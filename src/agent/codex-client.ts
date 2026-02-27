import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { CodexConfig, CodexSandboxMode } from "../config/env";

export type JsonSchema = Record<string, unknown>;

export interface CodexJsonCallOptions {
  prompt: string;
  schema: JsonSchema;
  cwd: string;
  sandbox: CodexSandboxMode;
  timeoutMs?: number;
}

export interface CodexJsonCallResult<T> {
  ok: boolean;
  data?: T;
  rawMessage: string;
  stdout: string;
  stderr: string;
  error?: string;
}

function parseJsonSafely<T>(payload: string): T | null {
  try {
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}

function buildArgs(config: CodexConfig, options: CodexJsonCallOptions, schemaPath: string, outputPath: string): string[] {
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    options.sandbox,
    "--output-schema",
    schemaPath,
    "-o",
    outputPath
  ];

  if (config.model.trim()) {
    args.push("--model", config.model.trim());
  }

  if (config.profile.trim()) {
    args.push("--profile", config.profile.trim());
  }

  args.push(options.prompt);
  return args;
}

async function runProcess(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        child.kill("SIGTERM");
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      if (!finished) {
        finished = true;
        reject(error);
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (!finished) {
        finished = true;
        resolve({
          code: code ?? 1,
          stdout,
          stderr
        });
      }
    });
  });
}

export class CodexClient {
  constructor(private readonly config: CodexConfig) {}

  async runJson<T>(options: CodexJsonCallOptions): Promise<CodexJsonCallResult<T>> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoloop-codex-"));
    const schemaPath = path.join(tempDir, "schema.json");
    const outputPath = path.join(tempDir, "result.json");

    try {
      await fs.writeFile(schemaPath, `${JSON.stringify(options.schema, null, 2)}\n`, "utf8");
      const args = buildArgs(this.config, options, schemaPath, outputPath);
      const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;

      const runResult = await runProcess(this.config.bin, args, options.cwd, timeoutMs);
      const rawMessage = await fs.readFile(outputPath, "utf8").catch(() => "");
      const parsed = parseJsonSafely<T>(rawMessage.trim());

      if (runResult.code !== 0) {
        return {
          ok: false,
          rawMessage,
          stdout: runResult.stdout,
          stderr: runResult.stderr,
          error: `Codex exited with code ${runResult.code}`
        };
      }

      if (!parsed) {
        return {
          ok: false,
          rawMessage,
          stdout: runResult.stdout,
          stderr: runResult.stderr,
          error: "Codex response was not valid JSON"
        };
      }

      return {
        ok: true,
        data: parsed,
        rawMessage,
        stdout: runResult.stdout,
        stderr: runResult.stderr
      };
    } catch (error) {
      return {
        ok: false,
        rawMessage: "",
        stdout: "",
        stderr: "",
        error: (error as Error).message
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}
