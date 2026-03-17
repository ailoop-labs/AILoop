#!/usr/bin/env bun
/**
 * Test script to verify database configuration is working
 */

import { loadConfig, loadConfigAsync } from "../src/config/env";
import { DatabaseManager } from "../src/utils/db";
import path from "node:path";

async function main() {
  console.log("Testing database configuration loading...\n");

  // Load config without database (from env only)
  const envConfig = loadConfig();
  console.log("1. Config from environment variables:");
  console.log(`   CODEX_BIN: ${envConfig.codex.bin}`);
  console.log(`   BUDGET_USD: ${envConfig.budget.usdPerRound}`);
  console.log(`   TIMEOUT_MS: ${envConfig.codex.timeoutMs}`);

  // Load config with database
  const dbPath = path.join(envConfig.homeDir, "ailoop.db");
  const db = new DatabaseManager({ dbPath });

  try {
    const dbConfig = await loadConfigAsync(process.env, db);
    console.log("\n2. Config from database (with env fallback):");
    console.log(`   CODEX_BIN: ${dbConfig.codex.bin}`);
    console.log(`   BUDGET_USD: ${dbConfig.budget.usdPerRound}`);
    console.log(`   TIMEOUT_MS: ${dbConfig.codex.timeoutMs}`);

    // Check database values directly
    console.log("\n3. Direct database values:");
    const allConfig = await db.getAllConfig();
    console.log(`   Total keys in DB: ${Object.keys(allConfig).length}`);
    console.log(`   AILOOP_CODEX_BIN: ${allConfig.AILOOP_CODEX_BIN}`);
    console.log(`   AILOOP_BUDGET_USD_PER_ROUND: ${allConfig.AILOOP_BUDGET_USD_PER_ROUND}`);

    // Verify Claude CLI is configured
    if (dbConfig.codex.bin.includes("claude")) {
      console.log("\n✓ SUCCESS: Claude CLI is configured in database!");
    } else {
      console.log("\n✗ WARNING: Claude CLI not found in config");
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
