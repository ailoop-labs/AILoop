#!/usr/bin/env bun
/**
 * Migration script to move configuration from .env file to SQLite database
 */

import { loadConfig, saveConfigToDb } from "../src/config/env";
import { DatabaseManager } from "../src/utils/db";
import path from "node:path";

async function main() {
  console.log("Starting configuration migration to database...");

  // Load config from environment variables
  const config = loadConfig();
  console.log(`Loaded configuration from environment`);
  console.log(`Home directory: ${config.homeDir}`);

  // Initialize database
  const dbPath = path.join(config.homeDir, "ailoop.db");
  const db = new DatabaseManager({ dbPath });
  console.log(`Database initialized at: ${dbPath}`);

  try {
    // Save all config to database
    await saveConfigToDb(config, db);
    console.log("✓ Configuration successfully migrated to database");

    // Verify by reading back
    const savedConfig = await db.getAllConfig();
    console.log(`\n✓ Verified ${Object.keys(savedConfig).length} configuration keys in database:`);
    for (const [key, value] of Object.entries(savedConfig)) {
      // Mask sensitive values
      const displayValue = key.includes("TOKEN") || key.includes("KEY")
        ? "***"
        : value;
      console.log(`  ${key}: ${displayValue}`);
    }
  } finally {
    db.close();
  }

  console.log("\n✓ Migration complete!");
  console.log("\nNext steps:");
  console.log("1. Restart AILoop to use database configuration");
  console.log("2. You can now manage config via the web console or API");
  console.log("3. Environment variables will still work as fallback");
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
