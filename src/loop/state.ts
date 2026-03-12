import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseManager } from "../utils/db";
import type { LoopPaths, LoopStateData, LoopStateName } from "../types/contracts";
export type { LoopPaths, LoopStateData };
import { ensureDir, ensureRegularFile, fileExists, readJsonFile, readTextFile, writeJsonFile } from "../utils/fs";

const INTERRUPTED_LOOP_STATES = new Set<LoopStateName>(["starting", "running", "cooldown", "stopping"]);

export function buildLoopPaths(homeDir: string): LoopPaths {
  return {
    homeDir,
    runsDir: path.join(homeDir, "runs"),
    taskPath: path.join(homeDir, "goal.md"),
    plannerRolePath: path.join(homeDir, "PLANNER_ROLE.md"),
    executorRolePath: path.join(homeDir, "EXECUTOR_ROLE.md"),
    designerRolePath: path.join(homeDir, "DESIGNER_ROLE.md"),
    evaluatorRolePath: path.join(homeDir, "EVALUATOR_ROLE.md"),
    leaderRolePath: path.join(homeDir, "LEADER_ROLE.md"),
    instructionsPath: path.join(homeDir, "instructions.queue.json"),
    legacyInstructionsPath: path.join(homeDir, "instructions.json"),
    statePath: path.join(homeDir, "state.json"), // Maintained for transition/compat but not authoritative
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

async function migrateLegacyLoopState(paths: LoopPaths): Promise<void> {
  // Try to bootstrap Database from state.json if DB is empty
  const db = new DatabaseManager({ dbPath: paths.dbPath });
  const existingDbState = await db.getLoopState();
  
  if (!existingDbState) {
    const jsonState = await readJsonFile<Partial<LoopStateData>>(paths.statePath, {});
    if (Object.keys(jsonState).length > 0) {
      console.log("[DB BOOTSTRAP] Initializing database from state.json");
      await db.setLoopState(normalizeLoopState(jsonState));
    } else if (await fileExists(paths.legacyStatePath)) {
      const legacyState = await readJsonFile<Partial<LoopStateData>>(paths.legacyStatePath, defaultLoopState());
      console.log("[DB BOOTSTRAP] Initializing database from legacy loop.state");
      await db.setLoopState(normalizeLoopState(legacyState));
    }
  }

  db.close();

  // Cleanup legacy files once DB is confirmed to have state
  const confirmedDb = new DatabaseManager({ dbPath: paths.dbPath });
  const finalState = await confirmedDb.getLoopState();
  if (finalState) {
    if (await fileExists(paths.statePath)) await fs.unlink(paths.statePath).catch(() => {});
    if (await fileExists(paths.legacyStatePath)) await fs.unlink(paths.legacyStatePath).catch(() => {});
  }
  confirmedDb.close();
}

export async function ensureLoopHome(paths: LoopPaths): Promise<void> {
  await ensureDir(paths.homeDir);
  await ensureDir(paths.runsDir);

  await ensureRegularFile(paths.taskPath, "# AILoop Task Log\n");
  await ensureRegularFile(paths.instructionsPath, "[]\n");
  await writeInstructionQueue(paths, await readMergedInstructionQueue(paths));
  await migrateLegacyLoopState(paths);
}

export function defaultLoopState(pid: number | null = null): LoopStateData {
  return {
    state: "idle",
    round: 0,
    updated_at: new Date().toISOString(),
    pid,
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
    previous_tool_result: raw.previous_tool_result ?? null,
    previous_evaluation_dimensions: raw.previous_evaluation_dimensions,
    current_budget: raw.current_budget ?? null
  };
}

export async function readLoopState(paths: LoopPaths): Promise<LoopStateData> {
  const db = new DatabaseManager({ dbPath: paths.dbPath });
  const raw = await db.getLoopState();
  db.close();
  
  return normalizeLoopState(raw as any);
}

export async function writeLoopState(paths: LoopPaths, state: LoopStateData): Promise<void> {
  const nextState: LoopStateData = {
    ...state,
    updated_at: new Date().toISOString()
  };
  
  const db = new DatabaseManager({ dbPath: paths.dbPath });
  await db.setLoopState(nextState);
  db.close();
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
  if (pid) {
    return `Interrupted: recovered unfinished ${state} state during ${source} because process ${pid} was not alive`;
  }

  return `Interrupted: recovered unfinished ${state} state during ${source} because no live process was found`;
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
