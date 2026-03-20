import { createHash } from "node:crypto";
import path from "node:path";
import type { AppConfig } from "../config/env";
import type { LoopPaths } from "../types/contracts";
import type { ActionRecord, SubTask, ToolResult } from "../types/contracts";
import { writeJsonFile } from "../utils/fs";
import { redactJsonStrings, SecretRedactor } from "../utils/redaction";
import type { Guardrails } from "./guardrails";
import { AIClient, type CodexJsonCallResult, type JsonSchema } from "./ai-client";
import { loadProjectRoleDefinition } from "./role-definitions";
import { buildInternalRuntimeSessionGuide } from "./runtime-policy";
import { ToolRegistry } from "./tool-registry";

interface ExecuteOptions {
  subTask: SubTask;
  round: number;
  goal: string;
  instructions: string[];
  guardrails: Guardrails;
  paths: LoopPaths;
  onLog?: (message: string) => void | Promise<void>;
}

export interface ExecuteResult {
  toolResult: ToolResult;
  actions: ActionRecord[];
}

interface CodexExecutorResponse {
  status: "success" | "failure";
  summary: string;
  operational_evidence: string[];
  error_type: string;
  error_message: string;
  next_state_hint: "continue" | "pause" | "stop";
  actions: string[];
}

// Backward compatibility alias
type AIExecutorResponse = CodexExecutorResponse;

