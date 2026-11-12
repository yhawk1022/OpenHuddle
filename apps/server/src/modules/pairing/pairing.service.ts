/**
 * @module server/modules/pairing/service
 * @description 人类主人签发一次性配对码与外部 AI Agent 自举绑定/认领（`--reclaim`）核心服务。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 防误覆盖保护：同一人类主人名下已存在相同 `slug` 的活跃 Agent 时，未显式声明 `reclaim: true` 且配对码未绑定 `reclaimAgentId` 的请求一律拦截并返回 `409 AGENT_ALREADY_ACTIVE`。
 * 2. 单次可见明文令牌：配对成功后签发的 `oh_agt_...` 明文令牌仅在本次响应返回一次，服务端仅存 SHA-256 哈希。
 */
import type {
  AuthenticatedCaller,
  CreatePairingCodeBody,
  CreatePairingCodeResponse,
  PairAgentRequest,
  PairAgentResponse,
} from "@openhuddle/protocol";
import { assertHumanCaller } from "../../infra/auth-middleware.js";
import {
  generateAgentId,
  generateAgentToken,
  generatePairingCode,
  sha256Hex,
  slugifyAgentName,
} from "../../infra/crypto.js";
import type { ServerEnv } from "../../infra/env.js";
import { AppError } from "../../infra/errors.js";
import type { RealtimeBus } from "../../infra/realtime-bus.js";
import { type SafeAgentRecord, mapAgentRecordToSummaryDto } from "../auth/auth.repo.js";
import type { PairingRepository } from "./pairing.repo.js";

/**
 * 构造 `PairingService` 所需的依赖。
 */
export interface PairingServiceDeps {
  readonly repo: PairingRepository;
  readonly env: ServerEnv;
  readonly realtimeBus: RealtimeBus;
}

/**
 * 配对码签发与 Agent 接入编排服务。
 */
export class PairingService {
  private readonly repo: PairingRepository;
  private readonly env: ServerEnv;
  private readonly realtimeBus: RealtimeBus;

  /**
   * @param deps - 配对仓储、运行环境配置与实时事件总线
   */
  public constructor(deps: Readonly<PairingServiceDeps>) {
    this.repo = deps.repo;
    this.env = deps.env;
    this.realtimeBus = deps.realtimeBus;
  }

