import fs from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
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
  ArtifactCompletenessStatus,
  BudgetDimension,
  BudgetDimensionHealth,
  BudgetHealthStatus,
  BudgetLimits,
  CrashRecoveryStatus,
  EvaluationResult,
  HotFileGovernanceResult,
  LoopStateData,
  OperatorStatusReason,
  RoundArtifactPresence,
  RoundArtifactKind,
  RequirementArtifactSnapshot,
  LoopStateData,
  LoopStateName
} from "../types/contracts";
import { fileExists, readJsonFile, readTextFile } from "../utils/fs";
import { redactJsonStrings, SecretRedactor } from "../utils/redaction";
import { buildDeterministicGoal, readGoalFile, resolveWorkspaceRootFromHome } from "./goal";

import {
  appendInstruction,
  buildLoopPaths,
  clearPid,
  clearFlag,
  defaultLoopState,
  ensureLoopHome,
  hasFlag,
  isPidAlive,
  parseCrashRecoveryMessage,
  peekInstructions,
  readLoopState,
  readPid,
  recoverInterruptedLoopState,
  setFlag,
  updateLoopState,
  writeLoopState
} from "./state";
import type { LoopPaths } from "./state";

const startOperations = new Map<string, Promise<{ started: boolean; message: string }>>();
const resumeOperations = new Map<string, Promise<void>>();
const PAUSEABLE_STATES: LoopStateName[] = ["starting", "running", "cooldown"];
const RESUMABLE_STATES: LoopStateName[] = ["paused"];
const STOPPABLE_STATES: LoopStateName[] = ["starting", "running", "cooldown", "paused"];
const LEGACY_CODEX_ENV_KEYS = [
  "AILOOP_CODEX_BIN",
  "AILOOP_CODEX_MODEL",
  "AILOOP_CODEX_PROFILE",
  "AILOOP_CODEX_PLANNER_SANDBOX",
  "AILOOP_CODEX_EXECUTOR_SANDBOX",
  "AILOOP_CODEX_EVALUATOR_SANDBOX",
  "AILOOP_CODEX_TIMEOUT_MS"
] as const;

export class InvalidLifecycleTransitionError extends Error {
  readonly code = "invalid_lifecycle_transition";
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "InvalidLifecycleTransitionError";
  }
}

function formatStateList(states: LoopStateName[]): string {
  if (states.length === 1) {
    return states[0];
  }
  if (states.length === 2) {
    return `${states[0]} or ${states[1]}`;
  }

  return `${states.slice(0, -1).join(", ")}, or ${states.at(-1)}`;
}

function mergeLoopChildEnv(runtimeEnv: Record<string, string>): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...runtimeEnv
  };

  for (const key of LEGACY_CODEX_ENV_KEYS) {
    if (!(key in runtimeEnv)) {
      delete childEnv[key];
    }
  }

  return childEnv;
}

function assertValidLifecycleControlTransition(
  action: "pause" | "resume" | "stop",
  state: LoopStateName
): void {
  const allowedStates =
    action === "pause" ? PAUSEABLE_STATES : action === "resume" ? RESUMABLE_STATES : STOPPABLE_STATES;

  if (allowedStates.includes(state)) {
    return;
  }

  throw new InvalidLifecycleTransitionError(
    `Invalid control transition: ${action} is only allowed from ${formatStateList(allowedStates)}.`
  );
}

export function resolveStartedLoopState(currentState: LoopStateData, childPid: number | null): LoopStateData {
  if (childPid && currentState.state === "running" && currentState.pid === childPid) {
    return currentState;
  }

  return {
    ...currentState,
    state: "starting",
    pid: childPid,
    last_error: null,
    current_budget: null
  };
}

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
    const loopLogFd = openSync(paths.loopLogPath, "a");
    let child;
    try {
      child = spawn("bun", ["run", "scripts/ailoop.ts", "run"], {
        cwd: process.cwd(),
        detached: true,
        stdio: ["ignore", loopLogFd, loopLogFd],
        env: mergeLoopChildEnv(runtimeEnv)
      });
    } finally {
      closeSync(loopLogFd);
    }

    const result = { started: true, message: `Loop started with pid ${child.pid}` };
    await updateLoopState(paths, (latestState) => resolveStartedLoopState(latestState, child.pid ?? null));
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

function clearPausedOperatorState(state: LoopStateData): LoopStateData {
  return {
    ...state,
    pause_reason: null,
    last_error: null,
    current_budget: null
  };
}

