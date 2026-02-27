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
      ? "Previous round failed; this step prioritizes a deterministic, low-risk update."
      : "Establishing/refreshing the next atomic action keeps rounds small and verifiable.";

  if (latestInstruction) {
    const cleanedInstruction = sanitizeInstruction(latestInstruction);
    return {
      rationale: `${blockerNote} Human instruction was supplied and is highest-priority input for this round.`,
      objective: `Process instruction '${cleanedInstruction}' and record one concrete next step in .autoloop/task.md.`,
      expected_outcome: ".autoloop/task.md contains a new round entry tied to the latest human instruction.",
      recommended_tools: ["read_file", "write_file", "run_shell", "http_request"]
    };
  }

  return {
    rationale: `${blockerNote} The round should produce a single visible state update without broad scope expansion.`,
    objective: `Update .autoloop/task.md with one atomic next step for round ${context.round} aligned to goal.md.`,
    expected_outcome: ".autoloop/task.md contains a round entry with objective and expected outcome.",
    recommended_tools: ["read_file", "write_file"]
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
      "- If goal is missing, create a clarification request task.",
      "- Consider previous round failure when setting rationale.",
      "- For this bootstrap phase, the objective must be completable within 1 minute and must include updating .autoloop/task.md.",
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
