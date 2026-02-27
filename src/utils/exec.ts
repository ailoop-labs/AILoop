import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execCallback);

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function runShellCommand(command: string, cwd?: string, timeoutMs = 120_000): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
      shell: process.platform === "win32" ? "powershell.exe" : "/bin/bash"
    });

    return {
      stdout,
      stderr,
      code: 0
    };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
      code: Number.isInteger(failure.code) ? Number(failure.code) : 1
    };
  }
}
