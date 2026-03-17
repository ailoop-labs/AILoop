import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseManager } from "../utils/db";
import type { CrashRecoveryRecoveredBy, CrashRecoveryStatus, LoopPaths, LoopStateData, LoopStateName } from "../types/contracts";
export type { LoopPaths, LoopStateData };
import { ensureDir, ensureRegularFile, fileExists, readJsonFile, readTextFile, writeJsonFile } from "../utils/fs";
import { ensureGoalFile, extractGoalReference, readGoalFile, resolveWorkspaceRootFromHome } from "./goal";

const INTERRUPTED_LOOP_STATES = new Set<LoopStateName>(["starting", "running", "cooldown", "stopping"]);
const CRASH_RECOVERY_NEXT_ACTION = "Inspect the run state and resume explicitly when safe.";

export function derivePauseReasonLabel(message: string | null | undefined): string {
  const normalized = message?.trim() ?? "";

  if (/^Crash recovery:/i.test(normalized)) {
    return "Crash recovery";
  }
  if (/BudgetBreach:/i.test(normalized)) {
    return "Budget breach";
  }
  if (/^EvaluatorStrategicBlock:/i.test(normalized)) {
    return "Strategic evaluator block";
  }
  if (/EvaluatorFailureLimit:/i.test(normalized)) {
    return "Evaluator failure threshold";
  }
  if (/rollback (failed|unsupported|incomplete)/i.test(normalized)) {
    return "Rollback incomplete";
  }
  if (/guardrail|unsafe/i.test(normalized)) {
    return "Guardrail block";
  }
  if (/^(Fatal error|Governance failed):/i.test(normalized)) {
    return "Engine error";
  }

  return "Manual pause";
}

export function buildLoopPaths(homeDir: string): LoopPaths {
  return {
    homeDir,
    runsDir: path.join(homeDir, "runs"),
    loopLogPath: path.join(homeDir, "loop.run.log"),
    taskPath: path.join(homeDir, "goal.md"),
    productRequirementsDirPath: path.join(homeDir, "product-requirements"),
    activeRequirementPath: path.join(homeDir, "product-requirements", "current.md"),
    plannerRolePath: path.join(homeDir, "PLANNER_ROLE.md"),
    productManagerRolePath: path.join(homeDir, "PRODUCT_MANAGER_ROLE.md"),
    executorRolePath: path.join(homeDir, "EXECUTOR_ROLE.md"),
    designerRolePath: path.join(homeDir, "DESIGNER_ROLE.md"),
    evaluatorRolePath: path.join(homeDir, "EVALUATOR_ROLE.md"),
    leaderRolePath: path.join(homeDir, "LEADER_ROLE.md"),
    instructionsPath: path.join(homeDir, "instructions.queue.json"),
    legacyInstructionsPath: path.join(homeDir, "instructions.json"),
    statePath: path.join(homeDir, "state.json"),
    legacyStatePath: path.join(homeDir, "loop.state"),
    pidPath: path.join(homeDir, "loop.pid"),
    stopFlagPath: path.join(homeDir, "loop.stop"),
    pauseFlagPath: path.join(homeDir, "loop.pause"),
    lockPath: path.join(homeDir, "loop.lock"),
    dbPath: path.join(homeDir, "ailoop.db")
  };
}

async function ensureLegacyInstructionsFile(paths: LoopPaths): Promise<boolean> {
  if (!(await fileExists(paths.legacyInstructionsPath))) {
    return false;
  }

  await ensureRegularFile(paths.legacyInstructionsPath, "[]\n");
  return true;
}

async function readMergedInstructionQueue(paths: LoopPaths): Promise<string[]> {
  const canonical = await readJsonFile<string[]>(paths.instructionsPath, []);
  const hasLegacyInstructions = await ensureLegacyInstructionsFile(paths);
  if (!hasLegacyInstructions) {
    return canonical;
  }

  const legacy = await readJsonFile<string[]>(paths.legacyInstructionsPath, []);
  if (legacy.length === 0) {
    return canonical;
  }

  return [...legacy, ...canonical];
}

