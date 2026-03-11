import { afterEach, describe, expect, test } from "bun:test";

const ENV_KEYS = [
  "AILOOP_CONSOLE_ADMIN_TOKEN",
  "AILOOP_CONSOLE_ADMIN_TOKEN_ISSUED_DATE",
  "AILOOP_CONSOLE_HOST",
  "AILOOP_CONSOLE_PORT"
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]])
);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
});

async function loadHandler(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }

  const module = await import(`./server.ts?test=${Date.now()}-${Math.random()}`);
  expect(typeof module.createConsoleFetch).toBe("function");
  return module.createConsoleFetch();
}

describe("console server API contract", () => {
  test("serves health status without auth", async () => {
    const fetchHandler = await loadHandler({
      AILOOP_CONSOLE_HOST: "127.0.0.1",
      AILOOP_CONSOLE_PORT: "0",
      AILOOP_CONSOLE_ADMIN_TOKEN: ""
    });

    const response = await fetchHandler(new Request("http://console.test/api/health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "ailoop-console"
    });
  });

  test("reports auth status when token auth is enabled", async () => {
    const fetchHandler = await loadHandler({
      AILOOP_CONSOLE_HOST: "127.0.0.1",
      AILOOP_CONSOLE_PORT: "0",
      AILOOP_CONSOLE_ADMIN_TOKEN: "test-token",
      AILOOP_CONSOLE_ADMIN_TOKEN_ISSUED_DATE: "2026-03-11"
    });

    const response = await fetchHandler(new Request("http://console.test/api/auth/status"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tokenRequired: true,
      tokenExpired: false
    });
  });

  test("rejects protected API access without a valid admin token", async () => {
    const fetchHandler = await loadHandler({
      AILOOP_CONSOLE_HOST: "127.0.0.1",
      AILOOP_CONSOLE_PORT: "0",
      AILOOP_CONSOLE_ADMIN_TOKEN: "test-token",
      AILOOP_CONSOLE_ADMIN_TOKEN_ISSUED_DATE: "2026-03-11"
    });

    const response = await fetchHandler(new Request("http://console.test/api/status"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Unauthorized"
    });
  });
});
