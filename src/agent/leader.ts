import type { AppConfig } from "../config/env";
import type { LeaderContext, LeaderDecision } from "../types/contracts";
import { CodexClient, type JsonSchema } from "./codex-client";
import { loadProjectRoleDefinition } from "./role-definitions";

const LEADER_DECISION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    rationale: { type: "string" },
    action: { type: "string", enum: ["resume", "stop"] },
    instructions: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: ["rationale", "action", "instructions"],
  additionalProperties: false
};

function buildLeaderPrompt(context: LeaderContext, roleDefinition: string): string {
  const dimensionsSummary = context.previousEvaluationDimensions
    ? context.previousEvaluationDimensions.map(d => 
        `- ${d.dimension}: ${d.decision} (score=${d.score}, confidence=${d.confidence}) - ${d.justification}`
      ).join("\n")
    : "None";

  return [
    roleDefinition,
    "",
    "## Current State",
    `- Goal: ${context.goal}`,
    `- Last Error: ${context.lastError ?? "None"}`,
    `- Previous Evaluator Justification: ${context.previousEvaluationJustification ?? "None"}`,
    "",
    "## Evaluation Dimensions Breakdown",
    dimensionsSummary,
    "",
    "## Workspace Changes (Diff)",
    context.stateChange ?? "No changes.",
    "",
    "## Task",
    "You are the Leader. The AILoop is currently PAUSED because of the errors/failures above.",
    "Your job is to diagnose the root cause and provide strategic instructions to unblock the loop.",
    "1. Read necessary logs, source code or configuration to understand what went wrong.",
    "2. If needed, write to README.md, GOAL.md or ARCHITECTURE.md to adjust the strategy.",
    "3. Provide concrete instructions for the Planner and Executor for the next round.",
    "4. Return a JSON object with your rationale, action ('resume' or 'stop'), and the instructions.",
    "",
    "IMPORTANT: You MUST NOT modify source code or tests. You may only modify directional documents."
  ].join("\n");
}

export interface LeaderExecuteOptions {
  context: LeaderContext;
  paths: { homeDir: string };
  onLog: (message: string) => void | Promise<void>;
}

export class LeaderAgent {
  private readonly codex: CodexClient;
  private readonly sandbox: AppConfig["codex"]["executorSandbox"];

  constructor(private readonly config: AppConfig) {
    this.codex = new CodexClient(config.codex);
    // Leader needs workspace write access to modify ARCHITECTURE.md
    this.sandbox = "workspace-write";
  }

  async execute(options: LeaderExecuteOptions): Promise<LeaderDecision> {
    const roleDefinition = await loadProjectRoleDefinition(options.paths.homeDir, "leader");
    const prompt = buildLeaderPrompt(options.context, roleDefinition);

    await options.onLog("Leader started Codex execution to unblock the loop.");
    const heartbeatStartedAt = Date.now();
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - heartbeatStartedAt) / 1000);
      options.onLog(`Leader running... ${elapsedSeconds}s elapsed.`);
    }, 15_000);

    try {
      const result = await this.codex.runJson<LeaderDecision>({
        prompt,
        schema: LEADER_DECISION_SCHEMA,
        cwd: process.cwd(),
        sandbox: this.sandbox,
        onStdoutChunk: (chunk) => {
          options.onLog(`[stdout] ${chunk.trim()}`);
        },
        onStderrChunk: (chunk) => {
          options.onLog(`[stderr] ${chunk.trim()}`);
        }
      });

      await options.onLog(`Leader Codex execution finished (ok=${result.ok}).`);

      if (!result.ok || !result.data) {
        throw new Error(result.error ?? result.stderr ?? "Leader execution failed");
      }

      return result.data;
    } finally {
      clearInterval(heartbeat);
    }
  }
}
