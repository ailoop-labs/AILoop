#!/usr/bin/env bun
/**
 * Legacy entrypoint retained for operator convenience.
 * Configuration is already database-only; this script now removes stale
 * legacy config keys from the current workspace database.
 */

import { resolveAiloopHome, resolveConfigDbPath } from "../src/config/env";
import { DatabaseManager } from "../src/utils/db";

const LEGACY_KEYS = [
  "AILOOP_HOME",
  "AILOOP_CODEX_BIN",
  "AILOOP_CODEX_MODEL",
  "AILOOP_CODEX_PROFILE",
  "AILOOP_CODEX_PLANNER_SANDBOX",
  "AILOOP_CODEX_EXECUTOR_SANDBOX",
  "AILOOP_CODEX_EVALUATOR_SANDBOX",
  "AILOOP_CODEX_TIMEOUT_MS"
] as const;

async function main() {
  const homeDir = resolveAiloopHome();
  const dbPath = resolveConfigDbPath(homeDir);
  const db = new DatabaseManager({ dbPath });

  try {
    for (const key of LEGACY_KEYS) {
      await db.deleteConfig(key);
    }

    console.log("Configuration is already database-only.");
    console.log(`Cleaned legacy keys in ${dbPath}:`);
    for (const key of LEGACY_KEYS) {
      console.log(`  - ${key}`);
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error("Legacy config cleanup failed:", error);
  process.exit(1);
});
