import type { AppConfig } from "../config/env";
import type { LeaderContext, LeaderDecision } from "../types/contracts";
import { SecretRedactor } from "../utils/redaction";
import { CodexClient, type CodexJsonCallResult, type JsonSchema } from "./codex-client";
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

function normalizeDiagnosticExcerpt(value: string | undefined, redactor: SecretRedactor): string | null {
  const normalized = redactor.redact((value ?? "").replace(/\s+/g, " ").trim());
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, 500);
}

function buildLeaderFailureMessage(result: CodexJsonCallResult<LeaderDecision>): string {
  const redactor = new SecretRedactor(process.env);
  const baseMessage = normalizeDiagnosticExcerpt(result.error, redactor) ?? "Leader strategy execution failed";
  const details: string[] = [];
  const seen = new Set<string>([baseMessage]);
  const candidates: Array<{ label: "stderr" | "raw"; value: string | undefined }> = [
    { label: "stderr", value: result.stderr },
    { label: "raw", value: result.rawMessage }
  ];

  for (const candidate of candidates) {
    const excerpt = normalizeDiagnosticExcerpt(candidate.value, redactor);
    if (!excerpt || seen.has(excerpt)) {
      continue;
    }
    seen.add(excerpt);
    details.push(`${candidate.label}: ${excerpt}`);
  }

  return details.length > 0 ? `${baseMessage} | ${details.join(" | ")}` : baseMessage;
}

function buildLeaderPrompt(context: LeaderContext, roleDefinition: string): string {
  const dimensionsSummary = context.previousEvaluationDimensions
    ? context.previousEvaluationDimensions.map(d => 
        `- ${d.dimension}: ${d.decision} (score=${d.score}, confidence=${d.confidence}) - ${d.justification}`
      ).join("\n")
    : "None";
  const pauseDiagnosticSummary = context.previousHotFileGovernance
    ? `Hot-file governance block in ${context.previousHotFileGovernance.file_path} (${context.previousHotFileGovernance.result_class}): ${context.previousHotFileGovernance.reason}`
    : context.lastError ?? "None";
  const hotFileGovernanceSummary = context.previousHotFileGovernance
    ? [
        `- Class: ${context.previousHotFileGovernance.result_class}`,
        `- File: ${context.previousHotFileGovernance.file_path}`,
        `- Labels: ${context.previousHotFileGovernance.heuristic_labels.join(", ")}`,
        `- Reason: ${context.previousHotFileGovernance.reason}`,
        `- Next Action: ${context.previousHotFileGovernance.recommended_next_action}`
      ].join("\n")
    : "None";

  return [
    roleDefinition,
    "",
    "## Current State",
    `- Goal: ${context.goal}`,
    `- Last Error: ${context.lastError ?? "None"}`,
    `- Pause Diagnostic: ${pauseDiagnosticSummary}`,
    `- Previous Evaluation Dimensions:`,
    dimensionsSummary,
    "",
    `- Hot-File Governance Signal:`,
    hotFileGovernanceSummary,
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
        throw new Error(buildLeaderFailureMessage(result));
      }

      await options.onLog(`Leader Diagnosis: ${result.data.diagnosis_type}. Action: ${result.data.action}.`);
      return result.data;
    } catch (err) {
      await options.onLog(`Leader Error: ${(err as Error).message}`);
      throw err;
    }
  }
}
