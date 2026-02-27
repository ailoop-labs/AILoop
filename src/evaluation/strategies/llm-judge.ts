import type { AppConfig } from "../../config/env";
import type { EvaluationResult, RoundEvaluationContext } from "../../types/contracts";
import { CodexClient, type JsonSchema } from "../../agent/codex-client";
import type { Evaluator } from "../evaluator";

const EVALUATION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["pass", "fail"] },
    justification: { type: "string" },
    evidence: {
      type: "array",
      items: { type: "string" }
    },
    recommended_next_action: { type: "string" }
  },
  required: ["decision", "justification", "evidence", "recommended_next_action"],
  additionalProperties: false
};

export class LLMJudgeEvaluator implements Evaluator {
  private readonly codex: CodexClient;
  private readonly sandbox: AppConfig["codex"]["evaluatorSandbox"];

  constructor(config: AppConfig) {
    this.codex = new CodexClient(config.codex);
    this.sandbox = config.codex.evaluatorSandbox;
  }

  async evaluate(context: RoundEvaluationContext): Promise<EvaluationResult> {
    const prompt = [
      "You are the AutoLoop LLM Judge evaluator.",
      "Evaluate whether the round objective was truly completed.",
      "Return JSON matching schema only.",
      "",
      "Rules:",
      "- Be skeptical by default.",
      "- If execution claim and observed state conflict, return fail.",
      "- Focus on correctness, not efficiency.",
      "",
      "Round context:",
      JSON.stringify(
        {
          objective: context.subTask.objective,
          expected_outcome: context.subTask.expected_outcome,
          tool_result: context.toolResult,
          state_change: context.stateChange,
          recent_logs: context.logLines.slice(-40)
        },
        null,
        2
      )
    ].join("\n");

    const codexResult = await this.codex.runJson<EvaluationResult>({
      prompt,
      schema: EVALUATION_SCHEMA,
      cwd: process.cwd(),
      sandbox: this.sandbox
    });

    if (!codexResult.ok || !codexResult.data) {
      const evidence = [codexResult.error, codexResult.stderr].filter(Boolean).map((item) => String(item));
      return {
        decision: "fail",
        justification: "Codex judge call failed, so this round cannot be trusted as complete.",
        evidence: evidence.length > 0 ? evidence : ["Codex judge unavailable"],
        recommended_next_action: "pause and inspect Codex evaluator failure"
      };
    }

    return {
      decision: codexResult.data.decision,
      justification: String(codexResult.data.justification ?? ""),
      evidence: Array.isArray(codexResult.data.evidence)
        ? codexResult.data.evidence.map((item) => String(item)).filter(Boolean)
        : [],
      recommended_next_action: codexResult.data.recommended_next_action
    };
  }
}
