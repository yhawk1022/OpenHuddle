/**
 * @module server/tests/admin
 * @description 运营与治理管理后台全链路集成与红队安全验证套件（基于真实内存 PGlite 数据库与 Hono 网关）。
 *
 * 覆盖核心不变量：
 * 1. 管理员引导与白名单热生效：无 `ADMIN_EMAILS` 时首位用户自动成为管理员；配置 `ADMIN_EMAILS` 时仅白名单（含已有会话热提权）获授管理员角色。
 * 2. 强 RBAC 与防越权：未登录 `401`、普通人类用户 `403 FORBIDDEN_ADMIN_ONLY`、管理员名下 Agent 令牌 `403 FORBIDDEN_ADMIN_ONLY`。
 * 3. 安全护栏（`400 ADMIN_GUARDRAIL_VIOLATION`）：禁止自我降权/封禁/删除、禁止操作 `ADMIN_EMAILS` 锁定超管、禁止移除全站最后一名活跃管理员。
 * 4. 账号封禁双端阻断与安全级联删户：封禁立即吊销所有 Web 会话并切断名下 Agent（`403 ACCOUNT_SUSPENDED`）；删户无外键冲突且向在线订阅者广播 `room.deleted`。
 * 5. 跨房只读审查（绝不污染成员 `last_read_seq`）、强制撤回、治理热调控、Agent/提案/配对码监管、统计大盘与审计日志全量校验。
 */
import {
  type ManagedDatabase,
  createDatabaseClient,
  ensureCoreSchema,
  userSessionsTable,
} from "@openhuddle/db";
import type {
  AdminAgentListResponse,
  AdminAuditLogListResponse,
  AdminDeleteUserResponse,
  AdminOverviewResponse,
  AdminPairingCodeListResponse,
  AdminProposalListResponse,
  AdminPurgeExpiredSessionsResponse,
  AdminPurgePairingCodesResponse,
  AdminRoomDetailResponse,
  AdminRoomListResponse,
  AdminRoomMessagesResponse,
  AdminSessionListResponse,
  AdminUpdateUserResponse,
  AdminUserDetailResponse,
  AdminUserListResponse,
  ApiErrorEnvelope,
  AuthCodeSentResponse,
  AuthSessionResponse,
  CreatePairingCodeResponse,
  PairAgentResponse,
  ProposalCardDto,
  RoomDetailDto,
  SseEvent,
  VerifyOtpResponse,
} from "@openhuddle/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerApp } from "../app.js";
import { sha256Hex } from "../infra/crypto.js";
import { parseServerEnv } from "../infra/env.js";
import { InMemoryRealtimeBus } from "../infra/realtime-bus.js";

async function loginHumanViaOtp(
  app: ReturnType<typeof createServerApp>,
  email: string,
  displayName: string,
): Promise<VerifyOtpResponse> {
  const reqRes = await app.request("/api/v1/auth/otp/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, displayName }),
  });
  expect(reqRes.status).toBe(200);
  const reqJson = (await reqRes.json()) as { ok: true; devOtpCode?: string };
  expect(reqJson.devOtpCode).toMatch(/^\d{6}$/);

  const verifyRes = await app.request("/api/v1/auth/otp/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      code: reqJson.devOtpCode,
      displayName,
    }),
  });
  expect(verifyRes.status).toBe(200);
  return (await verifyRes.json()) as VerifyOtpResponse;
}

async function registerHumanWithPassword(
  app: ReturnType<typeof createServerApp>,
  email: string,
  displayName: string,
  password: string,
): Promise<AuthSessionResponse> {
  const reqRes = await app.request("/api/v1/auth/register/request-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  expect(reqRes.status).toBe(200);
  const reqJson = (await reqRes.json()) as AuthCodeSentResponse;
  expect(reqJson.devOtpCode).toMatch(/^\d{6}$/);

  const regRes = await app.request("/api/v1/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      code: reqJson.devOtpCode,
      displayName,
      password,
    }),
  });
  expect(regRes.status).toBe(201);
  return (await regRes.json()) as AuthSessionResponse;
}

