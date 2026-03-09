import type { BudgetLimits, BudgetUsage } from "../types/contracts";

export type BudgetDimension = "cost" | "time" | "actions";
export type BudgetLimitKey = "usdPerRound" | "timeMinutes" | "actions";

export interface BudgetBreach {
  type: "BudgetBreach";
  dimension: BudgetDimension;
  limitKey: BudgetLimitKey;
  limit: number;
  used: number;
  message: string;
}

export interface BudgetCheckResult {
  ok: boolean;
  breach: BudgetBreach | null;
}

const BUDGET_BREACHES: Array<{
  dimension: BudgetDimension;
  limitKey: BudgetLimitKey;
  message: string;
  used: (usage: BudgetUsage) => number;
  limit: (limits: BudgetLimits) => number;
}> = [
  {
    dimension: "cost",
    limitKey: "usdPerRound",
    message: "BudgetBreach: USD budget exceeded",
    used: (usage) => usage.usdUsed,
    limit: (limits) => limits.usdPerRound
  },
  {
    dimension: "time",
    limitKey: "timeMinutes",
    message: "BudgetBreach: time budget exceeded",
    used: (usage) => usage.elapsedMs,
    limit: (limits) => limits.timeMinutes * 60_000
  },
  {
    dimension: "actions",
    limitKey: "actions",
    message: "BudgetBreach: action budget exceeded",
    used: (usage) => usage.actionsUsed,
    limit: (limits) => limits.actions
  }
];

export function evaluateRoundBudget(limits: BudgetLimits, usage: BudgetUsage): BudgetCheckResult {
  for (const candidate of BUDGET_BREACHES) {
    const used = candidate.used(usage);
    const limit = candidate.limit(limits);

    if (used > limit) {
      return {
        ok: false,
        breach: {
          type: "BudgetBreach",
          dimension: candidate.dimension,
          limitKey: candidate.limitKey,
          limit,
          used,
          message: candidate.message
        }
      };
    }
  }

  return {
    ok: true,
    breach: null
  };
}
