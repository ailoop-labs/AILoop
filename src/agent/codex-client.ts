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
  sessionIsolation?: {
    enabled: boolean;
    agentsGuide?: string;
  };
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
  killedGracefully?: boolean;
}

export type ProcessRunner = (
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  hooks?: {
    onStdoutChunk?: (chunk: string) => void;
    onStderrChunk?: (chunk: string) => void;
  },
  env?: NodeJS.ProcessEnv,
  stdin?: string
) => Promise<ProcessRunResult>;

type SleepFn = (ms: number) => Promise<void>;

const INTERFACE_ERROR_RETRY_DELAY_MS = 60_000;
const INTERFACE_ERROR_MAX_RETRIES = 5;

type CliProvider = "codex" | "claude" | "gemini";

function parseJsonSafely<T>(payload: string): T | null {
  try {
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}

interface ParsedJsonCandidate<T> {
  rawMessage: string;
  data: T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractJsonObjects(payload: string): string[] {
  const matches: string[] = [];
  let start = -1;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < payload.length; index += 1) {
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
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        matches.push(payload.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return matches;
}

function matchesJsonSchema(value: unknown, schemaLike: unknown): boolean {
  if (!isRecord(schemaLike)) {
    return true;
  }

  const enumValues = Array.isArray(schemaLike.enum) ? schemaLike.enum : null;
  if (enumValues && !enumValues.some((item) => Object.is(item, value))) {
    return false;
  }

  const declaredType = typeof schemaLike.type === "string" ? schemaLike.type : undefined;
  const inferredType =
    declaredType ??
    (isRecord(schemaLike.properties) || Array.isArray(schemaLike.required)
      ? "object"
      : schemaLike.items !== undefined
        ? "array"
        : undefined);

  if (inferredType === "string") {
    return typeof value === "string";
  }

  if (inferredType === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }

  if (inferredType === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }

  if (inferredType === "boolean") {
    return typeof value === "boolean";
  }

  if (inferredType === "null") {
    return value === null;
  }

  if (inferredType === "array") {
    if (!Array.isArray(value)) {
      return false;
    }
    if (schemaLike.items === undefined) {
      return true;
    }
    return value.every((item) => matchesJsonSchema(item, schemaLike.items));
  }

  if (inferredType === "object") {
    if (!isRecord(value)) {
      return false;
    }

    const properties = isRecord(schemaLike.properties) ? schemaLike.properties : {};
    const required = Array.isArray(schemaLike.required)
      ? schemaLike.required.filter((item): item is string => typeof item === "string")
      : [];

    for (const key of required) {
      if (!(key in value)) {
        return false;
      }
    }

    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value && !matchesJsonSchema(value[key], childSchema)) {
        return false;
      }
    }

    if (schemaLike.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          return false;
        }
      }
    }
  }

  return true;
}

function parseResponseJson<T>(rawMessage: string, schema: JsonSchema, preferLast: boolean): ParsedJsonCandidate<T> | null {
  const trimmed = rawMessage.trim();
  if (!trimmed) {
    return null;
  }

  const candidates: Array<ParsedJsonCandidate<T>> = [];
  const seen = new Set<string>();

  const pushCandidate = (candidateRaw: string): void => {
    if (seen.has(candidateRaw)) {
      return;
    }
    seen.add(candidateRaw);
    const parsed = parseJsonSafely<T>(candidateRaw);
    if (parsed !== null) {
      candidates.push({ rawMessage: candidateRaw, data: parsed });
    }
  };

  pushCandidate(trimmed);

  for (const embedded of extractJsonObjects(trimmed)) {
    pushCandidate(embedded);
  }

  if (candidates.length === 0) {
    return null;
  }

  const ordered = preferLast ? [...candidates].reverse() : candidates;
  const direct = ordered.find((candidate) => matchesJsonSchema(candidate.data, schema));
  if (direct) {
    return direct;
  }

  return null;
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

function detectCliProvider(bin: string): CliProvider {
  const basename = path.basename(bin).toLowerCase();
  if (basename === "gemini" || basename.endsWith("gemini")) {
    return "gemini";
  }
  if (basename === "claude" || basename.startsWith("claude")) {
    return "claude";
  }
  return "codex";
}

function claudePermissionModeForSandbox(sandbox: CodexSandboxMode): string {
  if (sandbox === "read-only") {
    return "plan";
  }
  if (sandbox === "workspace-write") {
    return "acceptEdits";
  }
  return "bypassPermissions";
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
    "stream disconnected before completion",
    "econnreset",
    "etimedout",
    "eai_again",
    "enotfound"
  ];
  return markers.some((marker) => combined.includes(marker));
}

