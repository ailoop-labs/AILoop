import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  ensureProjectRoleDefinitions,
  loadProjectRoleDefinition,
  type EnsureProjectRoleDefinitionsOptions,
  type ProjectRole
} from "../agent/role-definitions";
import type { AppConfig } from "../config/env";
import { readRuntimeLoopConfig, runtimeLoopConfigToEnv } from "../config/runtime";
import { listRunRecords, readLastLogTail } from "../reporting/summary";
import type { BudgetLimits, LoopStateData } from "../types/contracts";
import { fileExists, readJsonFile, readTextFile } from "../utils/fs";

export async function buildDeterministicGoal(workspaceRoot: string = process.cwd()): Promise<string> {
  const goalMd = await readTextFile(path.join(workspaceRoot, "GOAL.md"), "");
  if (goalMd.trim()) {
    return goalMd;
  }
  const readmeMd = await readTextFile(path.join(workspaceRoot, "README.md"), "");
  if (readmeMd.trim()) {
    return `# Project Goal (Derived from README.md)\n\n${readmeMd}`;
  }
  return "# AutoLoop Goal\n\nDescribe the top-level goal this autonomous loop should pursue. Keep it outcome-focused and measurable.\n";
}

import {
  appendInstruction,
  buildLoopPaths,
  clearFlag,
  defaultLoopState,
  ensureLoopHome,
  readLoopState,
  readPid,
  setFlag,
  writeLoopState
} from "./state";
import type { LoopPaths } from "./state";

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function ensureProjectRoles(
  config: AppConfig,
  options: EnsureProjectRoleDefinitionsOptions = {}
): Promise<void> {
  await ensureProjectRoleDefinitions(config, {
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    regen: options.regen ?? false,
    codexClient: options.codexClient
  });
}

export interface ProjectRoleView {
  role: ProjectRole;
  title: string;
  path: string;
  exists: boolean;
  definition: string;
}

function roleTitle(role: ProjectRole): string {
  if (role === "planner") {
    return "Planner";
  }
  if (role === "executor") {
    return "Executor";
  }
  return "Evaluator";
}

function rolePath(paths: LoopPaths, role: ProjectRole): string {
  if (role === "planner") {
    return paths.plannerRolePath;
  }
  if (role === "executor") {
    return paths.executorRolePath;
  }
  return paths.evaluatorRolePath;
}

export async function ensureLoopHomeWithGoal(config: AppConfig): Promise<LoopPaths> {
  const paths = buildLoopPaths(config.homeDir);
  const exists = await fileExists(paths.goalPath);
  let shouldGenerate = !exists;

  if (exists) {
    const content = await readTextFile(paths.goalPath, "");
    if (content.trim() === "# AutoLoop Goal\n\nDescribe the top-level goal this autonomous loop should pursue. Keep it outcome-focused and measurable.") {
      shouldGenerate = true;
    }
  }

  if (shouldGenerate) {
    await ensureLoopHome(paths, await buildDeterministicGoal(process.cwd()));
  } else {
    await ensureLoopHome(paths);
  }
  return paths;
}

export async function listProjectRoles(config: AppConfig): Promise<ProjectRoleView[]> {
  const paths = await ensureLoopHomeWithGoal(config);

  const roles: ProjectRole[] = ["planner", "executor", "evaluator"];
  const output: ProjectRoleView[] = [];

  for (const role of roles) {
    const targetPath = rolePath(paths, role);
    const exists = await fileExists(targetPath);
    output.push({
      role,
      title: roleTitle(role),
      path: targetPath,
      exists,
      definition: await loadProjectRoleDefinition(config.homeDir, role)
    });
  }

  return output;
}

export async function startBackgroundLoop(config: AppConfig): Promise<{ started: boolean; message: string }> {
  const paths = await ensureLoopHomeWithGoal(config);
  await ensureProjectRoles(config, { workspaceRoot: process.cwd(), regen: false });

  const existingPid = await readPid(paths);
  if (existingPid && isPidAlive(existingPid)) {
    return { started: false, message: `Loop already running with pid ${existingPid}` };
  }

  await prepareStartFlags(paths);
  const runtimeConfig = await readRuntimeLoopConfig(config);
  const runtimeEnv = runtimeLoopConfigToEnv(runtimeConfig);
  const child = spawn("bun", ["run", "scripts/autoloop.ts", "run"], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ...runtimeEnv
    }
  });
  child.unref();

  return { started: true, message: `Loop started with pid ${child.pid}` };
}

