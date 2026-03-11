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
import { buildRoundArtifactPaths, listRunRecords, readLastLogTail } from "../reporting/summary";
import type { BudgetLimits, EvaluationResult, LoopStateData } from "../types/contracts";
import { fileExists, readJsonFile, readTextFile } from "../utils/fs";
import { redactJsonStrings, SecretRedactor } from "../utils/redaction";

export async function buildDeterministicGoal(workspaceRoot: string = process.cwd()): Promise<string> {
  const goalMd = await readTextFile(path.join(workspaceRoot, "GOAL.md"), "");
  if (goalMd.trim()) {
    return goalMd;
  }
  const readmeMd = await readTextFile(path.join(workspaceRoot, "README.md"), "");
  if (readmeMd.trim()) {
    return `# Project Goal (Derived from README.md)\n\n${readmeMd}`;
  }
  return "# AILoop Goal\n\nDescribe the top-level goal this autonomous loop should pursue. Keep it outcome-focused and measurable.\n";
}

import {
  appendInstruction,
  buildLoopPaths,
  clearPid,
  clearFlag,
  defaultLoopState,
  ensureLoopHome,
  isPidAlive,
  readLoopState,
  readPid,
  recoverInterruptedLoopState,
  setFlag,
  writeLoopState
} from "./state";
import type { LoopPaths } from "./state";

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

export async function ensureLoopHomeAndGetPaths(config: AppConfig): Promise<LoopPaths> {
  const paths = buildLoopPaths(config.homeDir);
  await ensureLoopHome(paths);
  return paths;
}

export async function listProjectRoles(config: AppConfig): Promise<ProjectRoleView[]> {
  const paths = await ensureLoopHomeAndGetPaths(config);

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
  const paths = await ensureLoopHomeAndGetPaths(config);
  await ensureProjectRoles(config, { workspaceRoot: process.cwd(), regen: false });

  const existingPid = await readPid(paths);
  if (existingPid && isPidAlive(existingPid)) {
    return { started: false, message: `Loop already running with pid ${existingPid}` };
  }

  await prepareStartFlags(paths);
  const runtimeConfig = await readRuntimeLoopConfig(config);
  const runtimeEnv = runtimeLoopConfigToEnv(runtimeConfig);
  const child = spawn("bun", ["run", "scripts/ailoop.ts", "run"], {
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
  const paths = await ensureLoopHomeAndGetPaths(config);
  await setFlag(paths.stopFlagPath);
}

export async function pauseLoop(config: AppConfig): Promise<void> {
  const paths = await ensureLoopHomeAndGetPaths(config);
  await setFlag(paths.pauseFlagPath);
}

export async function resumeLoop(config: AppConfig): Promise<void> {
  const paths = await ensureLoopHomeAndGetPaths(config);
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
  const paths = await ensureLoopHomeAndGetPaths(config);
  await appendInstruction(paths, message);
}

export async function getLoopStatus(config: AppConfig): Promise<LoopStateData & { pid_alive: boolean }> {
  const paths = await ensureLoopHomeAndGetPaths(config);

  const recovered = await recoverInterruptedLoopState(paths, "status check");
  if (recovered) {
    return { ...recovered, pid_alive: false };
  }

  const state = await readLoopState(paths);
  const pid = state.pid ?? (await readPid(paths));
  const pidAlive = pid ? isPidAlive(pid) : false;

  if (!pidAlive && state.state !== "running") {
    if (pid) {
      await clearPid(paths);
    }
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
    evaluation: EvaluationResult | null;
  }>
> {
  const paths = await ensureLoopHomeAndGetPaths(config);
  const records = await listRunRecords(paths.runsDir, limit);

  const output: Array<{
    timestamp: string;
    summary: string;
    metrics: Record<string, unknown> | null;
    evaluation: EvaluationResult | null;
  }> = [];

  for (const record of records) {
    const summary = await fs.readFile(record.summaryPath, "utf8");
    const metrics = await readJsonFile<Record<string, unknown> | null>(record.metricsPath, null);
    const evaluation = await readJsonFile<EvaluationResult | null>(record.evaluationPath ?? "", null);
    output.push({
      timestamp: record.timestamp,
      summary,
      metrics,
      evaluation
    });
  }

  return output;
}

export interface RunArtifactBundle {
  timestamp: string;
  summary: string;
  metrics: Record<string, unknown>;
  log: string;
  state_change: string;
  evaluation: EvaluationResult;
}

const RUN_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

function isValidRunTimestamp(timestamp: string): boolean {
  return RUN_TIMESTAMP_PATTERN.test(timestamp);
}

export async function getRunArtifacts(config: AppConfig, timestamp: string): Promise<RunArtifactBundle | null> {
  const normalizedTimestamp = timestamp.trim();
  if (!isValidRunTimestamp(normalizedTimestamp)) {
    return null;
  }

  const paths = await ensureLoopHomeAndGetPaths(config);
  const artifactPaths = buildRoundArtifactPaths(paths.runsDir, normalizedTimestamp);
  const hasRequiredArtifacts = await Promise.all([
    fileExists(artifactPaths.summaryPath),
    fileExists(artifactPaths.metricsPath),
    fileExists(artifactPaths.logPath),
    fileExists(artifactPaths.stateChangePath),
    fileExists(artifactPaths.evaluationPath)
  ]);

  if (hasRequiredArtifacts.some((exists) => !exists)) {
    return null;
  }

  const [summary, metrics, log, stateChange, evaluation] = await Promise.all([
    readTextFile(artifactPaths.summaryPath, ""),
    readJsonFile<Record<string, unknown> | null>(artifactPaths.metricsPath, null),
    readTextFile(artifactPaths.logPath, ""),
    readTextFile(artifactPaths.stateChangePath, ""),
    readJsonFile<EvaluationResult | null>(artifactPaths.evaluationPath, null)
  ]);

  if (!metrics || !evaluation) {
    return null;
  }

  const redactor = new SecretRedactor(process.env);
  const redact = (text: string) => redactor.redact(text);

  return {
    timestamp: normalizedTimestamp,
    summary: redact(summary),
    metrics,
    log: redact(log),
    state_change: redact(stateChange),
    evaluation: redactJsonStrings(evaluation, redactor)
  };
}

export async function tailLatestLog(config: AppConfig, lines = 200): Promise<string[]> {
  const paths = await ensureLoopHomeAndGetPaths(config);
  const entries = await fs.readdir(paths.runsDir);
  const latestLog = entries
    .filter((entry) => entry.endsWith(".round.log"))
    .sort((a, b) => b.localeCompare(a))[0];
  if (!latestLog) {
    return [];
  }

  const redactor = new SecretRedactor(process.env);
  const tail = await readLastLogTail(path.join(paths.runsDir, latestLog), lines);
  return tail.map((line) => redactor.redact(line));
}

export async function readGoal(_config: AppConfig): Promise<string> {
  return buildDeterministicGoal(process.cwd());
}

export function resolveWebDistPath(): string {
  return path.join(process.cwd(), "web", "dist");
}