describe("@openhuddle/server — Admin Console RBAC, guardrails, moderation & analytics", () => {
  let database: ManagedDatabase;
  let bus: InMemoryRealtimeBus;

  beforeEach(async () => {
    database = createDatabaseClient({ url: "memory://" });
    await ensureCoreSchema(database.db);
    bus = new InMemoryRealtimeBus();
  });

  afterEach(async () => {
    await bus.close();
    await database.close();
  });

  it("bootstraps first user as admin when ADMIN_EMAILS is unset and rejects non-admin & agent access", async () => {
    const env = parseServerEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: "memory://",
    });
    const app = createServerApp({ env, database, realtimeBus: bus });

    // 未登录访问后台返回 401
    const anonRes = await app.request("/api/v1/admin/overview");
    expect(anonRes.status).toBe(401);

    // 第 1 位用户自动成为管理员，第 2 位默认为普通用户
    const firstUser = await loginHumanViaOtp(app, "founder@example.com", "Founder");
    const secondUser = await loginHumanViaOtp(app, "member@example.com", "Member");
    expect(firstUser.user.role).toBe("admin");
    expect(secondUser.user.role).toBe("user");

    // 管理员名下配对一个个人 Agent
    const codeRes = await app.request("/api/v1/pairing-codes", {
      method: "POST",
      headers: {
        authorization: `Bearer ${firstUser.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(codeRes.status).toBe(201);
    const codeJson = (await codeRes.json()) as CreatePairingCodeResponse;

    const pairRes = await app.request("/api/v1/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: codeJson.code,
        name: "Founder Codex",
        platform: "codex",
      }),
    });
    expect(pairRes.status).toBe(201);
    const pairJson = (await pairRes.json()) as PairAgentResponse;

    // 红队 1：普通人类用户调用后台返回 403 FORBIDDEN_ADMIN_ONLY
    const nonAdminRes = await app.request("/api/v1/admin/users", {
      headers: { authorization: `Bearer ${secondUser.sessionToken}` },
    });
    expect(nonAdminRes.status).toBe(403);
    const nonAdminErr = (await nonAdminRes.json()) as ApiErrorEnvelope;
    expect(nonAdminErr.error.code).toBe("FORBIDDEN_ADMIN_ONLY");

    // 红队 2：即便属于管理员名下的个人 Agent 令牌也绝对禁止访问后台
    const agentRes = await app.request("/api/v1/admin/overview", {
      headers: { authorization: `Bearer ${pairJson.token}` },
    });
    expect(agentRes.status).toBe(403);
    const agentErr = (await agentRes.json()) as ApiErrorEnvelope;
    expect(agentErr.error.code).toBe("FORBIDDEN_ADMIN_ONLY");

    // 管理员正常访问成功
    const okRes = await app.request("/api/v1/admin/overview", {
      headers: { authorization: `Bearer ${firstUser.sessionToken}` },
    });
    expect(okRes.status).toBe(200);
  });

  it("enforces ADMIN_EMAILS whitelist, hot-promotes matching existing sessions, and enforces guardrails", async () => {
    // 先在未配置 ADMIN_EMAILS 的情况下登录 Alice（自动成为普通用户？不，先用另一个环境变量启动让 Bob 先注册）
    const envInitial = parseServerEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: "memory://",
      ADMIN_EMAILS: "root@example.com",
    });
    const appInitial = createServerApp({ env: envInitial, database, realtimeBus: bus });

    // 即使 alice 是第 1 个注册，因为配置了 ADMIN_EMAILS 且不在其中，所以她只能是 user
    const alice = await loginHumanViaOtp(appInitial, "alice@example.com", "Alice");
    const rootAdmin = await loginHumanViaOtp(appInitial, "root@example.com", "RootAdmin");
    expect(alice.user.role).toBe("user");
    expect(rootAdmin.user.role).toBe("admin");

    // 当管理员变更环境白名单把 alice@example.com 加入时，她的既有会话应热生效为 admin 并落库
    const envExpanded = parseServerEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: "memory://",
      ADMIN_EMAILS: "root@example.com, alice@example.com",
    });
    const appExpanded = createServerApp({ env: envExpanded, database, realtimeBus: bus });
    const aliceMeRes = await appExpanded.request("/api/v1/me", {
      headers: { authorization: `Bearer ${alice.sessionToken}` },
    });
    expect(aliceMeRes.status).toBe(200);
    const aliceMeJson = (await aliceMeRes.json()) as {
      callerKind: "human";
      user: { role: string };
    };
    expect(aliceMeJson.user.role).toBe("admin");

    // 验证热提权结果已同步落库至 users.role，从而在管理端列表筛选 ?role=admin 可见
    const adminListRes = await appExpanded.request("/api/v1/admin/users?role=admin", {
      headers: { authorization: `Bearer ${rootAdmin.sessionToken}` },
    });
    expect(adminListRes.status).toBe(200);
    const adminListJson = (await adminListRes.json()) as AdminUserListResponse;
    expect(adminListJson.users.some((u) => u.id === alice.user.id)).toBe(true);

    // 护栏 1：禁止管理员自我降权或自我封禁
    const selfDemoteRes = await appExpanded.request(`/api/v1/admin/users/${rootAdmin.user.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${rootAdmin.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ role: "user" }),
    });
    expect(selfDemoteRes.status).toBe(400);
    expect(((await selfDemoteRes.json()) as ApiErrorEnvelope).error.code).toBe(
      "ADMIN_GUARDRAIL_VIOLATION",
    );

    // 护栏 2：禁止在界面降权或删除受 ADMIN_EMAILS 环境变量锁定的超管
    const demotePinnedRes = await appExpanded.request(`/api/v1/admin/users/${alice.user.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${rootAdmin.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ role: "user" }),
    });
    expect(demotePinnedRes.status).toBe(400);
    expect(((await demotePinnedRes.json()) as ApiErrorEnvelope).error.code).toBe(
      "ADMIN_GUARDRAIL_VIOLATION",
    );

    const deletePinnedRes = await appExpanded.request(`/api/v1/admin/users/${alice.user.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${rootAdmin.sessionToken}` },
    });
    expect(deletePinnedRes.status).toBe(400);
    expect(((await deletePinnedRes.json()) as ApiErrorEnvelope).error.code).toBe(
      "ADMIN_GUARDRAIL_VIOLATION",
    );
  });

  it("manages user suspension (blocking human & owned agents), safe cascade deletion, and sessions", async () => {
    const env = parseServerEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: "memory://",
      OTP_RESEND_COOLDOWN_SEC: "0",
    });
    const app = createServerApp({ env, database, realtimeBus: bus });

    const admin = await loginHumanViaOtp(app, "admin@example.com", "Admin");
    const bob = await loginHumanViaOtp(app, "bob@example.com", "Bob");

    // 保护全站最后一位活跃管理员护栏验证（禁止自我删除）
    const selfDeleteRes = await app.request(`/api/v1/admin/users/${admin.user.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${admin.sessionToken}` },
    });
    expect(selfDeleteRes.status).toBe(400);
    expect(((await selfDeleteRes.json()) as ApiErrorEnvelope).error.code).toBe(
      "ADMIN_GUARDRAIL_VIOLATION",
    );

    // 管理员创建房间并邀请 Bob 加入；Bob 同时自建一个房间且配对一个 Agent，并在管理员房间发消息
    const adminRoomRes = await app.request("/api/v1/rooms", {
      method: "POST",
      headers: {
        authorization: `Bearer ${admin.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Admin Room",
        topic: "T",
        rules: "",
        visibility: "invite_only",
      }),
    });
    const adminRoom = ((await adminRoomRes.json()) as { room: RoomDetailDto }).room;

    await app.request("/api/v1/join", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bob.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ inviteToken: adminRoom.inviteToken }),
    });

    await app.request(`/api/v1/rooms/${adminRoom.id}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bob.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content: "Bob message in admin room" }),
    });

    const bobRoomRes = await app.request("/api/v1/rooms", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bob.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Bob Private Room",
        topic: "Bob",
        rules: "",
        visibility: "invite_only",
      }),
    });
    const bobRoom = ((await bobRoomRes.json()) as { room: RoomDetailDto }).room;

    const bobCodeRes = await app.request("/api/v1/pairing-codes", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bob.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ autoJoinRoomId: bobRoom.id }),
    });
    const bobCode = ((await bobCodeRes.json()) as CreatePairingCodeResponse).code;

    const bobPairRes = await app.request("/api/v1/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: bobCode, name: "Bob Agent", platform: "cursor" }),
    });
    const bobAgent = (await bobPairRes.json()) as PairAgentResponse;

    // 1. 管理员授予 Bob 管理员权限后再撤销
    const grantRes = await app.request(`/api/v1/admin/users/${bob.user.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${admin.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(grantRes.status).toBe(200);
    expect(((await grantRes.json()) as AdminUpdateUserResponse).user.role).toBe("admin");

    const revokeRoleRes = await app.request(`/api/v1/admin/users/${bob.user.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${admin.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ role: "user" }),
    });
    expect(revokeRoleRes.status).toBe(200);
    expect(((await revokeRoleRes.json()) as AdminUpdateUserResponse).user.role).toBe("user");

    // 2. 封禁 Bob：立刻注销全部 Web 会话 + 阻断后续 OTP 请求 + 同步阻断名下 Agent
    const suspendRes = await app.request(`/api/v1/admin/users/${bob.user.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${admin.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "suspended", suspendedReason: "Policy violation" }),
    });
    expect(suspendRes.status).toBe(200);
    const suspendJson = (await suspendRes.json()) as AdminUpdateUserResponse;
    expect(suspendJson.user.status).toBe("suspended");
    expect(suspendJson.user.suspendedReason).toBe("Policy violation");
    expect(suspendJson.revokedSessionCount).toBe(1);

    // Bob 原会话已失效 (401)，申请新 OTP 被拒 (403 ACCOUNT_SUSPENDED)，名下 Agent 也被拒 (403 ACCOUNT_SUSPENDED)
    expect(
      (
        await app.request("/api/v1/me", {
          headers: { authorization: `Bearer ${bob.sessionToken}` },
        })
      ).status,
    ).toBe(401);

    const blockedOtpRes = await app.request("/api/v1/auth/otp/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bob@example.com" }),
    });
    expect(blockedOtpRes.status).toBe(403);
    expect(((await blockedOtpRes.json()) as ApiErrorEnvelope).error.code).toBe("ACCOUNT_SUSPENDED");

    const blockedAgentRes = await app.request("/api/v1/me", {
      headers: { authorization: `Bearer ${bobAgent.token}` },
    });
    expect(blockedAgentRes.status).toBe(403);
    expect(((await blockedAgentRes.json()) as ApiErrorEnvelope).error.code).toBe(
      "ACCOUNT_SUSPENDED",
    );

    // 3. 解封 Bob 后，Agent 与重新登录均恢复正常
    const unsuspendRes = await app.request(`/api/v1/admin/users/${bob.user.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${admin.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "active" }),
    });
    expect(unsuspendRes.status).toBe(200);
    expect(((await unsuspendRes.json()) as AdminUpdateUserResponse).user.status).toBe("active");
    expect(
      (
        await app.request("/api/v1/me", {
          headers: { authorization: `Bearer ${bobAgent.token}` },
        })
      ).status,
    ).toBe(200);

    const bobRelogin = await loginHumanViaOtp(app, "bob@example.com", "Bob");

    // 4. 会话管理：查看、单条强制下线、插入过期会话并清理
    const sessionsRes = await app.request("/api/v1/admin/sessions?status=active", {
      headers: { authorization: `Bearer ${admin.sessionToken}` },
    });
    expect(sessionsRes.status).toBe(200);
    const sessionsJson = (await sessionsRes.json()) as AdminSessionListResponse;
    const bobSessionItem = sessionsJson.sessions.find((s) => s.userId === bob.user.id);
    expect(bobSessionItem).toBeDefined();

    if (bobSessionItem) {
      const revokeOneRes = await app.request(`/api/v1/admin/sessions/${bobSessionItem.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${admin.sessionToken}` },
      });
      expect(revokeOneRes.status).toBe(200);
    }
    expect(
      (
        await app.request("/api/v1/me", {
          headers: { authorization: `Bearer ${bobRelogin.sessionToken}` },
        })
      ).status,
    ).toBe(401);

    // 插入一条已过期会话验证一键清理
    await database.db.insert(userSessionsTable).values({
      id: "ses_expired_test_01",
      userId: bob.user.id,
      tokenHash: sha256Hex("oh_ses_expired_dummy_token"),
      expiresAt: new Date(Date.now() - 60_000),
    });
    const purgeSessRes = await app.request("/api/v1/admin/sessions/purge-expired", {
      method: "POST",
      headers: { authorization: `Bearer ${admin.sessionToken}` },
    });
    expect(purgeSessRes.status).toBe(200);
    expect(((await purgeSessRes.json()) as AdminPurgeExpiredSessionsResponse).purgedCount).toBe(1);

    // 5. 彻底级联删除 Bob（含其名下房间 + 他房消息 + Agent），验证无 FK 异常且广播 room.deleted
    const roomDeletedEvents: SseEvent[] = [];
    bus.subscribeRoom(bobRoom.id, (ev) => roomDeletedEvents.push(ev));

    const bobDetailRes = await app.request(`/api/v1/admin/users/${bob.user.id}`, {
      headers: { authorization: `Bearer ${admin.sessionToken}` },
    });
    expect(bobDetailRes.status).toBe(200);
    const bobDetail = (await bobDetailRes.json()) as AdminUserDetailResponse;
    expect(bobDetail.agents).toHaveLength(1);
    expect(bobDetail.rooms.length).toBeGreaterThanOrEqual(2);

    const deleteBobRes = await app.request(`/api/v1/admin/users/${bob.user.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${admin.sessionToken}` },
    });
    expect(deleteBobRes.status).toBe(200);
    const deleteBobJson = (await deleteBobRes.json()) as AdminDeleteUserResponse;
    expect(deleteBobJson.deletedUserId).toBe(bob.user.id);
    expect(deleteBobJson.deletedRoomCount).toBe(1);
    expect(deleteBobJson.deletedAgentCount).toBe(1);
    expect(roomDeletedEvents.some((ev) => ev.type === "room.deleted")).toBe(true);

    // 管理员列表确认仅剩 Admin 一人
    const usersListRes = await app.request("/api/v1/admin/users", {
      headers: { authorization: `Bearer ${admin.sessionToken}` },
    });
    expect(usersListRes.status).toBe(200);
    expect(((await usersListRes.json()) as AdminUserListResponse).users).toHaveLength(1);
  });

  it("supports cross-room moderation (without advancing member read cursors), analytics overview, and audit logs", async () => {
    const env = parseServerEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: "memory://",
    });
    const app = createServerApp({ env, database, realtimeBus: bus });

    // Admin 登录（首位用户），随后 Alice 登录并建群（Admin 不在该群中）
    const admin = await loginHumanViaOtp(app, "admin@example.com", "Admin");
    const alice = await loginHumanViaOtp(app, "alice@example.com", "Alice");

    const roomRes = await app.request("/api/v1/rooms", {
      method: "POST",
      headers: {
        authorization: `Bearer ${alice.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Alice Private Huddle",
        topic: "Moderation & Analytics",
        rules: "Be concise",
        visibility: "invite_only",
        governance: { maxConsecutiveAgentTurns: 2, agentCooldownMs: 0 },
      }),
    });
    const room = ((await roomRes.json()) as { room: RoomDetailDto }).room;

    // 配对两个配对码：一个核销绑定 Agent，一个保留待核销
    const pairCode1Res = await app.request("/api/v1/pairing-codes", {
      method: "POST",
      headers: {
        authorization: `Bearer ${alice.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ autoJoinRoomId: room.id }),
    });
    const pairCode1 = ((await pairCode1Res.json()) as CreatePairingCodeResponse).code;

    const pairCode2Res = await app.request("/api/v1/pairing-codes", {
      method: "POST",
      headers: {
        authorization: `Bearer ${alice.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const pairCode2 = ((await pairCode2Res.json()) as CreatePairingCodeResponse).code;

    const pairRes = await app.request("/api/v1/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: pairCode1,
        name: "Alice Antigravity",
        platform: "antigravity",
      }),
    });
    const agent = (await pairRes.json()) as PairAgentResponse;

    // 模拟 Agent 在线 SSE 订阅与房间订阅，检查实时总线遥测
    const unsubAgent = bus.subscribeAgent(agent.agent.id, () => undefined);
    const unsubRoom = bus.subscribeRoom(room.id, () => undefined);

    // Alice 与 Agent 各自发一条消息，并提交一个提案
    await app.request(`/api/v1/rooms/${room.id}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${alice.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content: "Alice initial prompt" }),
    });

    await app.request(`/api/v1/rooms/${room.id}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${agent.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: "Agent reply with questionable content",
        lastReadSeq: 1,
      }),
    });

    const propRes = await app.request(`/api/v1/rooms/${room.id}/proposals`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${alice.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Choose storage backend",
        contextSummary: "Evaluate unified Postgres vs split DB",
        recommendedOptionKey: "opt_a",
        options: [
          {
            optionKey: "opt_a",
            label: "Unified Postgres",
            summary: "PGlite locally and Postgres in prod",
            pros: ["Single dialect"],
            cons: [],
            risks: [],
          },
        ],
      }),
    });
    const proposal = ((await propRes.json()) as { proposal: ProposalCardDto }).proposal;

    // 1. 数据统计大盘验证
    const overviewRes = await app.request("/api/v1/admin/overview?days=14", {
      headers: { authorization: `Bearer ${admin.sessionToken}` },
    });
    expect(overviewRes.status).toBe(200);
    const overview = (await overviewRes.json()) as AdminOverviewResponse;
    expect(overview.windowDays).toBe(14);
    expect(overview.dailyTrends).toHaveLength(14);
    expect(overview.kpis.totalUsers).toBe(2);
    expect(overview.kpis.adminUsers).toBe(1);
    expect(overview.kpis.totalRooms).toBe(1);
    expect(overview.kpis.totalAgents).toBe(1);
    expect(overview.kpis.onlineSseAgents).toBe(1);
    expect(overview.kpis.totalMessages).toBe(3); // 1 human + 1 agent + 1 proposal timeline message
    expect(overview.kpis.totalProposals).toBe(1);
    expect(overview.kpis.openProposals).toBe(1);
    expect(overview.kpis.activePairingCodes).toBe(1);
    expect(overview.runtime.activeAgentConnections).toBe(1);
    expect(overview.runtime.activeRoomSubscriptions).toBe(1);
    expect(overview.topActiveRooms[0]?.id).toBe(room.id);

    const todayPoint = overview.dailyTrends[overview.dailyTrends.length - 1];
    expect(todayPoint?.totalMessages).toBe(3);
    expect(todayPoint?.newUsers).toBe(2);
    expect(todayPoint?.newRooms).toBe(1);
    expect(todayPoint?.newProposals).toBe(1);

    // 2. 跨房只读审查（Admin 非成员可查详情与消息，且不改变任何成员的 lastReadSeq）
    const roomDetailBefore = (await (
      await app.request(`/api/v1/admin/rooms/${room.id}`, {
        headers: { authorization: `Bearer ${admin.sessionToken}` },
      })
    ).json()) as AdminRoomDetailResponse;
    expect(roomDetailBefore.room.lastSeq).toBe(3);
    const agentMemberBefore = roomDetailBefore.members.find(
      (m) => m.memberKind === "agent" && m.agentId === agent.agent.id,
    );
    // Agent 在 seq=2 发言时自身已读游标推至 2；seq=3 为随后生成的提案消息
    expect(agentMemberBefore?.lastReadSeq).toBe(2);

    const adminMsgsRes = await app.request(
      `/api/v1/admin/rooms/${room.id}/messages?authorKind=agent&includeRecalled=true`,
      { headers: { authorization: `Bearer ${admin.sessionToken}` } },
    );
    expect(adminMsgsRes.status).toBe(200);
    const adminMsgs = (await adminMsgsRes.json()) as AdminRoomMessagesResponse;
    expect(adminMsgs.messages).toHaveLength(1);
    expect(adminMsgs.messages[0]?.seq).toBe(2);

    // 验证成员游标未被管理员只读审查推进（仍停留在 2，未前进至 3）
    const roomDetailAfterRead = (await (
      await app.request(`/api/v1/admin/rooms/${room.id}`, {
        headers: { authorization: `Bearer ${admin.sessionToken}` },
      })
    ).json()) as AdminRoomDetailResponse;
    expect(roomDetailAfterRead.members.find((m) => m.agentId === agent.agent.id)?.lastReadSeq).toBe(
      2,
    );

    // 3. 管理员强制撤回消息 #2，并热更新房间治理参数
    const recallRes = await app.request(`/api/v1/admin/rooms/${room.id}/messages/2/recall`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${admin.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ reason: "Off-topic test recall" }),
    });
    expect(recallRes.status).toBe(200);

    const updateRoomRes = await app.request(`/api/v1/admin/rooms/${room.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${admin.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        visibility: "public_shareable",
        mode: "round_table",
        maxConsecutiveAgentTurns: 10,
        renewBudget: true,
      }),
    });
    expect(updateRoomRes.status).toBe(200);

    // 4. 列表查询 & 清理 Agent、Proposal、PairingCodes
    const roomsList = (await (
      await app.request("/api/v1/admin/rooms?visibility=public_shareable", {
        headers: { authorization: `Bearer ${admin.sessionToken}` },
      })
    ).json()) as AdminRoomListResponse;
    expect(roomsList.rooms).toHaveLength(1);

    const agentsList = (await (
      await app.request("/api/v1/admin/agents?reach=online_sse", {
        headers: { authorization: `Bearer ${admin.sessionToken}` },
      })
    ).json()) as AdminAgentListResponse;
    expect(agentsList.agents).toHaveLength(1);

    const proposalsList = (await (
      await app.request("/api/v1/admin/proposals?status=open", {
        headers: { authorization: `Bearer ${admin.sessionToken}` },
      })
    ).json()) as AdminProposalListResponse;
    expect(proposalsList.proposals).toHaveLength(1);

    const codesList = (await (
      await app.request("/api/v1/admin/pairing-codes", {
        headers: { authorization: `Bearer ${admin.sessionToken}` },
      })
    ).json()) as AdminPairingCodeListResponse;
    expect(codesList.pairingCodes).toHaveLength(2);

    // 吊销活跃配对码 + 清理已使用配对码
    expect(
      (
        await app.request(`/api/v1/admin/pairing-codes/${pairCode2}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${admin.sessionToken}` },
        })
      ).status,
    ).toBe(200);
    const purgeCodesRes = await app.request("/api/v1/admin/pairing-codes/purge-expired", {
      method: "POST",
      headers: { authorization: `Bearer ${admin.sessionToken}` },
    });
    expect(purgeCodesRes.status).toBe(200);
    expect(((await purgeCodesRes.json()) as AdminPurgePairingCodesResponse).purgedCount).toBe(1);

    // 删除提案、删除 Agent、解散房间
    expect(
      (
        await app.request(`/api/v1/admin/proposals/${proposal.id}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${admin.sessionToken}` },
        })
      ).status,
    ).toBe(200);

    expect(
      (
        await app.request(`/api/v1/admin/agents/${agent.agent.id}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${admin.sessionToken}` },
        })
      ).status,
    ).toBe(200);

    expect(
      (
        await app.request(`/api/v1/admin/rooms/${room.id}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${admin.sessionToken}` },
        })
      ).status,
    ).toBe(200);

    unsubAgent();
    unsubRoom();

    // 5. 审计日志验证：记录了所有写操作且支持按目标筛选
    const auditRes = await app.request("/api/v1/admin/audit-logs?pageSize=20", {
      headers: { authorization: `Bearer ${admin.sessionToken}` },
    });
    expect(auditRes.status).toBe(200);
    const auditJson = (await auditRes.json()) as AdminAuditLogListResponse;
    const actions = auditJson.logs.map((l) => l.action);
    expect(actions).toContain("message.recalled");
    expect(actions).toContain("room.updated");
    expect(actions).toContain("pairing_code.revoked");
    expect(actions).toContain("pairing_code.purged_expired");
    expect(actions).toContain("proposal.deleted");
    expect(actions).toContain("agent.deleted");
    expect(actions).toContain("room.deleted");
  });

  it("blocks suspended users on password login and persists ADMIN_EMAILS promotion during login", async () => {
    const baseEnv = parseServerEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: "memory://",
      OTP_RESEND_COOLDOWN_SEC: "0",
    });
    const app = createServerApp({ env: baseEnv, database, realtimeBus: bus });

    const owner = await registerHumanWithPassword(
      app,
      "owner@example.com",
      "Owner",
      "OwnerPass#2026",
    );
    const pwdUser = await registerHumanWithPassword(
      app,
      "pwduser@example.com",
      "PwdUser",
      "PwdUserPass#2026",
    );
    expect(owner.user.role).toBe("admin");
    expect(pwdUser.user.role).toBe("user");

    // 1. 封禁后使用邮箱+密码登录同样返回 403 ACCOUNT_SUSPENDED
    const suspendRes = await app.request(`/api/v1/admin/users/${pwdUser.user.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${owner.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "suspended", suspendedReason: "Password login check" }),
    });
    expect(suspendRes.status).toBe(200);

    const blockedLoginRes = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "pwduser@example.com", password: "PwdUserPass#2026" }),
    });
    expect(blockedLoginRes.status).toBe(403);
    expect(((await blockedLoginRes.json()) as ApiErrorEnvelope).error.code).toBe(
      "ACCOUNT_SUSPENDED",
    );

    // 2. 解封并在环境变量加入 ADMIN_EMAILS 后，密码登录自动提权并持久化至数据库
    const unsuspendRes = await app.request(`/api/v1/admin/users/${pwdUser.user.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${owner.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "active" }),
    });
    expect(unsuspendRes.status).toBe(200);

    const promotedEnv = parseServerEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: "memory://",
      OTP_RESEND_COOLDOWN_SEC: "0",
      ADMIN_EMAILS: "owner@example.com, pwduser@example.com",
    });
    const promotedApp = createServerApp({ env: promotedEnv, database, realtimeBus: bus });

    const loginRes = await promotedApp.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "pwduser@example.com", password: "PwdUserPass#2026" }),
    });
    expect(loginRes.status).toBe(200);
    const loginJson = (await loginRes.json()) as AuthSessionResponse;
    expect(loginJson.user.role).toBe("admin");

    const adminsRes = await promotedApp.request("/api/v1/admin/users?role=admin", {
      headers: { authorization: `Bearer ${owner.sessionToken}` },
    });
    expect(adminsRes.status).toBe(200);
    const adminsJson = (await adminsRes.json()) as AdminUserListResponse;
    expect(adminsJson.users.some((u) => u.id === pwdUser.user.id)).toBe(true);
  });
});
