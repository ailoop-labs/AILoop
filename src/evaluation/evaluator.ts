import type { AppConfig } from "../config/env";
import type { EvaluationResult, RoundEvaluationContext } from "../types/contracts";
import { LLMJudgeEvaluator } from "./strategies/llm-judge";
import { ShellEvaluator } from "./strategies/shell-script";
import { WebhookEvaluator } from "./strategies/webhook";

export interface Evaluator {
  evaluate(context: RoundEvaluationContext): Promise<EvaluationResult>;
}

export function createEvaluator(config: AppConfig): Evaluator {
  if (config.evaluatorType === "llm") {
    return new LLMJudgeEvaluator(config);
  }

  if (config.evaluatorType === "webhook") {
    return new WebhookEvaluator(config.webhookEvaluatorUrl);
  }

  return new ShellEvaluator(config.evaluatorCmd, config.homeDir);
}
