import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";

const CORE_PATH_KEYS = [
  "planner",
  "executor",
  "evaluator",
  "engine_loop",
  "state_persistence"
] as const;

type CorePathKey = (typeof CORE_PATH_KEYS)[number];
type CorePathsContext = Record<CorePathKey, string | null>;

function contextFilePath(): string {
  return path.join(process.cwd(), ".autoloop", "context", "core_paths.json");
}

async function readCorePathsContext(): Promise<CorePathsContext> {
  const raw = await fs.readFile(contextFilePath(), "utf8");
  return JSON.parse(raw) as CorePathsContext;
}

describe("core paths context", () => {
  test("contains exactly the required keys", async () => {
    const context = await readCorePathsContext();
    const keys = Object.keys(context).sort();
    expect(keys).toEqual([...CORE_PATH_KEYS].sort());
  });

  test("maps each required key to a path string or explicit null", async () => {
    const context = await readCorePathsContext();
    for (const key of CORE_PATH_KEYS) {
      const value = context[key];
      expect(value === null || typeof value === "string").toBe(true);
    }
  });

  test("resolves each present mapped path to an existing file", async () => {
    const context = await readCorePathsContext();
    for (const key of CORE_PATH_KEYS) {
      const value = context[key];
      if (value === null) {
        continue;
      }

      const stat = await fs.stat(path.join(process.cwd(), value));
      expect(stat.isFile()).toBe(true);
    }
  });
});
