import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AIConfig, AISandboxMode } from "../config/env";
import { isValidGitRepository } from "../environment/workspace";

export type JsonSchema = Record<string, unknown>;

export type AIProvider = "codex" | "claude" | "gemini" | "opencode";

export interface AIJsonCallOptions {
  prompt: string;
  schema: JsonSchema;
  cwd: string;
  sandbox: AISandboxMode;
  sessionIsolation?: {
    enabled: boolean;
    agentsGuide?: string;
  };
  timeoutMs?: number;
  maxRetries?: number;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
}

export interface AIJsonCallResult<T> {
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
  },
  env?: NodeJS.ProcessEnv,
  stdin?: string
) => Promise<ProcessRunResult>;

type SleepFn = (ms: number) => Promise<void>;

const INTERFACE_ERROR_RETRY_DELAY_MS = 60_000;
const INTERFACE_ERROR_MAX_RETRIES = 5;
const UUID_LIKE_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

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

interface CodexJsonlMetadata {
  sessionId: string | null;
  errorMessages: string[];
  assistantMessages: string[];
}

interface CodexCliInvocationOptions {
  resumeSessionId?: string | null;
  skipGitRepoCheck?: boolean;
}

function maybePushString(target: string[], value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.trim();
  if (!normalized) {
    return;
  }
  target.push(normalized);
}

function collectSessionId(value: unknown): string | null {
  if (typeof value === "string") {
    const match = value.match(UUID_LIKE_PATTERN);
    return match ? match[0] : null;
  }

  if (!isRecord(value)) {
    return null;
  }

  for (const key of ["session_id", "sessionId", "conversation_id", "conversationId"]) {
    const match = collectSessionId(value[key]);
    if (match) {
      return match;
    }
  }

  for (const child of Object.values(value)) {
    const match = collectSessionId(child);
    if (match) {
      return match;
    }
  }

  return null;
}

