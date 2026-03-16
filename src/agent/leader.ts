import type { AppConfig } from "../config/env";
import type { LeaderContext, LeaderDecision } from "../types/contracts";
import { CodexClient, type JsonSchema } from "./codex-client";
import { loadProjectRoleDefinition } from "./role-definitions";
import { buildInternalRuntimeSessionGuide } from "./runtime-policy";

const LEADER_DECISION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    rationale: { type: "string" },
    action: { type: "string", enum: ["resume", "stop", "escalate_to_ccb"] },
    diagnosis_type: { type: "string", enum: ["implementation_failure", "constitutional_conflict"] },
    instructions: {
      type: "array",
      items: { type: "string" }
    },
    proposed_readme_change: { type: "string" }
  },
  required: ["rationale", "action", "diagnosis_type", "instructions"],
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
    `- Previous Evaluation Dimensions:`,
    dimensionsSummary,
    "",
    "## Task",
    "Analyze the situation and decide the next move.",
    "1. If it's an 'implementation_failure', provide strategic instructions for the Executor and set action='resume'.",
    "2. If the goal in README.md is unreachable given the current constraints/logic, it's a 'constitutional_conflict'. Set action='escalate_to_ccb' and propose a change to README.md.",
    "3. Return the decision as JSON."
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
    this.sandbox = "workspace-write";
  }

  async execute(options: LeaderExecuteOptions): Promise<LeaderDecision> {
    const roleDefinition = await loadProjectRoleDefinition(options.paths.homeDir, "leader");
    const prompt = buildLeaderPrompt(options.context, roleDefinition);

    await options.onLog("Leader analyzing failures and formulating strategy...");
    
    try {
      const result = await this.codex.runJson<LeaderDecision>({
        prompt,
        schema: LEADER_DECISION_SCHEMA,
        cwd: process.cwd(),
        sandbox: this.sandbox,
        sessionIsolation: {
          enabled: true,
          agentsGuide: buildInternalRuntimeSessionGuide("Leader", [
            "Keep reasoning anchored to the supplied failure, evaluation, and governance context unless the runtime prompt explicitly broadens scope."
          ])
        }
      });

      if (!result.ok || !result.data) {
        throw new Error(result.error ?? result.stderr ?? "Leader strategy execution failed");
      }

      await options.onLog(`Leader Diagnosis: ${result.data.diagnosis_type}. Action: ${result.data.action}.`);
      return result.data;
    } catch (err) {
      await options.onLog(`Leader Error: ${(err as Error).message}`);
      throw err;
    }
  }
}