async function writeInstructionQueue(paths: LoopPaths, queue: string[]): Promise<void> {
  await writeJsonFile(paths.instructionsPath, queue);

  if (await ensureLegacyInstructionsFile(paths)) {
    await writeJsonFile(paths.legacyInstructionsPath, []);
  }
}

async function syncCanonicalLoopStateFile(paths: LoopPaths, state: LoopStateData): Promise<void> {
  await writeJsonFile(paths.statePath, state);
}

async function attachGoalReference(paths: LoopPaths, state: LoopStateData): Promise<LoopStateData> {
  const goalMarkdown = await readGoalFile(paths.taskPath, resolveWorkspaceRootFromHome(paths.homeDir));
  return {
    ...state,
    goal_reference: extractGoalReference(goalMarkdown)
  };
}

async function migrateLegacyLoopState(paths: LoopPaths): Promise<LoopStateData | null> {
  const db = new DatabaseManager({ dbPath: paths.dbPath });
  let finalState = await db.getLoopState();

  if (!finalState) {
    const jsonState = await readJsonFile<Partial<LoopStateData>>(paths.statePath, {});
    if (Object.keys(jsonState).length > 0) {
      console.log("[DB BOOTSTRAP] Initializing database from state.json");
      const normalizedState = normalizeLoopState(jsonState);
      finalState = normalizedState;
      await db.setLoopState(normalizedState);
    } else if (await fileExists(paths.legacyStatePath)) {
      const legacyState = await readJsonFile<Partial<LoopStateData>>(paths.legacyStatePath, defaultLoopState());
      console.log("[DB BOOTSTRAP] Initializing database from legacy loop.state");
      const normalizedState = normalizeLoopState(legacyState);
      finalState = normalizedState;
      await db.setLoopState(normalizedState);
    }
  }
  db.close();

  if (finalState) {
    const normalizedState = await attachGoalReference(paths, normalizeLoopState(finalState));
    await syncCanonicalLoopStateFile(paths, normalizedState);
    if (await fileExists(paths.legacyStatePath)) await fs.unlink(paths.legacyStatePath).catch(() => {});
    return normalizedState;
  }

  return null;
}

export async function ensureLoopHome(paths: LoopPaths): Promise<void> {
  await ensureDir(paths.homeDir);
  await ensureDir(paths.runsDir);

  await ensureRegularFile(paths.taskPath, "# AILoop Task Log\n");
  await ensureGoalFile(paths.taskPath, resolveWorkspaceRootFromHome(paths.homeDir));
  await ensureRegularFile(paths.instructionsPath, "[]\n");
  await writeInstructionQueue(paths, await readMergedInstructionQueue(paths));
  const state = await migrateLegacyLoopState(paths);
  if (!state) {
    await writeLoopState(paths, defaultLoopState());
  }
}

export function defaultLoopState(pid: number | null = null): LoopStateData {
  return {
    state: "idle",
    round: 0,
    updated_at: new Date().toISOString(),
    pid,
    goal_reference: null,
    pause_reason: null,
    last_error: null,
    consecutive_evaluator_failures: 0,
    previous_tool_result: null,
    current_budget: null
  };
}

function normalizePersistedPid(pid: number | null | undefined): number | null {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
}

function normalizeLoopState(raw: Partial<LoopStateData> | null | undefined): LoopStateData {
  const fallback = defaultLoopState();
  if (!raw) {
    return fallback;
  }

  return {
    ...fallback,
    ...raw,
    pid: normalizePersistedPid(raw.pid),
    goal_reference: raw.goal_reference ?? null,
    pause_reason:
      raw.state === "paused" ? raw.pause_reason ?? derivePauseReasonLabel(raw.last_error) : null,
    previous_tool_result: raw.previous_tool_result ?? null,
    previous_evaluation_dimensions: raw.previous_evaluation_dimensions,
    previous_hot_file_governance: raw.previous_hot_file_governance ?? undefined,
    current_budget: raw.current_budget ?? null
  };
}