function collectCodexMessages(value: unknown, errors: string[], assistantMessages: string[]): void {
  if (typeof value === "string") {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectCodexMessages(item, errors, assistantMessages);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const typeValue = typeof value.type === "string" ? value.type.toLowerCase() : "";
  const roleValue = typeof value.role === "string" ? value.role.toLowerCase() : "";

  if (typeValue.includes("error") || typeValue.includes("failed")) {
    maybePushString(errors, value.message);
    if (isRecord(value.error)) {
      maybePushString(errors, value.error.message);
      maybePushString(errors, value.error.detail);
    }
  }

  if (roleValue === "assistant" || typeValue.includes("message") || typeValue.includes("output")) {
    maybePushString(assistantMessages, value.text);
    maybePushString(assistantMessages, value.content);
    maybePushString(assistantMessages, value.message);
  }

  for (const child of Object.values(value)) {
    collectCodexMessages(child, errors, assistantMessages);
  }
}

function parseCodexJsonlMetadata(payload: string): CodexJsonlMetadata {
  const sessionCandidates: string[] = [];
  const errorMessages: string[] = [];
  const assistantMessages: string[] = [];

  for (const line of payload.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parsed = parseJsonSafely<unknown>(trimmed);
    if (!parsed) {
      continue;
    }

    const sessionId = collectSessionId(parsed);
    if (sessionId) {
      sessionCandidates.push(sessionId);
    }
    collectCodexMessages(parsed, errorMessages, assistantMessages);
  }

  return {
    sessionId: sessionCandidates.at(-1) ?? null,
    errorMessages: Array.from(new Set(errorMessages)),
    assistantMessages: Array.from(new Set(assistantMessages))
  };
}

function shouldResumeCodexSession(lastFailure: AIJsonCallResult<unknown> | null): boolean {
  if (!lastFailure?.error) {
    return false;
  }

  const combined = `${lastFailure.error}\n${lastFailure.stderr}`.toLowerCase();
  if (
    combined.includes("timed out") ||
    combined.includes("429") ||
    combined.includes("rate_limit_error") ||
    combined.includes("usage limit exceeded") ||
    combined.includes("too many requests") ||
    combined.includes("quota") ||
    combined.includes("credits")
  ) {
    return false;
  }

  return true;
}

function detectAIProvider(bin: string): AIProvider {
  const basename = path.basename(bin).toLowerCase();
  if (basename === "gemini" || basename.includes("gemini")) {
    return "gemini";
  }
  if (basename === "claude" || basename.includes("claude")) {
    return "claude";
  }
  if (basename === "opencode" || basename.includes("opencode")) {
    return "opencode";
  }
  return "codex";
}

function permissionModeForSandbox(sandbox: AISandboxMode, provider: AIProvider): string {
  // Claude-specific permission modes
  if (provider === "claude") {
    if (sandbox === "read-only") {
      return "plan";
    }
    if (sandbox === "workspace-write") {
      return "acceptEdits";
    }
    return "bypassPermissions";
  }

  // For other providers, return the sandbox mode as-is
  return sandbox;
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

function buildArgs(
  config: AIConfig,
  options: AIJsonCallOptions,
  schemaPath: string,
  outputPath: string,
  invocation: CodexCliInvocationOptions = {}
): string[] {
  const provider = detectAIProvider(config.bin);

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
      permissionModeForSandbox(options.sandbox, provider),
      "--add-dir",
      options.cwd
    ];

    if (config.model.trim()) {
      args.push("--model", config.model.trim());
    }

    return args;
  }

  if (provider === "opencode") {
    // OpenCode CLI arguments (placeholder - adjust based on actual CLI)
    const args = [
      "--json-output",
      "--schema",
      schemaPath
    ];

    if (config.model.trim()) {
      args.push("--model", config.model.trim());
    }

    args.push(options.prompt);
    return args;
  }

  // Codex (default)
  const args = ["exec"];

  if (invocation.resumeSessionId) {
    args.push("resume", invocation.resumeSessionId);
  }

  args.push("--ephemeral");

  if (!invocation.resumeSessionId) {
    args.push("--sandbox", options.sandbox);
    if (config.profile.trim()) {
      args.push("--profile", config.profile.trim());
    }
  }

  if (invocation.skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }

  args.push("--json", "--output-schema", schemaPath, "-o", outputPath);

  if (config.model.trim()) {
    args.push("--model", config.model.trim());
  }

  args.push("-");
  return args;
}

async function buildProcessEnv(config: AIConfig, _cwd: string, baseEnv: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  // Pass through the environment for all providers
  return { ...baseEnv };
}

