import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../config/env";
import type { PlannerContext, SubTask } from "../types/contracts";
import { writeJsonFile } from "../utils/fs";
import { redactJsonStrings, SecretRedactor } from "../utils/redaction";
import {
  AIClient,
  type AIJsonCallResult,
  type AIJsonPartialProgressCheckpoint,
  type AIProcessTimingBreakdown,
  type JsonSchema
} from "./ai-client";
import { loadProjectRoleDefinition } from "./role-definitions";
import { buildInternalRuntimeSessionGuide } from "./runtime-policy";
import type { ToolRegistry } from "./tool-registry";

const SUBTASK_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    rationale: { type: "string" },
    assignee: { type: "string", enum: ["executor", "designer"] },
    objective: { type: "string" },
    expected_outcome: { type: "string" },
    impacted_files: {
      type: "array",
      items: { type: "string" },
      description: "List of files or directories the executor is expected to read or modify. Used for workspace snapshotting."
    },
    recommended_tools: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: ["rationale", "assignee", "objective", "expected_outcome", "impacted_files", "recommended_tools"],
  additionalProperties: false
};

const PLANNER_TRANSIENT_RETRY_MAX_ATTEMPTS = 3;
const PLANNER_TRANSIENT_RETRY_BASE_DELAY_MS = 1_000;
const PLANNER_TRANSIENT_RETRY_MAX_DELAY_MS = 8_000;
const PLANNER_NETWORK_PROBE_TARGET = "example.com";
const PLANNER_NETWORK_PROBE_TIMEOUT_MS = 250;
const PLANNER_DIAGNOSTIC_LIST_LIMIT = 16;

type PlannerTransientFailureKind = "provider_rate_limit" | "provider_upstream_error" | "timeout";
type PlannerFailureSnapshot = Record<string, unknown>;
type PlannerFailureSnapshotBuilder = (tools: ToolRegistry) => Promise<PlannerFailureSnapshot>;
interface PlannerDiagnosticsContext {
  timeout_duration_ms: number | null;
  partial_output: Record<string, unknown>;
  exit_status: Record<string, unknown>;
  environment_state: Record<string, unknown>;
  failure_snapshot: PlannerFailureSnapshot;
  provider_error_context: Record<string, unknown> | null;
}

export class PlannerInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerInfrastructureError";
  }
}

function sanitizeInstruction(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 240);
}

function hasExplicitDocumentationRequest(instructions: string[]): boolean {
  const merged = instructions.join(" ").toLowerCase();
  return /(readme|docs?|文档|报告|checklist|audit|baseline|goal\.md|task\.md|plan)/.test(merged);
}

function isProviderRateLimitFailure(result: { error?: string; stderr: string }): boolean {
  const combined = `${result.error ?? ""}\n${result.stderr}`.toLowerCase();
  return (
    combined.includes("429") ||
    combined.includes("rate_limit_error") ||
    combined.includes("usage limit exceeded") ||
    combined.includes("too many requests")
  );
}

function classifyTransientPlannerFailure(result: AIJsonCallResult<unknown>): PlannerTransientFailureKind | null {
  const combined = `${result.error ?? ""}\n${result.stderr}\n${result.rawMessage}`.toLowerCase();

  if (isProviderRateLimitFailure(result)) {
    return "provider_rate_limit";
  }

  if (
    combined.includes("502 bad gateway") ||
    combined.includes("503 service unavailable") ||
    combined.includes("504 gateway timeout") ||
    combined.includes("unexpected status 502") ||
    combined.includes("unexpected status 503") ||
    combined.includes("unexpected status 504") ||
    combined.includes("bad gateway") ||
    combined.includes("gateway timeout") ||
    combined.includes("service unavailable")
  ) {
    return "provider_upstream_error";
  }

  if (
    result.diagnostics?.timedOut === true ||
    combined.includes("timed out") ||
    combined.includes("etimedout")
  ) {
    return "timeout";
  }

  return null;
}