const RUN_ARTIFACT_REFERENCE_PATTERN =
  /(?:[^\s'"`]*\.ailoop\/runs\/[^\s'"`]+|[^\s'"`]+\.round\.(?:log|summary\.md|metrics\.json|state_change\.txt))/g;

export interface ExecutorPromptInput {
  round: number;
  goal: string;
  instructions: string[];
  subTask: SubTask;
  ailoopHome: string;
  workspaceRoot: string;
  availableTools: Array<{ name: string; description: string }>;
  availableSkills: Array<{ name: string; description: string }>;
}

const EXECUTOR_RESPONSE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["success", "failure"] },
    summary: { type: "string" },
    operational_evidence: {
      type: "array",
      items: { type: "string" },
      description: "CRITICAL: Direct command outputs and key implementation code excerpts proving the work succeeded. Must include: 1) Direct test/build command outputs showing pass/fail results, 2) Key code excerpts supporting the claimed changes."
    },
    error_type: { type: "string" },
    error_message: { type: "string" },
    next_state_hint: { type: "string", enum: ["continue", "pause", "stop"] },
    actions: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: ["status", "summary", "operational_evidence", "error_type", "error_message", "next_state_hint", "actions"],
  additionalProperties: false
};

export function sanitizeCodexActionDetail(detail: string): string {
  return detail.replace(RUN_ARTIFACT_REFERENCE_PATTERN, ".ailoop/runs/<engine-managed-artifact>");
}

function normalizeActions(rawActions: string[], status: "success" | "failure", errorMessage: string): ActionRecord[] {
  const actions = rawActions.slice(0, 50).map((item, index) => ({
    tool: "codex_step",
    args: { index: index + 1 },
    ok: status === "success",
    output: sanitizeCodexActionDetail(String(item)),
    error: status === "success" ? undefined : errorMessage
  }));

  return actions.length > 0
    ? actions
    : [
        {
          tool: "codex_step",
          args: { index: 1 },
          ok: status === "success",
          output: "No action details returned by Codex.",
          error: status === "success" ? undefined : errorMessage
        }
      ];
}

function toLogLines(_source: "stdout" | "stderr", chunk: string): string[] {
  return chunk
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => `[executor] ${line}`);
}

function emitLog(options: ExecuteOptions, message: string): void {
  if (!options.onLog) {
    return;
  }

  void Promise.resolve(options.onLog(message)).catch(() => {
    // Logging must never block executor flow.
  });
}

function normalizeDiagnosticExcerpt(
  value: string | undefined,
  redactor: SecretRedactor,
  limit = 500
): string | null {
  const normalized = redactor.redact((value ?? "").replace(/\s+/g, " ").trim());
  if (!normalized) {
    return null;
  }

  if (normalized.length <= limit) {
    return normalized;
  }

  return `...${normalized.slice(normalized.length - limit + 3)}`;
}

function parseExitCode(error: string | undefined): number | null {
  const match = (error ?? "").match(/code (\d+)/i);
  return match ? Number(match[1]) : null;
}

function normalizeTimingBreakdown(
  value: CodexJsonCallResult<CodexExecutorResponse>["diagnostics"] extends infer Diagnostics
    ? Diagnostics extends { timingBreakdown: infer TimingBreakdown }
      ? TimingBreakdown
      : never
    : never
): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  return {
    timeout_ms: value.timeoutMs,
    total_runtime_ms: value.totalRuntimeMs,
    sigterm_sent_after_ms: value.sigtermSentAfterMs,
    sigkill_sent_after_ms: value.sigkillSentAfterMs,
    exit_observed_after_ms: value.exitObservedAfterMs,
    shutdown_after_sigterm_ms: value.shutdownAfterSigtermMs,
    required_sigkill: value.requiredSigkill
  };
}

function resolveExecutorDiagnosticsPath(runsDir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(runsDir, `${stamp}.executor.debug.json`);
}

function normalizePartialProgressCheckpoint(
  checkpoint: CodexJsonCallResult<CodexExecutorResponse>["diagnostics"] extends infer Diagnostics
    ? Diagnostics extends { partialProgress: infer PartialProgress }
      ? PartialProgress
      : never
    : never,
  redactor: SecretRedactor
): Record<string, unknown> | null {
  if (!checkpoint) {
    return null;
  }

  const redacted = redactJsonStrings(checkpoint, redactor);
  const excerpt = normalizeDiagnosticExcerpt(
    typeof redacted.excerpt === "string" ? redacted.excerpt : undefined,
    redactor,
    800
  );

  return {
    ...redacted,
    excerpt
  };
}

async function writeExecutorDiagnosticsArtifact(
  runsDir: string,
  prompt: string,
  result: CodexJsonCallResult<CodexExecutorResponse>,
  sandbox: AppConfig["ai"]["executorSandbox"],
  cwd: string
): Promise<string> {
  const redactor = new SecretRedactor(process.env);
  const diagnosticsPath = resolveExecutorDiagnosticsPath(runsDir);
  const diagnostics = result.diagnostics;
  await writeJsonFile(diagnosticsPath, {
    created_at: new Date().toISOString(),
    exit_code: result.diagnostics?.exitCode ?? parseExitCode(result.error),
    exit_signal: result.diagnostics?.exitSignal ?? null,
    timed_out: diagnostics?.timedOut ?? /timed out/i.test(result.error ?? ""),
    sandbox,
    cwd,
    model: diagnostics?.model ?? null,
    prompt_chars: diagnostics?.promptChars ?? prompt.length,
    input_tokens: diagnostics?.inputTokens ?? null,
    output_tokens: diagnostics?.outputTokens ?? null,
    total_tokens: diagnostics?.totalTokens ?? null,
    timing_breakdown: normalizeTimingBreakdown(diagnostics?.timingBreakdown),
    partial_progress_checkpoint: normalizePartialProgressCheckpoint(diagnostics?.partialProgress, redactor),
    prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
    role_contract_mode: "runtime_json_v1",
    stdout_tail: normalizeDiagnosticExcerpt(result.stdout, redactor, 800),
    stderr_tail: normalizeDiagnosticExcerpt(result.stderr, redactor, 800),
    raw_tail: normalizeDiagnosticExcerpt(result.rawMessage, redactor, 800),
    error: normalizeDiagnosticExcerpt(result.error, redactor)
  });
  return diagnosticsPath;
}

function buildExecutorFailureMessage(
  result: CodexJsonCallResult<CodexExecutorResponse>,
  diagnosticsPath?: string,
  diagnosticsWriteError?: string
): string {
  const redactor = new SecretRedactor(process.env);
  const baseMessage =
    normalizeDiagnosticExcerpt(result.error, redactor) ??
    normalizeDiagnosticExcerpt(result.stderr, redactor) ??
    "AI CLI execution failed";
  const details: string[] = [];

  if (diagnosticsPath) {
    details.push(`diagnostics: ${diagnosticsPath}`);
  }

  if (diagnosticsWriteError) {
    details.push(`diagnostics_write_error: ${diagnosticsWriteError}`);
  }

  return details.length > 0 ? `${baseMessage} | ${details.join(" | ")}` : baseMessage;
}

export function buildExecutorPrompt(input: ExecutorPromptInput, executorRoleDefinition: string): string {
  return [
    "You are the AILoop Executor agent.",
    "Project-specific Executor Role Definition:",
    executorRoleDefinition.trim(),
    "",
    `Repository root: ${input.workspaceRoot}`,
    "",
    "Runtime execution notes:",
    "- This internal runtime session is intentionally isolated from repository-local AGENTS.md files and development-assistant skill workflows.",
    "- If you inspect repository files, use absolute paths under the repository root or explicitly `cd` into the repository root first.",
    "- Do not use external development-assistant skills, collaborative brainstorming workflows, or human question-asking patterns.",
    "",
    "Complete exactly one atomic sub-task in this workspace.",
    "",
    "Hard requirements:",
    "- Use observe -> reason -> act loop internally.",
    "- Start each round with a short explicit plan covering the minimal read/write/verification steps you intend to take.",
    "- Verify target state before any mutation (read before write).",
    "- Reserve enough remaining action budget for final verification; do not spend the last action-budget unit before running validation.",
    "- Retry at most 3 times for the same error before failing.",
    "- Keep actions minimal and deterministic.",
    "- Prioritize concrete progress toward subTask.expected_outcome; avoid cosmetic-only edits.",
    "- If you cannot both complete the change and still run final verification within the remaining action budget, fail explicitly instead of guessing or skipping validation.",
    "- If blocked by missing context or unavailable prerequisites, fail explicitly instead of guessing.",
    "- Return final JSON strictly matching schema.",
    "- Do NOT commit, push, restart, or deploy. The engine handles these operational steps automatically after evaluation passes.",
    "- If you run local verifications or test commands, capture the concrete evidence in both `summary` and `actions`.",
    "",
    "- Do not create or claim `.ailoop/runs/*` artifacts in your response; those are engine-managed.",
    "- The engine writes canonical round artifacts and populates `tool_result.artifacts` after your execution.",
    "",
    "Available tool semantics for action log naming:",
    JSON.stringify(input.availableTools, null, 2),
    "",
    "Available Expert Skills (use activate_skill to load):",
    JSON.stringify(input.availableSkills, null, 2),
    "",
    "Round input:",
    JSON.stringify(
      {
        round: input.round,
        goal: input.goal,
        instructions: input.instructions,
        subTask: input.subTask,
        ailoopHome: input.ailoopHome,
        workspaceRoot: input.workspaceRoot
      },
      null,
      2
    ),
    "",
    "After performing actions in the workspace, output:",
    "- status: success or failure",
    "- summary: short factual sentence",
    "- operational_evidence: array of compact proof snippets including direct verification command output and key code excerpts",
    "- error_type: empty string on success, otherwise a short machine-friendly type",
    "- error_message: empty string on success, otherwise a concrete failure reason",
    "- next_state_hint: continue/pause/stop",
    "- actions: ordered list of concise action strings"
  ].join("\n");
}

export class ExecutorAgent {
  private readonly ai: Pick<AIClient, "runJson">;
  private readonly sandbox: AppConfig["ai"]["executorSandbox"];
  private readonly homeDir: string;
  private readonly workspaceRoot: string;

  constructor(
    private readonly tools: ToolRegistry,
    config: AppConfig,
    aiClient?: Pick<AIClient, "runJson">
  ) {
    this.ai = aiClient ?? new AIClient(config.ai);
    this.sandbox = config.ai.executorSandbox;
    this.homeDir = config.homeDir;
    this.workspaceRoot = process.cwd();
  }

  async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    await this.tools.initialize();
    const availableTools = this.tools.listTools().map((tool) => ({
      name: tool.name,
      description: tool.description
    }));
    const availableSkills = this.tools.getSkillManager().getAvailableSkills().map((skill) => ({
      name: skill.name,
      description: skill.description
    }));
    const executorRoleDefinition = await loadProjectRoleDefinition(this.homeDir, "executor");
    const prompt = buildExecutorPrompt(
      {
        round: options.round,
        goal: options.goal,
        instructions: options.instructions,
        subTask: options.subTask,
        ailoopHome: options.paths.homeDir,
        workspaceRoot: this.workspaceRoot,
        availableTools,
        availableSkills
      },
      executorRoleDefinition
    );

    emitLog(options, "Executor started Codex execution.");
    const heartbeatStartedAt = Date.now();
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - heartbeatStartedAt) / 1000);
      emitLog(options, `Executor running... ${elapsedSeconds}s elapsed.`);
    }, 15_000);

    const aiResult = await this.ai
      .runJson<CodexExecutorResponse>({
        prompt,
        schema: EXECUTOR_RESPONSE_SCHEMA,
        cwd: this.workspaceRoot,
        sandbox: this.sandbox,
        sessionIsolation: {
          enabled: true,
          agentsGuide: buildInternalRuntimeSessionGuide("Executor", [
            "If repository inspection or mutation is needed, use absolute paths under the provided repository root or explicitly `cd` into the repository root first."
          ])
        },
        onStdoutChunk: (chunk) => {
          for (const line of toLogLines("stdout", chunk)) {
            emitLog(options, line);
          }
        },
        onStderrChunk: (chunk) => {
          for (const line of toLogLines("stderr", chunk)) {
            emitLog(options, line);
          }
        }
      })
      .finally(() => {
        clearInterval(heartbeat);
      });
    emitLog(options, `Executor Codex execution finished (ok=${aiResult.ok}).`);

    if (!aiResult.ok || !aiResult.data) {
      let diagnosticsPath: string | undefined;
      let diagnosticsWriteError: string | undefined;
      const timeoutContext = {
        timed_out: aiResult.diagnostics?.timedOut ?? /timed out/i.test(aiResult.error ?? ""),
        model: aiResult.diagnostics?.model ?? null,
        prompt_chars: aiResult.diagnostics?.promptChars ?? prompt.length,
        input_tokens: aiResult.diagnostics?.inputTokens ?? null,
        output_tokens: aiResult.diagnostics?.outputTokens ?? null,
        total_tokens: aiResult.diagnostics?.totalTokens ?? null,
        exit_code: aiResult.diagnostics?.exitCode ?? parseExitCode(aiResult.error),
        exit_signal: aiResult.diagnostics?.exitSignal ?? null,
        timing_breakdown: normalizeTimingBreakdown(aiResult.diagnostics?.timingBreakdown)
      };

      if (timeoutContext.timed_out) {
        emitLog(options, `Executor timeout context: ${JSON.stringify(timeoutContext)}`);
      }

      try {
        diagnosticsPath = await writeExecutorDiagnosticsArtifact(
          options.paths.runsDir,
          prompt,
          aiResult,
          this.sandbox,
          this.workspaceRoot
        );
        emitLog(options, `Executor diagnostics artifact: ${diagnosticsPath}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        diagnosticsWriteError =
          normalizeDiagnosticExcerpt(message, new SecretRedactor(process.env)) ??
          "Unable to persist executor diagnostics";
        emitLog(options, `Executor diagnostics artifact failed: ${diagnosticsWriteError}`);
      }

      const failureMessage = buildExecutorFailureMessage(aiResult, diagnosticsPath, diagnosticsWriteError);
      emitLog(options, `Executor Error: ${failureMessage}`);
      options.guardrails.recordAction(0);
      return {
        actions: [
          {
            tool: "codex_exec",
            args: { round: options.round },
            ok: false,
            output: aiResult.stdout,
            error: failureMessage
          }
        ],
        toolResult: {
          status: "failure",
          summary: "Executor could not complete the task because AI CLI execution failed.",
          operational_evidence: [],
          artifacts: {
            state_change_path: options.paths.runsDir,
            log_path: options.paths.runsDir
          },
          error: {
            type: "AIExecError",
            message: failureMessage
          },
          next_state_hint: "pause"
        }
      };
    }

    const safeStatus = aiResult.data.status === "success" ? "success" : "failure";
    const safeErrorMessage = String(aiResult.data.error_message ?? "").trim();
    const safeErrorType = String(aiResult.data.error_type ?? "").trim() || "ExecutorFailure";
    const normalizedActions = normalizeActions(aiResult.data.actions ?? [], safeStatus, safeErrorMessage);
    const countedActions = Math.max(1, normalizedActions.length);
    for (let index = 0; index < countedActions; index += 1) {
      options.guardrails.recordAction(0);
    }

    const safeError =
      safeStatus === "success"
        ? null
        : {
            type: safeErrorType,
            message: safeErrorMessage || "AI CLI reported failure without detailed error"
          };

    return {
      actions: normalizedActions,
      toolResult: {
        status: safeStatus,
        summary: String(aiResult.data.summary || "No summary provided by AI executor."),
        operational_evidence: aiResult.data.operational_evidence ?? [],
        artifacts: {
          state_change_path: options.paths.runsDir, // Will be replaced by finalizeRoundArtifacts with the concrete file path
          log_path: options.paths.runsDir // Will be replaced by finalizeRoundArtifacts with the concrete file path
        },
        error: safeError ?? undefined,
        next_state_hint: aiResult.data.next_state_hint ?? (safeStatus === "success" ? "continue" : "pause")
      }
    };
  }
}
