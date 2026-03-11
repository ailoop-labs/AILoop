import type { AppConfig } from "../config/env";
import { resolveCodexBin } from "../config/env";
import type { PlannerContext, SubTask } from "../types/contracts";
import { CodexClient, type JsonSchema } from "./codex-client";
import { loadProjectRoleDefinition } from "./role-definitions";
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

function sanitizeInstruction(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 240);
}

function hasExplicitDocumentationRequest(instructions: string[]): boolean {
  const merged = instructions.join(" ").toLowerCase();
  return /(readme|docs?|文档|报告|checklist|audit|baseline|goal\.md|task\.md|plan)/.test(merged);
}

function hasNoDiffSignal(previousRoundError: string | null): boolean {
  const error = (previousRoundError ?? "").toLowerCase();
  return error.includes("no observable file creation or content diff") || error.includes("insufficient evidence");
}

export function buildAdaptivePlannerDirectives(context: PlannerContext): string[] {
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
  availableSkills: { name: string; description: string }[] = []
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
        consecutive_evaluator_failures: context.consecutive_evaluator_failures
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
  private readonly codex: CodexClient;
  private readonly sandbox: AppConfig["codex"]["plannerSandbox"];
  private readonly homeDir: string;
  private readonly tools: ToolRegistry;

  constructor(tools: ToolRegistry, config: AppConfig) {
    this.tools = tools;
    this.codex = new CodexClient({
      ...config.codex,
      bin: resolveCodexBin(config.codex)
    });
    this.sandbox = config.codex.plannerSandbox;
    this.homeDir = config.homeDir;
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
    const toLogLines = (source: "stdout" | "stderr", chunk: string): string[] =>
      chunk
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line) => `[planner codex ${source}] ${line}`);

    const adaptiveDirectives = buildAdaptivePlannerDirectives(context);
    const plannerRoleDefinition = await loadProjectRoleDefinition(this.homeDir, "planner");
    
    await this.tools.initialize();
    const availableSkills = this.tools.getSkillManager().getAvailableSkills();
    const prompt = buildPlannerPrompt(context, adaptiveDirectives, plannerRoleDefinition, availableSkills);

    emitLog("Planner started Codex planning.");
    const heartbeatStartedAt = Date.now();
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - heartbeatStartedAt) / 1000);
      emitLog(`Planner running... ${elapsedSeconds}s elapsed.`);
    }, 15_000);

    const result = await this.codex
      .runJson<SubTask>({
        prompt,
        schema: SUBTASK_SCHEMA,
        cwd: process.cwd(),
        sandbox: this.sandbox,
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
      })
      .finally(() => {
        clearInterval(heartbeat);
      });
    emitLog(`Planner Codex planning finished (ok=${result.ok}).`);

    if (!result.ok || !result.data) {
      return fallbackPlan(context);
    }

    const normalized = normalizeSubTask(result.data);
    if (!normalized.objective || !normalized.expected_outcome || normalized.recommended_tools.length === 0) {
      return fallbackPlan(context);
    }

    return normalized;
  }

  asStrictJson(subTask: SubTask): string {
    return JSON.stringify(subTask);
  }
}
