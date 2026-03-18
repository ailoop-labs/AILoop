#!/usr/bin/env bun
import { loadConfig, loadConfigAsync } from "../src/config/env";
import { LoopEngine } from "../src/loop/engine";
import { DatabaseManager } from "../src/utils/db";
import path from "node:path";
import {
  ensureProjectRoles,
  getCliStatus,
  instructLoop,
  listRuns,
  pauseLoop,
  renderCliStatus,
  resumeLoop,
  startBackgroundLoop,
  stopLoop,
  tailLatestLog
} from "../src/loop/control";
import { sleep } from "../src/utils/time";

// Load config with database support
async function getConfig() {
  const baseConfig = loadConfig();
  const dbPath = path.join(baseConfig.homeDir, "ailoop.db");
  const db = new DatabaseManager({ dbPath });
  try {
    return await loadConfigAsync(process.env, db);
  } finally {
    db.close();
  }
}

const config = await getConfig();

async function runForeground(): Promise<void> {
  await ensureProjectRoles(config, { workspaceRoot: process.cwd(), autoRefresh: false });
  const engine = new LoopEngine(config);
  await engine.run();
}

async function printStatus(): Promise<void> {
  const status = await getCliStatus(config);
  console.log(renderCliStatus(status));
}

async function watchLogs(): Promise<void> {
  console.log("Watching latest loop logs. Press Ctrl+C to exit.");
  let lastPrinted = 0;

  while (true) {
    const lines = await tailLatestLog(config, 400);
    if (lines.length > lastPrinted) {
      const nextLines = lines.slice(lastPrinted);
      for (const line of nextLines) {
        console.log(line);
      }
      lastPrinted = lines.length;
    }
    await sleep(1000);
  }
}

async function printRecentRuns(): Promise<void> {
  const runs = await listRuns(config, 5);
  if (runs.length === 0) {
    console.log("No runs yet.");
    return;
  }

  for (const run of runs) {
    console.log(`\n=== ${run.timestamp} ===`);
    console.log(run.summary.split("\n").slice(0, 14).join("\n"));
    if (run.metrics) {
      console.log("Metrics:", JSON.stringify(run.metrics));
    }
  }
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case "run": {
      await runForeground();
      break;
    }
    case "start": {
      const result = await startBackgroundLoop(config);
      console.log(result.message);
      break;
    }
    case "stop": {
      await stopLoop(config);
      console.log("Stop requested. Loop will stop at a safe checkpoint.");
      break;
    }
    case "pause": {
      await pauseLoop(config);
      console.log("Pause requested. Loop will pause before next round.");
      break;
    }
    case "resume": {
      await resumeLoop(config);
      console.log("Resume requested.");
      break;
    }
    case "status": {
      await printStatus();
      break;
    }
    case "watch": {
      await watchLogs();
      break;
    }
    case "instruct": {
      const message = rest.join(" ").trim();
      if (!message) {
        console.error("Usage: bun run ailoop instruct <message>");
        process.exitCode = 1;
        return;
      }
      await instructLoop(config, message);
      console.log("Instruction queued for next round.");
      break;
    }
    case "history": {
      await printRecentRuns();
      break;
    }
    case "roles": {
      const subCommand = rest[0];
      if (subCommand !== "generate") {
        console.error("Usage: bun run ailoop roles generate [--regen]");
        process.exitCode = 1;
        return;
      }
      const regen = rest.includes("--regen");
      await ensureProjectRoles(config, { workspaceRoot: process.cwd(), regen });
      console.log(regen ? "Project role definitions regenerated." : "Project role definitions ensured.");
      break;
    }
    case undefined: {
      console.log([
        "Usage: bun run ailoop <command>",
        "",
        "Commands:",
        "  run",
        "  start",
        "  stop",
        "  pause",
        "  resume",
        "  status",
        "  watch",
        "  instruct <message>",
        "  history",
        "  roles generate [--regen]"
      ].join("\n"));
      break;
    }
    default: {
      console.error(`Unknown command: ${command}`);
      process.exitCode = 1;
      break;
    }
  }
}

await main();
