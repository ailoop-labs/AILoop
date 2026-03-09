import type { BudgetLimits, BudgetUsage } from "../types/contracts";
import { evaluateRoundBudget } from "../engine/budget";

export class BudgetBreachError extends Error {
  constructor(public readonly dimension: "cost" | "time" | "actions", message: string) {
    super(message);
    this.name = "BudgetBreachError";
  }
}

export class Guardrails {
  private readonly startedAt: number;
  private usdUsed = 0;
  private actionsUsed = 0;

  constructor(private readonly limits: BudgetLimits) {
    this.startedAt = Date.now();
  }

  checkBudget(): void {
    const result = evaluateRoundBudget(this.limits, this.usage());
    if (result.breach) {
      throw new BudgetBreachError(result.breach.dimension, result.breach.message);
    }
  }

  recordAction(costUsd = 0): void {
    this.actionsUsed += 1;
    this.usdUsed += costUsd;
    this.checkBudget();
  }

  usage(): BudgetUsage {
    return {
      usdUsed: Number(this.usdUsed.toFixed(6)),
      actionsUsed: this.actionsUsed,
      elapsedMs: Date.now() - this.startedAt
    };
  }

  limitsSnapshot(): BudgetLimits {
    return { ...this.limits };
  }
}