  /**
   * 为当前已登录人类主人生成一次性 `HUDDLE-XXXX-XXXX` 配对码及可直接复制给外部 Agent 的引导词。
   *
   * @param caller - 当前调用者（必须为人类）
   * @param body - 可选自动入群房间、可选认领 Agent 与有效小时数
   * @returns 配对码与 `onboardingPrompt`
   * @throws {AppError} 非人类调用抛 `403 FORBIDDEN_NOT_OWNER`；房间不存在抛 `404`；非房间成员抛 `403 FORBIDDEN_NOT_ROOM_MEMBER`
   */
  public async createPairingCode(
    caller: Readonly<AuthenticatedCaller>,
    body: Readonly<CreatePairingCodeBody>,
  ): Promise<CreatePairingCodeResponse> {
    const human = assertHumanCaller(caller);

    if (body.autoJoinRoomId !== undefined) {
      const exists = await this.repo.roomExists(body.autoJoinRoomId);
      if (!exists) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Target auto-join room "${body.autoJoinRoomId}" was not found.`,
        });
      }
      const isMember = await this.repo.isHumanRoomMember(body.autoJoinRoomId, human.userId);
      if (!isMember) {
        throw new AppError({
          code: "FORBIDDEN_NOT_ROOM_MEMBER",
          statusCode: 403,
          message: "You must be a member of the room to create an auto-join pairing code for it.",
        });
      }
    }

    if (body.reclaimAgentId !== undefined) {
      const targetAgent = await this.repo.findAgentById(body.reclaimAgentId);
      if (!targetAgent) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Target reclaim agent "${body.reclaimAgentId}" was not found.`,
        });
      }
      if (targetAgent.ownerUserId !== human.userId) {
        throw new AppError({
          code: "FORBIDDEN_NOT_OWNER",
          statusCode: 403,
          message: "You can only issue a reclaim pairing code for an agent you own.",
        });
      }
    }

    const code = generatePairingCode();
    const expiresAt = new Date(Date.now() + body.expiresInHours * 3_600_000);

    await this.repo.insertPairingCode({
      code,
      ownerUserId: human.userId,
      ...(body.autoJoinRoomId !== undefined ? { autoJoinRoomId: body.autoJoinRoomId } : {}),
      ...(body.reclaimAgentId !== undefined ? { reclaimAgentId: body.reclaimAgentId } : {}),
      expiresAt,
    });

    const baseUrl = this.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
    const reclaimSuffix = body.reclaimAgentId !== undefined ? " --reclaim" : "";
    const onboardingPrompt = [
      `Read ${baseUrl}/install.md and pair with OpenHuddle using one-time code ${code}${reclaimSuffix}.`,
      `After pairing, read ${baseUrl}/skill.md and obey the Owner-First trust boundary before reading or sending messages.`,
    ].join(" ");

    return {
      ok: true,
      code,
      expiresAtIso: expiresAt.toISOString(),
      onboardingPrompt,
    };
  }

  /**
   * 消费一次性配对码绑定新 Agent（或通过 `--reclaim` 轮换找回已有 Agent 令牌）并可选自动入群。
   *
   * @param body - 配对码、Agent 名称、宿主平台标识及 `reclaim` 标志
   * @returns 含一次性明文 `oh_agt_` 令牌、Agent 详情与归属主人信息的响应
   * @throws {AppError} 配对码无效/过期抛 `400 PAIRING_CODE_INVALID_OR_EXPIRED`；同名冲突抛 `409 AGENT_ALREADY_ACTIVE`
   */
  public async pairAgent(body: Readonly<PairAgentRequest>): Promise<PairAgentResponse> {
    const rawToken = generateAgentToken();
    const tokenHash = sha256Hex(rawToken);
    const slug = slugifyAgentName(body.name);
    const now = new Date();

    const txResult = await this.repo.runInTransaction(async (txRepo) => {
      const codeRecord = await txRepo.lockPairingCodeForUpdate(body.code);
      if (
        !codeRecord ||
        codeRecord.usedAt !== null ||
        codeRecord.expiresAt.getTime() <= now.getTime()
      ) {
        throw new AppError({
          code: "PAIRING_CODE_INVALID_OR_EXPIRED",
          statusCode: 400,
          message: "Pairing code is invalid, has already been used, or has expired.",
        });
      }

      const owner = await txRepo.findOwnerById(codeRecord.ownerUserId);
      if (!owner) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: "Owner account associated with this pairing code was not found.",
        });
      }

      let agentRecord: SafeAgentRecord;

      if (codeRecord.reclaimAgentId !== null) {
        // 配对码已由主人显式绑定待认领的 Agent 主键：直接原地轮换其 tokenHash，保留所有房间与游标
        const target = await txRepo.findAgentById(codeRecord.reclaimAgentId);
        if (!target || target.ownerUserId !== owner.id) {
          throw new AppError({
            code: "NOT_FOUND",
            statusCode: 404,
            message: "Target agent specified for reclaim no longer exists.",
          });
        }
        agentRecord = await txRepo.rotateAgentTokenAndProfile({
          agentId: target.id,
          displayName: body.name,
          platform: body.platform,
          ...(body.intro !== undefined ? { intro: body.intro } : {}),
          tokenHash,
          now,
        });
      } else {
        const existingBySlug = await txRepo.findAgentByOwnerAndSlug(owner.id, slug);
        if (existingBySlug) {
          if (!body.reclaim) {
            throw new AppError({
              code: "AGENT_ALREADY_ACTIVE",
              statusCode: 409,
              message: `An agent with slug "${slug}" is already active under this owner. Pass reclaim=true or use a reclaim pairing code to rotate its token.`,
            });
          }
          agentRecord = await txRepo.rotateAgentTokenAndProfile({
            agentId: existingBySlug.id,
            displayName: body.name,
            platform: body.platform,
            ...(body.intro !== undefined ? { intro: body.intro } : {}),
            tokenHash,
            now,
          });
        } else {
          agentRecord = await txRepo.insertAgent({
            id: generateAgentId(),
            ownerUserId: owner.id,
            displayName: body.name,
            slug,
            platform: body.platform,
            ...(body.intro !== undefined ? { intro: body.intro } : {}),
            tokenHash,
            now,
          });
        }
      }

      await txRepo.markPairingCodeUsed(codeRecord.code, now);

      let autoJoinedRoomId = codeRecord.autoJoinRoomId ?? undefined;
      if (autoJoinedRoomId !== undefined) {
        const roomStillExists = await txRepo.roomExists(autoJoinedRoomId);
        if (roomStillExists) {
          await txRepo.ensureAgentRoomMembership(autoJoinedRoomId, agentRecord.id);
        } else {
          autoJoinedRoomId = undefined;
        }
      }

      return { agentRecord, owner, autoJoinedRoomId };
    });

    return {
      ok: true,
      token: rawToken,
      agent: mapAgentRecordToSummaryDto(txResult.agentRecord, this.realtimeBus),
      owner: txResult.owner,
      ...(txResult.autoJoinedRoomId !== undefined
        ? { autoJoinedRoomId: txResult.autoJoinedRoomId }
        : {}),
    };
  }
}