function getPlannerRetryDelayMs(attempt: number): number {
  return Math.min(
    PLANNER_TRANSIENT_RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1)),
    PLANNER_TRANSIENT_RETRY_MAX_DELAY_MS
  );
}

function describeTransientPlannerFailure(kind: PlannerTransientFailureKind): string {
  switch (kind) {
    case "provider_rate_limit":
      return "rate-limited";
    case "provider_upstream_error":
      return "hit an upstream provider failure";
    case "timeout":
      return "timed out";
  }
}

function summarizeInfrastructureFailure(result: { error?: string; stderr: string }): string {
  const message = result.error?.trim() || "AI CLI execution failed";
  const stderr = result.stderr.trim();
  if (!stderr) {
    return message;
  }
  return `${message} | stderr: ${stderr}`;
}

function normalizeDiagnosticExcerpt(
  value: string | undefined,
  redactor: SecretRedactor,
  maxLength = 800
): string | null {
  const normalized = redactor.redact((value ?? "").replace(/\s+/g, " ").trim());
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, maxLength);
}

function resolvePlannerDiagnosticsPath(homeDir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(homeDir, "runs", `${stamp}.planner.debug.json`);
}

function parsePlannerExitCode(error?: string): number | null {
  const match = (error ?? "").match(/code (\d+)/i);
  return match ? Number(match[1]) : null;
}

function parsePlannerProviderStatusCode(result: Pick<AIJsonCallResult<unknown>, "error" | "stderr" | "rawMessage">): number | null {
  const match = `${result.error ?? ""}\n${result.stderr}\n${result.rawMessage}`.match(/\b(429|502|503|504)\b/);
  return match ? Number(match[1]) : null;
}

