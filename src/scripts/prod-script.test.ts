import fs from "node:fs/promises";
import { describe, expect, test } from "bun:test";

describe("production launcher entrypoints", () => {
  test("package.json points the production shortcut at the TypeScript launcher", async () => {
    const packageJson = JSON.parse(await fs.readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.up).toBe("bun run scripts/prod.ts");
  });
});