async function prepareInvocationCwd(tempDir: string, options: AIJsonCallOptions): Promise<string> {
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

    // Write stdin if provided (for Claude CLI and others that support it)
    if (stdin && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }

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

export class AIClient {
  constructor(
    private readonly config: AIConfig,
    private readonly processRunner: ProcessRunner = runProcess,
    private readonly sleep: SleepFn = (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      })
  ) {}

  async runJson<T>(options: AIJsonCallOptions): Promise<AIJsonCallResult<T>> {
    const cooldownMs = process.env.NODE_ENV === "test" ? 0 : 10000;
    return acquireGlobalLock(() => this._runJsonInner<T>(options), cooldownMs, this.sleep);
  }

  private async _runJsonInner<T>(options: AIJsonCallOptions): Promise<AIJsonCallResult<T>> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-ai-"));
    const schemaPath = path.join(tempDir, "schema.json");
    const outputPath = path.join(tempDir, "result.json");

    try {
      await fs.writeFile(schemaPath, `${JSON.stringify(options.schema, null, 2)}\n`, "utf8");
      const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
      const maxRetries = Math.min(3, Math.max(0, options.maxRetries ?? 2));
      const basePrompt = options.prompt;
      let lastFailure: AIJsonCallResult<T> | null = null;
      let combinedStdout = "";
      let combinedStderr = "";
      let interfaceRetryCount = 0;
      const processEnv = await buildProcessEnv(this.config, options.cwd);
      const invocationCwd = await prepareInvocationCwd(tempDir, options);
      const provider = detectAIProvider(this.config.bin);
      const skipGitRepoCheck = provider === "codex" ? !(await isValidGitRepository(options.cwd)) : false;
      let previousSessionId: string | null = null;

      for (let attempt = 0; ; attempt += 1) {
        const prompt =
          attempt > 0 && lastFailure
            ? buildRetryPrompt(basePrompt, attempt, summarizeForRetry(lastFailure.error ?? "unknown error", lastFailure.stderr))
            : basePrompt;

        let finalPrompt = prompt;
        if (provider === "gemini" || provider === "claude") {
          finalPrompt = `${prompt}\n\nIMPORTANT: You MUST return a single JSON object strictly matching this schema. Output ONLY the raw JSON object, no markdown formatting or backticks.\nSCHEMA:\n${JSON.stringify(options.schema, null, 2)}`;
        }

        const attemptOptions: AIJsonCallOptions = {
          ...options,
          prompt: finalPrompt
        };
        const resumeSessionId =
          provider === "codex" && attempt > 0 && previousSessionId && shouldResumeCodexSession(lastFailure)
            ? previousSessionId
            : null;

        await fs.writeFile(outputPath, "", "utf8");
        const args = buildArgs(this.config, attemptOptions, schemaPath, outputPath, {
          resumeSessionId,
          skipGitRepoCheck
        });
        const stdin = provider === "claude" || provider === "codex" ? attemptOptions.prompt : undefined;
        const runResult = await this.processRunner(
          this.config.bin,
          args,
          invocationCwd,
          timeoutMs,
          {
            onStdoutChunk: provider === "codex" ? undefined : attemptOptions.onStdoutChunk,
            onStderrChunk: attemptOptions.onStderrChunk
          },
          processEnv,
          stdin
        );

        let effectiveStdout = runResult.stdout;
        if (provider === "gemini") {
          try {
            const parsed = JSON.parse(effectiveStdout);
            if (parsed && typeof parsed.response === "string") {
              effectiveStdout = parsed.response;
            }
          } catch {
            // fallback to raw stdout if parsing fails
          }
        }
        const codexJsonl = provider === "codex" ? parseCodexJsonlMetadata(runResult.stdout) : null;
        if (codexJsonl?.sessionId) {
          previousSessionId = codexJsonl.sessionId;
        }
        if (provider === "codex") {
          effectiveStdout = codexJsonl?.assistantMessages.join("\n") ?? "";
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

        const codexErrorDetail = codexJsonl?.errorMessages.at(-1);
        const errorMessage = runResult.timedOut
          ? `AI CLI process timed out after ${timeoutMs}ms`
          : runResult.code !== 0
            ? codexErrorDetail
              ? `AI CLI exited with code ${runResult.code} | detail: ${codexErrorDetail}`
              : `AI CLI exited with code ${runResult.code}`
            : "AI CLI response was not valid JSON";
        const failure: AIJsonCallResult<T> = {
          ok: false,
          rawMessage,
          stdout: combinedStdout,
          stderr: combinedStderr,
          error: errorMessage
        };

        const shouldRetryByPolicy = attempt < maxRetries && isRetryableFailure(errorMessage, Boolean(runResult.timedOut));
        const shouldRetryByInterfacePolicy =
          interfaceRetryCount < INTERFACE_ERROR_MAX_RETRIES && isTransientInterfaceFailure(errorMessage, runResult.stderr);
        lastFailure = failure;
        if (shouldRetryByPolicy) {
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
          error: "AI CLI execution failed with unknown retry state"
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

// Backward compatibility: export CodexClient as alias
export const CodexClient = AIClient;
export type CodexConfig = AIConfig;
export type CodexSandboxMode = AISandboxMode;
export type CodexJsonCallOptions = AIJsonCallOptions;
export type CodexJsonCallResult<T> = AIJsonCallResult<T>;