function normalizeTimingBreakdown(value: AIProcessTimingBreakdown | null | undefined): Record<string, unknown> | null {
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

function normalizePartialOutput(
  checkpoint: AIJsonPartialProgressCheckpoint | null | undefined,
  redactor: SecretRedactor
): Record<string, unknown> | null {
  if (!checkpoint) {
    return null;
  }

  const redacted = redactJsonStrings(checkpoint, redactor);
  return {
    source: typeof redacted.source === "string" ? redacted.source : null,
    kind: typeof redacted.kind === "string" ? redacted.kind : null,
    event_type: typeof redacted.eventType === "string" ? redacted.eventType : null,
    session_id: typeof redacted.sessionId === "string" ? redacted.sessionId : null,
    excerpt: normalizeDiagnosticExcerpt(typeof redacted.excerpt === "string" ? redacted.excerpt : undefined, redactor)
  };
}

function normalizePlannerEnvironmentState(
  sandbox: AppConfig["ai"]["plannerSandbox"],
  cwd: string
): Record<string, unknown> {
  return {
    sandbox,
    cwd,
    process_cwd: process.cwd(),
    node_env: process.env.NODE_ENV ?? null,
    pid: process.pid
  };
}

function buildPlannerExitStatus(result: AIJsonCallResult<unknown>): Record<string, unknown> {
  return {
    exit_code: result.diagnostics?.exitCode ?? parsePlannerExitCode(result.error),
    exit_signal: result.diagnostics?.exitSignal ?? null,
    timed_out: result.diagnostics?.timedOut ?? /timed out/i.test(`${result.error ?? ""}\n${result.stderr}\n${result.rawMessage}`)
  };
}

function buildPlannerPartialOutput(result: AIJsonCallResult<unknown>): Record<string, unknown> {
  const redactor = new SecretRedactor(process.env);
  return {
    checkpoint: normalizePartialOutput(result.diagnostics?.partialProgress, redactor),
    stdout_tail: normalizeDiagnosticExcerpt(result.stdout, redactor),
    stderr_tail: normalizeDiagnosticExcerpt(result.stderr, redactor),
    raw_tail: normalizeDiagnosticExcerpt(result.rawMessage, redactor)
  };
}

async function buildPlannerFailureSnapshot(tools: ToolRegistry): Promise<PlannerFailureSnapshot> {
  const cpuUsage = process.cpuUsage();
  const memoryUsage = process.memoryUsage();
  const registeredTools = tools
    .listTools()
    .map((tool) => tool.name)
    .sort();
  const interfaceNames = Object.entries(os.networkInterfaces())
    .filter(([, addresses]) => (addresses ?? []).some((address) => address.internal === false))
    .map(([name]) => name)
    .sort()
    .slice(0, PLANNER_DIAGNOSTIC_LIST_LIMIT);
  const probeStartedAt = Date.now();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let networkConnectivity: Record<string, unknown>;

  try {
    await Promise.race([
      lookup(PLANNER_NETWORK_PROBE_TARGET),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("network_probe_timeout")), PLANNER_NETWORK_PROBE_TIMEOUT_MS);
      })
    ]);

    networkConnectivity = {
      status: "reachable",
      probe_target: `dns:${PLANNER_NETWORK_PROBE_TARGET}`,
      probe_latency_ms: Date.now() - probeStartedAt,
      timed_out: false,
      error: null,
      non_internal_interface_count: interfaceNames.length,
      interface_names: interfaceNames
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    networkConnectivity = {
      status: message === "network_probe_timeout" ? "timeout" : "unreachable",
      probe_target: `dns:${PLANNER_NETWORK_PROBE_TARGET}`,
      probe_latency_ms: Date.now() - probeStartedAt,
      timed_out: message === "network_probe_timeout",
      error: message,
      non_internal_interface_count: interfaceNames.length,
      interface_names: interfaceNames
    };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }

  return {
    captured_at: new Date().toISOString(),
    cpu_state: {
      process_user_cpu_time_us: cpuUsage.user,
      process_system_cpu_time_us: cpuUsage.system,
      system_load_average: os.loadavg(),
      available_parallelism: typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length
    },
    memory_state: {
      process_rss_bytes: memoryUsage.rss,
      process_heap_total_bytes: memoryUsage.heapTotal,
      process_heap_used_bytes: memoryUsage.heapUsed,
      process_external_bytes: memoryUsage.external,
      process_array_buffers_bytes: memoryUsage.arrayBuffers,
      system_total_bytes: os.totalmem(),
      system_free_bytes: os.freemem()
    },
    network_connectivity: networkConnectivity,
    tool_availability: {
      status: registeredTools.length > 0 ? "available" : "none_registered",
      registered_count: registeredTools.length,
      registered_tools: registeredTools.slice(0, PLANNER_DIAGNOSTIC_LIST_LIMIT)
    }
  };
}

function buildPlannerTimeoutContext(
  result: AIJsonCallResult<unknown>,
  sandbox: AppConfig["ai"]["plannerSandbox"],
  cwd: string,
  failureSnapshot: PlannerFailureSnapshot
): PlannerDiagnosticsContext {
  return {
    timeout_duration_ms: result.diagnostics?.timingBreakdown?.timeoutMs ?? null,
    partial_output: buildPlannerPartialOutput(result),
    exit_status: buildPlannerExitStatus(result),
    environment_state: normalizePlannerEnvironmentState(sandbox, cwd),
    failure_snapshot: failureSnapshot,
    provider_error_context: null
  };
}

function buildPlannerProviderFailureContext(
  result: AIJsonCallResult<unknown>,
  sandbox: AppConfig["ai"]["plannerSandbox"],
  cwd: string,
  failureSnapshot: PlannerFailureSnapshot,
  failureKind: Extract<PlannerTransientFailureKind, "provider_rate_limit" | "provider_upstream_error">
): PlannerDiagnosticsContext {
  const redactor = new SecretRedactor(process.env);

  return {
    timeout_duration_ms: result.diagnostics?.timingBreakdown?.timeoutMs ?? null,
    partial_output: buildPlannerPartialOutput(result),
    exit_status: buildPlannerExitStatus(result),
    environment_state: normalizePlannerEnvironmentState(sandbox, cwd),
    failure_snapshot: failureSnapshot,
    provider_error_context: {
      failure_kind: failureKind,
      status_code: parsePlannerProviderStatusCode(result),
      retry_exhausted: true,
      error_excerpt: normalizeDiagnosticExcerpt(result.error, redactor),
      stderr_excerpt: normalizeDiagnosticExcerpt(result.stderr, redactor),
      raw_excerpt: normalizeDiagnosticExcerpt(result.rawMessage, redactor)
    }
  };
}