export async function stopLoop(config: AppConfig): Promise<void> {
  const paths = await ensureLoopHomeAndGetPaths(config);
  const state = await readLoopState(paths);
  assertValidLifecycleControlTransition("stop", state.state);

  await setFlag(paths.stopFlagPath);

  // If no process is actually running, we should transition the state to idle immediately
  // otherwise it stays stuck in 'paused' or 'running' forever in the DB.
  const pid = state.pid ?? (await readPid(paths));
  const pidAlive = pid ? isPidAlive(pid) : false;

  if (!pidAlive) {
    await writeLoopState(paths, {
      ...clearPausedOperatorState(state),
      state: "idle",
      pid: null
    });
    await clearFlag(paths.pauseFlagPath);
  }
}

export async function pauseLoop(config: AppConfig): Promise<void> {
  const paths = await ensureLoopHomeAndGetPaths(config);
  const state = await readLoopState(paths);
  assertValidLifecycleControlTransition("pause", state.state);

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
    const state = await readLoopState(paths);
    assertValidLifecycleControlTransition("resume", state.state);

    await clearFlag(paths.pauseFlagPath);
    const pid = state.pid ?? (await readPid(paths));

    if (pid && isPidAlive(pid)) {
      await writeLoopState(paths, {
        ...clearPausedOperatorState(state),
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
  pending_instruction_count: number;
  hot_file_governance: HotFileGovernanceResult | null;
  crash_recovery: CrashRecoveryStatus | null;
  operator_reason: OperatorStatusReason | null;
  budget_health: BudgetHealthStatus | null;
  artifact_completeness: ArtifactCompletenessStatus;
  active_requirement: RequirementArtifactSnapshot;
}

const ROUND_ARTIFACT_KINDS: RoundArtifactKind[] = ["log", "summary", "metrics", "state_change", "evaluation"];

const ROUND_ARTIFACT_SUFFIXES: Record<RoundArtifactKind, string> = {
  log: ".round.log",
  summary: ".round.summary.md",
  metrics: ".round.metrics.json",
  state_change: ".round.state_change.txt",
  evaluation: ".round.evaluation.json"
};

function emptyArtifactCompleteness(): ArtifactCompletenessStatus {
  return {
    kind: "none",
    label: "No artifacts yet",
    latest_round_timestamp: null,
    latest_artifact_at: null,
    present: [],
    missing: [...ROUND_ARTIFACT_KINDS]
  };
}

function classifyArtifactCompleteness(present: RoundArtifactKind[]): ArtifactCompletenessStatus["kind"] {
  if (present.length === 0) {
    return "none";
  }
  if (present.length === 1 && present[0] === "log") {
    return "log_only";
  }
  if (present.length === ROUND_ARTIFACT_KINDS.length) {
    return "full_bundle";
  }
  return "partial_bundle";
}

function labelArtifactCompleteness(kind: ArtifactCompletenessStatus["kind"]): string {
  if (kind === "log_only") {
    return "Log only";
  }
  if (kind === "partial_bundle") {
    return "Partial bundle";
  }
  if (kind === "full_bundle") {
    return "Full evidence bundle";
  }
  return "No artifacts yet";
}

function buildRoundArtifactPresence(present: RoundArtifactKind[]): RoundArtifactPresence {
  const missing = ROUND_ARTIFACT_KINDS.filter((kind) => !present.includes(kind));
  const kind = classifyArtifactCompleteness(present);

  return {
    kind,
    label: labelArtifactCompleteness(kind),
    present,
    missing
  };
}

function derivePresentArtifactKinds(record: {
  summaryPath?: string;
  metricsPath?: string;
  logPath?: string;
  stateChangePath?: string;
  evaluationPath?: string;
}): RoundArtifactKind[] {
  return ROUND_ARTIFACT_KINDS.filter((kind) => {
    if (kind === "summary") {
      return Boolean(record.summaryPath);
    }
    if (kind === "metrics") {
      return Boolean(record.metricsPath);
    }
    if (kind === "log") {
      return Boolean(record.logPath);
    }
    if (kind === "state_change") {
      return Boolean(record.stateChangePath);
    }
    return Boolean(record.evaluationPath);
  });
}

async function deriveArtifactCompleteness(paths: LoopPaths): Promise<ArtifactCompletenessStatus> {
  await fs.mkdir(paths.runsDir, { recursive: true });
  const entries = await fs.readdir(paths.runsDir, { withFileTypes: true });
  const grouped = new Map<string, { present: Set<RoundArtifactKind>; latestArtifactAt: number }>();

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    let artifactKind: RoundArtifactKind | null = null;
    for (const kind of ROUND_ARTIFACT_KINDS) {
      const suffix = ROUND_ARTIFACT_SUFFIXES[kind];
      if (entry.name.endsWith(suffix)) {
        artifactKind = kind;
        break;
      }
    }

    if (!artifactKind) {
      continue;
    }

    const timestamp = entry.name.slice(0, entry.name.length - ROUND_ARTIFACT_SUFFIXES[artifactKind].length);
    if (!isValidRunTimestamp(timestamp)) {
      continue;
    }

    const fullPath = path.join(paths.runsDir, entry.name);
    const stat = await fs.stat(fullPath);
    const record = grouped.get(timestamp) ?? { present: new Set<RoundArtifactKind>(), latestArtifactAt: 0 };
    record.present.add(artifactKind);
    record.latestArtifactAt = Math.max(record.latestArtifactAt, stat.mtimeMs);
    grouped.set(timestamp, record);
  }

  const latestRoundTimestamp = Array.from(grouped.keys()).sort((a, b) => b.localeCompare(a))[0];
  if (!latestRoundTimestamp) {
    return emptyArtifactCompleteness();
  }

  const record = grouped.get(latestRoundTimestamp);
  if (!record) {
    return emptyArtifactCompleteness();
  }

  const present = ROUND_ARTIFACT_KINDS.filter((kind) => record.present.has(kind));
  const presence = buildRoundArtifactPresence(present);

  return {
    kind: presence.kind,
    label: presence.label,
    latest_round_timestamp: latestRoundTimestamp,
    latest_artifact_at: record.latestArtifactAt > 0 ? new Date(record.latestArtifactAt).toISOString() : null,
    present: presence.present,
    missing: presence.missing
  };
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

const DEFAULT_REVIEW_ACTION = "Inspect the run state and resume explicitly when safe.";
const BUDGET_WARNING_RATIO = 0.8;
const LIVE_RUN_STALE_STATUS_MS = 15 * 60_000;

function isActiveExecutionState(state: LoopStateName): boolean {
  return state === "starting" || state === "running" || state === "cooldown" || state === "stopping";
}

function formatDurationForStatus(durationMs: number): string {
  if (durationMs < 60_000) {
    return `${Math.max(1, Math.round(durationMs / 1_000))}s`;
  }

  return `${Math.round(durationMs / 60_000)}m`;
}

async function deriveLiveRunInconsistencyReason(
  paths: LoopPaths,
  state: LoopStateData,
  pidAlive: boolean,
  latestArtifactAt: string | null
): Promise<OperatorStatusReason | null> {
  if (!pidAlive || !isActiveExecutionState(state.state)) {
    return null;
  }

  const updatedAtMs = Date.parse(state.updated_at);
  if (!Number.isFinite(updatedAtMs)) {
    return null;
  }

  const ageMs = Date.now() - updatedAtMs;
  if (ageMs < LIVE_RUN_STALE_STATUS_MS) {
    return null;
  }

  // Long-running rounds can keep streaming log/state-change artifacts without mutating the
  // persisted lifecycle row. Treat recent artifact writes as an activity heartbeat.
  const latestArtifactAtMs = latestArtifactAt ? Date.parse(latestArtifactAt) : Number.NaN;
  if (Number.isFinite(latestArtifactAtMs) && Date.now() - latestArtifactAtMs < LIVE_RUN_STALE_STATUS_MS) {
    return null;
  }

  const [pidFileExists, lockFileExists] = await Promise.all([
    fileExists(paths.pidPath),
    fileExists(paths.lockPath)
  ]);
  if (pidFileExists && lockFileExists) {
    return null;
  }

  const missingMarkers: string[] = [];
  if (!pidFileExists) {
    missingMarkers.push("pid file");
  }
  if (!lockFileExists) {
    missingMarkers.push("lock file");
  }

  return {
    kind: "engine_error",
    title: "Engine error",
    summary: [
      `The loop process is still alive, but lifecycle markers are inconsistent (${missingMarkers.join(" + ")} missing).`,
      `The state heartbeat has not advanced for ${formatDurationForStatus(ageMs)} while the run remains ${state.state}.`
    ].join(" "),
    next_action: "Inspect the live PID, stop the loop if it remains idle, then resume explicitly when safe.",
    severity: "critical"
  };
}

function formatBudgetDimensionLabel(dimension: BudgetDimension): string {
  if (dimension === "cost") {
    return "USD";
  }
  if (dimension === "time") {
    return "Time";
  }
  return "Actions";
}

function parseBudgetBreachDimension(message: string): BudgetDimension | null {
  if (/USD budget exceeded/i.test(message)) {
    return "cost";
  }
  if (/time budget exceeded/i.test(message)) {
    return "time";
  }
  if (/action budget exceeded/i.test(message)) {
    return "actions";
  }
  return null;
}

function normalizeBudgetRatio(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
    return 0;
  }
  return Number((used / limit).toFixed(4));
}

function classifyBudgetHealth(ratio: number): BudgetDimensionHealth["health"] {
  if (ratio > 1) {
    return "breached";
  }
  if (ratio >= BUDGET_WARNING_RATIO) {
    return "warning";
  }
  return "healthy";
}

function buildBudgetDimensionHealth(
  dimension: BudgetDimension,
  used: number,
  limit: number
): BudgetDimensionHealth {
  const ratio = normalizeBudgetRatio(used, limit);
  return {
    dimension,
    label: formatBudgetDimensionLabel(dimension),
    used,
    limit,
    ratio,
    health: classifyBudgetHealth(ratio)
  };
}

function deriveBudgetHealth(state: LoopStateData): BudgetHealthStatus | null {
  if (!state.current_budget) {
    return null;
  }

  const { limits, usage } = state.current_budget;
  const dimensions: BudgetDimensionHealth[] = [
    buildBudgetDimensionHealth("cost", usage.usdUsed, limits.usdPerRound),
    buildBudgetDimensionHealth("actions", usage.actionsUsed, limits.actions),
    buildBudgetDimensionHealth("time", usage.elapsedMs, limits.timeMinutes * 60_000)
  ];

  const breachedFromPauseContext = parseBudgetBreachDimension(state.last_error ?? "");
  const normalizedDimensions = breachedFromPauseContext
    ? dimensions.map((dimension) =>
        dimension.dimension === breachedFromPauseContext
          ? { ...dimension, health: "breached" as const }
          : dimension
      )
    : dimensions;
  const breachedDimension =
    breachedFromPauseContext ?? normalizedDimensions.find((dimension) => dimension.health === "breached")?.dimension ?? null;
  const overall = breachedDimension
    ? "breached"
    : normalizedDimensions.some((dimension) => dimension.health === "warning")
      ? "warning"
      : "healthy";

  return {
    overall,
    breached_dimension: breachedDimension,
    dimensions: normalizedDimensions
  };
}

function formatBudgetBreachSummary(state: LoopStateData, message: string): string {
  const breachedDimension = parseBudgetBreachDimension(message);
  const label =
    breachedDimension === "cost"
      ? "USD budget"
      : breachedDimension === "time"
        ? "time budget"
        : breachedDimension === "actions"
          ? "action budget"
          : "configured budget";

  if (!state.current_budget) {
    return `Paused because the ${label} was exceeded.`;
  }

  const { limits, usage } = state.current_budget;
  if (breachedDimension === "cost") {
    return `Paused because the USD budget was exceeded (${usage.usdUsed.toFixed(4)} / ${limits.usdPerRound}).`;
  }
  if (breachedDimension === "time") {
    return `Paused because the time budget was exceeded (${Math.round(usage.elapsedMs / 1000)}s / ${limits.timeMinutes}m).`;
  }
  if (breachedDimension === "actions") {
    return `Paused because the action budget was exceeded (${usage.actionsUsed} / ${limits.actions}).`;
  }
  return `Paused because a configured budget was exceeded.`;
}

function trimReasonPrefix(message: string, prefixPattern: RegExp): string {
  return message.replace(prefixPattern, "").trim() || message;
}

function formatHotFileGovernanceSummary(hotFileGovernance: HotFileGovernanceResult): string {
  const labels =
    hotFileGovernance.heuristic_labels.length > 0
      ? ` Labels: ${hotFileGovernance.heuristic_labels.join(", ")}.`
      : "";

  return [
    `Paused after repeated hot-file governance failures in ${hotFileGovernance.file_path}.`,
    `Class: ${hotFileGovernance.result_class}.`,
    `Reason: ${hotFileGovernance.reason}.${labels}`
  ].join(" ");
}

function formatStrategicHotFileGovernanceSummary(hotFileGovernance: HotFileGovernanceResult): string {
  const labels =
    hotFileGovernance.heuristic_labels.length > 0
      ? ` Labels: ${hotFileGovernance.heuristic_labels.join(", ")}.`
      : "";

  return [
    `Paused because the evaluator requested immediate hot-file governance review for ${hotFileGovernance.file_path}.`,
    `Class: ${hotFileGovernance.result_class}.`,
    `Reason: ${hotFileGovernance.reason}.${labels}`
  ].join(" ");
}

function resolveStrategicEvaluatorNextAction(state: LoopStateData): string {
  const dimensionAction = state.previous_evaluation_dimensions
    ?.find((dimension) => dimension.decision !== "pass")
    ?.recommended_next_action
    ?.trim();

  if (dimensionAction) {
    return dimensionAction;
  }

  return "Review the evaluator findings, adjust scope or architecture, and resume only after the governance issue is addressed.";
}

function deriveOperatorReason(
  state: LoopStateData,
  options: {
    crashRecovery: CrashRecoveryStatus | null;
    pauseRequested: boolean;
    liveRunInconsistency: OperatorStatusReason | null;
  }
): OperatorStatusReason | null {
  if (options.crashRecovery) {
    return {
      kind: "crash_recovery",
      title: "Crash recovery",
      summary: options.crashRecovery.summary,
      next_action: options.crashRecovery.next_action,
      severity: "critical"
    };
  }

  const message = state.last_error?.trim() ?? "";

  if (options.pauseRequested && state.state !== "paused") {
    return {
      kind: "manual_pause_requested",
      title: "Pause requested",
      summary: "Operator requested a pause. The engine will stop at the next safe boundary.",
      next_action: "Wait for the run to enter paused, then review and resume explicitly when safe.",
      severity: "warning"
    };
  }

  if (options.liveRunInconsistency) {
    return options.liveRunInconsistency;
  }

  if (/BudgetBreach:/i.test(message)) {
    return {
      kind: "budget_breach",
      title: "Budget breach",
      summary: formatBudgetBreachSummary(state, message),
      next_action: "Review the last budget snapshot and reduce scope or raise budgets before resuming.",
      severity: "critical"
    };
  }

  if (/^EvaluatorStrategicBlock:/i.test(message)) {
    if (state.previous_hot_file_governance) {
      return {
        kind: "hot_file_governance",
        title: "Hot-file governance block",
        summary: formatStrategicHotFileGovernanceSummary(state.previous_hot_file_governance),
        next_action: state.previous_hot_file_governance.recommended_next_action,
        severity: "critical"
      };
    }

    return {
      kind: "evaluator_strategic_block",
      title: "Strategic evaluator block",
      summary: trimReasonPrefix(message, /^EvaluatorStrategicBlock:\s*/i),
      next_action: resolveStrategicEvaluatorNextAction(state),
      severity: "critical"
    };
  }

  if (/EvaluatorFailureLimit:/i.test(message)) {
    if (state.previous_hot_file_governance) {
      return {
        kind: "hot_file_governance",
        title: "Hot-file governance block",
        summary: formatHotFileGovernanceSummary(state.previous_hot_file_governance),
        next_action: state.previous_hot_file_governance.recommended_next_action,
        severity: "critical"
      };
    }

    return {
      kind: "evaluator_failure_limit",
      title: "Evaluator failure threshold",
      summary: trimReasonPrefix(message, /^EvaluatorFailureLimit:\s*/i),
      next_action: "Inspect the evaluator findings and narrow the next sub-task before resuming.",
      severity: "critical"
    };
  }

  if (/rollback (failed|unsupported|incomplete)/i.test(message)) {
    return {
      kind: "rollback_incomplete",
      title: "Rollback incomplete",
      summary: message,
      next_action: "Inspect the workspace state and repair or revert it before resuming.",
      severity: "critical"
    };
  }

  if (/guardrail|unsafe/i.test(message)) {
    return {
      kind: "guardrail_block",
      title: "Guardrail block",
      summary: message,
      next_action: "Inspect the blocked condition and resolve it before resuming.",
      severity: "critical"
    };
  }

  if (/^(Fatal error|Governance failed):/i.test(message)) {
    return {
      kind: "engine_error",
      title: "Engine error",
      summary: trimReasonPrefix(message, /^(Fatal error|Governance failed):\s*/i),
      next_action: "Inspect the error and recover the run state before resuming.",
      severity: "critical"
    };
  }

  if (state.state === "paused" || options.pauseRequested) {
    return {
      kind: "manual_pause",
      title: "Manual pause",
      summary: message || "Run is paused and waiting for operator review.",
      next_action: DEFAULT_REVIEW_ACTION,
      severity: "warning"
    };
  }

  if (state.state === "error" && message) {
    return {
      kind: "engine_error",
      title: "Engine error",
      summary: message,
      next_action: "Inspect the error and recover the run state before continuing.",
      severity: "critical"
    };
  }

  return null;
}

export async function getLoopStatus(config: AppConfig): Promise<LoopStatusView> {
  const paths = await ensureLoopHomeAndGetPaths(config);
  const redactor = new SecretRedactor(process.env);
  const [rawActiveRequirement, artifactCompleteness, pendingInstructions] = await Promise.all([
    readActiveRequirementSnapshot(paths),
    deriveArtifactCompleteness(paths),
    peekInstructions(paths)
  ]);
  const activeRequirement = redactRequirementSnapshot(rawActiveRequirement, redactor);
  const pendingInstructionCount = pendingInstructions.length;

  const recovered = await recoverInterruptedLoopState(paths, "status check");
  if (recovered) {
    const crashRecovery = deriveCrashRecoveryStatus(recovered, true);
    return {
      ...recovered,
      pid_alive: false,
      pending_instruction_count: pendingInstructionCount,
      hot_file_governance: recovered.previous_hot_file_governance ?? null,
      crash_recovery: crashRecovery,
      operator_reason: deriveOperatorReason(recovered, {
        crashRecovery,
        pauseRequested: true
      }),
      budget_health: deriveBudgetHealth(recovered),
      artifact_completeness: artifactCompleteness,
      active_requirement: activeRequirement
    };
  }

  const state = await readLoopState(paths);
  const pid = state.pid ?? (await readPid(paths));
  const pidAlive = pid ? isPidAlive(pid) : false;
  const pauseRequested = await hasFlag(paths.pauseFlagPath);
  const liveRunInconsistency = await deriveLiveRunInconsistencyReason(
    paths,
    state,
    pidAlive,
    artifactCompleteness.latest_artifact_at
  );

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
      pending_instruction_count: pendingInstructionCount,
      hot_file_governance: normalized.previous_hot_file_governance ?? null,
      crash_recovery: null,
      operator_reason: null,
      budget_health: null,
      artifact_completeness: artifactCompleteness,
      active_requirement: activeRequirement
    };
  }

  const crashRecovery = deriveCrashRecoveryStatus(state, false);

  return {
    ...state,
    pid: pid ?? null,
    pid_alive: pidAlive,
    pending_instruction_count: pendingInstructionCount,
    hot_file_governance: state.previous_hot_file_governance ?? null,
    crash_recovery: crashRecovery,
    operator_reason: deriveOperatorReason(state, {
      crashRecovery,
      pauseRequested,
      liveRunInconsistency
    }),
    budget_health: deriveBudgetHealth(state),
    artifact_completeness: artifactCompleteness,
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
    `Pending instructions: ${status.state.pending_instruction_count}`,
    `Budget limits: ${formatBudgetLimits(status.budget)}`
  ];

  if (status.state.operator_reason) {
    lines.push(`Pause / risk reason: ${status.state.operator_reason.title}`);
    lines.push(`Reason summary: ${status.state.operator_reason.summary}`);
    lines.push(`Next safe action: ${status.state.operator_reason.next_action}`);
  }

  if (status.state.hot_file_governance) {
    lines.push(
      `Hot-file governance: ${status.state.hot_file_governance.result_class} @ ${status.state.hot_file_governance.file_path}`
    );
    lines.push(`Hot-file labels: ${status.state.hot_file_governance.heuristic_labels.join(", ")}`);
    lines.push(`Hot-file next action: ${status.state.hot_file_governance.recommended_next_action}`);
  }

  if (status.state.budget_health) {
    lines.push(`Budget health: ${status.state.budget_health.overall}`);
    lines.push(
      `Budget dimension health: ${status.state.budget_health.dimensions
        .map((dimension) => `${dimension.label}=${dimension.health}`)
        .join(", ")}`
    );
    if (status.state.budget_health.breached_dimension) {
      lines.push(`Breached dimension: ${formatBudgetDimensionLabel(status.state.budget_health.breached_dimension)}`);
    }
  }

  lines.push(`Artifact completeness: ${status.state.artifact_completeness.label}`);
  lines.push(
    `Latest artifact timestamp: ${status.state.artifact_completeness.latest_artifact_at ?? "none"}`
  );

  const crashRecovery = status.state.crash_recovery;
  if (crashRecovery) {
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
    hot_file_governance: HotFileGovernanceResult | null;
    artifacts: RoundArtifactPresence;
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
        record.summaryPath ? readTextFile(record.summaryPath, "") : Promise.resolve(""),
        record.metricsPath ? readJsonFile<Record<string, unknown> | null>(record.metricsPath, null) : Promise.resolve(null),
        record.evaluationPath ? readJsonFile<EvaluationResult | null>(record.evaluationPath, null) : Promise.resolve(null)
      ]);
      const metricsRound = typeof metrics?.round === "number" ? metrics.round : null;
      const round = roundsByTimestamp.get(record.timestamp) ?? metricsRound ?? 0;
      const artifacts = buildRoundArtifactPresence(derivePresentArtifactKinds(record));

      return {
        timestamp: record.timestamp,
        round,
        summary: redactor.redact(summary),
        metrics,
        evaluation: evaluation ? redactJsonStrings(evaluation, redactor) : null,
        hot_file_governance: evaluation?.hot_file_governance ? redactJsonStrings(evaluation.hot_file_governance, redactor) : null,
        artifacts
      };
    })
  );
}

