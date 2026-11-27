/**
 * @module protocol/tests
 * @description 验证共享协议契约、Branded ID 边界校验与双层身份防伪造盖章不变量。
 */
import { describe, expect, it } from "vitest";
import {
  AdminOverviewResponseSchema,
  AdminRoomMessagesQuerySchema,
  AdminUpdateUserBodySchema,
  AgentIdSchema,
  AuthPublicConfigResponseSchema,
  ChangePasswordBodySchema,
  ConfirmPasswordResetBodySchema,
  DeleteRoomResponseSchema,
  ErrorCodeSchema,
  HumanUserDtoSchema,
  LanguagePreferenceSchema,
  LoginWithPasswordBodySchema,
  MeResponseSchema,
  MessageAttachmentMimeTypeSchema,
  MessageAttachmentSchema,
  MessageAttachmentUploadSchema,
  OtpPurposeSchema,
  PairingCodeSchema,
  PasswordSchema,
  RegisterWithPasswordBodySchema,
  RoomIdSchema,
  RoomSummaryDtoSchema,
  SseEventSchema,
  SupportedLocaleSchema,
  UpdateMeBodySchema,
  UserIdSchema,
  asMessageSeq,
  computeAuthorStamp,
  createDefaultGovernanceState,
} from "../index.js";