async function writePlannerDiagnosticsArtifact(
  homeDir: string,
  prompt: string,
  result: AIJsonCallResult<unknown>,
  failureKind: PlannerTransientFailureKind,
  diagnosticsContext: PlannerDiagnosticsContext
): Promise<string> {
  const redactor = new SecretRedactor(process.env);
  const diagnosticsPath = resolvePlannerDiagnosticsPath(homeDir);
  const diagnostics = result.diagnostics;

  await writeJsonFile(diagnosticsPath, {
    created_at: new Date().toISOString(),
    failure_classification: failureKind,
    exit_code: diagnostics?.exitCode ?? parsePlannerExitCode(result.error),
    exit_signal: diagnostics?.exitSignal ?? null,
    timed_out: diagnostics?.timedOut ?? /timed out/i.test(`${result.error ?? ""}\n${result.stderr}\n${result.rawMessage}`),
    sandbox: diagnosticsContext.environment_state?.sandbox ?? null,
    cwd: diagnosticsContext.environment_state?.cwd ?? null,
    model: diagnostics?.model ?? null,
    prompt_chars: diagnostics?.promptChars ?? prompt.length,
    input_tokens: diagnostics?.inputTokens ?? null,
    output_tokens: diagnostics?.outputTokens ?? null,
    total_tokens: diagnostics?.totalTokens ?? null,
    timing_breakdown: normalizeTimingBreakdown(diagnostics?.timingBreakdown),
    partial_progress_checkpoint: normalizePartialOutput(diagnostics?.partialProgress, redactor),
    timeout_duration_ms: diagnosticsContext.timeout_duration_ms,
    partial_output: diagnosticsContext.partial_output,
    exit_status: diagnosticsContext.exit_status,
    environment_state: diagnosticsContext.environment_state,
    failure_snapshot: diagnosticsContext.failure_snapshot,
    provider_error_context: diagnosticsContext.provider_error_context,
    prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
    role_contract_mode: "runtime_json_v1",
    stdout_tail: normalizeDiagnosticExcerpt(result.stdout, redactor),
    stderr_tail: normalizeDiagnosticExcerpt(result.stderr, redactor),
    raw_tail: normalizeDiagnosticExcerpt(result.rawMessage, redactor),
    error: normalizeDiagnosticExcerpt(result.error, redactor)
  });

  return diagnosticsPath;
}

function buildPlannerActionableFailureContext(diagnosticsContext: PlannerDiagnosticsContext | null): string {
  if (!diagnosticsContext?.provider_error_context) {
    return "";
  }

  const statusCode = diagnosticsContext.provider_error_context.status_code;
  return typeof statusCode === "number" ? ` | provider_status: ${statusCode}` : "";
}

function hasNoDiffSignal(previousRoundError: string | null): boolean {
  const error = (previousRoundError ?? "").toLowerCase();
  return error.includes("no observable file creation or content diff") || error.includes("insufficient evidence");
}

function isDocumentationPath(pathToken: string): boolean {
  const normalized = pathToken.trim().replace(/\\/g, "/");
  return (
    normalized.startsWith(".ailoop/") ||
    normalized.startsWith("docs/") ||
    normalized === "README.md" ||
    normalized === "ARCHITECTURE.md" ||
    normalized === "AILOOP_ENGINE_WORKFLOW.md" ||
    normalized.endsWith(".md")
  );
}

function isDocumentationOnlySubTask(subTask: SubTask): boolean {
  const impactedFiles = subTask.impacted_files.map((item) => item.trim()).filter(Boolean);
  const touchesOnlyDocumentation = impactedFiles.length === 0 || impactedFiles.every(isDocumentationPath);
  if (!touchesOnlyDocumentation) {
    return false;
  }

  const combined = `${subTask.rationale} ${subTask.objective} ${subTask.expected_outcome}`.toLowerCase();
  return /(readme|docs?|文档|report|checklist|audit|markdown|requirement|requirements|current\.md|\.ailoop)/.test(
    combined
  );
}