export async function prepareStartFlags(paths: LoopPaths): Promise<void> {
  await clearFlag(paths.stopFlagPath);
  await clearFlag(paths.pauseFlagPath);
}

export async function stopLoop(config: AppConfig): Promise<void> {
  const paths = await ensureLoopHomeWithGoal(config);
  await setFlag(paths.stopFlagPath);
}

export async function pauseLoop(config: AppConfig): Promise<void> {
  const paths = await ensureLoopHomeWithGoal(config);
  await setFlag(paths.pauseFlagPath);
}

export async function resumeLoop(config: AppConfig): Promise<void> {
  const paths = await ensureLoopHomeWithGoal(config);
  await clearFlag(paths.pauseFlagPath);

  const state = await readLoopState(paths);
  const pid = state.pid ?? (await readPid(paths));
  if (state.state !== "paused" || !pid || !isPidAlive(pid)) {
    return;
  }

  await writeLoopState(paths, {
    ...state,
    state: "running",
    pid
  });
}

export async function instructLoop(config: AppConfig, message: string): Promise<void> {
  const paths = await ensureLoopHomeWithGoal(config);
  await appendInstruction(paths, message);
}

export async function getLoopStatus(config: AppConfig): Promise<LoopStateData & { pid_alive: boolean }> {
  const paths = await ensureLoopHomeWithGoal(config);

  const state = await readLoopState(paths);
  const pid = state.pid ?? (await readPid(paths));
  const pidAlive = pid ? isPidAlive(pid) : false;

  if ((state.state === "running" || state.state === "cooldown") && !pidAlive) {
    const recovered = defaultLoopState(null);
    recovered.last_error = "Process was not alive during status check";
    await writeLoopState(paths, recovered);
    return { ...recovered, pid_alive: false };
  }

  if (!pidAlive && state.state !== "running") {
    const normalized = {
      ...state,
      pid: null,
      current_budget: state.state === "idle" ? null : state.current_budget
    };
    await writeLoopState(paths, normalized);
    return {
      ...normalized,
      pid_alive: false
    };
  }

  if (state.state === "idle" && state.current_budget) {
    const normalized = {
      ...state,
      pid: pid ?? null,
      current_budget: null
    };
    await writeLoopState(paths, normalized);
    return {
      ...normalized,
      pid_alive: pidAlive
    };
  }

  return {
    ...state,
    pid: pid ?? null,
    pid_alive: pidAlive
  };
}

export interface CliStatusPayload {
  state: LoopStateData & { pid_alive: boolean };
  budget: BudgetLimits;
}

export async function getCliStatus(config: AppConfig): Promise<CliStatusPayload> {
  const [state, runtimeConfig] = await Promise.all([getLoopStatus(config), readRuntimeLoopConfig(config)]);
  return {
    state,
    budget: {
      ...runtimeConfig.budget
    }
  };
}

export async function listRuns(config: AppConfig, limit = 20): Promise<
  Array<{
    timestamp: string;
    summary: string;
    metrics: Record<string, unknown> | null;
  }>
> {
  const paths = await ensureLoopHomeWithGoal(config);
  const records = await listRunRecords(paths.runsDir, limit);

  const output: Array<{
    timestamp: string;
    summary: string;
    metrics: Record<string, unknown> | null;
  }> = [];

  for (const record of records) {
    const summary = await fs.readFile(record.summaryPath, "utf8");
    const metrics = await readJsonFile<Record<string, unknown> | null>(record.metricsPath, null);
    output.push({
      timestamp: record.timestamp,
      summary,
      metrics
    });
  }

  return output;
}

export async function tailLatestLog(config: AppConfig, lines = 200): Promise<string[]> {
  const paths = await ensureLoopHomeWithGoal(config);
  const entries = await fs.readdir(paths.runsDir);
  const latestLog = entries
    .filter((entry) => entry.endsWith(".round.log"))
    .sort((a, b) => b.localeCompare(a))[0];
  if (!latestLog) {
    return [];
  }

  return readLastLogTail(path.join(paths.runsDir, latestLog), lines);
}

export async function readGoal(config: AppConfig): Promise<string> {
  const paths = await ensureLoopHomeWithGoal(config);
  return readTextFile(paths.goalPath, "");
}

export function resolveWebDistPath(): string {
  return path.join(process.cwd(), "web", "dist");
}
