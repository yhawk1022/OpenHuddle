/**
 * @module server/modules/workspaces/repo
 * @description 工作区（`workspaces`）、房间挂载绑定（`workspace_room_bindings`）与协作工单/分片（`work_items` / `work_slices`）仓储层。
 *
 * 并发与性能关键不变量：
 * 1. 全局防死锁加锁顺序：凡需同时追加房间时间线里程碑消息与更新工单的事务，必须严格按 `rooms FOR UPDATE -> work_items FOR UPDATE` 顺序取锁，与消息和提案仓储完全对齐。
 * 2. 批量水合零 1+N：工单列表查询通过 `WHERE work_item_id IN (...)` 一次性拉取全部分片，并批量合并在线 Agent 最新昵称快照。
 */
import {
  MAX_SLICE_ATTEMPTS,
  type OrchestrationReviewState,
  type OrchestrationSliceState,
} from "@openhuddle/core-governance";
import {
  type OpenHuddleDb,
  messagesTable,
  roomsTable,
  workItemsTable,
  workReviewEvidenceTable,
  workSlicesTable,
  workspaceRoomBindingsTable,
  workspacesTable,
} from "@openhuddle/db";
import {
  type AgentExecutionTier,
  type AgentId,
  AgentPlatformSchema,
  type AuthenticatedCaller,
  type InboxWorkAssignment,
  type MessageSeq,
  type MessageType,
  type OperationKey,
  type RoomId,
  type RoomWorkspaceBindingDto,
  type UserId,
  type WorkDiffFileDto,
  type WorkItemId,
  type WorkSliceId,
  type WorkStage,
  type WorkTopology,
  type WorkTraceEntry,
  type WorkspaceContextAssets,
  type WorkspaceHostMode,
  WorkspaceHostModeSchema,
  type WorkspaceId,
  type WorkspaceKind,
  type WorkspaceLifecycleHooks,
  WorkspaceLifecycleHooksSchema,
  type WorkspaceRootEntry,
  type WorkspaceSandboxMode,
  WorkspaceSandboxModeSchema,
} from "@openhuddle/protocol";
import { type SQL, and, eq, sql } from "drizzle-orm";
import { extractSqlRows } from "../../infra/sql-rows.js";
import { type HydratedRawMessageRecord, MessagesRepository } from "../messages/messages.repo.js";
import {
  type HydratedWorkItemRecord,
  type HydratedWorkspaceRecord,
  type StoredAgentSnapshot,
  type StoredAttentionRecord,
  parseJsonValue,
  parseRawSliceRow,
  parseRawWorkspaceRow,
  parseStoredAgentSnapshots,
  parseStoredAttention,
  parseStoredDiffFiles,
  parseStoredReview,
  parseStoredTraceEntries,
  parseWorkItemMetaFields,
  toDate,
} from "./workspaces.mapper.js";

const MAX_STORED_TRACE_ENTRIES = 160;

interface RawWorkspaceJoinedRow {
  readonly id: string;
  readonly ownerUserId: string;
  readonly ownerDisplayName: string | null;
  readonly name: string;
  readonly kind: string;
  readonly rootsJson: unknown;
  readonly hostMode: string;
  readonly hostLabel: string;
  readonly sandboxMode: string;
  readonly allowRoomCollaborators: boolean;
  readonly prewarmedWorktrees: number;
  readonly hooksJson: unknown;
  readonly contextJson: unknown;
  readonly defaultTopology: string;
  readonly defaultWorkerAgentId: string | null;
  readonly defaultVerifierAgentId: string | null;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
}

interface RawWorkItemJoinedRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceOwnerUserId: string;
  readonly workspaceHostMode: string;
  readonly workspaceSandboxMode: string;
  readonly workspaceAllowRoomCollaborators: boolean;
  readonly workspaceHooksJson: unknown;
  readonly ownerUserId: string;
  readonly roomId: string | null;
  readonly anchorMessageSeq: number;
  readonly title: string;
  readonly brief: string;
  readonly topology: string;
  readonly tier: string;
  readonly stage: string;
  readonly worktreeBranch: string;
  readonly coordinatorAgentId: string | null;
  readonly primaryWorkerAgentId: string;
  readonly verifierAgentId: string | null;
  readonly attentionJson: unknown;
  readonly reviewJson: unknown;
  readonly traceJson: unknown;
  readonly diffFilesJson: unknown;
  readonly agentSnapshotsJson: unknown;
  readonly version: number;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
}

interface WorkListOptions {
  readonly stage?: WorkStage | undefined;
  readonly limit?: number | undefined;
  readonly claimableBy?:
    | {
        readonly agentId: AgentId;
        readonly ownerUserId: UserId;
        readonly nowMs: number;
      }
    | undefined;
}

/**
 * 工作区与多 Agent 协作工单数据库仓储。
 */
export class WorkspacesRepository {
  private readonly db: OpenHuddleDb;

  public constructor(db: OpenHuddleDb) {
    this.db = db;
  }