function buildArgs(config: CodexConfig, options: CodexJsonCallOptions, schemaPath: string, outputPath: string): string[] {
  const provider = detectCliProvider(config.bin);

  if (provider === "gemini") {
    const args = [
      "--output-format",
      "json"
    ];

    if (config.model.trim()) {
      args.push("--model", config.model.trim());
    }

    args.push(options.prompt);
    return args;
  }

  if (provider === "claude") {
    const args = [
      "--print",
      "--permission-mode",
      claudePermissionModeForSandbox(options.sandbox),
      "--add-dir",
      options.cwd
    ];

    if (config.model.trim()) {
      args.push("--model", config.model.trim());
    }

    return args;
  }

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

async function buildProcessEnv(config: CodexConfig, _cwd: string, baseEnv: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  // If we're using gemini or any other tool, we just pass through the environment.
  // The Zero-Config model ensures process.env already has what it needs.
  return { ...baseEnv };
}

async function prepareInvocationCwd(tempDir: string, options: CodexJsonCallOptions): Promise<string> {
  if (!options.sessionIsolation?.enabled) {
    return options.cwd;
  }

  const sessionDir = path.join(tempDir, "session");
  await fs.mkdir(sessionDir, { recursive: true });

  const agentsGuide = options.sessionIsolation.agentsGuide?.trim();
  if (agentsGuide) {
    await fs.writeFile(path.join(sessionDir, "AGENTS.md"), `${agentsGuide}\n`, "utf8");
  }

  return sessionDir;
}


async function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  hooks?: {
    onStdoutChunk?: (chunk: string) => void;
    onStderrChunk?: (chunk: string) => void;
  },
  env: NodeJS.ProcessEnv = process.env,
  stdin?: string
): Promise<ProcessRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env
    });

    // Write stdin if provided (for Claude CLI)
    if (stdin && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }

    let stdout = "";
    let stderr = "";
    let finished = false;

    // Timeout handler: SIGTERM first, then SIGKILL after grace period
    const GRACE_PERIOD_MS = 5000;
    let timedOut = false;
    let killedGracefully = false;

    const timer = setTimeout(() => {
      if (!finished) {
        timedOut = true;
        // First attempt graceful termination with SIGTERM
        child.kill("SIGTERM");
        killedGracefully = true;

        // After grace period, escalate to SIGKILL if still running
        setTimeout(() => {
          if (!finished) {
            try {
              child.kill("SIGKILL");
            } catch {
              // Process may have already exited
            }
          }
        }, GRACE_PERIOD_MS);
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

let globalRequestChain: Promise<void> = Promise.resolve();

function acquireGlobalLock<T>(fn: () => Promise<T>, cooldownMs: number, sleepFn: SleepFn): Promise<T> {
  const ticket = globalRequestChain.then(async () => {
    try {
      return await fn();
    } finally {
      await sleepFn(cooldownMs);
    }
  });
  globalRequestChain = ticket.then(() => {}, () => {});
  return ticket;
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
    const cooldownMs = process.env.NODE_ENV === "test" ? 0 : 10000;
    return acquireGlobalLock(() => this._runJsonInner<T>(options), cooldownMs, this.sleep);
  }

  private async _runJsonInner<T>(options: CodexJsonCallOptions): Promise<CodexJsonCallResult<T>> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-codex-"));
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
      const processEnv = await buildProcessEnv(this.config, options.cwd);
      const invocationCwd = await prepareInvocationCwd(tempDir, options);

      for (let attempt = 0; ; attempt += 1) {
        const prompt =
          attempt > 0 && lastFailure
            ? buildRetryPrompt(basePrompt, attempt, summarizeForRetry(lastFailure.error ?? "unknown error", lastFailure.stderr))
            : basePrompt;

        let finalPrompt = prompt;
        const provider = detectCliProvider(this.config.bin);
        if (provider === "gemini" || provider === "claude") {
          finalPrompt = `${prompt}\n\nIMPORTANT: You MUST return a single JSON object strictly matching this schema. Output ONLY the raw JSON object, no markdown formatting or backticks.\nSCHEMA:\n${JSON.stringify(options.schema, null, 2)}`;
        }

        const attemptOptions: CodexJsonCallOptions = {
          ...options,
          prompt: finalPrompt
        };

        await fs.writeFile(outputPath, "", "utf8");
        const args = buildArgs(this.config, attemptOptions, schemaPath, outputPath);
        const stdin = provider === "claude" ? attemptOptions.prompt : undefined;
        const runResult = await this.processRunner(
          this.config.bin,
          args,
          invocationCwd,
          timeoutMs,
          {
            onStdoutChunk: attemptOptions.onStdoutChunk,
            onStderrChunk: attemptOptions.onStderrChunk
          },
          processEnv,
          stdin
        );

        let effectiveStdout = runResult.stdout;
        if (this.config.bin.endsWith("gemini")) {
          try {
            const parsed = JSON.parse(effectiveStdout);
            if (parsed && typeof parsed.response === "string") {
              effectiveStdout = parsed.response;
            }
          } catch {
            // fallback to raw stdout if parsing fails
          }
        }

        const outputPayload = await fs.readFile(outputPath, "utf8").catch(() => "");
        const outputCandidate = parseResponseJson<T>(outputPayload, attemptOptions.schema, true);
        const stdoutCandidate = outputCandidate
          ? null
          : parseResponseJson<T>(effectiveStdout, attemptOptions.schema, true);
        const stderrCandidate =
          outputCandidate || stdoutCandidate
            ? null
            : parseResponseJson<T>(runResult.stderr, attemptOptions.schema, true);

        const parsedCandidate = outputCandidate ?? stdoutCandidate ?? stderrCandidate;
        const rawMessage = parsedCandidate?.rawMessage ?? outputPayload;
        const parsed = parsedCandidate?.data;

        if (combinedStdout) {
          combinedStdout += "\n";
        }
        combinedStdout += runResult.stdout;

        if (combinedStderr) {
          combinedStderr += "\n";
        }
        combinedStderr += runResult.stderr;

        if (parsed && !runResult.timedOut) {
          return {
            ok: true,
            data: parsed,
            rawMessage,
            stdout: combinedStdout,
            stderr: combinedStderr
          };
        }

        const errorMessage = runResult.timedOut
          ? `AI CLI process timed out after ${timeoutMs}ms`
          : runResult.code !== 0
            ? `AI CLI exited with code ${runResult.code}`
            : "AI CLI response was not valid JSON";

        // Capture diagnostic context for timeout failures
        const diagnosticContext = runResult.timedOut ? {
          timeoutMs,
          model: this.config.model || "default",
          promptLength: basePrompt.length,
          partialStdoutLength: runResult.stdout.length,
          partialStderrLength: runResult.stderr.length,
          exitCode: runResult.code,
          killedGracefully: runResult.killedGracefully,
          attempt
        } : null;

        const failure: CodexJsonCallResult<T> = {
          ok: false,
          rawMessage,
          stdout: combinedStdout,
          stderr: combinedStderr,
          error: diagnosticContext
            ? `${errorMessage} | diagnostics: model=${diagnosticContext.model}, promptLen=${diagnosticContext.promptLength}, partialStdout=${diagnosticContext.partialStdoutLength} chars, partialStderr=${diagnosticContext.partialStderrLength} chars, gracefulKill=${diagnosticContext.killedGracefully}, attempt=${diagnosticContext.attempt}`
            : errorMessage
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
          
          // Exponential backoff: delay * 2^retryCount, capped at 5 mins
          const backoffDelay = Math.min(
            INTERFACE_ERROR_RETRY_DELAY_MS * Math.pow(2, interfaceRetryCount),
            300_000 
          );

          emitChunkSafely(
            attemptOptions.onStderrChunk,
            `AILoop interface retry ${nextRetry}/${INTERFACE_ERROR_MAX_RETRIES}: waiting ${backoffDelay}ms before retry. reason=${reason}\n`
          );
          interfaceRetryCount += 1;
          await this.sleep(backoffDelay);
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
