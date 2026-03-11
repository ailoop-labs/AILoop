import type { AppConfig } from "../config/env";
import type { EvaluationResult, RoundEvaluationContext } from "../types/contracts";
import { LLMJudgeEvaluator } from "./strategies/llm-judge";

export interface Evaluator {
  evaluate(context: RoundEvaluationContext): Promise<EvaluationResult>;
}

export function createEvaluator(config: AppConfig): Evaluator {
  return new LLMJudgeEvaluator(config);
}
