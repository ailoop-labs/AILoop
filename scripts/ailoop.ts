#!/usr/bin/env bun
import { loadConfig } from "../src/config/env";
import { LoopEngine } from "../src/loop/engine";
import {
  ensureProjectRoles,
  getCliStatus,
  instructLoop,
  listRuns,
  pauseLoop,
  renderCliStatus,
  resumeLoop,
  runExternalValidationMetricsReport,
  runExternalValidationPreflight,
  startBackgroundLoop,
  stopLoop,
  tailLatestLog
} from "../src/loop/control";
import { sleep } from "../src/utils/time";

async function runForeground(): Promise<void> {
  const config = loadConfig();
  await ensureProjectRoles(config, { workspaceRoot: process.cwd(), autoRefresh: false });
  const engine = new LoopEngine(config);
  await engine.run();
}

async function printStatus(): Promise<void> {
  const config = loadConfig();
  const status = await getCliStatus(config);
  console.log(renderCliStatus(status));
}

async function watchLogs(): Promise<void> {
  const config = loadConfig();
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
  const config = loadConfig();
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
      const config = loadConfig();
      const result = await startBackgroundLoop(config);
      console.log(result.message);
      break;
    }
    case "stop": {
      const config = loadConfig();
      await stopLoop(config);
      console.log("Stop requested. Loop will stop at a safe checkpoint.");
      break;
    }
    case "pause": {
      const config = loadConfig();
      await pauseLoop(config);
      console.log("Pause requested. Loop will pause before next round.");
      break;
    }
    case "resume": {
      const config = loadConfig();
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
      const config = loadConfig();
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
      const config = loadConfig();
      await ensureProjectRoles(config, { workspaceRoot: process.cwd(), regen });
      console.log(regen ? "Project role definitions regenerated." : "Project role definitions ensured.");
      break;
    }
    case "external-validation": {
      const subCommand = rest[0];
      if (subCommand === "preflight") {
        const repoPath = rest.slice(1).join(" ").trim();
        if (!repoPath) {
          console.error("Usage: bun run ailoop external-validation preflight <repo-path>");
          process.exitCode = 1;
          return;
        }

        const report = await runExternalValidationPreflight(repoPath);
        console.log(report.report);
        if (!report.result.eligible) {
          process.exitCode = 1;
        }
        break;
      }

      if (subCommand === "report") {
        if (rest.length > 1) {
          console.error("Usage: bun run ailoop external-validation report");
          process.exitCode = 1;
          return;
        }

        const config = loadConfig();
        const report = await runExternalValidationMetricsReport(config);
        console.log(report.report);
        break;
      }

      console.error(
        [
          "Usage:",
          "  bun run ailoop external-validation preflight <repo-path>",
          "  bun run ailoop external-validation report"
        ].join("\n")
      );
      process.exitCode = 1;
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
        "  roles generate [--regen]",
        "  external-validation preflight <repo-path>",
        "  external-validation report"
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
