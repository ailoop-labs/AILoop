import fs from "node:fs/promises";
import path from "node:path";
import type { LoopStateData } from "../types/contracts";
import { ensureDir, fileExists, readJsonFile, readTextFile, writeJsonFile } from "../utils/fs";

export interface LoopPaths {
  homeDir: string;
  runsDir: string;
  goalPath: string;
  taskPath: string;
  instructionsPath: string;
  statePath: string;
  pidPath: string;
  lockPath: string;
  pauseFlagPath: string;
  stopFlagPath: string;
}

export function buildLoopPaths(homeDir: string): LoopPaths {
  return {
    homeDir,
    runsDir: path.join(homeDir, "runs"),
    goalPath: path.join(homeDir, "goal.md"),
    taskPath: path.join(homeDir, "task.md"),
    instructionsPath: path.join(homeDir, "instructions.json"),
    statePath: path.join(homeDir, "loop.state"),
    pidPath: path.join(homeDir, "loop.pid"),
    lockPath: path.join(homeDir, "loop.lock"),
    pauseFlagPath: path.join(homeDir, "loop.pause"),
    stopFlagPath: path.join(homeDir, "loop.stop")
  };
}

export async function ensureLoopHome(paths: LoopPaths): Promise<void> {
  await ensureDir(paths.homeDir);
  await ensureDir(paths.runsDir);

  if (!(await fileExists(paths.goalPath))) {
    await fs.writeFile(
      paths.goalPath,
      "# AutoLoop Goal\n\nDescribe the top-level goal this autonomous loop should pursue. Keep it outcome-focused and measurable.\n",
      "utf8"
    );
  }

  if (!(await fileExists(paths.taskPath))) {
    await fs.writeFile(paths.taskPath, "# AutoLoop Task Log\n", "utf8");
  }

  if (!(await fileExists(paths.instructionsPath))) {
    await writeJsonFile(paths.instructionsPath, []);
  }
}

export function defaultLoopState(pid: number | null = null): LoopStateData {
  return {
    state: "idle",
    round: 0,
    updated_at: new Date().toISOString(),
    pid,
    last_error: null,
    consecutive_evaluator_failures: 0,
    current_budget: null
  };
}

export async function readLoopState(paths: LoopPaths): Promise<LoopStateData> {
  return readJsonFile(paths.statePath, defaultLoopState());
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