export async function readLoopState(paths: LoopPaths): Promise<LoopStateData> {
  const db = new DatabaseManager({ dbPath: paths.dbPath });
  let raw = await db.getLoopState();
  if (!raw) {
    const fileState = await readJsonFile<Partial<LoopStateData>>(paths.statePath, {});
    if (Object.keys(fileState).length > 0) {
      const normalizedState = normalizeLoopState(fileState);
      raw = normalizedState;
      await db.setLoopState(normalizedState);
    }
  }
  db.close();

  const normalized = await attachGoalReference(paths, normalizeLoopState(raw));
  await syncCanonicalLoopStateFile(paths, normalized);
  return normalized;
}

export async function writeLoopState(paths: LoopPaths, state: LoopStateData): Promise<void> {
  const nextState = await attachGoalReference(paths, {
    ...state,
    pause_reason: state.state === "paused" ? state.pause_reason ?? derivePauseReasonLabel(state.last_error) : null,
    updated_at: new Date().toISOString()
  });
  
  const db = new DatabaseManager({ dbPath: paths.dbPath });
  await db.setLoopState(nextState);
  db.close();
  await syncCanonicalLoopStateFile(paths, nextState);
}

export async function saveEvaluation(paths: LoopPaths, roundId: number, evaluation: any): Promise<void> {
  const db = new DatabaseManager({ dbPath: paths.dbPath });
  await db.saveEvaluation(roundId, evaluation);
  db.close();
}

export async function saveLeaderStrategy(paths: LoopPaths, roundId: number, strategy: any): Promise<void> {
  const db = new DatabaseManager({ dbPath: paths.dbPath });
  await db.saveLeaderStrategy(roundId, strategy);
  db.close();
}

export async function saveCCBSession(paths: LoopPaths, roundId: number, session: any): Promise<void> {
  const db = new DatabaseManager({ dbPath: paths.dbPath });
  await db.saveCCBSession(roundId, session);
  db.close();
}

export async function updateLoopState(
  paths: LoopPaths,
  updater: (current: LoopStateData) => LoopStateData
): Promise<LoopStateData> {
  const current = await readLoopState(paths);
  const next = updater(current);
  await writeLoopState(paths, next);
  return next;
}

export async function hasFlag(flagPath: string): Promise<boolean> {
  return fileExists(flagPath);
}

export async function setFlag(flagPath: string): Promise<void> {
  await fs.writeFile(flagPath, "1\n", "utf8");
}