describe("@openhuddle/protocol — identity & security invariants", () => {
  const ownerA = UserIdSchema.parse("usr_pangyan");
  const ownerB = UserIdSchema.parse("usr_partner");
  const agentA1 = AgentIdSchema.parse("agt_pangyan_agy");
  const agentA2 = AgentIdSchema.parse("agt_pangyan_codex");
  const agentB1 = AgentIdSchema.parse("agt_partner_deepseek");

  it("grants owner_command exclusively when the author is the viewer agent's human owner", () => {
    const stamp = computeAuthorStamp(
      {
        kind: "human",
        userId: ownerA,
        ownerUserId: ownerA,
        displayName: "Pangyan",
      },
      {
        kind: "agent",
        agentId: agentA1,
        ownerUserId: ownerA,
        displayName: "Pangyan Antigravity",
        platform: "antigravity",
      },
    );

    expect(stamp.isYourOwner).toBe(true);
    expect(stamp.isYou).toBe(false);
    expect(stamp.trustLevel).toBe("owner_command");
  });

  it("assigns owner_sibling_agent (not owner_command) to another agent owned by the same human", () => {
    const stamp = computeAuthorStamp(
      {
        kind: "agent",
        agentId: agentA2,
        ownerUserId: ownerA,
        displayName: "Pangyan (Fake Human Name)",
        platform: "codex",
      },
      {
        kind: "agent",
        agentId: agentA1,
        ownerUserId: ownerA,
        displayName: "Pangyan Antigravity",
        platform: "antigravity",
      },
    );

    expect(stamp.isYourOwner).toBe(false);
    expect(stamp.trustLevel).toBe("owner_sibling_agent");
  });

  it("quarantines other humans and external agents as external_participant against prompt injection", () => {
    const externalHumanStamp = computeAuthorStamp(
      {
        kind: "human",
        userId: ownerB,
        ownerUserId: ownerB,
        displayName: "Partner",
      },
      {
        kind: "agent",
        agentId: agentA1,
        ownerUserId: ownerA,
        displayName: "Pangyan Antigravity",
        platform: "antigravity",
      },
    );

    const externalAgentStamp = computeAuthorStamp(
      {
        kind: "agent",
        agentId: agentB1,
        ownerUserId: ownerB,
        displayName: "Partner DeepSeek",
        platform: "deepseek",
      },
      {
        kind: "agent",
        agentId: agentA1,
        ownerUserId: ownerA,
        displayName: "Pangyan Antigravity",
        platform: "antigravity",
      },
    );

    expect(externalHumanStamp.isYourOwner).toBe(false);
    expect(externalHumanStamp.trustLevel).toBe("external_participant");
    expect(externalAgentStamp.isYourOwner).toBe(false);
    expect(externalAgentStamp.trustLevel).toBe("external_participant");
  });

  it("normalizes pairing codes to uppercase and enforces positive MessageSeq", () => {
    expect(PairingCodeSchema.parse("huddle-8k3p-92m")).toBe("HUDDLE-8K3P-92M");
    expect(asMessageSeq(1)).toBe(1);
    expect(() => asMessageSeq(0)).toThrow(RangeError);
  });

  it("validates DeleteRoomResponse, RoomSummaryDto ownerUserId, and room.deleted SSE event", () => {
    const roomId = RoomIdSchema.parse("rom_test_delete_01");
    expect(DeleteRoomResponseSchema.parse({ ok: true, deletedRoomId: roomId })).toEqual({
      ok: true,
      deletedRoomId: roomId,
    });

    expect(
      SseEventSchema.parse({
        type: "room.deleted",
        roomId,
      }),
    ).toEqual({
      type: "room.deleted",
      roomId,
    });

    const summaryBase = {
      id: roomId,
      name: "Test Room",
      topic: "Topic",
      visibility: "invite_only",
      lastSeq: 0,
      yourLastReadSeq: 0,
      governance: createDefaultGovernanceState(),
      createdAtIso: "2026-11-20T08:00:00.000Z",
    };
    expect(() => RoomSummaryDtoSchema.parse(summaryBase)).toThrow();
    expect(
      RoomSummaryDtoSchema.parse({
        ...summaryBase,
        ownerUserId: ownerA,
      }).ownerUserId,
    ).toBe(ownerA);
    expect(
      RoomSummaryDtoSchema.parse({
        ...summaryBase,
        ownerUserId: ownerA,
        lastMessageAtIso: "2026-11-25T10:30:00.000Z",
      }).lastMessageAtIso,
    ).toBe("2026-11-25T10:30:00.000Z");
  });

  it("defaults HumanUserDto role/status for backward compatibility and validates admin schemas", () => {
    const legacyHuman = HumanUserDtoSchema.parse({
      id: ownerA,
      email: "owner@example.com",
      displayName: "Owner",
      createdAtIso: "2026-11-20T08:00:00.000Z",
    });
    expect(legacyHuman.role).toBe("user");
    expect(legacyHuman.status).toBe("active");

    expect(ErrorCodeSchema.parse("FORBIDDEN_ADMIN_ONLY")).toBe("FORBIDDEN_ADMIN_ONLY");
    expect(ErrorCodeSchema.parse("ACCOUNT_SUSPENDED")).toBe("ACCOUNT_SUSPENDED");
    expect(ErrorCodeSchema.parse("ADMIN_GUARDRAIL_VIOLATION")).toBe("ADMIN_GUARDRAIL_VIOLATION");

    expect(
      AdminUpdateUserBodySchema.parse({
        role: "admin",
        status: "suspended",
        suspendedReason: "Spamming",
      }),
    ).toEqual({
      role: "admin",
      status: "suspended",
      suspendedReason: "Spamming",
    });

    expect(AdminRoomMessagesQuerySchema.parse({ includeRecalled: "false" }).includeRecalled).toBe(
      false,
    );

    const parsedOverview = AdminOverviewResponseSchema.parse({
      ok: true,
      windowDays: 14,
      runtime: {
        databaseDriver: "pglite",
        realtimeBusDriver: "memory",
        activeAgentConnections: 1,
        activeAgentCount: 1,
        activeRoomSubscriptions: 2,
        activeRoomCount: 1,
        uptimeSec: 120,
        serverTimeIso: "2026-11-20T09:00:00.000Z",
      },
      kpis: {
        totalUsers: 2,
        adminUsers: 1,
        suspendedUsers: 0,
        newUsers7d: 2,
        activeSessions: 1,
        expiredSessions: 0,
        totalAgents: 1,
        onlineSseAgents: 1,
        totalRooms: 1,
        publicShareableRooms: 0,
        pausedBudgetRooms: 0,
        totalMessages: 5,
        messages24h: 5,
        messages7d: 5,
        recalledMessages: 0,
        totalProposals: 1,
        openProposals: 1,
        approvedProposals: 0,
        rejectedProposals: 0,
        totalVotes: 1,
        activePairingCodes: 0,
      },
      dailyTrends: [
        {
          date: "2026-11-20",
          newUsers: 2,
          newRooms: 1,
          totalMessages: 5,
          humanMessages: 3,
          agentMessages: 2,
          newProposals: 1,
        },
      ],
      agentPlatformDistribution: [{ key: "codex", label: "Codex", count: 1 }],
      agentReachDistribution: [{ key: "online_sse", label: "在线（SSE）", count: 1 }],
      roomGovernanceDistribution: [{ key: "free", label: "自由讨论", count: 1 }],
      topActiveRooms: [],
      topActiveUsers: [],
      recentAuditLogs: [],
    });
    expect(parsedOverview.kpis.totalUsers).toBe(2);
  });

  it("validates email+password registration, login, reset, change-password schemas and auth error codes", () => {
    expect(PasswordSchema.safeParse("1234567").success).toBe(false);
    expect(PasswordSchema.safeParse("        ").success).toBe(false);
    expect(PasswordSchema.safeParse("a".repeat(129)).success).toBe(false);
    expect(PasswordSchema.parse("StrongPass2026!")).toBe("StrongPass2026!");

    const reg = RegisterWithPasswordBodySchema.parse({
      email: "  Alice@Example.COM ",
      code: " 042819 ",
      displayName: "  Alice  ",
      password: "correct horse battery staple",
    });
    expect(reg.email).toBe("alice@example.com");
    expect(reg.code).toBe("042819");
    expect(reg.displayName).toBe("Alice");

    const login = LoginWithPasswordBodySchema.parse({
      email: "Bob@Example.COM",
      password: "my-secret-password",
    });
    expect(login.email).toBe("bob@example.com");

    expect(
      ConfirmPasswordResetBodySchema.parse({
        email: "Alice@Example.com",
        code: "123456",
        newPassword: "new-password-999",
      }).email,
    ).toBe("alice@example.com");

    expect(ChangePasswordBodySchema.parse({ newPassword: "first-password-123" }).newPassword).toBe(
      "first-password-123",
    );

    expect(OtpPurposeSchema.parse("register")).toBe("register");
    expect(OtpPurposeSchema.parse("password_reset")).toBe("password_reset");
    expect(OtpPurposeSchema.parse("login")).toBe("login");

    const config = AuthPublicConfigResponseSchema.parse({
      ok: true,
      allowPublicSignup: true,
      allowedEmailDomains: ["example.com"],
      emailDeliveryMode: "smtp",
      otpResendCooldownSec: 60,
      otpTtlSec: 600,
      passwordMinLength: 8,
    });
    expect(config.emailDeliveryMode).toBe("smtp");

    for (const code of [
      "INVALID_CREDENTIALS",
      "EMAIL_ALREADY_REGISTERED",
      "SIGNUP_DISABLED",
      "EMAIL_DOMAIN_NOT_ALLOWED",
      "OTP_INVALID_OR_EXPIRED",
      "OTP_ATTEMPTS_EXCEEDED",
      "AUTH_RATE_LIMITED",
      "EMAIL_DELIVERY_FAILED",
      "EMAIL_DELIVERY_UNAVAILABLE",
    ] as const) {
      expect(ErrorCodeSchema.parse(code)).toBe(code);
    }

    const legacyHuman = HumanUserDtoSchema.parse({
      id: ownerA,
      email: "legacy@example.com",
      displayName: "Legacy",
      createdAtIso: "2026-11-20T08:00:00.000Z",
    });
    expect(legacyHuman.emailVerified).toBe(true);
    expect(legacyHuman.hasPassword).toBe(false);
  });

  it("validates MessageAttachment dimensions, optional image/audio fileName, required binary fileName, and blocks image/svg+xml", () => {
    expect(MessageAttachmentMimeTypeSchema.safeParse("image/svg+xml").success).toBe(false);

    expect(
      MessageAttachmentSchema.parse({
        mimeType: "image/png",
        byteLength: 1024,
        width: 1280,
        height: 720,
        fileName: "diagram.png",
      }),
    ).toEqual({
      mimeType: "image/png",
      byteLength: 1024,
      width: 1280,
      height: 720,
      fileName: "diagram.png",
    });

    expect(
      MessageAttachmentSchema.safeParse({
        mimeType: "image/png",
        byteLength: 1024,
      }).success,
    ).toBe(true);

    expect(
      MessageAttachmentSchema.safeParse({
        mimeType: "image/png",
        byteLength: 1024,
        width: 0,
        height: 720,
      }).success,
    ).toBe(false);

    expect(
      MessageAttachmentSchema.safeParse({
        mimeType: "image/png",
        byteLength: 1024,
        width: 32_769,
        height: 720,
      }).success,
    ).toBe(false);

    // image/* and audio/* allow omitting or including fileName
    expect(
      MessageAttachmentUploadSchema.safeParse({
        mimeType: "image/png",
        data: "iVBORw0KGgo=",
      }).success,
    ).toBe(true);

    expect(
      MessageAttachmentUploadSchema.safeParse({
        mimeType: "image/png",
        fileName: "architecture.png",
        data: "iVBORw0KGgo=",
      }).success,
    ).toBe(true);

    expect(
      MessageAttachmentUploadSchema.safeParse({
        mimeType: "audio/mpeg",
        fileName: "voice-note.mp3",
        data: "SUQzBAAAAAA=",
      }).success,
    ).toBe(true);

    // application/octet-stream still strictly requires fileName
    expect(
      MessageAttachmentUploadSchema.safeParse({
        mimeType: "application/octet-stream",
        data: "UEsDBBQAAAA=",
      }).success,
    ).toBe(false);

    expect(
      MessageAttachmentUploadSchema.safeParse({
        mimeType: "application/octet-stream",
        fileName: "bundle.zip",
        data: "UEsDBBQAAAA=",
      }).success,
    ).toBe(true);

    // Reject path traversal and bidi spoofing in fileName
    expect(
      MessageAttachmentUploadSchema.safeParse({
        mimeType: "image/png",
        fileName: "../secret.png",
        data: "iVBORw0KGgo=",
      }).success,
    ).toBe(false);

    expect(
      MessageAttachmentUploadSchema.safeParse({
        mimeType: "image/png",
        fileName: "spoof\u202egnp.exe",
        data: "iVBORw0KGgo=",
      }).success,
    ).toBe(false);
  });

  it("validates SupportedLocale, LanguagePreference, RegisterWithPasswordBody, UpdateMeBody, and MeResponse isolation", () => {
    expect(SupportedLocaleSchema.parse("zh-CN")).toBe("zh-CN");
    expect(SupportedLocaleSchema.parse("en")).toBe("en");
    expect(SupportedLocaleSchema.safeParse("auto").success).toBe(false);
    expect(SupportedLocaleSchema.safeParse("ja-JP").success).toBe(false);

    expect(LanguagePreferenceSchema.parse("auto")).toBe("auto");
    expect(LanguagePreferenceSchema.parse("zh-CN")).toBe("zh-CN");
    expect(LanguagePreferenceSchema.parse("en")).toBe("en");
    expect(LanguagePreferenceSchema.safeParse("fr").success).toBe(false);

    const legacyReg = RegisterWithPasswordBodySchema.parse({
      email: "legacy-client@example.com",
      code: "123456",
      displayName: "Legacy",
      password: "ValidPassword#2026",
    });
    expect(legacyReg.languagePreference).toBeUndefined();

    const localizedReg = RegisterWithPasswordBodySchema.parse({
      email: "en-client@example.com",
      code: "123456",
      displayName: "English",
      password: "ValidPassword#2026",
      languagePreference: "en",
    });
    expect(localizedReg.languagePreference).toBe("en");
    expect(
      RegisterWithPasswordBodySchema.safeParse({
        email: "bad@example.com",
        code: "123456",
        displayName: "Bad",
        password: "ValidPassword#2026",
        languagePreference: "jp",
      }).success,
    ).toBe(false);

    expect(UpdateMeBodySchema.parse({ languagePreference: "zh-CN" })).toEqual({
      languagePreference: "zh-CN",
    });
    expect(UpdateMeBodySchema.safeParse({ languagePreference: "de" }).success).toBe(false);

    const humanMe = MeResponseSchema.parse({
      ok: true,
      callerKind: "human",
      user: {
        id: ownerA,
        email: "owner@example.com",
        displayName: "Owner",
        createdAtIso: "2026-11-20T08:00:00.000Z",
      },
      agents: [],
      themePreference: "auto",
      languagePreference: "en",
    });
    expect(humanMe.callerKind === "human" && humanMe.languagePreference).toBe("en");

    // HumanUserDto and agent MeResponse must strip / exclude languagePreference
    const strippedUser = HumanUserDtoSchema.parse({
      id: ownerA,
      email: "owner@example.com",
      displayName: "Owner",
      languagePreference: "en",
      createdAtIso: "2026-11-20T08:00:00.000Z",
    });
    expect("languagePreference" in strippedUser).toBe(false);

    const agentMe = MeResponseSchema.parse({
      ok: true,
      callerKind: "agent",
      agent: {
        id: agentA1,
        ownerUserId: ownerA,
        displayName: "Agent",
        slug: "agent",
        platform: "codex",
        reach: "online_sse",
        createdAtIso: "2026-11-20T08:00:00.000Z",
      },
      owner: {
        id: ownerA,
        email: "owner@example.com",
        displayName: "Owner",
        languagePreference: "en",
        createdAtIso: "2026-11-20T08:00:00.000Z",
      },
      siblingAgents: [],
      languagePreference: "en",
    });
    expect("languagePreference" in agentMe).toBe(false);
    expect(agentMe.callerKind === "agent" && "languagePreference" in agentMe.owner).toBe(false);
  });
});
