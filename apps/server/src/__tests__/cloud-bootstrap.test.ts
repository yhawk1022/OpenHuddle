/**
 * @module server/tests/cloud-bootstrap
 * @description 全环境安装器（`/install.sh`、`/install.ps1`）、动态公网根地址推导与远程 MCP 鉴权边界测试。
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ManagedDatabase, createDatabaseClient, ensureCoreSchema } from "@openhuddle/db";
import { MAX_MESSAGE_ATTACHMENT_BASE64_LENGTH } from "@openhuddle/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerApp } from "../app.js";
import { parseServerEnv } from "../infra/env.js";
import { resolveEffectivePublicBaseUrl } from "../infra/public-url.js";
import { InMemoryRealtimeBus } from "../infra/realtime-bus.js";
import { renderInstallShellScript } from "../modules/pairing/bootstrap-docs.routes.js";

describe("@openhuddle/server — universal installer & cloud access", () => {
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

  it("derives public base URL from forwarded headers only when configured URL is loopback, rejecting malicious hosts", () => {
    const req = (headers: Record<string, string>) =>
      new Request("http://localhost/install.sh", { headers });
    expect(
      resolveEffectivePublicBaseUrl(
        "http://localhost",
        req({ host: "cyanarch.com", "x-forwarded-proto": "https" }),
      ),
    ).toBe("https://cyanarch.com");
    expect(
      resolveEffectivePublicBaseUrl("https://huddle.example.com", req({ host: "evil.com" })),
    ).toBe("https://huddle.example.com");
    expect(
      resolveEffectivePublicBaseUrl("http://localhost:3000", req({ host: "evil.com;rm -rf /" })),
    ).toBe("http://localhost:3000");
    expect(
      resolveEffectivePublicBaseUrl("http://localhost:3000", req({ host: "localhost:5173" })),
    ).toBe("http://localhost:3000");
  });

  it("serves /install.sh with node + posix fallback, safe preset quoting, and /install.ps1", async () => {
    const env = parseServerEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      PUBLIC_BASE_URL: "https://huddle.example.com",
      DATABASE_URL: "memory://",
    });
    const app = createServerApp({ env, database, realtimeBus: bus });

    const shRes = await app.request(
      "/install.sh?code=HUDDLE-AB12-CD34&name=O'Brien%20Bot&platform=codex",
    );
    expect(shRes.status).toBe(200);
    const sh = await shRes.text();
    expect(sh.startsWith("#!/bin/sh")).toBe(true);
    expect(sh).toContain("BASE_URL='https://huddle.example.com'");
    expect(sh).toContain("/openhuddle.mjs");
    expect(sh).toContain("posix-sh-fallback");
    expect(sh).toContain(`connect 'HUDDLE-AB12-CD34' --name 'O'\\''Brien Bot' --platform 'codex'`);

    const psRes = await app.request("/install.ps1?code=HUDDLE-AB12-CD34");
    const ps = await psRes.text();
    expect(ps).toContain("[string]$Code = 'HUDDLE-AB12-CD34'");
    expect(ps).toContain("openhuddle.cmd");
    expect(ps).toContain("$env:OPENHUDDLE_HOME = $OhHome");
    expect(ps).toContain('$ConnectArgs += @("--agent", $Agent)');
    expect(ps).toContain('$ConnectArgs += "--no-listen"');

    const installMd = await (await app.request("/install.md")).text();
    expect(installMd).toContain("POST https://huddle.example.com/api/v1/agent-connections/redeem");
    expect(installMd).toContain("/api/v1/mcp");
    expect(installMd).toContain("Connect with an approved, installed CLI");
    expect(installMd).toContain("appearance and language preferences");
    expect(installMd).not.toContain("| sh");
    expect(installMd).not.toContain("ExecutionPolicy Bypass");
    const skillMd = await (await app.request("/skill.md")).text();
    expect(skillMd).toContain(
      "Installing software or starting a background runner requires its own host permission.",
    );
    expect(skillMd).toContain("`themePreference` and `languagePreference`");
  });

  it("rejects anonymous, human, and oversized (>8MiB Base64) payloads on remote MCP endpoint", async () => {
    const env = parseServerEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: "memory://",
    });
    const app = createServerApp({ env, database, realtimeBus: bus });
    const anon = await app.request("/api/v1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(anon.status).toBe(401);

    // Register human + pair an agent to obtain a valid oh_agt_ token
    const otpReq = await app.request("/api/v1/auth/otp/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "mcp-limit@example.com", displayName: "MCP Owner" }),
    });
    const { devOtpCode } = (await otpReq.json()) as { devOtpCode: string };
    const verifyRes = await app.request("/api/v1/auth/otp/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "mcp-limit@example.com",
        code: devOtpCode,
        displayName: "MCP Owner",
      }),
    });
    const { sessionToken } = (await verifyRes.json()) as { sessionToken: string };

    // Human bearer session must be rejected with 403 on /api/v1/mcp
    const humanMcp = await app.request("/api/v1/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(humanMcp.status).toBe(403);
    const codeRes = await app.request("/api/v1/pairing-codes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({}),
    });
    const { code } = (await codeRes.json()) as { code: string };
    const pairRes = await app.request("/api/v1/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: "MCP Guard Bot", platform: "custom" }),
    });
    const { token: agentToken } = (await pairRes.json()) as { token: string };

    // Oversized JSON-RPC request (> MAX_MESSAGE_ATTACHMENT_BASE64_LENGTH + 256 KiB) must be rejected with 413
    const hugeBody = `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"pad":"${"A".repeat(
      MAX_MESSAGE_ATTACHMENT_BASE64_LENGTH + 300 * 1024,
    )}"}}`;
    const oversized = await app.request("/api/v1/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${agentToken}`,
      },
      body: hugeBody,
    });
    expect(oversized.status).toBe(413);
    const errJson = (await oversized.json()) as { error: { code: string } };
    expect(errJson.error.code).toBe("VALIDATION_ERROR");

    // Reclaiming the agent rotates its token -> old token immediately rejected with 401 on /api/v1/mcp
    const codeRes2 = await app.request("/api/v1/pairing-codes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({}),
    });
    const { code: code2 } = (await codeRes2.json()) as { code: string };
    const reclaimRes = await app.request("/api/v1/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: code2,
        name: "MCP Guard Bot",
        platform: "custom",
        reclaim: true,
      }),
    });
    expect(reclaimRes.status).toBe(201);

    const revokedMcp = await app.request("/api/v1/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${agentToken}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    });
    expect(revokedMcp.status).toBe(401);
  });
});

it.skipIf(process.platform === "win32")(
  "connects in the POSIX fallback, streams --image/--file via --data-binary @-, and downloads 0600 attachments safely",
  () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openhuddle-fallback-"));
    try {
      const home = join(tempDir, "Agent's home");
      const tools = join(tempDir, "bin");
      const capture = join(tempDir, "request.json");
      const requestArgs = join(tempDir, "request-args.txt");
      const readCursor = join(tempDir, "read-cursor");
      const separateTokenPath = join(tempDir, "separate.token");
      const installed = join(tempDir, "openhuddle");
      mkdirSync(tools);
      const url = "https://huddle.example.com";
      const alternateUrl = "https://different.example.com";
      const installer = renderInstallShellScript(url);
      const fallback = installer.split("<<'SH_CLI_EOF'\n")[1]?.split("\nSH_CLI_EOF")[0];
      if (fallback === undefined) {
        throw new Error("Installer did not include the POSIX fallback");
      }
      writeFileSync(installed, fallback);
      for (const utility of [
        "base64",
        "cat",
        "chmod",
        "date",
        "head",
        "mkdir",
        "mktemp",
        "mv",
        "od",
        "rm",
        "sed",
        "tr",
      ]) {
        const executable = execFileSync("/bin/sh", ["-c", 'command -v "$1"', "sh", utility], {
          encoding: "utf8",
        }).trim();
        symlinkSync(executable, join(tools, utility));
      }

      const samplePng = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFzsAAAAASUVORK5CYII=",
        "base64",
      );
      const storedAttachmentFile = join(tempDir, "server-stored.png");
      writeFileSync(storedAttachmentFile, samplePng);

      writeFileSync(
        join(tools, "curl"),
        [
          "#!/bin/sh",
          'printf \'%s\\n\' "$@" > "$REQUEST_ARGS"',
          'case "$*" in',
          '  *"$ISSUER/api/v1/agent-connections/redeem"*)',
          '    cat > "$CAPTURE"',
          '    printf \'%s\' \'{"token":"oh_agt_test","autoJoinedRoomId":"rom_example"}\' ;;',
          '  *"$ISSUER/api/v1/rooms/rom_example/messages/9/attachment"*"Authorization: Bearer oh_agt_test"*)',
          '    cat "$STORED_ATT" ;;',
          '  *"$ISSUER/api/v1/rooms/rom_example/messages?limit=30"*"Authorization: Bearer oh_agt_test"*)',
          '    : > "$READ_CURSOR"',
          '    printf \'%s\' \'{"messages":[{"seq":1,"content":"Owner request"}]}\' ;;',
          '  *"$ISSUER/api/v1/rooms/rom_example/messages"*"Authorization: Bearer oh_agt_test"*"--data-binary @-"*)',
          '    cat > "$CAPTURE"',
          '    case "$(cat "$CAPTURE")" in *\'"ignoreUnread":true\'*) exit 1 ;; esac',
          '    [ -f "$READ_CURSOR" ] || exit 22',
          "    printf '%s' '{\"message\":{\"seq\":2}}' ;;",
          '  *"$ISSUER/api/v1/rooms"*"Authorization: Bearer oh_agt_test"*)',
          '    printf \'%s\' \'{"rooms":[{"id":"rom_example"}]}\' ;;',
          '  *"$ALTERNATE_URL/api/v1/me"*"Authorization: Bearer oh_agt_separate"*)',
          "    printf '%s' '{\"callerKind\":\"agent\"}' ;;",
          "  *) exit 1 ;;",
          "esac",
        ].join("\n"),
        { mode: 0o700 },
      );
      const env = {
        HOME: home,
        INSTALLED_OH_HOME: home,
        INSTALLED_OH_SERVER: url,
        PATH: tools,
        ISSUER: url,
        ALTERNATE_URL: alternateUrl,
        OPENHUDDLE_URL: alternateUrl,
        CAPTURE: capture,
        REQUEST_ARGS: requestArgs,
        READ_CURSOR: readCursor,
        STORED_ATT: storedAttachmentFile,
      };
      const connectionToken = `oh_connect_ng_${"a".repeat(43)}`;
      const output = execFileSync(
        "/bin/sh",
        [
          installed,
          "connect",
          `${url}/connect#${connectionToken}`,
          "--name",
          "Cloud Agent",
          "--platform",
          "codex",
          "--no-greet",
        ],
        { env, encoding: "utf8" },
      );
      expect(output).toContain("room=rom_example");
      expect(output).not.toContain(connectionToken);
      expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual({
        connectionToken,
        name: "Cloud Agent",
        platform: "codex",
      });
      expect(
        JSON.parse(execFileSync("/bin/sh", [installed, "rooms"], { env, encoding: "utf8" })),
      ).toEqual({ rooms: [{ id: "rom_example" }] });
      expect(spawnSync("/bin/sh", [installed, "reply", "Before reading"], { env }).status).toBe(22);
      execFileSync("/bin/sh", [installed, "read"], { env });
      execFileSync("/bin/sh", [installed, "reply", "Read and replied"], { env });
      expect(readFileSync(requestArgs, "utf8")).toContain("--data-binary\n@-");
      expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual({
        content: "Read and replied",
        opKey: expect.any(String),
      });
      execFileSync("/bin/sh", [installed, "send", "rom_example", "Direct send"], { env });
      expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual({
        content: "Direct send",
        opKey: expect.any(String),
      });

      // Test POSIX sh --image, fake PNG rejection, --sticker, and --file without python3
      const validImgPath = join(tempDir, "diagram.png");
      writeFileSync(validImgPath, samplePng);
      execFileSync(
        "/bin/sh",
        [installed, "reply", "Chart", "--image", validImgPath, "--reply", "1"],
        {
          env,
        },
      );
      expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual({
        content: "Chart",
        replyToSeq: 1,
        opKey: expect.any(String),
        attachment: {
          mimeType: "image/png",
          fileName: "diagram.png",
          data: samplePng.toString("base64"),
        },
      });

      const fakePngPath = join(tempDir, "spoof.png");
      writeFileSync(fakePngPath, "<svg><script>alert(1)</script></svg>");
      expect(
        spawnSync("/bin/sh", [installed, "reply", "--image", fakePngPath], { env }).status,
      ).toBe(1);

      const docPath = join(tempDir, "notes.txt");
      writeFileSync(docPath, "hello posix attachment");
      execFileSync("/bin/sh", [installed, "send", "rom_example", "--file", docPath], { env });
      expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual({
        content: "",
        opKey: expect.any(String),
        attachment: {
          mimeType: "application/octet-stream",
          fileName: "notes.txt",
          data: Buffer.from("hello posix attachment").toString("base64"),
        },
      });

      // Test POSIX sh `attachment` subcommand: 0600 mode, overwrite protection, --force, and symlink rejection
      const downloadedOut = join(tempDir, "downloaded.png");
      execFileSync("/bin/sh", [installed, "attachment", "9", "--out", downloadedOut], { env });
      expect(readFileSync(downloadedOut)).toEqual(samplePng);
      expect(statSync(downloadedOut).mode & 0o777).toBe(0o600);

      writeFileSync(downloadedOut, "keep-me");
      expect(
        spawnSync("/bin/sh", [installed, "attachment", "9", "--out", downloadedOut], { env })
          .status,
      ).toBe(1);
      expect(readFileSync(downloadedOut, "utf8")).toBe("keep-me");

      execFileSync("/bin/sh", [installed, "attachment", "9", "--out", downloadedOut, "--force"], {
        env,
      });
      expect(readFileSync(downloadedOut)).toEqual(samplePng);

      const symlinkOut = join(tempDir, "symlink.png");
      symlinkSync(docPath, symlinkOut);
      expect(
        spawnSync("/bin/sh", [installed, "attachment", "9", "--out", symlinkOut, "--force"], {
          env,
        }).status,
      ).toBe(1);
      expect(readFileSync(docPath, "utf8")).toBe("hello posix attachment");

      // Also verify the python3 branch of POSIX fallback (--image + --sticker)
      const py3Bin = execFileSync("/bin/sh", ["-c", "command -v python3 || true"], {
        encoding: "utf8",
      }).trim();
      if (py3Bin.length > 0) {
        symlinkSync(py3Bin, join(tools, "python3"));
        execFileSync(
          "/bin/sh",
          [installed, "reply", "--image", validImgPath, "--sticker", " 赞 "],
          { env },
        );
        expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual({
          content: "",
          opKey: expect.any(String),
          attachment: {
            mimeType: "image/png",
            stickerName: "赞",
            data: samplePng.toString("base64"),
          },
        });
        expect(
          spawnSync("/bin/sh", [installed, "reply", "--image", fakePngPath], { env }).status,
        ).toBe(1);
      }

      writeFileSync(separateTokenPath, "oh_agt_separate\n");
      const explicitEnv = { ...env, OPENHUDDLE_TOKEN_FILE: separateTokenPath };
      expect(
        JSON.parse(
          execFileSync("/bin/sh", [installed, "whoami"], { env: explicitEnv, encoding: "utf8" }),
        ),
      ).toEqual({ callerKind: "agent" });
      const explicitReply = spawnSync("/bin/sh", [installed, "reply", "No room"], {
        env: explicitEnv,
        encoding: "utf8",
      });
      expect(explicitReply.status).toBe(1);
      expect(explicitReply.stderr).toContain("No default room saved");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  },
);
