import fs from "node:fs/promises";
import path from "node:path";
import type { LoopStateData, LoopStateName } from "../types/contracts";
import { ensureDir, ensureRegularFile, fileExists, readJsonFile, readTextFile, writeJsonFile } from "../utils/fs";

export interface LoopPaths {
  homeDir: string;
  runsDir: string;
  taskPath: string;
  plannerRolePath: string;
  executorRolePath: string;
  evaluatorRolePath: string;
  leaderRolePath: string;
  instructionsPath: string;
  statePath: string;
  pidPath: string;
  stopFlagPath: string;
  pauseFlagPath: string;
  lockPath: string;
}

const INTERRUPTED_LOOP_STATES = new Set<LoopStateName>(["running", "cooldown", "stopping"]);

export function buildLoopPaths(homeDir: string): LoopPaths {
  return {
    homeDir,
    runsDir: path.join(homeDir, "runs"),
    taskPath: path.join(homeDir, "task.md"),
    plannerRolePath: path.join(homeDir, "PLANNER_ROLE.md"),
    executorRolePath: path.join(homeDir, "EXECUTOR_ROLE.md"),
    evaluatorRolePath: path.join(homeDir, "EVALUATOR_ROLE.md"),
    leaderRolePath: path.join(homeDir, "LEADER_ROLE.md"),
    instructionsPath: path.join(homeDir, "instructions.json"),
    statePath: path.join(homeDir, "loop.state"),
    pidPath: path.join(homeDir, "loop.pid"),
    stopFlagPath: path.join(homeDir, "loop.stop"),
    pauseFlagPath: path.join(homeDir, "loop.pause"),
    lockPath: path.join(homeDir, "loop.lock")
  };
}

export async function ensureLoopHome(paths: LoopPaths): Promise<void> {
  await ensureDir(paths.homeDir);
  await ensureDir(paths.runsDir);

  await ensureRegularFile(paths.taskPath, "# AILoop Task Log\n");
  await ensureRegularFile(paths.instructionsPath, "[]\n");
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

function normalizeLoopState(raw: Partial<LoopStateData> | null | undefined): LoopStateData {
  const fallback = defaultLoopState();
  if (!raw) {
    return fallback;
  }

  return {
    ...fallback,
    ...raw,
    previous_tool_result: raw.previous_tool_result ?? null,
    current_budget: raw.current_budget ?? null
  };
}

export async function readLoopState(paths: LoopPaths): Promise<LoopStateData> {
  const raw = await readJsonFile<Partial<LoopStateData>>(paths.statePath, defaultLoopState());
  return normalizeLoopState(raw);
}

export async function writeLoopState(paths: LoopPaths, state: LoopStateData): Promise<void> {
  const nextState: LoopStateData = {
    ...state,
    updated_at: new Date().toISOString()
  };
  await writeJsonFile(paths.statePath, nextState);
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
  const current = await readJsonFile<string[]>(paths.instructionsPath, []);
  current.push(message);
  await writeJsonFile(paths.instructionsPath, current);
}

export async function drainInstructions(paths: LoopPaths): Promise<string[]> {
  const current = await readJsonFile<string[]>(paths.instructionsPath, []);
  await writeJsonFile(paths.instructionsPath, []);
  return current;
}

export async function peekInstructions(paths: LoopPaths): Promise<string[]> {
  return readJsonFile<string[]>(paths.instructionsPath, []);
}
