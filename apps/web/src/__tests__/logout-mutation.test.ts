/**
 * @module web/tests/logout-mutation
 * @description 验证注销后清理登录数据、更新身份订阅并回到首页。
 */
import { HumanUserDtoSchema } from "@openhuddle/protocol";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import {
  currentMeQueryOptions,
  useLogoutMutation,
} from "../features/auth-pairing/api/auth-pairing.queries.js";
import type { HumanMeResponseDto } from "../lib/api-client.js";
import { huddleQueryKeys } from "../lib/query-keys.js";
import { getStoredSessionToken, setStoredSessionToken } from "../lib/session-store.js";

function renderLogoutMutation(queryClient: QueryClient) {
  let logout: ReturnType<typeof useLogoutMutation>["mutateAsync"] | undefined;

  function LogoutProbe() {
    logout = useLogoutMutation().mutateAsync;
    return null;
  }

  renderToString(
    createElement(QueryClientProvider, { client: queryClient }, createElement(LogoutProbe)),
  );
  if (logout === undefined) {
    throw new Error("Logout mutation did not render");
  }
  return logout;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each(["/admin/users", "/?room=test-room", "/"])(
  "returns from %s to the signed-out homepage",
  async (path) => {
    const origin = "https://openhuddle.test";
    const storage = new Map<string, string>();
    const browser = {
      location: new URL(path, origin),
      history: {
        replaceState: vi.fn((_state: unknown, _title: string, to: string) => {
          browser.location = new URL(to, origin);
        }),
      },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    };
    vi.stubGlobal("window", browser);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true })));
    setStoredSessionToken("test-session");

    const queryClient = new QueryClient();
    const meOptions = currentMeQueryOptions();
    const signedInUser: HumanMeResponseDto = {
      ok: true,
      callerKind: "human",
      user: HumanUserDtoSchema.parse({
        id: "test-user",
        email: "user@openhuddle.test",
        displayName: "Test user",
        createdAtIso: "2026-01-01T00:00:00.000Z",
      }),
      agents: [],
    };
    queryClient.setQueryData(meOptions.queryKey, signedInUser);
    queryClient.setQueryData(huddleQueryKeys.rooms(), { rooms: [] });
    const meObserver = new QueryObserver(queryClient, meOptions);
    const unsubscribe = meObserver.subscribe(() => {});

    try {
      await renderLogoutMutation(queryClient)();

      expect(browser.history.replaceState).toHaveBeenCalledWith(null, "", "/");
      expect(browser.location.href).toBe(`${origin}/`);
      expect(getStoredSessionToken()).toBeNull();
      expect(meObserver.getCurrentResult().data).toBeNull();
      expect(queryClient.getQueryData(huddleQueryKeys.rooms())).toBeUndefined();
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  },
);
