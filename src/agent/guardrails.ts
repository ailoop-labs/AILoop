import type { BudgetLimits, BudgetUsage } from "../types/contracts";

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
    const elapsedMs = Date.now() - this.startedAt;
    if (this.usdUsed > this.limits.usdPerRound) {
      throw new BudgetBreachError("cost", "BudgetBreach: USD budget exceeded");
    }

    if (elapsedMs > this.limits.timeMinutes * 60_000) {
      throw new BudgetBreachError("time", "BudgetBreach: time budget exceeded");
    }

    if (this.actionsUsed > this.limits.actions) {
      throw new BudgetBreachError("actions", "BudgetBreach: action budget exceeded");
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