function shouldForceImplementationForReadyRequirement(context: PlannerContext, subTask: SubTask): boolean {
  return (
    resolvePlannerRequirementMode(context) === "normal_execution" &&
    !hasExplicitDocumentationRequest(context.instructions) &&
    isDocumentationOnlySubTask(subTask)
  );
}

function buildImplementationFirstSubTask(reason: string): SubTask {
  return {
    rationale: `${reason} The active requirement is already implementation-ready, so this round must advance the product with a minimal code or test change instead of refreshing documentation again.`,
    assignee: "executor",
    objective: "Implement one minimal code or test change that advances the active requirement.",
    expected_outcome:
      "At least one file under src/, scripts/, or web/src/ changes and one re-runnable verification command confirms progress.",
    impacted_files: ["src/", "scripts/", "web/src/"],
    recommended_tools: ["read_file", "write_file", "run_shell"]
  };
}

export function resolvePlannerRequirementMode(
  context: PlannerContext
): "create_requirement" | "refresh_requirement" | "normal_execution" {
  if (context.requirement_artifact_status === "missing") {
    return "create_requirement";
  }

  if (context.requirement_artifact_status === "needs_refresh") {
    return "refresh_requirement";
  }

  return "normal_execution";
}

export function buildAdaptivePlannerDirectives(context: PlannerContext): string[] {
  const requirementMode = resolvePlannerRequirementMode(context);
  if (requirementMode === "create_requirement" || requirementMode === "refresh_requirement") {
    return [
      "Do not continue normal code implementation until the active requirement artifact is available.",
      `Direct this round toward ${requirementMode === "create_requirement" ? "creating" : "refreshing"} .ailoop/product-requirements/current.md first.`
    ];
  }

  const shouldForceImplementation =
    (context.consecutive_evaluator_failures > 0 || hasNoDiffSignal(context.previous_round_error)) &&
    !hasExplicitDocumentationRequest(context.instructions);

  if (!shouldForceImplementation) {
    return [];
  }

  return [
    "Do not output documentation-only audit/checklist/report tasks.",
    "Pick one smallest implementation step that mutates tracked project files under src/, scripts/, or web/src/.",
    "Expected outcome must name changed file path(s) and one re-runnable verification command."
  ];
}

export function buildPlannerPrompt(
  context: PlannerContext,
  adaptiveDirectives: string[],
  plannerRoleDefinition: string,
  availableSkills: { name: string; description: string }[] = [],
  workspaceRoot = process.cwd()
): string {
  const skillsContext = availableSkills.length > 0
    ? [
        "Available Skills (the Executor can load these if you recommend 'activate_skill'):",
        ...availableSkills.map((s) => `- ${s.name}: ${s.description}`)
      ]
    : [];

  return [
    "You are the AILoop Planner agent.",
    "Project-specific Planner Role Definition:",
    plannerRoleDefinition.trim(),
    "",
    `Repository root: ${workspaceRoot}`,
    "",
    "Runtime execution notes:",
    "- This internal runtime session is intentionally isolated from repository-local AGENTS.md files and development-assistant skill workflows.",
    "- If you inspect repository files, use absolute paths under the repository root or explicitly `cd` into the repository root first.",
    "- Do not use external development-assistant skills, collaborative brainstorming workflows, or human question-asking patterns.",
    "",
    "Return one atomic SubTask JSON that strictly matches the output schema.",
    "Rules:",
    "- One task only.",
    "- Respect human instructions as highest priority.",
    "- Prioritize measurable user-defined value over cosmetic activity.",
    "- If goal is missing, create a clarification request task.",
    "- Consider previous round failure when setting rationale.",
    "- Explicitly list ALL files or directories in 'impacted_files' that will be relevant for this step (snapshotting).",
    "- Keep the plan domain-agnostic and derived only from provided goal/instructions; do not inject scenario-specific assumptions.",
    "- objective and expected_outcome must be observable and verifiable (workspace change, command output, API check, or evaluator evidence).",
    "- If required context is missing for safe execution, choose a clarification sub-task instead of guessing.",
    "- Keep recommended_tools realistic from: read_file, write_file, run_shell, http_request, activate_skill.",
    ...(adaptiveDirectives.length > 0
      ? ["- Additional adaptive constraints from prior failures:", ...adaptiveDirectives.map((line) => `  - ${line}`)]
      : []),
    ...(skillsContext.length > 0 ? ["", ...skillsContext] : []),
    "",
    "Planner input:",
    JSON.stringify(
      {
        goal: context.goal,
        instructions: context.instructions,
        round: context.round,
        budget: context.budget,
        previous_tool_result: context.previous_tool_result,
        previous_round_error: context.previous_round_error,
        consecutive_evaluator_failures: context.consecutive_evaluator_failures,
        requirement_artifact_status: context.requirement_artifact_status ?? "ready",
        requirement_artifact_summary: context.requirement_artifact_summary ?? null
      },
      null,
      2
    )
  ].join("\n");
}

