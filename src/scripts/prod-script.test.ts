import fs from "node:fs/promises";
import { describe, expect, test } from "bun:test";

describe("scripts/prod.sh daemon launcher", () => {
  test("does not wrap the server command as 'nohup setsid ...'", async () => {
    const script = await fs.readFile("scripts/prod.sh", "utf8");

    expect(script).not.toContain('nohup setsid bun run src/server.ts');
    expect(script).toContain('nohup bun run src/server.ts >>"$LOG_FILE" 2>&1 < /dev/null &');
  });

  test("serializes daemon start attempts with a startup lock", async () => {
    const script = await fs.readFile("scripts/prod.sh", "utf8");

    expect(script).toContain('START_LOCK_DIR="$RUN_DIR/prod.server.start.lock"');
    expect(script).toContain('acquire_start_lock');
    expect(script).toContain('release_start_lock');
    expect(script).toContain('if mkdir "$START_LOCK_DIR" 2>/dev/null; then');
    expect(script).toContain('trap release_start_lock EXIT');
  });

  test("waits for the console health endpoint before declaring daemon startup success", async () => {
    const script = await fs.readFile("scripts/prod.sh", "utf8");

    expect(script).toContain('STARTUP_TIMEOUT_SECONDS="${AILOOP_PROD_STARTUP_TIMEOUT_SECONDS:-20}"');
    expect(script).toContain('wait_for_server_start');
    expect(script).toContain('curl -fsS "http://127.0.0.1:${CONSOLE_PORT}/api/health"');
    expect(script).toContain('Production server failed to become healthy');
  });
});
