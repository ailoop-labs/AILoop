import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseManager } from "../utils/db";
import {
  ensureProjectRoleDefinitions,
  loadProjectRoleDefinition,
  type EnsureProjectRoleDefinitionsOptions,
  type ProjectRole
} from "../agent/role-definitions";
import type { AppConfig } from "../config/env";
import { readRuntimeLoopConfig, runtimeLoopConfigToEnv } from "../config/runtime";
import { readActiveRequirementSnapshot } from "../product/requirements";
import { buildRoundArtifactPaths, listRunRecords, readLastLogTail } from "../reporting/summary";
import type {
  BudgetLimits,
  CrashRecoveryStatus,
  EvaluationResult,
  LoopStateData,
  RequirementArtifactSnapshot
} from "../types/contracts";
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
  parseCrashRecoveryMessage,
  readLoopState,
  readPid,
  recoverInterruptedLoopState,
  setFlag,
  writeLoopState
} from "./state";
import type { LoopPaths } from "./state";

const startOperations = new Map<string, Promise<{ started: boolean; message: string }>>();
const resumeOperations = new Map<string, Promise<void>>();

export async function ensureProjectRoles(
  config: AppConfig,
  options: EnsureProjectRoleDefinitionsOptions = {}
): Promise<void> {
  await ensureProjectRoleDefinitions(config, {
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    regen: options.regen ?? false,
    autoRefresh: options.autoRefresh ?? false,
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
    return "Project Planner";
  }
  if (role === "product_manager") {
    return "Product Manager";
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
  if (role === "product_manager") {
    return paths.productManagerRolePath;
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

function redactRequirementSnapshot(snapshot: RequirementArtifactSnapshot, redactor: SecretRedactor): RequirementArtifactSnapshot {
  return {
    ...snapshot,
    title: snapshot.title ? redactor.redact(snapshot.title) : null,
    summary: snapshot.summary ? redactor.redact(snapshot.summary) : null,
    markdown: snapshot.markdown ? redactor.redact(snapshot.markdown) : null
  };
}

export async function listProjectRoles(config: AppConfig): Promise<ProjectRoleView[]> {
  const paths = await ensureLoopHomeAndGetPaths(config);

  const roles: ProjectRole[] = ["planner", "product_manager", "executor", "evaluator"];
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
  const existingOperation = startOperations.get(config.homeDir);
  if (existingOperation) {
    return await existingOperation;
  }

  let resolveOperation!: (value: { started: boolean; message: string }) => void;
  let rejectOperation!: (reason?: unknown) => void;
  const operation = new Promise<{ started: boolean; message: string }>((resolve, reject) => {
    resolveOperation = resolve;
    rejectOperation = reject;
  });
  startOperations.set(config.homeDir, operation);

  try {
    const paths = await ensureLoopHomeAndGetPaths(config);

    const currentState = await readLoopState(paths);
    const recordedPid = await readPid(paths);
    const livePid = [recordedPid, currentState.pid].find(
      (pid): pid is number => typeof pid === "number" && isPidAlive(pid)
    );
    if (currentState.state !== "idle" && livePid) {
      const result = { started: false, message: `Loop already running with pid ${livePid}` };
      resolveOperation(result);
      return result;
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

    const result = { started: true, message: `Loop started with pid ${child.pid}` };
    await writeLoopState(paths, {
      ...currentState,
      state: "starting",
      pid: child.pid ?? null,
      last_error: null,
      current_budget: null
    });
    child.unref();
    resolveOperation(result);
    return result;
  } catch (error) {
    rejectOperation(error);
    throw error;
  } finally {
    if (startOperations.get(config.homeDir) === operation) {
      startOperations.delete(config.homeDir);
    }
  }
}

export async function prepareStartFlags(paths: LoopPaths): Promise<void> {
  await clearFlag(paths.stopFlagPath);
  await clearFlag(paths.pauseFlagPath);
}

export async function stopLoop(config: AppConfig): Promise<void> {
  const paths = await ensureLoopHomeAndGetPaths(config);
  await setFlag(paths.stopFlagPath);

  // If no process is actually running, we should transition the state to idle immediately
  // otherwise it stays stuck in 'paused' or 'running' forever in the DB.
  const state = await readLoopState(paths);
  const pid = state.pid ?? (await readPid(paths));
  const pidAlive = pid ? isPidAlive(pid) : false;

  if (!pidAlive) {
    await writeLoopState(paths, {
      ...state,
      state: "idle",
      pid: null,
      current_budget: null
    });
    await clearFlag(paths.pauseFlagPath);
  }
}

export async function pauseLoop(config: AppConfig): Promise<void> {
  const paths = await ensureLoopHomeAndGetPaths(config);
  await setFlag(paths.pauseFlagPath);
}

export async function resumeLoop(config: AppConfig): Promise<void> {
  const existingOperation = resumeOperations.get(config.homeDir);
  if (existingOperation) {
    await existingOperation;
    return;
  }

  const operation = (async () => {
    const paths = await ensureLoopHomeAndGetPaths(config);
    await clearFlag(paths.pauseFlagPath);

    const state = await readLoopState(paths);
    const pid = state.pid ?? (await readPid(paths));
    if (state.state !== "paused") {
      return;
    }

    if (pid && isPidAlive(pid)) {
      await writeLoopState(paths, {
        ...state,
        state: "running",
        pid
      });
      return;
    }

    if (pid) {
      await clearPid(paths);
    }

    await startBackgroundLoop(config);
  })();

  resumeOperations.set(config.homeDir, operation);

  try {
    await operation;
  } finally {
    if (resumeOperations.get(config.homeDir) === operation) {
      resumeOperations.delete(config.homeDir);
    }
  }
}

export async function instructLoop(config: AppConfig, message: string): Promise<void> {
  const paths = await ensureLoopHomeAndGetPaths(config);
  await appendInstruction(paths, message);
}

export interface LoopStatusView extends LoopStateData {
  pid_alive: boolean;
  crash_recovery: CrashRecoveryStatus | null;
  active_requirement: RequirementArtifactSnapshot;
}

function deriveCrashRecoveryStatus(state: LoopStateData, statusCheckFinalized: boolean): CrashRecoveryStatus | null {
  if (state.state !== "paused") {
    return null;
  }

  const parsed = parseCrashRecoveryMessage(state.last_error);
  if (!parsed) {
    return null;
  }

  return {
    ...parsed,
    status_check_finalized: statusCheckFinalized
  };
}

export async function getLoopStatus(config: AppConfig): Promise<LoopStatusView> {
  const paths = await ensureLoopHomeAndGetPaths(config);
  const redactor = new SecretRedactor(process.env);
  const activeRequirement = redactRequirementSnapshot(await readActiveRequirementSnapshot(paths), redactor);

  const recovered = await recoverInterruptedLoopState(paths, "status check");
  if (recovered) {
    return {
      ...recovered,
      pid_alive: false,
      crash_recovery: deriveCrashRecoveryStatus(recovered, true),
      active_requirement: activeRequirement
    };
  }

  const state = await readLoopState(paths);
  const pid = state.pid ?? (await readPid(paths));
  const pidAlive = pid ? isPidAlive(pid) : false;

  // Ensure idle state doesn't have stale budget/PID
  if (state.state === "idle" && (state.current_budget || state.pid)) {
    const normalized = {
      ...state,
      pid: null,
      current_budget: null
    };
    await writeLoopState(paths, normalized);
    return {
      ...normalized,
      pid_alive: false,
      crash_recovery: null,
      active_requirement: activeRequirement
    };
  }

  return {
    ...state,
    pid: pid ?? null,
    pid_alive: pidAlive,
    crash_recovery: deriveCrashRecoveryStatus(state, false),
    active_requirement: activeRequirement
  };
}

export interface CliStatusPayload {
  state: LoopStatusView;
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

function formatRoundContext(round: number): string {
  return round > 0 ? `run round ${round}` : "not started";
}

function formatBudgetLimits(budget: BudgetLimits): string {
  return `$${budget.usdPerRound}/round, ${budget.timeMinutes}m, ${budget.actions} actions`;
}

export function renderCliStatus(status: CliStatusPayload): string {
  const lines = [
    `State: ${status.state.state}`,
    `Round context: ${formatRoundContext(status.state.round)}`,
    `Process alive: ${status.state.pid_alive ? "yes" : "no"}`,
    `Budget limits: ${formatBudgetLimits(status.budget)}`
  ];

  const crashRecovery = status.state.crash_recovery;
  if (crashRecovery) {
    lines.push("Reason: Crash recovery");
    lines.push(`Interruption: ${crashRecovery.interruption_type === "startup_interrupted" ? "startup interrupted" : "round interrupted"}`);
    if (crashRecovery.interruption_type === "round_interrupted") {
      lines.push(`Interrupted during: ${crashRecovery.interrupted_state}`);
    }
    lines.push(`Round incomplete: ${crashRecovery.incomplete_work ? "yes" : "no"}`);
    lines.push(`Details: ${crashRecovery.summary}`);
    lines.push(
      crashRecovery.status_check_finalized
        ? "Recovery was finalized during this status check."
        : "Run is already paused for crash review."
    );
    lines.push(`Next safe action: ${crashRecovery.next_action}`);
    return lines.join("\n");
  }

  if (status.state.last_error) {
    lines.push(`Last error: ${status.state.last_error}`);
  }

  if (status.state.current_budget) {
    const { usage } = status.state.current_budget;
    lines.push(
      `Current budget usage: $${usage.usdUsed}, ${usage.elapsedMs}ms, ${usage.actionsUsed} actions`
    );
  }

  if (status.state.active_requirement.summary) {
    lines.push(`Active requirement: ${status.state.active_requirement.summary}`);
  }

  return lines.join("\n");
}

export async function listRuns(config: AppConfig, limit = 20): Promise<
  Array<{
    timestamp: string;
    round: number;
    summary: string;
    metrics: Record<string, unknown> | null;
    evaluation: EvaluationResult | null;
  }>
> {
  const paths = await ensureLoopHomeAndGetPaths(config);
  const records = await listRunRecords(paths.runsDir, limit);
  const db = new DatabaseManager({ dbPath: paths.dbPath });
  const dbRounds = await db.getLatestRounds(limit);
  db.close();
  const roundsByTimestamp = new Map(
    (dbRounds as Array<{ run_timestamp: string; round_id: number }>).map((record) => [record.run_timestamp, record.round_id])
  );
  const redactor = new SecretRedactor(process.env);

  return await Promise.all(
    records.map(async (record) => {
      const [summary, metrics, evaluation] = await Promise.all([
        readTextFile(record.summaryPath, ""),
        readJsonFile<Record<string, unknown> | null>(record.metricsPath, null),
        record.evaluationPath ? readJsonFile<EvaluationResult | null>(record.evaluationPath, null) : Promise.resolve(null)
      ]);
      const metricsRound = typeof metrics?.round === "number" ? metrics.round : null;
      const round = roundsByTimestamp.get(record.timestamp) ?? metricsRound ?? 0;

      return {
        timestamp: record.timestamp,
        round,
        summary: redactor.redact(summary),
        metrics,
        evaluation: evaluation ? redactJsonStrings(evaluation, redactor) : null
      };
    })
  );
}

export interface RunArtifactBundle {
  timestamp: string;
  summary: string;
  metrics: Record<string, unknown>;
  log: string;
  state_change: string;
  evaluation: EvaluationResult | null;
  active_requirement: RequirementArtifactSnapshot;
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
  const activeRequirement = await readActiveRequirementSnapshot(paths);
  const artifactPaths = buildRoundArtifactPaths(paths.runsDir, normalizedTimestamp);
  const requiredArtifactsExist = await Promise.all([
    fileExists(artifactPaths.summaryPath),
    fileExists(artifactPaths.metricsPath),
    fileExists(artifactPaths.logPath),
    fileExists(artifactPaths.stateChangePath),
    fileExists(artifactPaths.evaluationPath)
  ]);

  if (requiredArtifactsExist.some((exists) => !exists)) {
    return null;
  }

  const [summary, metrics, log, stateChange, evaluation] = await Promise.all([
    readTextFile(artifactPaths.summaryPath, ""),
    readJsonFile<Record<string, unknown> | null>(artifactPaths.metricsPath, null),
    readTextFile(artifactPaths.logPath, ""),
    readTextFile(artifactPaths.stateChangePath, ""),
    readJsonFile<EvaluationResult | null>(artifactPaths.evaluationPath, null)
  ]);

  if (!metrics) {
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
    evaluation: evaluation ? redactJsonStrings(evaluation, redactor) : null,
    active_requirement: {
      ...activeRequirement,
      markdown: activeRequirement.markdown ? redact(activeRequirement.markdown) : null,
      summary: activeRequirement.summary ? redact(activeRequirement.summary) : null
    }
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