export interface RunArtifactBundle {
  timestamp: string;
  summary: string | null;
  metrics: Record<string, unknown> | null;
  log: string | null;
  state_change: string | null;
  evaluation: EvaluationResult | null;
  hot_file_governance: HotFileGovernanceResult | null;
  artifacts: RoundArtifactPresence;
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
  const [summaryExists, metricsExists, logExists, stateChangeExists, evaluationExists] = await Promise.all([
    fileExists(artifactPaths.summaryPath),
    fileExists(artifactPaths.metricsPath),
    fileExists(artifactPaths.logPath),
    fileExists(artifactPaths.stateChangePath),
    fileExists(artifactPaths.evaluationPath)
  ]);
  const present = ROUND_ARTIFACT_KINDS.filter((kind) => {
    if (kind === "summary") {
      return summaryExists;
    }
    if (kind === "metrics") {
      return metricsExists;
    }
    if (kind === "log") {
      return logExists;
    }
    if (kind === "state_change") {
      return stateChangeExists;
    }
    return evaluationExists;
  });
  const artifacts = buildRoundArtifactPresence(present);

  if (artifacts.present.length === 0) {
    return null;
  }

  const [summary, metrics, log, stateChange, evaluation] = await Promise.all([
    summaryExists ? readTextFile(artifactPaths.summaryPath, "") : Promise.resolve(null),
    metricsExists ? readJsonFile<Record<string, unknown> | null>(artifactPaths.metricsPath, null) : Promise.resolve(null),
    logExists ? readTextFile(artifactPaths.logPath, "") : Promise.resolve(null),
    stateChangeExists ? readTextFile(artifactPaths.stateChangePath, "") : Promise.resolve(null),
    evaluationExists ? readJsonFile<EvaluationResult | null>(artifactPaths.evaluationPath, null) : Promise.resolve(null)
  ]);

  const redactor = new SecretRedactor(process.env);
  const redact = (text: string) => redactor.redact(text);

  return {
    timestamp: normalizedTimestamp,
    summary: summary === null ? null : redact(summary),
    metrics,
    log: log === null ? null : redact(log),
    state_change: stateChange === null ? null : redact(stateChange),
    evaluation: evaluation ? redactJsonStrings(evaluation, redactor) : null,
    hot_file_governance: evaluation?.hot_file_governance ? redactJsonStrings(evaluation.hot_file_governance, redactor) : null,
    artifacts,
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
  const paths = await ensureLoopHomeAndGetPaths(_config);
  return readGoalFile(paths.taskPath, resolveWorkspaceRootFromHome(paths.homeDir));
}

export function resolveWebDistPath(): string {
  return path.join(process.cwd(), "web", "dist");
}
