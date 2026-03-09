import fs from "node:fs/promises";
import { describe, expect, test } from "bun:test";

describe("scripts/prod.sh daemon launcher", () => {
  test("does not wrap the server command as 'nohup setsid ...'", async () => {
    const script = await fs.readFile("scripts/prod.sh", "utf8");

    expect(script).not.toContain('nohup setsid bun run src/server.ts');
    expect(script).toContain('nohup bun run src/server.ts >>"$LOG_FILE" 2>&1 < /dev/null &');
  });

  test("uses launchctl with an absolute bun path on macOS-capable hosts", async () => {
    const script = await fs.readFile("scripts/prod.sh", "utf8");

    expect(script).toContain('LAUNCHCTL_LABEL="com.ailoop.prod.server"');
    expect(script).toContain('BUN_BIN="$(command -v bun)"');
    expect(script).toContain('launchctl submit -l "$LAUNCHCTL_LABEL"');
    expect(script).toContain("exec '$BUN_BIN' run src/server.ts");
  });
});
