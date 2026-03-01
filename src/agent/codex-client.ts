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
  maxRetries?: number;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
}

export interface CodexJsonCallResult<T> {
  ok: boolean;
  data?: T;
  rawMessage: string;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface ProcessRunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type ProcessRunner = (
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  hooks?: {
    onStdoutChunk?: (chunk: string) => void;
    onStderrChunk?: (chunk: string) => void;
  }
) => Promise<ProcessRunResult>;

type SleepFn = (ms: number) => Promise<void>;

const INTERFACE_ERROR_RETRY_DELAY_MS = 60_000;
const INTERFACE_ERROR_MAX_RETRIES = 5;

function parseJsonSafely<T>(payload: string): T | null {
  try {
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}

function extractFirstJsonObject(payload: string): string | null {
  const start = payload.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < payload.length; index += 1) {
    const char = payload[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return payload.slice(start, index + 1);
      }
    }
  }

  return null;
}

function parseResponseJson<T>(rawMessage: string): T | null {
  const trimmed = rawMessage.trim();
  if (!trimmed) {
    return null;
  }

  const direct = parseJsonSafely<T>(trimmed);
  if (direct) {
    return direct;
  }

  const embedded = extractFirstJsonObject(trimmed);
  if (!embedded) {
    return null;
  }

  return parseJsonSafely<T>(embedded);
}

function summarizeForRetry(errorMessage: string, stderr: string): string {
  const combined = `${errorMessage} ${stderr}`.replace(/\s+/g, " ").trim();
  return combined.slice(0, 500);
}

function emitChunkSafely(handler: ((chunk: string) => void) | undefined, message: string): void {
  try {
    handler?.(message);
  } catch {
    // Stream hooks are best-effort and must not break execution.
  }
}

function buildRetryPrompt(basePrompt: string, attempt: number, reason: string): string {
  return [
    basePrompt,
    "",
    `Retry attempt ${attempt} due to previous output/parsing failure: ${reason}`,
    "Return only one JSON object that strictly matches the output schema.",
    "Do not include markdown, backticks, analysis text, or any extra prefix/suffix."
  ].join("\n");
}

function isRetryableFailure(errorMessage: string, timedOut: boolean): boolean {
  if (timedOut) {
    return true;
  }

  const message = errorMessage.toLowerCase();
  return (
    message.includes("not valid json") ||
    message.includes("schema") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("ecanceled")
  );
}

function isTransientInterfaceFailure(errorMessage: string, stderr: string): boolean {
  const combined = `${errorMessage}\n${stderr}`.toLowerCase();
  const markers = [
    " 429 ",
    "429 too many requests",
    "502 bad gateway",
    "503 service unavailable",
    "504 gateway timeout",
    "unexpected status 429",
    "unexpected status 502",
    "unexpected status 503",
    "unexpected status 504",
    "bad gateway",
    "gateway timeout",
    "too many requests",
    "service unavailable",
    "network error",
    "econnreset",
    "etimedout",
    "eai_again",
    "enotfound"
  ];
  return markers.some((marker) => combined.includes(marker));
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

async function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  hooks?: {
    onStdoutChunk?: (chunk: string) => void;
    onStderrChunk?: (chunk: string) => void;
  }
): Promise<ProcessRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    let timedOut = false;
    const timer = setTimeout(() => {
      if (!finished) {
        timedOut = true;
        child.kill("SIGTERM");
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      try {
        hooks?.onStdoutChunk?.(text);
      } catch {
        // Stream hooks are best-effort and must not break execution.
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      try {
        hooks?.onStderrChunk?.(text);
      } catch {
        // Stream hooks are best-effort and must not break execution.
      }
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
          stderr,
          timedOut
        });
      }
    });
  });
}

export class CodexClient {
  constructor(
    private readonly config: CodexConfig,
    private readonly processRunner: ProcessRunner = runProcess,
    private readonly sleep: SleepFn = (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      })
  ) {}

  async runJson<T>(options: CodexJsonCallOptions): Promise<CodexJsonCallResult<T>> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoloop-codex-"));
    const schemaPath = path.join(tempDir, "schema.json");
    const outputPath = path.join(tempDir, "result.json");

    try {
      await fs.writeFile(schemaPath, `${JSON.stringify(options.schema, null, 2)}\n`, "utf8");
      const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
      const maxRetries = Math.min(3, Math.max(0, options.maxRetries ?? 2));
      const basePrompt = options.prompt;
      let lastFailure: CodexJsonCallResult<T> | null = null;
      let combinedStdout = "";
      let combinedStderr = "";
      let interfaceRetryCount = 0;

      for (let attempt = 0; ; attempt += 1) {
        const prompt =
          attempt > 0 && lastFailure
            ? buildRetryPrompt(basePrompt, attempt, summarizeForRetry(lastFailure.error ?? "unknown error", lastFailure.stderr))
            : basePrompt;
        const attemptOptions: CodexJsonCallOptions = {
          ...options,
          prompt
        };

        await fs.writeFile(outputPath, "", "utf8");
        const args = buildArgs(this.config, attemptOptions, schemaPath, outputPath);
        const runResult = await this.processRunner(this.config.bin, args, attemptOptions.cwd, timeoutMs, {
          onStdoutChunk: attemptOptions.onStdoutChunk,
          onStderrChunk: attemptOptions.onStderrChunk
        });
        const rawMessage = await fs.readFile(outputPath, "utf8").catch(() => "");
        const parsed = parseResponseJson<T>(rawMessage);

        if (combinedStdout) {
          combinedStdout += "\n";
        }
        combinedStdout += runResult.stdout;

        if (combinedStderr) {
          combinedStderr += "\n";
        }
        combinedStderr += runResult.stderr;

        if (runResult.code === 0 && parsed) {
          return {
            ok: true,
            data: parsed,
            rawMessage,
            stdout: combinedStdout,
            stderr: combinedStderr
          };
        }

        const errorMessage =
          runResult.code !== 0
            ? runResult.timedOut
              ? `Codex process timed out after ${timeoutMs}ms`
              : `Codex exited with code ${runResult.code}`
            : "Codex response was not valid JSON";
        const failure: CodexJsonCallResult<T> = {
          ok: false,
          rawMessage,
          stdout: combinedStdout,
          stderr: combinedStderr,
          error: errorMessage
        };

        const shouldRetryByCodexPolicy = attempt < maxRetries && isRetryableFailure(errorMessage, Boolean(runResult.timedOut));
        const shouldRetryByInterfacePolicy =
          interfaceRetryCount < INTERFACE_ERROR_MAX_RETRIES && isTransientInterfaceFailure(errorMessage, runResult.stderr);
        lastFailure = failure;
        if (shouldRetryByCodexPolicy) {
          continue;
        }
        if (shouldRetryByInterfacePolicy) {
          const nextRetry = interfaceRetryCount + 1;
          const reason = summarizeForRetry(errorMessage, runResult.stderr);
          emitChunkSafely(
            attemptOptions.onStderrChunk,
            `AutoLoop interface retry ${nextRetry}/${INTERFACE_ERROR_MAX_RETRIES}: waiting ${INTERFACE_ERROR_RETRY_DELAY_MS}ms before retry. reason=${reason}\n`
          );
          interfaceRetryCount += 1;
          await this.sleep(INTERFACE_ERROR_RETRY_DELAY_MS);
          continue;
        }
        return failure;
      }

      return (
        lastFailure ?? {
          ok: false,
          rawMessage: "",
          stdout: combinedStdout,
          stderr: combinedStderr,
          error: "Codex execution failed with unknown retry state"
        }
      );
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
