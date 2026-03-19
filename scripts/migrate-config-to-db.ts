#!/usr/bin/env bun
/**
 * Legacy entrypoint retained for operator convenience.
 * Configuration is already database-only; this script now removes stale
 * legacy config keys from the current workspace database and deletes the
 * deprecated runtime-config.json file if it exists.
 */

import path from "node:path";
import { loadConfig, resolveAiloopHome, resolveConfigDbPath } from "../src/config/env";
import { readRuntimeLoopConfig } from "../src/config/runtime";
import { DatabaseManager } from "../src/utils/db";

const LEGACY_KEYS = [
  "AILOOP_HOME",
  "AILOOP_AI_CLI_TIMEOUT_MS",
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
  const runtimeConfigPath = path.join(homeDir, "runtime-config.json");
  const config = loadConfig();
  const db = new DatabaseManager({ dbPath });

  try {
    await readRuntimeLoopConfig(config);

    for (const key of LEGACY_KEYS) {
      await db.deleteConfig(key);
    }

    console.log("Configuration is already database-only.");
    console.log(`Cleaned legacy keys in ${dbPath}:`);
    for (const key of LEGACY_KEYS) {
      console.log(`  - ${key}`);
    }
    console.log(`Migrated and removed deprecated runtime config file if present: ${runtimeConfigPath}`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error("Legacy config cleanup failed:", error);
  process.exit(1);
});