export async function clearFlag(flagPath: string): Promise<void> {
  try {
    await fs.unlink(flagPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function writePid(paths: LoopPaths, pid: number): Promise<void> {
  await fs.writeFile(paths.pidPath, `${pid}\n`, "utf8");
}

export async function readPid(paths: LoopPaths): Promise<number | null> {
  const raw = await readTextFile(paths.pidPath, "");
  const pid = Number(raw.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return pid;
}

export async function clearPid(paths: LoopPaths): Promise<void> {
  try {
    await fs.unlink(paths.pidPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function buildInterruptedRecoveryMessage(
  state: LoopStateName,
  pid: number | null,
  source: "startup" | "status check"
): string {
  const reason = pid ? `process ${pid} was not alive` : "no live process was found";

  if (state === "starting") {
    return [
      `Crash recovery: Interrupted state recovered during ${source}.`,
      `Startup interrupted during initialization because ${reason}.`,
      "Normal round execution did not begin.",
      "Run paused for review.",
      `Next action: ${CRASH_RECOVERY_NEXT_ACTION}`
    ].join(" ");
  }

  return [
    `Crash recovery: Interrupted state recovered during ${source}.`,
    `Round interrupted during ${state} because ${reason}.`,
    "Work may be incomplete.",
    "Run paused for review.",
    `Next action: ${CRASH_RECOVERY_NEXT_ACTION}`
  ].join(" ");
}

function normalizeCrashRecoverySource(raw: string): CrashRecoveryRecoveredBy | null {
  if (raw === "startup") {
    return "startup";
  }
  if (raw === "status check") {
    return "status_check";
  }
  return null;
}

export function parseCrashRecoveryMessage(message: string | null): Omit<CrashRecoveryStatus, "status_check_finalized"> | null {
  if (!message) {
    return null;
  }

  const startupMatch = message.match(
    /^Crash recovery: Interrupted state recovered during (startup|status check)\. Startup interrupted during initialization because (.+?)\. Normal round execution did not begin\. Run paused for review\. Next action: (.+)$/
  );
  if (startupMatch) {
    const recoveredBy = normalizeCrashRecoverySource(startupMatch[1]);
    if (!recoveredBy) {
      return null;
    }

    return {
      interruption_type: "startup_interrupted",
      interrupted_state: "starting",
      recovered_by: recoveredBy,
      normal_round_execution_started: false,
      incomplete_work: false,
      reason: startupMatch[2],
      summary: "Initialization was interrupted before normal round execution began.",
      next_action: startupMatch[3]
    };
  }

  const roundMatch = message.match(
    /^Crash recovery: Interrupted state recovered during (startup|status check)\. Round interrupted during (starting|running|paused|cooldown|stopping|idle|error) because (.+?)\. Work may be incomplete\. Run paused for review\. Next action: (.+)$/
  );
  if (!roundMatch) {
    return null;
  }

  const recoveredBy = normalizeCrashRecoverySource(roundMatch[1]);
  if (!recoveredBy) {
    return null;
  }

  const interruptedState = roundMatch[2] as LoopStateName;
  return {
    interruption_type: "round_interrupted",
    interrupted_state: interruptedState,
    recovered_by: recoveredBy,
    normal_round_execution_started: true,
    incomplete_work: true,
    reason: roundMatch[3],
    summary: `Round execution was interrupted during ${interruptedState}; work may be incomplete.`,
    next_action: roundMatch[4]
  };
}

export async function recoverInterruptedLoopState(
  paths: LoopPaths,
  source: "startup" | "status check"
): Promise<LoopStateData | null> {
  const state = await readLoopState(paths);
  const pid = state.pid ?? (await readPid(paths));
  const pidAlive = pid ? isPidAlive(pid) : false;

  if (!INTERRUPTED_LOOP_STATES.has(state.state) || pidAlive) {
    return null;
  }

  await clearPid(paths);

  const recovered = {
    ...state,
    state: "paused" as const,
    pid: null,
    pause_reason: "Crash recovery",
    last_error: buildInterruptedRecoveryMessage(state.state, pid ?? null, source)
  };

  await writeLoopState(paths, recovered);
  return recovered;
}

export async function appendInstruction(paths: LoopPaths, message: string): Promise<void> {
  const current = await readMergedInstructionQueue(paths);
  current.push(message);
  await writeInstructionQueue(paths, current);
}

export async function consumeNextInstruction(paths: LoopPaths): Promise<string[]> {
  const current = await readMergedInstructionQueue(paths);
  if (current.length === 0) {
    await writeInstructionQueue(paths, []);
    return [];
  }

  const [nextInstruction, ...remaining] = current;
  await writeInstructionQueue(paths, remaining);
  return nextInstruction ? [nextInstruction] : [];
}

export async function drainInstructions(paths: LoopPaths): Promise<string[]> {
  const current = await readMergedInstructionQueue(paths);
  await writeInstructionQueue(paths, []);
  return current;
}

export async function peekInstructions(paths: LoopPaths): Promise<string[]> {
  const current = await readMergedInstructionQueue(paths);
  await writeInstructionQueue(paths, current);
  return current;
}