function fallbackPlan(context: PlannerContext): SubTask {
  const goal = context.goal.trim();
  const latestInstruction = context.instructions.at(-1)?.trim();
  const previousError = context.previous_tool_result?.error?.message?.trim();
  const requirementMode = resolvePlannerRequirementMode(context);

  if (!goal) {
    return {
      rationale: "Missing required context: README.md is empty, so the safest next action is clarification.",
      assignee: "executor",
      objective: "Request clarification from the operator to populate .ailoop/README.md before continuing execution.",
      expected_outcome: "A human instruction is queued with concrete goal details.",
      impacted_files: [".ailoop/README.md"],
      recommended_tools: ["read_file"]
    };
  }

  if (requirementMode === "create_requirement" || requirementMode === "refresh_requirement") {
    const needsRefresh = requirementMode === "refresh_requirement";
    return {
      rationale: needsRefresh
        ? "The active requirement slice is no longer sufficient for safe execution, so product definition must be refreshed before implementation continues."
        : "No active requirement slice exists, so product definition must be created before implementation continues.",
      assignee: "executor",
      objective: `${needsRefresh ? "Refresh" : "Create"} the active requirement artifact at .ailoop/product-requirements/current.md via the ProductManager before normal execution planning resumes.`,
      expected_outcome: "The active requirement artifact exists as human-readable Markdown and is specific enough for the next atomic round.",
      impacted_files: [".ailoop/product-requirements/current.md"],
      recommended_tools: ["read_file"]
    };
  }

  const blockerNote =
    context.previous_tool_result?.status === "failure"
      ? `Previous round failed${previousError ? ` with blocker: ${sanitizeInstruction(previousError)}.` : "."} This step prioritizes a deterministic, low-risk recovery action.`
      : "This step keeps the round atomic, verifiable, and aligned with measurable progress.";

  if (latestInstruction) {
    const cleanedInstruction = sanitizeInstruction(latestInstruction);
    return {
      rationale: `${blockerNote} Human instruction was supplied and is highest-priority input for this round.`,
      assignee: "executor",
      objective: `Execute one atomic, verifiable step that applies instruction '${cleanedInstruction}' and advances the goal.`,
      expected_outcome: "A concrete state change or validation result demonstrates measurable progress tied to the instruction.",
      impacted_files: [],
      recommended_tools: ["read_file", "write_file", "run_shell", "http_request"]
    };
  }

  if (context.consecutive_evaluator_failures > 0 && !hasExplicitDocumentationRequest(context.instructions)) {
    return {
      rationale: `${blockerNote} Prior evaluator failures require an implementation-first recovery task with concrete, verifiable code change.`,
      assignee: "executor",
      objective: "Implement one minimal code or test change in tracked project files that addresses the latest failure signal.",
      expected_outcome:
        "At least one file under src/, scripts/, or web/src/ changes and a re-runnable verification command confirms progress.",
      impacted_files: ["src/", "scripts/", "web/src/"],
      recommended_tools: ["read_file", "write_file", "run_shell"]
    };
  }

  return {
    rationale: `${blockerNote} The round should produce one clear, outcome-oriented change without broad scope expansion.`,
    assignee: "executor",
    objective: `Complete one atomic, verifiable step for round ${context.round} that advances the goal in README.md.`,
    expected_outcome: "Evidence in workspace state or checks shows measurable progress toward the goal.",
    impacted_files: [],
    recommended_tools: ["read_file", "write_file", "run_shell"]
  };
}

