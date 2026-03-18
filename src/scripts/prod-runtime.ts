import { closeSync, openSync } from "node:fs";
import { spawn } from "node:child_process";

export interface DetachedProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  logPath: string;
  env?: NodeJS.ProcessEnv;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function spawnDetachedProcess(options: DetachedProcessOptions): number {
  const logFd = openSync(options.logPath, "a");
  let child;

  try {
    child = spawn(options.command, options.args, {
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: options.env ?? process.env
    });
  } finally {
    closeSync(logFd);
  }

  if (!child.pid) {
    throw new Error(`Failed to spawn detached process for ${options.command}.`);
  }

  child.unref();
  return child.pid;
}

export async function waitForHttpHealth(url: string, pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return false;
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        return true;
      }
    } catch {
      // Keep polling until the timeout expires or the process exits.
    }

    await Bun.sleep(200);
  }

  return false;
}

export async function stopProcess(pid: number, timeoutMs: number): Promise<void> {
  if (!isPidAlive(pid)) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return;
    }
    await Bun.sleep(200);
  }

  if (!isPidAlive(pid)) {
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }

  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline && isPidAlive(pid)) {
    await Bun.sleep(100);
  }
}
