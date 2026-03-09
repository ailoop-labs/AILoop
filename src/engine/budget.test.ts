import { describe, expect, test } from "bun:test";
import type { BudgetLimits, BudgetUsage } from "../types/contracts";
import { evaluateRoundBudget } from "./budget";

const limits: BudgetLimits = {
  usdPerRound: 0.5,
  timeMinutes: 15,
  actions: 30
};

function usage(overrides: Partial<BudgetUsage> = {}): BudgetUsage {
  return {
    usdUsed: 0.1,
    elapsedMs: 60_000,
    actionsUsed: 1,
    ...overrides
  };
}

describe("evaluateRoundBudget", () => {
  test("returns no breach when usage stays within limits", () => {
    expect(evaluateRoundBudget(limits, usage())).toEqual({
      ok: true,
      breach: null
    });
  });

  test("returns a cost BudgetBreach when usdPerRound is exceeded", () => {
    expect(evaluateRoundBudget(limits, usage({ usdUsed: 0.500001 }))).toEqual({
      ok: false,
      breach: {
        type: "BudgetBreach",
        dimension: "cost",
        limitKey: "usdPerRound",
        limit: 0.5,
        used: 0.500001,
        message: "BudgetBreach: USD budget exceeded"
      }
    });
  });

  test("returns a time BudgetBreach when timeMinutes is exceeded", () => {
    expect(evaluateRoundBudget(limits, usage({ elapsedMs: 15 * 60_000 + 1 }))).toEqual({
      ok: false,
      breach: {
        type: "BudgetBreach",
        dimension: "time",
        limitKey: "timeMinutes",
        limit: 15 * 60_000,
        used: 15 * 60_000 + 1,
        message: "BudgetBreach: time budget exceeded"
      }
    });
  });

  test("returns an action BudgetBreach when actions is exceeded", () => {
    expect(evaluateRoundBudget(limits, usage({ actionsUsed: 31 }))).toEqual({
      ok: false,
      breach: {
        type: "BudgetBreach",
        dimension: "actions",
        limitKey: "actions",
        limit: 30,
        used: 31,
        message: "BudgetBreach: action budget exceeded"
      }
    });
  });

  test("returns the first deterministic breach when multiple limits are exceeded", () => {
    expect(
      evaluateRoundBudget(
        limits,
        usage({
          usdUsed: 1,
          elapsedMs: 16 * 60_000,
          actionsUsed: 99
        })
      )
    ).toEqual({
      ok: false,
      breach: {
        type: "BudgetBreach",
        dimension: "cost",
        limitKey: "usdPerRound",
        limit: 0.5,
        used: 1,
        message: "BudgetBreach: USD budget exceeded"
      }
    });
  });
});
