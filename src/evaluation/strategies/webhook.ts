import type { EvaluationResult, RoundEvaluationContext } from "../../types/contracts";
import type { Evaluator } from "../evaluator";

export class WebhookEvaluator implements Evaluator {
  constructor(private readonly endpoint: string) {}

  async evaluate(context: RoundEvaluationContext): Promise<EvaluationResult> {
    if (!this.endpoint.trim()) {
      return {
        decision: "fail",
        justification: "Webhook evaluator URL is not configured.",
        evidence: ["Set AILOOP_WEBHOOK_EVALUATOR_URL to enable webhook checks."],
        recommended_next_action: "configure webhook evaluator URL"
      };
    }

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(context)
      });

      const text = await response.text();
      if (!response.ok) {
        return {
          decision: "fail",
          justification: `Webhook evaluator HTTP ${response.status}`,
          evidence: [text],
          recommended_next_action: "validate evaluator endpoint availability"
        };
      }

      return {
        decision: "pass",
        justification: "Webhook evaluator returned a successful response.",
        evidence: [text.slice(0, 300) || "Webhook response was empty"],
        recommended_next_action: "continue"
      };
    } catch (error) {
      return {
        decision: "fail",
        justification: "Webhook evaluator request failed.",
        evidence: [(error as Error).message],
        recommended_next_action: "verify network and webhook URL"
      };
    }
  }
}