  /**
   * 在单个数据库事务中执行状态变更。
   */
  public async runInTransaction<T>(fn: (txRepo: WorkspacesRepository) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const txRepo = new WorkspacesRepository(tx as unknown as OpenHuddleDb);
      return fn(txRepo);
    });
  }

  /**
   * 排他锁定房间行（全局锁顺序第 1 级：`rooms`）。
   */
  public async lockRoomBasicForUpdate(roomId: RoomId): Promise<
    | {
        readonly id: RoomId;
        readonly ownerUserId: UserId;
        readonly lastSeq: number;
      }
    | undefined
  > {
    const result = await this.db.execute(sql`
      SELECT
        id,
        owner_user_id AS "ownerUserId",
        last_seq AS "lastSeq"
      FROM rooms
      WHERE id = ${roomId}
      FOR UPDATE
    `);

    const row = extractSqlRows<{
      readonly id: string;
      readonly ownerUserId: string;
      readonly lastSeq: number;
    }>(result)[0];

    if (!row) {
      return undefined;
    }
    return {
      id: row.id as RoomId,
      ownerUserId: row.ownerUserId as UserId,
      lastSeq: Number(row.lastSeq),
    };
  }

  /**
   * 排他锁定工单聚合根行（全局锁顺序第 2 级：`work_items`），串行化分片认领、续租与状态跃迁。
   */
  public async lockWorkItemForUpdate(workItemId: WorkItemId): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT id
      FROM work_items
      WHERE id = ${workItemId}
      FOR UPDATE
    `);
    return extractSqlRows<{ readonly id: string }>(result).length > 0;
  }

  public async findRoomBasic(roomId: RoomId): Promise<
    | {
        readonly id: RoomId;
        readonly ownerUserId: UserId;
        readonly lastSeq: number;
      }
    | undefined
  > {
    const result = await this.db.execute(sql`
      SELECT
        id,
        owner_user_id AS "ownerUserId",
        last_seq AS "lastSeq"
      FROM rooms
      WHERE id = ${roomId}
      LIMIT 1
    `);
    const row = extractSqlRows<{
      readonly id: string;
      readonly ownerUserId: string;
      readonly lastSeq: number;
    }>(result)[0];
    return row
      ? {
          id: row.id as RoomId,
          ownerUserId: row.ownerUserId as UserId,
          lastSeq: Number(row.lastSeq),
        }
      : undefined;
  }

  public async isMemberInRoom(roomId: RoomId, memberKey: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1 AS "ok"
      FROM room_members
      WHERE room_id = ${roomId} AND member_key = ${memberKey}
      LIMIT 1
    `);
    return extractSqlRows<{ readonly ok: number }>(result).length > 0;
  }

  public async listJoinedRoomIds(memberKey: string): Promise<readonly RoomId[]> {
    const result = await this.db.execute(sql`
      SELECT room_id AS "roomId"
      FROM room_members
      WHERE member_key = ${memberKey}
    `);
    return extractSqlRows<{ readonly roomId: string }>(result).map((r) => r.roomId as RoomId);
  }

  public async listPresentAgentIdsInRoom(
    roomId: RoomId,
    agentIds: readonly AgentId[],
  ): Promise<ReadonlySet<AgentId>> {
    if (agentIds.length === 0) {
      return new Set();
    }
    const idParams = sql.join(
      agentIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const result = await this.db.execute(sql`
      SELECT agent_id AS "agentId"
      FROM room_members
      WHERE room_id = ${roomId} AND agent_id IN (${idParams})
    `);
    return new Set(
      extractSqlRows<{ readonly agentId: string | null }>(result)
        .filter((r): r is { readonly agentId: string } => r.agentId !== null)
        .map((r) => r.agentId as AgentId),
    );
  }

  public async listAgentIdsByOwner(ownerUserId: UserId): Promise<readonly AgentId[]> {
    const result = await this.db.execute(sql`
      SELECT id
      FROM agents
      WHERE owner_user_id = ${ownerUserId}
    `);
    return extractSqlRows<{ readonly id: string }>(result).map((r) => r.id as AgentId);
  }

  public async findAgentSnapshotsByIds(
    agentIds: readonly AgentId[],
  ): Promise<ReadonlyMap<AgentId, StoredAgentSnapshot>> {
    const uniqueIds = [...new Set(agentIds)];
    if (uniqueIds.length === 0) {
      return new Map();
    }
    const idParams = sql.join(
      uniqueIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const result = await this.db.execute(sql`
      SELECT
        a.id AS "agentId",
        a.display_name AS "displayName",
        a.platform AS "platform",
        a.owner_user_id AS "ownerUserId",
        u.display_name AS "ownerDisplayName"
      FROM agents a
      JOIN users u ON a.owner_user_id = u.id
      WHERE a.id IN (${idParams})
    `);

    const map = new Map<AgentId, StoredAgentSnapshot>();
    for (const row of extractSqlRows<{
      readonly agentId: string;
      readonly displayName: string;
      readonly platform: string;
      readonly ownerUserId: string;
      readonly ownerDisplayName: string;
    }>(result)) {
      const id = row.agentId as AgentId;
      map.set(id, {
        agentId: id,
        displayName: row.displayName,
        platform: AgentPlatformSchema.parse(row.platform),
        ownerUserId: row.ownerUserId as UserId,
        ownerDisplayName: row.ownerDisplayName,
      });
    }
    return map;
  }

  public async findAgentIdentityById(agentId: AgentId): Promise<
    | {
        readonly agentId: AgentId;
        readonly slug: string;
        readonly displayName: string;
        readonly platform: ReturnType<typeof AgentPlatformSchema.parse>;
        readonly ownerUserId: UserId;
      }
    | undefined
  > {
    const result = await this.db.execute(sql`
      SELECT
        id AS "agentId",
        slug AS "slug",
        display_name AS "displayName",
        platform AS "platform",
        owner_user_id AS "ownerUserId"
      FROM agents
      WHERE id = ${agentId}
      LIMIT 1
    `);
    const row = extractSqlRows<{
      readonly agentId: string;
      readonly slug: string;
      readonly displayName: string;
      readonly platform: string;
      readonly ownerUserId: string;
    }>(result)[0];
    if (!row) {
      return undefined;
    }
    return {
      agentId: row.agentId as AgentId,
      slug: row.slug,
      displayName: row.displayName,
      platform: AgentPlatformSchema.parse(row.platform),
      ownerUserId: row.ownerUserId as UserId,
    };
  }

  public async insertWorkspace(input: {
    readonly id: WorkspaceId;
    readonly ownerUserId: UserId;
    readonly name: string;
    readonly kind: WorkspaceKind;
    readonly roots: readonly WorkspaceRootEntry[];
    readonly hostMode: WorkspaceHostMode;
    readonly hostLabel: string;
    readonly sandboxMode: WorkspaceSandboxMode;
    readonly allowRoomCollaborators: boolean;
    readonly prewarmedWorktrees: number;
    readonly hooks: WorkspaceLifecycleHooks;
    readonly context: WorkspaceContextAssets;
    readonly defaultTopology: WorkTopology;
    readonly defaultWorkerAgentId?: AgentId | undefined;
    readonly defaultVerifierAgentId?: AgentId | undefined;
  }): Promise<void> {
    const now = new Date();
    await this.db.insert(workspacesTable).values({
      id: input.id,
      ownerUserId: input.ownerUserId,
      name: input.name,
      kind: input.kind,
      rootsJson: input.roots,
      hostMode: input.hostMode,
      hostLabel: input.hostLabel,
      sandboxMode: input.sandboxMode,
      allowRoomCollaborators: input.allowRoomCollaborators,
      prewarmedWorktrees: input.prewarmedWorktrees,
      hooksJson: input.hooks,
      contextJson: input.context,
      defaultTopology: input.defaultTopology,
      defaultWorkerAgentId: input.defaultWorkerAgentId ?? null,
      defaultVerifierAgentId: input.defaultVerifierAgentId ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  public async updateWorkspaceRow(
    workspaceId: WorkspaceId,
    patch: {
      readonly name?: string | undefined;
      readonly kind?: WorkspaceKind | undefined;
      readonly roots?: readonly WorkspaceRootEntry[] | undefined;
      readonly hostMode?: WorkspaceHostMode | undefined;
      readonly hostLabel?: string | undefined;
      readonly sandboxMode?: WorkspaceSandboxMode | undefined;
      readonly allowRoomCollaborators?: boolean | undefined;
      readonly prewarmedWorktrees?: number | undefined;
      readonly hooks?: WorkspaceLifecycleHooks | undefined;
      readonly context?: WorkspaceContextAssets | undefined;
      readonly defaultTopology?: WorkTopology | undefined;
      readonly defaultWorkerAgentId?: AgentId | null | undefined;
      readonly defaultVerifierAgentId?: AgentId | null | undefined;
    },
  ): Promise<void> {
    await this.db
      .update(workspacesTable)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
        ...(patch.roots !== undefined ? { rootsJson: patch.roots } : {}),
        ...(patch.hostMode !== undefined ? { hostMode: patch.hostMode } : {}),
        ...(patch.hostLabel !== undefined ? { hostLabel: patch.hostLabel } : {}),
        ...(patch.sandboxMode !== undefined ? { sandboxMode: patch.sandboxMode } : {}),
        ...(patch.allowRoomCollaborators !== undefined
          ? { allowRoomCollaborators: patch.allowRoomCollaborators }
          : {}),
        ...(patch.prewarmedWorktrees !== undefined
          ? { prewarmedWorktrees: patch.prewarmedWorktrees }
          : {}),
        ...(patch.hooks !== undefined ? { hooksJson: patch.hooks } : {}),
        ...(patch.context !== undefined ? { contextJson: patch.context } : {}),
        ...(patch.defaultTopology !== undefined ? { defaultTopology: patch.defaultTopology } : {}),
        ...(patch.defaultWorkerAgentId !== undefined
          ? { defaultWorkerAgentId: patch.defaultWorkerAgentId }
          : {}),
        ...(patch.defaultVerifierAgentId !== undefined
          ? { defaultVerifierAgentId: patch.defaultVerifierAgentId }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(workspacesTable.id, workspaceId));
  }

  public async deleteWorkspaceRow(workspaceId: WorkspaceId): Promise<void> {
    await this.db.delete(workspacesTable).where(eq(workspacesTable.id, workspaceId));
  }

  public async findWorkspaceById(
    workspaceId: WorkspaceId,
  ): Promise<HydratedWorkspaceRecord | undefined> {
    const result = await this.db.execute(sql`
      SELECT
        w.id AS "id",
        w.owner_user_id AS "ownerUserId",
        u.display_name AS "ownerDisplayName",
        w.name AS "name",
        w.kind AS "kind",
        w.roots_json AS "rootsJson",
        w.host_mode AS "hostMode",
        w.host_label AS "hostLabel",
        w.sandbox_mode AS "sandboxMode",
        w.allow_room_collaborators AS "allowRoomCollaborators",
        w.prewarmed_worktrees AS "prewarmedWorktrees",
        w.hooks_json AS "hooksJson",
        w.context_json AS "contextJson",
        w.default_topology AS "defaultTopology",
        w.default_worker_agent_id AS "defaultWorkerAgentId",
        w.default_verifier_agent_id AS "defaultVerifierAgentId",
        w.created_at AS "createdAt",
        w.updated_at AS "updatedAt"
      FROM workspaces w
      LEFT JOIN users u ON w.owner_user_id = u.id
      WHERE w.id = ${workspaceId}
      LIMIT 1
    `);

    const row = extractSqlRows<RawWorkspaceJoinedRow>(result)[0];
    return row ? parseRawWorkspaceRow(row) : undefined;
  }

  public async listWorkspacesByOwner(
    ownerUserId: UserId,
  ): Promise<readonly HydratedWorkspaceRecord[]> {
    const result = await this.db.execute(sql`
      SELECT
        w.id AS "id",
        w.owner_user_id AS "ownerUserId",
        u.display_name AS "ownerDisplayName",
        w.name AS "name",
        w.kind AS "kind",
        w.roots_json AS "rootsJson",
        w.host_mode AS "hostMode",
        w.host_label AS "hostLabel",
        w.sandbox_mode AS "sandboxMode",
        w.allow_room_collaborators AS "allowRoomCollaborators",
        w.prewarmed_worktrees AS "prewarmedWorktrees",
        w.hooks_json AS "hooksJson",
        w.context_json AS "contextJson",
        w.default_topology AS "defaultTopology",
        w.default_worker_agent_id AS "defaultWorkerAgentId",
        w.default_verifier_agent_id AS "defaultVerifierAgentId",
        w.created_at AS "createdAt",
        w.updated_at AS "updatedAt"
      FROM workspaces w
      LEFT JOIN users u ON w.owner_user_id = u.id
      WHERE w.owner_user_id = ${ownerUserId}
      ORDER BY w.updated_at DESC
    `);

    return extractSqlRows<RawWorkspaceJoinedRow>(result).map(parseRawWorkspaceRow);
  }

  public async listRoomBindingsByOwner(
    ownerUserId: UserId,
  ): Promise<readonly RoomWorkspaceBindingDto[]> {
    const result = await this.db.execute(sql`
      SELECT
        room_id AS "roomId",
        owner_user_id AS "ownerUserId",
        workspace_id AS "workspaceId",
        bound_at AS "boundAt"
      FROM workspace_room_bindings
      WHERE owner_user_id = ${ownerUserId}
      ORDER BY bound_at DESC
    `);

    return extractSqlRows<{
      readonly roomId: string;
      readonly ownerUserId: string;
      readonly workspaceId: string;
      readonly boundAt: Date | string;
    }>(result).map((r) => ({
      roomId: r.roomId as RoomId,
      ownerUserId: r.ownerUserId as UserId,
      workspaceId: r.workspaceId as WorkspaceId,
      boundAtIso: toDate(r.boundAt).toISOString(),
    }));
  }

  public async listBoundRoomIdsForWorkspace(workspaceId: WorkspaceId): Promise<readonly RoomId[]> {
    const result = await this.db.execute(sql`
      SELECT room_id AS "roomId"
      FROM workspace_room_bindings
      WHERE workspace_id = ${workspaceId}
    `);
    return extractSqlRows<{ readonly roomId: string }>(result).map((r) => r.roomId as RoomId);
  }

  public async upsertRoomWorkspaceBinding(params: {
    readonly roomId: RoomId;
    readonly ownerUserId: UserId;
    readonly workspaceId: WorkspaceId;
  }): Promise<RoomWorkspaceBindingDto> {
    const now = new Date();
    await this.db
      .insert(workspaceRoomBindingsTable)
      .values({
        roomId: params.roomId,
        ownerUserId: params.ownerUserId,
        workspaceId: params.workspaceId,
        boundAt: now,
      })
      .onConflictDoUpdate({
        target: [workspaceRoomBindingsTable.roomId, workspaceRoomBindingsTable.ownerUserId],
        set: {
          workspaceId: params.workspaceId,
          boundAt: now,
        },
      });

    return {
      roomId: params.roomId,
      ownerUserId: params.ownerUserId,
      workspaceId: params.workspaceId,
      boundAtIso: now.toISOString(),
    };
  }

  public async deleteRoomWorkspaceBinding(roomId: RoomId, ownerUserId: UserId): Promise<void> {
    await this.db
      .delete(workspaceRoomBindingsTable)
      .where(
        and(
          eq(workspaceRoomBindingsTable.roomId, roomId),
          eq(workspaceRoomBindingsTable.ownerUserId, ownerUserId),
        ),
      );
  }

  public async listBoundWorkspacesForRoom(roomId: RoomId): Promise<{
    readonly workspaces: readonly HydratedWorkspaceRecord[];
    readonly bindings: readonly RoomWorkspaceBindingDto[];
  }> {
    const bindResult = await this.db.execute(sql`
      SELECT
        room_id AS "roomId",
        owner_user_id AS "ownerUserId",
        workspace_id AS "workspaceId",
        bound_at AS "boundAt"
      FROM workspace_room_bindings
      WHERE room_id = ${roomId}
      ORDER BY bound_at ASC
    `);

    const bindings = extractSqlRows<{
      readonly roomId: string;
      readonly ownerUserId: string;
      readonly workspaceId: string;
      readonly boundAt: Date | string;
    }>(bindResult).map((r) => ({
      roomId: r.roomId as RoomId,
      ownerUserId: r.ownerUserId as UserId,
      workspaceId: r.workspaceId as WorkspaceId,
      boundAtIso: toDate(r.boundAt).toISOString(),
    }));

    if (bindings.length === 0) {
      return { workspaces: [], bindings: [] };
    }

    const wsIds = [...new Set(bindings.map((b) => b.workspaceId))];
    const wsParams = sql.join(
      wsIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const wsResult = await this.db.execute(sql`
      SELECT
        w.id AS "id",
        w.owner_user_id AS "ownerUserId",
        u.display_name AS "ownerDisplayName",
        w.name AS "name",
        w.kind AS "kind",
        w.roots_json AS "rootsJson",
        w.host_mode AS "hostMode",
        w.host_label AS "hostLabel",
        w.sandbox_mode AS "sandboxMode",
        w.allow_room_collaborators AS "allowRoomCollaborators",
        w.prewarmed_worktrees AS "prewarmedWorktrees",
        w.hooks_json AS "hooksJson",
        w.context_json AS "contextJson",
        w.default_topology AS "defaultTopology",
        w.default_worker_agent_id AS "defaultWorkerAgentId",
        w.default_verifier_agent_id AS "defaultVerifierAgentId",
        w.created_at AS "createdAt",
        w.updated_at AS "updatedAt"
      FROM workspaces w
      LEFT JOIN users u ON w.owner_user_id = u.id
      WHERE w.id IN (${wsParams})
    `);

    return {
      workspaces: extractSqlRows<RawWorkspaceJoinedRow>(wsResult).map(parseRawWorkspaceRow),
      bindings,
    };
  }

  /**
   * 在已持有 `rooms FOR UPDATE` 行锁的事务中追加一条房间里程碑消息，并推进 `rooms.last_seq`。
   */
  public async appendRoomMilestoneUnderLock(input: {
    readonly roomId: RoomId;
    readonly nextSeq: MessageSeq;
    readonly memberKey: string;
    readonly caller: AuthenticatedCaller;
    readonly type: Extract<MessageType, "text" | "decision">;
    readonly content: string;
    readonly payloadJson: Record<string, unknown>;
  }): Promise<HydratedRawMessageRecord> {
    const authorUserId = input.caller.kind === "human" ? input.caller.userId : null;
    const authorAgentId = input.caller.kind === "agent" ? input.caller.agentId : null;
    const ownerUserId =
      input.caller.kind === "human" ? input.caller.userId : input.caller.ownerUserId;

    await this.db.insert(messagesTable).values({
      roomId: input.roomId,
      seq: input.nextSeq,
      authorKind: input.caller.kind,
      authorUserId,
      authorAgentId,
      ownerUserId,
      type: input.type,
      content: input.content,
      payloadJson: input.payloadJson,
      replyToSeq: null,
      mentionsJson: [],
      opKey: null,
    });

    await this.db
      .update(roomsTable)
      .set({ lastSeq: input.nextSeq })
      .where(eq(roomsTable.id, input.roomId));

    await this.db.execute(sql`
      UPDATE room_members
      SET last_read_seq = GREATEST(last_read_seq, ${input.nextSeq})
      WHERE room_id = ${input.roomId} AND member_key = ${input.memberKey}
    `);

    const msgRepo = new MessagesRepository(this.db);
    const created = await msgRepo.findBySeq(input.roomId, input.nextSeq);
    if (!created) {
      throw new Error(`Failed to hydrate room work milestone message (seq=${input.nextSeq}).`);
    }
    return created;
  }

  public async insertWorkItemWithSlices(input: {
    readonly id: WorkItemId;
    readonly workspaceId: WorkspaceId;
    readonly ownerUserId: UserId;
    readonly roomId?: RoomId | undefined;
    readonly anchorMessageSeq: number;
    readonly title: string;
    readonly brief: string;
    readonly topology: WorkTopology;
    readonly tier: AgentExecutionTier;
    readonly stage: WorkStage;
    readonly worktreeBranch: string;
    readonly coordinatorAgentId?: AgentId | undefined;
    readonly primaryWorkerAgentId: AgentId;
    readonly verifierAgentId?: AgentId | undefined;
    readonly opKey?: OperationKey | undefined;
    readonly agentSnapshots: Readonly<Record<string, StoredAgentSnapshot>>;
    readonly slices: readonly OrchestrationSliceState[];
    readonly initialTrace?: readonly WorkTraceEntry[] | undefined;
  }): Promise<void> {
    const now = new Date();
    await this.db.insert(workItemsTable).values({
      id: input.id,
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      roomId: input.roomId ?? null,
      anchorMessageSeq: input.anchorMessageSeq,
      title: input.title,
      brief: input.brief,
      topology: input.topology,
      tier: input.tier,
      stage: input.stage,
      worktreeBranch: input.worktreeBranch,
      coordinatorAgentId: input.coordinatorAgentId ?? null,
      primaryWorkerAgentId: input.primaryWorkerAgentId,
      verifierAgentId: input.verifierAgentId ?? null,
      attentionJson: null,
      reviewJson: null,
      traceJson: (input.initialTrace ?? []).slice(-MAX_STORED_TRACE_ENTRIES),
      diffFilesJson: [],
      agentSnapshotsJson: input.agentSnapshots as unknown as Readonly<
        Record<string, Record<string, unknown>>
      >,
      opKey: input.opKey ?? null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    if (input.slices.length > 0) {
      // 单条多值 INSERT 批量落盘全部分片，消除蜂群建单时的 N 次数据库往返
      await this.db.insert(workSlicesTable).values(
        input.slices.map((s) => ({
          id: s.sliceId,
          workItemId: input.id,
          orderIndex: s.orderIndex,
          title: s.title,
          leaseRole: s.leaseRole,
          assignedAgentId: s.assignedAgentId,
          leaseOwnerAgentId: s.leaseOwnerAgentId ?? null,
          leaseVersion: s.leaseVersion,
          leaseExpiresAt: s.leaseExpiresAtMs !== undefined ? new Date(s.leaseExpiresAtMs) : null,
          attemptCount: s.attemptCount,
          ownedPathsJson: s.ownedPaths,
          status: s.status,
          liveSummary: s.liveSummary,
          diffAdded: s.diffAdded,
          diffRemoved: s.diffRemoved,
          changedFilesJson: s.changedFiles,
          worktreeBranch: s.worktreeBranch ?? null,
          steerNotesJson: s.steerNotes,
          failureCode: s.failureCode ?? null,
          provenanceJson: s.provenance ?? null,
          startedAt: s.startedAtMs !== undefined ? new Date(s.startedAtMs) : null,
          completedAt: s.completedAtMs !== undefined ? new Date(s.completedAtMs) : null,
          createdAt: now,
        })),
      );
    }
  }

  /**
   * 原子持久化状态机推进后的工单聚合根与分片集合，并单调递增 `work_items.version`。
   * 支持通过 `dirtySliceIds` 仅更新实际发生变更的分片行，降低事务持锁窗口。
   */
  public async persistWorkItemState(input: {
    readonly workItemId: WorkItemId;
    readonly nextStage: WorkStage;
    readonly nextSlices: readonly OrchestrationSliceState[];
    readonly nextAttention: StoredAttentionRecord | null;
    readonly nextReview: OrchestrationReviewState | null;
    readonly nextTrace?: readonly WorkTraceEntry[] | undefined;
    readonly nextDiffFiles?: readonly WorkDiffFileDto[] | undefined;
    readonly nextAgentSnapshots?: Readonly<Record<string, StoredAgentSnapshot>> | undefined;
    readonly roomAttachment?: { readonly roomId: RoomId; readonly anchorSeq: number } | undefined;
    readonly dirtySliceIds?: ReadonlySet<WorkSliceId> | undefined;
  }): Promise<void> {
    const now = new Date();
    await this.db
      .update(workItemsTable)
      .set({
        stage: input.nextStage,
        attentionJson:
          input.nextAttention !== null
            ? (input.nextAttention as unknown as Record<string, unknown>)
            : null,
        reviewJson:
          input.nextReview !== null
            ? (input.nextReview as unknown as Record<string, unknown>)
            : null,
        ...(input.nextTrace !== undefined
          ? {
              traceJson: input.nextTrace.slice(-MAX_STORED_TRACE_ENTRIES),
            }
          : {}),
        ...(input.nextDiffFiles !== undefined
          ? {
              diffFilesJson: input.nextDiffFiles,
            }
          : {}),
        ...(input.nextAgentSnapshots !== undefined
          ? {
              agentSnapshotsJson: input.nextAgentSnapshots as unknown as Readonly<
                Record<string, Record<string, unknown>>
              >,
            }
          : {}),
        ...(input.roomAttachment !== undefined
          ? {
              roomId: input.roomAttachment.roomId,
              anchorMessageSeq: input.roomAttachment.anchorSeq,
            }
          : {}),
        version: sql`${workItemsTable.version} + 1`,
        updatedAt: now,
      })
      .where(eq(workItemsTable.id, input.workItemId));

    const slicesToWrite =
      input.dirtySliceIds !== undefined
        ? input.nextSlices.filter((s) => input.dirtySliceIds?.has(s.sliceId))
        : input.nextSlices;

    for (const s of slicesToWrite) {
      await this.db
        .update(workSlicesTable)
        .set({
          assignedAgentId: s.assignedAgentId,
          leaseOwnerAgentId: s.leaseOwnerAgentId ?? null,
          leaseVersion: s.leaseVersion,
          leaseExpiresAt: s.leaseExpiresAtMs !== undefined ? new Date(s.leaseExpiresAtMs) : null,
          attemptCount: s.attemptCount,
          status: s.status,
          liveSummary: s.liveSummary,
          diffAdded: s.diffAdded,
          diffRemoved: s.diffRemoved,
          changedFilesJson: s.changedFiles,
          worktreeBranch: s.worktreeBranch ?? null,
          steerNotesJson: s.steerNotes,
          failureCode: s.failureCode ?? null,
          provenanceJson: s.provenance ?? null,
          startedAt: s.startedAtMs !== undefined ? new Date(s.startedAtMs) : null,
          completedAt: s.completedAtMs !== undefined ? new Date(s.completedAtMs) : null,
        })
        .where(eq(workSlicesTable.id, s.sliceId));
    }
  }

  /**
   * 单分片无跨片锁竞争的原子 Compare-And-Swap 心跳续期：
   * 仅锁定目标 `work_slices` 单行，不获取 `work_items FOR UPDATE`，使同一蜂群内多 Worker 心跳 100% 并发执行。
   */
  public async renewSliceHeartbeatCas(params: {
    readonly workItemId: WorkItemId;
    readonly sliceId: WorkSliceId;
    readonly callerAgentId: AgentId;
    readonly leaseVersion: number;
    readonly nowMs: number;
    readonly nextExpiresAtMs: number;
    readonly liveSummary?: string | undefined;
    readonly diffAdded?: number | undefined;
    readonly diffRemoved?: number | undefined;
    readonly traceEntries?: readonly WorkTraceEntry[] | undefined;
  }): Promise<boolean> {
    const nowIso = new Date(params.nowMs).toISOString();
    const nextExpIso = new Date(params.nextExpiresAtMs).toISOString();

    const updated = await this.db.execute(sql`
      UPDATE work_slices
      SET
        lease_expires_at = ${nextExpIso}::timestamptz,
        live_summary = COALESCE(${params.liveSummary ?? null}, live_summary),
        diff_added = COALESCE(${params.diffAdded ?? null}, diff_added),
        diff_removed = COALESCE(${params.diffRemoved ?? null}, diff_removed)
      WHERE id = ${params.sliceId}
        AND work_item_id = ${params.workItemId}
        AND lease_owner_agent_id = ${params.callerAgentId}
        AND lease_version = ${params.leaseVersion}
        AND status IN ('running', 'verifying')
        AND lease_expires_at > ${nowIso}::timestamptz
      RETURNING id
    `);

    if (extractSqlRows<{ readonly id: string }>(updated).length === 0) {
      return false;
    }

    if (params.traceEntries !== undefined && params.traceEntries.length > 0) {
      await this.appendWorkItemTraceEntries({
        workItemId: params.workItemId,
        entries: params.traceEntries,
        nowIso,
      });
    } else {
      await this.db.execute(sql`
        UPDATE work_items
        SET version = version + 1, updated_at = ${nowIso}::timestamptz
        WHERE id = ${params.workItemId}
      `);
    }
    return true;
  }

  /**
   * 原子向 `work_items.trace_json` 追加实时追踪条目（硬上限保留最新 160 条），并可选同步目标分片瞬态摘要与增删统计。
   */
  public async appendWorkItemTraceEntries(params: {
    readonly workItemId: WorkItemId;
    readonly entries: readonly WorkTraceEntry[];
    readonly sliceId?: WorkSliceId | undefined;
    readonly liveSummary?: string | undefined;
    readonly diffAdded?: number | undefined;
    readonly diffRemoved?: number | undefined;
    readonly nowIso?: string | undefined;
  }): Promise<
    | {
        readonly workspaceId: WorkspaceId;
        readonly ownerUserId: UserId;
        readonly workspaceOwnerUserId: UserId;
        readonly roomId?: RoomId | undefined;
      }
    | undefined
  > {
    if (params.entries.length === 0) {
      return undefined;
    }
    const nowIso = params.nowIso ?? new Date().toISOString();
    const entriesJson = JSON.stringify(params.entries.slice(-MAX_STORED_TRACE_ENTRIES));

    if (
      params.sliceId !== undefined &&
      (params.liveSummary !== undefined ||
        params.diffAdded !== undefined ||
        params.diffRemoved !== undefined)
    ) {
      await this.db.execute(sql`
        UPDATE work_slices
        SET
          live_summary = COALESCE(${params.liveSummary ?? null}, live_summary),
          diff_added = COALESCE(${params.diffAdded ?? null}, diff_added),
          diff_removed = COALESCE(${params.diffRemoved ?? null}, diff_removed)
        WHERE id = ${params.sliceId}
          AND work_item_id = ${params.workItemId}
      `);
    }

    const updated = await this.db.execute(sql`
      UPDATE work_items wi
      SET
        trace_json = CASE
          WHEN jsonb_array_length(COALESCE(wi.trace_json, '[]'::jsonb) || ${entriesJson}::jsonb) <= ${MAX_STORED_TRACE_ENTRIES}
            THEN COALESCE(wi.trace_json, '[]'::jsonb) || ${entriesJson}::jsonb
          ELSE (
            SELECT COALESCE(jsonb_agg(tail.elem ORDER BY tail.ord ASC), '[]'::jsonb)
            FROM (
              SELECT elem, ord
              FROM jsonb_array_elements(COALESCE(wi.trace_json, '[]'::jsonb) || ${entriesJson}::jsonb) WITH ORDINALITY AS t(elem, ord)
              ORDER BY ord DESC
              LIMIT ${MAX_STORED_TRACE_ENTRIES}
            ) tail
          )
        END,
        version = wi.version + 1,
        updated_at = ${nowIso}::timestamptz
      FROM workspaces w
      WHERE wi.id = ${params.workItemId}
        AND w.id = wi.workspace_id
      RETURNING
        wi.workspace_id AS "workspaceId",
        wi.owner_user_id AS "ownerUserId",
        w.owner_user_id AS "workspaceOwnerUserId",
        wi.room_id AS "roomId"
    `);

    const row = extractSqlRows<{
      readonly workspaceId: string;
      readonly ownerUserId: string;
      readonly workspaceOwnerUserId: string;
      readonly roomId: string | null;
    }>(updated)[0];

    if (!row) {
      return undefined;
    }
    return {
      workspaceId: row.workspaceId as WorkspaceId,
      ownerUserId: row.ownerUserId as UserId,
      workspaceOwnerUserId: row.workspaceOwnerUserId as UserId,
      ...(row.roomId !== null ? { roomId: row.roomId as RoomId } : {}),
    };
  }

  /**
   * 列出当前处于活跃态（`working` / `verifying`）且宿主为 `local_machine` 的待执行工单，供本机执行引擎启动恢复扫描。
   */
  public async listActiveLocalMachineWorkItems(
    limit = 40,
  ): Promise<readonly HydratedWorkItemRecord[]> {
    return this.queryHydratedWorkItems(
      sql`w.host_mode = 'local_machine' AND wi.stage IN ('working', 'verifying')`,
      limit,
    );
  }

  /**
   * 基于部分索引与 `FOR UPDATE SKIP LOCKED` 扫描已过期的活跃分片（多实例部署下互不阻塞、零重复回收）。
   */
  public async lockExpiredActiveSlicesSkipLocked(
    nowMs: number,
    batchLimit: number,
  ): Promise<ReadonlyArray<{ readonly sliceId: WorkSliceId; readonly workItemId: WorkItemId }>> {
    const nowIso = new Date(nowMs).toISOString();
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(batchLimit)));
    const result = await this.db.execute(sql`
      SELECT
        id AS "sliceId",
        work_item_id AS "workItemId"
      FROM work_slices
      WHERE status IN ('running', 'verifying')
        AND lease_expires_at <= ${nowIso}::timestamptz
      ORDER BY lease_expires_at ASC
      LIMIT ${safeLimit}
      FOR UPDATE SKIP LOCKED
    `);

    return extractSqlRows<{ readonly sliceId: string; readonly workItemId: string }>(result).map(
      (r) => ({
        sliceId: r.sliceId as WorkSliceId,
        workItemId: r.workItemId as WorkItemId,
      }),
    );
  }

  /** The old listener emitted these fixed options on process failure. Lock the aggregate before
   * clearing its prompt, following the same lock order as human answers and manual retries. */
  public async lockInterruptedDevicePrompts(batchLimit: number) {
    const result = await this.db.execute(sql`
      SELECT wi.id AS "workItemId", s.id AS "sliceId"
      FROM work_items wi
      JOIN work_slices s ON s.id = wi.attention_json->>'sliceId' AND s.work_item_id = wi.id
      JOIN workspaces w ON w.id = wi.workspace_id
      JOIN agents a ON a.id = s.assigned_agent_id
      WHERE wi.stage = 'awaiting_answer'
        AND wi.attention_json->>'question' LIKE '设备执行失败：Agent CLI 退出（null）：%'
        AND wi.attention_json->'options' = '["已处理设备或工作区问题，重试", "补充说明后继续"]'::jsonb
        AND wi.attention_json->>'answeredChoice' IS NULL AND wi.attention_json->>'answeredAtMs' IS NULL
        AND s.status = 'waiting' AND s.lease_version > 0
        AND s.attempt_count > 0 AND s.attempt_count < ${MAX_SLICE_ATTEMPTS}
        AND s.lease_owner_agent_id = s.assigned_agent_id AND s.assigned_agent_id = wi.attention_json->>'askedByAgentId'
        AND ${this.workExecutionAllowed(sql`a.id`, sql`a.owner_user_id`)}
        AND (s.lease_role <> 'write' OR w.sandbox_mode <> 'read_only')
        AND (s.lease_role <> 'verify' OR NOT EXISTS (
          SELECT 1 FROM work_slices writer WHERE writer.work_item_id = wi.id
            AND writer.lease_role <> 'verify' AND writer.status <> 'ready'
        ))
      ORDER BY wi.updated_at, wi.id LIMIT ${Math.max(1, Math.min(100, Math.trunc(batchLimit)))}
      FOR UPDATE OF wi SKIP LOCKED
    `);
    return extractSqlRows<{ workItemId: WorkItemId; sliceId: WorkSliceId }>(result);
  }

  public async listReviewPatchDigests(workItemId: WorkItemId): Promise<Map<WorkSliceId, string>> {
    const result = await this.db.execute(sql`
      SELECT s.id AS "sliceId", encode(sha256(convert_to(e.patch, 'UTF8')), 'hex') AS digest
      FROM work_slices s
      JOIN work_review_evidence e ON e.slice_id = s.id AND e.lease_version = s.lease_version
      WHERE s.work_item_id = ${workItemId} AND s.lease_role <> 'verify' AND s.status = 'ready'
    `);
    const rows = extractSqlRows<{ sliceId: WorkSliceId; digest: string }>(result);
    return new Map(rows.map((r) => [r.sliceId, r.digest]));
  }

  public async findReviewEvidence(
    sliceId: WorkSliceId,
    leaseVersion: number,
  ): Promise<string | undefined> {
    const [row] = await this.db
      .select({ patch: workReviewEvidenceTable.patch })
      .from(workReviewEvidenceTable)
      .where(
        and(
          eq(workReviewEvidenceTable.sliceId, sliceId),
          eq(workReviewEvidenceTable.leaseVersion, leaseVersion),
        ),
      );
    return row?.patch;
  }

  /** Caller holds the work-item row lock and validated the slice and current lease. */
  public async storeReviewEvidence(
    sliceId: WorkSliceId,
    leaseVersion: number,
    patch: string,
  ): Promise<void> {
    await this.db
      .insert(workReviewEvidenceTable)
      .values({ sliceId, leaseVersion, patch })
      .onConflictDoUpdate({
        target: workReviewEvidenceTable.sliceId,
        set: { leaseVersion, patch },
      });
  }

  public async findHydratedWorkItemByOwnerOpKey(
    ownerUserId: UserId,
    opKey: OperationKey,
  ): Promise<HydratedWorkItemRecord | undefined> {
    const items = await this.queryHydratedWorkItems(
      sql`wi.owner_user_id = ${ownerUserId} AND wi.op_key = ${opKey}`,
      1,
    );
    return items[0];
  }

  public async findHydratedWorkItemById(
    workItemId: WorkItemId,
  ): Promise<HydratedWorkItemRecord | undefined> {
    const items = await this.queryHydratedWorkItems(sql`wi.id = ${workItemId}`, 1);
    return items[0];
  }

  public async listHydratedWorkItemsByRoom(
    roomId: RoomId,
    options?: WorkListOptions,
  ): Promise<readonly HydratedWorkItemRecord[]> {
    const base = sql`wi.room_id = ${roomId}`;
    return this.listFilteredWorkItems(base, options);
  }

  public async listHydratedWorkItemsByWorkspace(
    workspaceId: WorkspaceId,
    options?: WorkListOptions,
  ): Promise<readonly HydratedWorkItemRecord[]> {
    const base = sql`wi.workspace_id = ${workspaceId}`;
    return this.listFilteredWorkItems(base, options);
  }

  public async listHydratedWorkItemsVisibleToOwnerAndRooms(
    params: WorkListOptions & {
      readonly ownerUserId: UserId;
      readonly joinedRoomIds: readonly RoomId[];
    },
  ): Promise<readonly HydratedWorkItemRecord[]> {
    const visibilityExpr =
      params.joinedRoomIds.length > 0
        ? sql`(wi.owner_user_id = ${params.ownerUserId} OR wi.room_id IN (${sql.join(
            params.joinedRoomIds.map((id) => sql`${id}`),
            sql`, `,
          )}))`
        : sql`wi.owner_user_id = ${params.ownerUserId}`;

    return this.listFilteredWorkItems(visibilityExpr, params);
  }

  /** A small projection keeps inbox polling independent of the size of a work item's trace/diff. */
  public async listInboxWorkAssignments(
    agent: Extract<AuthenticatedCaller, { kind: "agent" }>,
  ): Promise<InboxWorkAssignment[]> {
    const data = await this.db.execute(sql`
      SELECT wi.id AS "workItemId", s.id AS "sliceId", wi.workspace_id AS "workspaceId",
             wi.room_id AS "roomId", s.title, s.lease_role AS "leaseRole", s.lease_version AS "leaseVersion"
      FROM work_slices s JOIN work_items wi ON wi.id = s.work_item_id
      JOIN workspaces w ON w.id = wi.workspace_id
      WHERE s.assigned_agent_id = ${agent.agentId} AND s.status = 'waiting'
        AND ${this.workVisibleToAgent(agent)} AND ${this.sliceReadyForStage()}
      ORDER BY wi.created_at ASC, wi.id ASC, s.order_index ASC LIMIT 20
    `);
    const rows = extractSqlRows<Omit<InboxWorkAssignment, "roomId"> & { roomId: RoomId | null }>(
      data,
    );
    return rows.map(({ roomId, ...row }) => ({ ...row, ...(roomId ? { roomId } : {}) }));
  }

  /** Only the original writer can recover evidence from its previously completed local worktree. */
  public async listReviewEvidenceRequests(agent: Extract<AuthenticatedCaller, { kind: "agent" }>) {
    const data = await this.db.execute(sql`
      SELECT wi.id AS "workItemId", s.id AS "sliceId"
      FROM work_items wi JOIN workspaces w ON w.id = wi.workspace_id
      JOIN work_slices s ON s.work_item_id = wi.id
      JOIN work_slices v ON v.work_item_id = wi.id AND v.id = (wi.attention_json->>'sliceId')
      WHERE wi.stage = 'awaiting_answer' AND wi.attention_json->>'answeredAtMs' IS NULL
        AND wi.owner_user_id = ${agent.ownerUserId} AND w.owner_user_id = ${agent.ownerUserId}
        AND w.host_mode = 'local_machine' AND w.sandbox_mode = 'worktree_pool'
        AND s.lease_role = 'write' AND s.status = 'ready' AND s.lease_version > 0
        AND s.assigned_agent_id = ${agent.agentId} AND s.lease_owner_agent_id = ${agent.agentId}
        AND v.lease_role = 'verify' AND v.status = 'waiting'
        AND v.lease_owner_agent_id = (wi.attention_json->>'askedByAgentId')
        AND (wi.room_id IS NULL OR EXISTS (SELECT 1 FROM room_members rm
          WHERE rm.room_id = wi.room_id AND rm.agent_id = ${agent.agentId}))
        AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.changed_files_json) files(path)
          WHERE (wi.attention_json->>'question') =
            ('设备执行失败：文件 ' || files.path || ' 的变更证据不完整，请在有完整工作树的设备上复核。'))
        AND NOT EXISTS (SELECT 1 FROM work_review_evidence e
          WHERE e.slice_id = s.id AND e.lease_version = s.lease_version)
      ORDER BY wi.updated_at ASC, s.id ASC LIMIT 20
    `);
    return [...extractSqlRows<{ workItemId: WorkItemId; sliceId: WorkSliceId }>(data)];
  }

  private workVisibleToAgent(agent: { agentId: AgentId; ownerUserId: UserId }) {
    return sql`wi.stage IN ('working', 'verifying')
      AND ${this.workExecutionAllowed(sql`${agent.agentId}`, sql`${agent.ownerUserId}`)}`;
  }

  private workExecutionAllowed(agentId: SQL, ownerUserId: SQL) {
    return sql`wi.tier <> 'chat_only'
      AND (wi.room_id IS NULL OR EXISTS (
        SELECT 1 FROM room_members rm WHERE rm.room_id = wi.room_id AND rm.agent_id = ${agentId}
      ))
      AND (w.owner_user_id = ${ownerUserId} OR (
        w.host_mode = 'shared_container' AND w.allow_room_collaborators
        AND wi.room_id IS NOT NULL AND wi.tier <> 'full_owner_delegate'
      ))`;
  }

  private sliceReadyForStage() {
    return sql`(s.lease_role = 'verify') = (wi.stage = 'verifying')
          AND (s.lease_role <> 'write' OR w.sandbox_mode <> 'read_only')
          AND s.attempt_count < ${MAX_SLICE_ATTEMPTS}`;
  }

  private listFilteredWorkItems(base: ReturnType<typeof sql>, options: WorkListOptions = {}) {
    const stage = options.stage ? sql`AND wi.stage = ${options.stage}` : sql``;
    const agent = options.claimableBy;
    if (!agent) return this.queryHydratedWorkItems(sql`${base} ${stage}`, options.limit);

    // Apply dispatch eligibility before LIMIT so other workers' newer tasks cannot hide this queue.
    const where = sql`${base} ${stage}
      AND ${this.workVisibleToAgent(agent)}
      AND EXISTS (
        SELECT 1 FROM work_slices s WHERE s.work_item_id = wi.id AND ${this.sliceReadyForStage()}
          AND (
            (s.assigned_agent_id = ${agent.agentId} AND s.status = 'waiting')
            OR (s.status IN ('running', 'verifying')
                AND s.lease_expires_at <= ${new Date(agent.nowMs).toISOString()}::timestamptz)
          )
      )`;
    return this.queryHydratedWorkItems(where, options.limit, sql`wi.created_at ASC, wi.id ASC`);
  }

  private async queryHydratedWorkItems(
    whereClause: ReturnType<typeof sql>,
    limit = 50,
    orderBy = sql`wi.updated_at DESC, wi.created_at DESC`,
  ): Promise<readonly HydratedWorkItemRecord[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const itemResult = await this.db.execute(sql`
      SELECT
        wi.id AS "id",
        wi.workspace_id AS "workspaceId",
        w.name AS "workspaceName",
        w.owner_user_id AS "workspaceOwnerUserId",
        w.host_mode AS "workspaceHostMode",
        w.sandbox_mode AS "workspaceSandboxMode",
        w.allow_room_collaborators AS "workspaceAllowRoomCollaborators",
        w.hooks_json AS "workspaceHooksJson",
        wi.owner_user_id AS "ownerUserId",
        wi.room_id AS "roomId",
        wi.anchor_message_seq AS "anchorMessageSeq",
        wi.title AS "title",
        wi.brief AS "brief",
        wi.topology AS "topology",
        wi.tier AS "tier",
        wi.stage AS "stage",
        wi.worktree_branch AS "worktreeBranch",
        wi.coordinator_agent_id AS "coordinatorAgentId",
        wi.primary_worker_agent_id AS "primaryWorkerAgentId",
        wi.verifier_agent_id AS "verifierAgentId",
        wi.attention_json AS "attentionJson",
        wi.review_json AS "reviewJson",
        wi.trace_json AS "traceJson",
        wi.diff_files_json AS "diffFilesJson",
        wi.agent_snapshots_json AS "agentSnapshotsJson",
        wi.version AS "version",
        wi.created_at AS "createdAt",
        wi.updated_at AS "updatedAt"
      FROM work_items wi
      JOIN workspaces w ON wi.workspace_id = w.id
      WHERE ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ${safeLimit}
    `);

    const itemRows = extractSqlRows<RawWorkItemJoinedRow>(itemResult);
    if (itemRows.length === 0) {
      return [];
    }

    const itemIdParams = sql.join(
      itemRows.map((r) => sql`${r.id}`),
      sql`, `,
    );
    const sliceResult = await this.db.execute(sql`
      SELECT
        id AS "id",
        work_item_id AS "workItemId",
        order_index AS "orderIndex",
        title AS "title",
        lease_role AS "leaseRole",
        assigned_agent_id AS "assignedAgentId",
        lease_owner_agent_id AS "leaseOwnerAgentId",
        lease_version AS "leaseVersion",
        lease_expires_at AS "leaseExpiresAt",
        attempt_count AS "attemptCount",
        owned_paths_json AS "ownedPathsJson",
        status AS "status",
        live_summary AS "liveSummary",
        diff_added AS "diffAdded",
        diff_removed AS "diffRemoved",
        changed_files_json AS "changedFilesJson",
        worktree_branch AS "worktreeBranch",
        steer_notes_json AS "steerNotesJson",
        failure_code AS "failureCode",
        provenance_json AS "provenanceJson",
        started_at AS "startedAt",
        completed_at AS "completedAt"
      FROM work_slices
      WHERE work_item_id IN (${itemIdParams})
      ORDER BY order_index ASC
    `);

    const slicesByItemId = new Map<string, OrchestrationSliceState[]>();
    const allReferencedAgentIds = new Set<AgentId>();

    for (const rawSlice of extractSqlRows<
      Parameters<typeof parseRawSliceRow>[0] & { readonly workItemId: string }
    >(sliceResult)) {
      const parsedSlice = parseRawSliceRow(rawSlice);
      allReferencedAgentIds.add(parsedSlice.assignedAgentId);
      const bucket = slicesByItemId.get(rawSlice.workItemId);
      if (bucket) {
        bucket.push(parsedSlice);
      } else {
        slicesByItemId.set(rawSlice.workItemId, [parsedSlice]);
      }
    }

    for (const row of itemRows) {
      allReferencedAgentIds.add(row.primaryWorkerAgentId as AgentId);
      if (row.coordinatorAgentId !== null) {
        allReferencedAgentIds.add(row.coordinatorAgentId as AgentId);
      }
      if (row.verifierAgentId !== null) {
        allReferencedAgentIds.add(row.verifierAgentId as AgentId);
      }
    }

    const liveAgentMap = await this.findAgentSnapshotsByIds([...allReferencedAgentIds]);

    return itemRows.map((row) => {
      const meta = parseWorkItemMetaFields(row);
      const hooksParsed = WorkspaceLifecycleHooksSchema.safeParse(
        parseJsonValue(row.workspaceHooksJson),
      );
      const storedSnapshots = parseStoredAgentSnapshots(row.agentSnapshotsJson);
      for (const [agentId, liveSnap] of liveAgentMap.entries()) {
        storedSnapshots[agentId] = liveSnap;
      }

      const attention = parseStoredAttention(row.attentionJson);
      const review = parseStoredReview(row.reviewJson);
      const trace = parseStoredTraceEntries(row.traceJson);
      const diffFiles = parseStoredDiffFiles(row.diffFilesJson);

      return {
        id: row.id as WorkItemId,
        workspaceId: row.workspaceId as WorkspaceId,
        workspaceName: row.workspaceName,
        workspaceOwnerUserId: row.workspaceOwnerUserId as UserId,
        workspaceHostMode: WorkspaceHostModeSchema.parse(row.workspaceHostMode),
        workspaceSandboxMode: WorkspaceSandboxModeSchema.parse(row.workspaceSandboxMode),
        workspaceAllowRoomCollaborators: Boolean(row.workspaceAllowRoomCollaborators),
        ...(hooksParsed.success && hooksParsed.data.verifyCommand !== undefined
          ? { workspaceVerifyCommand: hooksParsed.data.verifyCommand }
          : {}),
        ownerUserId: row.ownerUserId as UserId,
        ...(row.roomId !== null ? { roomId: row.roomId as RoomId } : {}),
        anchorMessageSeq: Number(row.anchorMessageSeq),
        title: row.title,
        brief: row.brief,
        topology: meta.topology,
        tier: meta.tier,
        stage: meta.stage,
        worktreeBranch: row.worktreeBranch,
        ...(row.coordinatorAgentId !== null
          ? { coordinatorAgentId: row.coordinatorAgentId as AgentId }
          : {}),
        primaryWorkerAgentId: row.primaryWorkerAgentId as AgentId,
        ...(row.verifierAgentId !== null
          ? { verifierAgentId: row.verifierAgentId as AgentId }
          : {}),
        slices: slicesByItemId.get(row.id) ?? [],
        ...(attention !== undefined ? { attention } : {}),
        ...(review !== undefined ? { review } : {}),
        trace,
        diffFiles,
        agentSnapshots: storedSnapshots,
        version: Number(row.version),
        createdAt: toDate(row.createdAt),
        updatedAt: toDate(row.updatedAt),
      };
    });
  }
}
