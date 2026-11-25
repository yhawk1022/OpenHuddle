/**
 * @module server/__tests__/security-and-infra-guards
 * @description 验证 AI 主持人 BYOK 密钥隔离与 SSRF 防护、Markdown JSON 围栏剥离及反向代理客户端 IP 提取防伪造逻辑。
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { extractClientIp } from "../infra/rate-limiter.js";
import {
  resolveSafeSynthesisEndpoint,
  stripJsonCodeFence,
} from "../modules/ai-moderator/ai-moderator.service.js";

describe("AI Moderator SSRF & Server Key Isolation Guards", () => {
  const configuredBaseUrl = "https://api.openai.com/v1";
  const configuredApiKey = "sk-server-operator-secret";
  const configuredModel = "gpt-4o-mini";

  it("never leaks the server operator AI_API_KEY when a caller overrides baseUrl without their own apiKey", () => {
    const blocked = resolveSafeSynthesisEndpoint({
      configuredBaseUrl,
      configuredApiKey,
      configuredModel,
      request: {
        messageWindowLimit: 20,
        baseUrl: "https://evil-collector.example.com/v1",
      },
    });
    expect(blocked).toBeNull();
  });

  it("blocks SSRF to loopback, RFC1918 private networks, cloud metadata, and plaintext HTTP on custom baseUrl", () => {
    const unsafeUrls = [
      "https://127.0.0.1:8443/v1",
      "https://localhost/v1",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.12/v1",
      "https://172.20.1.5/v1",
      "https://192.168.1.8/v1",
      "https://[::1]/v1",
      "http://api.thirdparty-llm.com/v1",
      "https://user:pass@api.thirdparty-llm.com/v1",
    ];

    for (const baseUrl of unsafeUrls) {
      expect(
        resolveSafeSynthesisEndpoint({
          configuredBaseUrl,
          configuredApiKey,
          configuredModel,
          request: {
            messageWindowLimit: 20,
            baseUrl,
            apiKey: "sk-user-byok-key",
          },
        }),
      ).toBeNull();
    }
  });

  it("permits HTTPS public BYOK endpoints with caller apiKey and strips optional JSON code fences", () => {
    const resolved = resolveSafeSynthesisEndpoint({
      configuredBaseUrl,
      configuredApiKey,
      configuredModel,
      request: {
        messageWindowLimit: 20,
        baseUrl: "https://api.deepseek.com/v1/",
        apiKey: "sk-user-deepseek-key",
        model: "deepseek-chat",
      },
    });
    expect(resolved).toEqual({
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-user-deepseek-key",
      model: "deepseek-chat",
    });

    const fenced = '```json\n{"title":"Clean Plan"}\n```';
    expect(JSON.parse(stripJsonCodeFence(fenced))).toEqual({ title: "Clean Plan" });
  });
});

describe("extractClientIp X-Forwarded-For spoofing resistance", () => {
  it("prefers X-Real-IP and selects the rightmost proxy-appended hop in X-Forwarded-For", async () => {
    const app = new Hono();
    app.get("/ip", (c) => c.json({ ip: extractClientIp(c) }));

    const spoofedForwarded = await app.request("/ip", {
      headers: {
        "x-forwarded-for": "1.2.3.4, 203.0.113.42",
      },
    });
    expect(await spoofedForwarded.json()).toEqual({ ip: "203.0.113.42" });

    const withRealIp = await app.request("/ip", {
      headers: {
        "x-forwarded-for": "1.2.3.4, 203.0.113.42",
        "x-real-ip": "198.51.100.7",
      },
    });
    expect(await withRealIp.json()).toEqual({ ip: "198.51.100.7" });
  });
});