function normalizeSubTask(candidate: SubTask): SubTask {
  return {
    rationale: String(candidate.rationale ?? "").trim(),
    assignee: candidate.assignee === "designer" ? "designer" : "executor",
    objective: String(candidate.objective ?? "").trim(),
    expected_outcome: String(candidate.expected_outcome ?? "").trim(),
    impacted_files: Array.isArray(candidate.impacted_files)
      ? candidate.impacted_files.map((item) => String(item)).filter(Boolean)
      : [],
    recommended_tools: Array.isArray(candidate.recommended_tools)
      ? candidate.recommended_tools.map((item) => String(item)).filter(Boolean)
      : []
  };
}

export class PlannerAgent {
  private readonly ai: Pick<AIClient, "runJson">;
  private readonly sandbox: AppConfig["ai"]["plannerSandbox"];
  private readonly homeDir: string;
  private readonly tools: ToolRegistry;
  private readonly workspaceRoot: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly buildFailureSnapshot: PlannerFailureSnapshotBuilder;

  constructor(
    tools: ToolRegistry,
    config: AppConfig,
    aiClient?: Pick<AIClient, "runJson">,
    sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    buildFailureSnapshotFn: PlannerFailureSnapshotBuilder = buildPlannerFailureSnapshot
  ) {
    this.tools = tools;
    this.ai = aiClient ?? new AIClient(config.ai);
    this.sandbox = config.ai.plannerSandbox;
    this.homeDir = config.homeDir;
    this.workspaceRoot = process.cwd();
    this.sleep = sleepFn;
    this.buildFailureSnapshot = buildFailureSnapshotFn;
  }

