import fs from "node:fs/promises";
import { describe, expect, test } from "bun:test";

describe("scripts/prod.sh daemon launcher", () => {
  test("does not wrap the server command as 'nohup setsid ...'", async () => {
    const script = await fs.readFile("scripts/prod.sh", "utf8");

    expect(script).not.toContain('nohup setsid bun run src/server.ts');
    expect(script).toContain('nohup bun run src/server.ts >>"$LOG_FILE" 2>&1 < /dev/null &');
  });
});
