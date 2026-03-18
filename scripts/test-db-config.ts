#!/usr/bin/env bun
/**
 * Inspect the current workspace database-backed configuration.
 */

import { loadConfig, resolveAiloopHome, resolveConfigDbPath } from "../src/config/env";
import { DatabaseManager } from "../src/utils/db";

async function main() {
  const homeDir = resolveAiloopHome();
  const dbPath = resolveConfigDbPath(homeDir);
  const db = new DatabaseManager({ dbPath });

  try {
    const storedConfig = await db.getAllConfig();
    const resolvedConfig = loadConfig();

    console.log("Workspace home:", homeDir);
    console.log("Database path:", dbPath);
    console.log("Stored config keys:", Object.keys(storedConfig).length);
    console.log("Resolved AI CLI bin:", resolvedConfig.ai.bin);
    console.log("Resolved console port:", resolvedConfig.consolePort);
    console.log("Resolved round budget:", resolvedConfig.budget.usdPerRound);
    console.log("");
    console.log("Database entries:");

    for (const [key, value] of Object.entries(storedConfig).sort(([left], [right]) => left.localeCompare(right))) {
      const displayValue = key.includes("TOKEN") || key.includes("KEY") || key.includes("SECRET") ? "***" : value;
      console.log(`  ${key}: ${displayValue}`);
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error("Configuration inspection failed:", error);
  process.exit(1);
});
