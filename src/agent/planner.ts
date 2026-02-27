import type { AppConfig } from "../config/env";
import type { PlannerContext, SubTask } from "../types/contracts";
import { CodexClient, type JsonSchema } from "./codex-client";

const SUBTASK_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    rationale: { type: "string" },
    objective: { type: "string" },
    expected_outcome: { type: "string" },
    recommended_tools: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: ["rationale", "objective", "expected_outcome", "recommended_tools"],
  additionalProperties: false
};

function sanitizeInstruction(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 240);
}

function fallbackPlan(context: PlannerContext): SubTask {
  const goal = context.goal.trim();
  const latestInstruction = context.instructions.at(-1)?.trim();
  const previousError = context.previous_tool_result?.error?.message?.trim();

  if (!goal) {
    return {
      rationale: "Missing required context: goal.md is empty, so the safest next action is clarification.",
      objective: "Request clarification from the operator to populate .autoloop/goal.md before continuing execution.",
      expected_outcome: "A human instruction is queued with concrete goal details.",
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
      objective: `Execute one atomic, verifiable step that applies instruction '${cleanedInstruction}' and advances the goal.`,
      expected_outcome: "A concrete state change or validation result demonstrates measurable progress tied to the instruction.",
      recommended_tools: ["read_file", "write_file", "run_shell", "http_request"]
    };
  }

  return {
    rationale: `${blockerNote} The round should produce one clear, outcome-oriented change without broad scope expansion.`,
    objective: `Complete one atomic, verifiable step for round ${context.round} that advances the goal in goal.md.`,
    expected_outcome: "Evidence in workspace state or checks shows measurable progress toward the goal.",
    recommended_tools: ["read_file", "write_file", "run_shell"]
  };
}

function normalizeSubTask(candidate: SubTask): SubTask {
  return {
    rationale: String(candidate.rationale ?? "").trim(),
    objective: String(candidate.objective ?? "").trim(),
    expected_outcome: String(candidate.expected_outcome ?? "").trim(),
    recommended_tools: Array.isArray(candidate.recommended_tools)
      ? candidate.recommended_tools.map((item) => String(item)).filter(Boolean)
      : []
  };
}

export class PlannerAgent {
  private readonly codex: CodexClient;
  private readonly sandbox: AppConfig["codex"]["plannerSandbox"];

  constructor(config: AppConfig) {
    this.codex = new CodexClient(config.codex);
    this.sandbox = config.codex.plannerSandbox;
  }

  async plan(context: PlannerContext): Promise<SubTask> {
    const prompt = [
      "You are the AutoLoop Planner agent.",
      "Return one atomic SubTask JSON that strictly matches the output schema.",
      "Rules:",
      "- One task only.",
      "- Respect human instructions as highest priority.",
      "- Prioritize measurable user-defined value over cosmetic activity.",
      "- If goal is missing, create a clarification request task.",
      "- Consider previous round failure when setting rationale.",
      "- Keep the plan domain-agnostic and derived only from provided goal/instructions; do not inject scenario-specific assumptions.",
      "- objective and expected_outcome must be observable and verifiable (workspace change, command output, API check, or evaluator evidence).",
      "- If required context is missing for safe execution, choose a clarification sub-task instead of guessing.",
      "- Keep recommended_tools realistic from: read_file, write_file, run_shell, http_request.",
      "",
      "Planner input:",
      JSON.stringify(
        {
          goal: context.goal,
          instructions: context.instructions,
          round: context.round,
          budget: context.budget,
          previous_tool_result: context.previous_tool_result
        },
        null,
        2
      )
    ].join("\n");

    const result = await this.codex.runJson<SubTask>({
      prompt,
      schema: SUBTASK_SCHEMA,
      cwd: process.cwd(),
      sandbox: this.sandbox
    });

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
