import assert from "node:assert/strict";
import test from "node:test";
import { OAUTH_ENDPOINTS } from "../../open-sse/config/constants.ts";
import { getAccessToken } from "../../open-sse/services/tokenRefresh.ts";
import { createProviderConnection, getProviderConnectionById } from "../../src/lib/db/providers.ts";
import { sweep } from "../../src/lib/tokenHealthCheck.ts";

test("the health sweep spaces Google OAuth refreshes and defers Antigravity project discovery", async (t) => {
  const connections = [];
  for (const provider of ["antigravity", "agy", "gemini", "antigravity"]) {
    const index = connections.length;
    connections.push(
      await createProviderConnection({
        provider,
        authType: "oauth",
        email: `refresh-${index}@example.test`,
        refreshToken: `refresh-${index}`,
        accessToken: `expired-${index}`,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        testStatus: index === 3 ? "banned" : "active",
        isActive: true,
      })
    );
  }

  const oauthTokens: string[] = [];
  const projectCalls: string[] = [];
  const gaps: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const originalSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    if (delay >= 12_000 && delay < 16_000) {
      gaps.push(delay);
      return originalSetTimeout(callback, 0, ...args);
    }
    return originalSetTimeout(callback, delay, ...args);
  });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === OAUTH_ENDPOINTS.google.token) {
      const token = new URLSearchParams(String(init?.body)).get("refresh_token")!;
      oauthTokens.push(token);
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise<void>((resolve) => setImmediate(resolve));
      inFlight--;
      return Response.json({ access_token: `new-${token}`, expires_in: 3600 });
    }
    if (url.endsWith(":loadCodeAssist")) {
      projectCalls.push(url);
      return Response.json({ cloudaicompanionProject: "test-google-project" });
    }
    assert.fail(`Unexpected upstream URL: ${url}`);
  });

  assert.equal(await sweep(), connections.length);
  assert.deepEqual([...oauthTokens].sort(), ["refresh-0", "refresh-1", "refresh-2"]);
  assert.equal(maxInFlight, 1, "different Google accounts refreshed concurrently");
  assert.equal(gaps.length, 2, "expected one wait between each pair of due accounts");
  assert.equal(projectCalls.length, 0, "a background refresh contacted Cloud Code");

  for (const [index, connection] of connections.slice(0, 3).entries()) {
    const stored = await getProviderConnectionById(connection.id);
    assert.equal(stored?.accessToken, `new-refresh-${index}`);
    assert.ok(Date.parse(stored?.expiresAt ?? "") > Date.now());
  }

  const result = await getAccessToken(
    "antigravity",
    { refreshToken: "request-time-refresh" },
    undefined
  );
  assert.equal(result?.projectId, "test-google-project");
  assert.equal(projectCalls.length, 1, "request-time project discovery stopped working");
});
