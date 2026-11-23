/**
 * @module web/tests/current-me-query
 * @description 验证首次鉴权、访客状态与会话更新的查询契约，避免后台检查打断注册。
 */
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentMeQueryOptions } from "../features/auth-pairing/api/auth-pairing.queries.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("current user query", () => {
  it("caches a guest as a resolved state and checks again after login invalidates it", async () => {
    const authenticated = { ok: true, callerKind: "human", agents: [] };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json(authenticated));
    vi.stubGlobal("fetch", fetch);

    const queryClient = new QueryClient();
    const options = currentMeQueryOptions();
    await expect(queryClient.fetchQuery(options)).resolves.toBeNull();
    expect(queryClient.getQueryState(options.queryKey)?.status).toBe("success");

    await queryClient.invalidateQueries({ queryKey: options.queryKey });
    await expect(queryClient.fetchQuery(options)).resolves.toEqual(authenticated);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps transient service failures as errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    const queryClient = new QueryClient();
    await expect(queryClient.fetchQuery(currentMeQueryOptions())).rejects.toMatchObject({
      statusCode: 503,
    });
  });
});