  async plan(
    context: PlannerContext,
    options?: {
      onLog?: (message: string) => void | Promise<void>;
    }
  ): Promise<SubTask> {
    const emitLog = (message: string): void => {
      if (!options?.onLog) {
        return;
      }
      void Promise.resolve(options.onLog(message)).catch(() => {
        // Planner logging is best-effort and must not block planning.
      });
    };
    const toLogLines = (_source: "stdout" | "stderr", chunk: string): string[] =>
      chunk
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line) => `[planner] ${line}`);

    const adaptiveDirectives = buildAdaptivePlannerDirectives(context);
    const plannerRoleDefinition = await loadProjectRoleDefinition(this.homeDir, "planner");

    await this.tools.initialize();
    const availableSkills = this.tools.getSkillManager().getAvailableSkills();
    const prompt = buildPlannerPrompt(
      context,
      adaptiveDirectives,
      plannerRoleDefinition,
      availableSkills,
      this.workspaceRoot
    );

    emitLog("ProjectPlanner started AI CLI planning.");
    const heartbeatStartedAt = Date.now();
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - heartbeatStartedAt) / 1000);
      emitLog(`ProjectPlanner running... ${elapsedSeconds}s elapsed.`);
    }, 15_000);

    let result: AIJsonCallResult<SubTask> | null = null;
    let finalTransientFailure: PlannerTransientFailureKind | null = null;

    try {
      for (let attempt = 1; attempt <= PLANNER_TRANSIENT_RETRY_MAX_ATTEMPTS; attempt += 1) {
        result = await this.ai.runJson<SubTask>({
          prompt,
          schema: SUBTASK_SCHEMA,
          cwd: this.workspaceRoot,
          sandbox: this.sandbox,
          sessionIsolation: {
            enabled: true,
            agentsGuide: buildInternalRuntimeSessionGuide("ProjectPlanner", [
              "If repository inspection is needed, use absolute paths under the provided repository root or explicitly `cd` into the repository root first."
            ])
          },
          onStdoutChunk: (chunk) => {
            for (const line of toLogLines("stdout", chunk)) {
              emitLog(line);
            }
          },
          onStderrChunk: (chunk) => {
            for (const line of toLogLines("stderr", chunk)) {
              emitLog(line);
            }
          }
        });
        emitLog(
          `ProjectPlanner AI CLI planning finished (ok=${result.ok}, attempt=${attempt}/${PLANNER_TRANSIENT_RETRY_MAX_ATTEMPTS}).`
        );

        finalTransientFailure = !result.ok || !result.data ? classifyTransientPlannerFailure(result) : null;
        if (!finalTransientFailure) {
          break;
        }

        if (attempt === PLANNER_TRANSIENT_RETRY_MAX_ATTEMPTS) {
          break;
        }

        const delayMs = getPlannerRetryDelayMs(attempt);
        emitLog(
          `ProjectPlanner transient AI failure (${finalTransientFailure}), retrying in ${delayMs}ms (attempt ${attempt}/${PLANNER_TRANSIENT_RETRY_MAX_ATTEMPTS}).`
        );
        await this.sleep(delayMs);
      }
    } finally {
      clearInterval(heartbeat);
    }

    if (!result) {
      return fallbackPlan(context);
    }

    if (!result.ok || !result.data) {
      if (finalTransientFailure) {
        let diagnosticsPath: string | undefined;
        let diagnosticsContext: PlannerDiagnosticsContext | null = null;
        if (
          finalTransientFailure === "timeout" ||
          finalTransientFailure === "provider_upstream_error" ||
          finalTransientFailure === "provider_rate_limit"
        ) {
          diagnosticsContext =
            finalTransientFailure === "timeout"
              ? buildPlannerTimeoutContext(
                  result,
                  this.sandbox,
                  this.workspaceRoot,
                  await this.buildFailureSnapshot(this.tools)
                )
              : buildPlannerProviderFailureContext(
                  result,
                  this.sandbox,
                  this.workspaceRoot,
                  await this.buildFailureSnapshot(this.tools),
                  finalTransientFailure
                );
          emitLog(
            `ProjectPlanner ${
              finalTransientFailure === "timeout"
                ? "timeout"
                : finalTransientFailure === "provider_rate_limit"
                  ? "provider rate limit"
                  : "provider upstream"
            } context: ${JSON.stringify(diagnosticsContext)}`
          );
          diagnosticsPath = await writePlannerDiagnosticsArtifact(
            this.homeDir,
            prompt,
            result,
            finalTransientFailure,
            diagnosticsContext
          );
          emitLog(`ProjectPlanner diagnostics artifact: ${diagnosticsPath}`);
        }
        throw new PlannerInfrastructureError(
          `Planner AI CLI ${describeTransientPlannerFailure(finalTransientFailure)} after ${PLANNER_TRANSIENT_RETRY_MAX_ATTEMPTS} attempts: ${summarizeInfrastructureFailure(result)}${buildPlannerActionableFailureContext(diagnosticsContext)}${diagnosticsPath ? ` | diagnostics: ${diagnosticsPath}` : ""}`
        );
      }
      return fallbackPlan(context);
    }

    const normalized = normalizeSubTask(result.data);
    if (!normalized.objective || !normalized.expected_outcome || normalized.recommended_tools.length === 0) {
      return fallbackPlan(context);
    }

    if (shouldForceImplementationForReadyRequirement(context, normalized)) {
      return buildImplementationFirstSubTask(
        "Planner proposed a documentation-only subtask while the active requirement slice was already ready."
      );
    }

    return normalized;
  }

  asStrictJson(subTask: SubTask): string {
    return JSON.stringify(subTask);
  }
}
