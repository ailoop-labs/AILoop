import { describe, expect, test } from "bun:test";
import { deriveRoundProgress } from "./round-progress";

describe("deriveRoundProgress", () => {
  test("reports planner stage when planner starts", () => {
    const result = deriveRoundProgress({
      state: "running",
      round: 3,
      logs: [
        "[2026-03-02T12:00:00.000Z] Round 3 started.",
        "[2026-03-02T12:00:01.000Z] Planner started Codex planning."
      ]
    });

    expect(result.percent).toBe(20);
    expect(result.role).toBe("Planner");
    expect(result.phase).toBe("planner");
    expect(result.step).toContain("planning");
  });

  test("reports evaluator dimension stage with parsed dimension name", () => {
    const result = deriveRoundProgress({
      state: "running",
      round: 8,
      logs: ["[2026-03-02T12:01:00.000Z] Evaluator checking dimension: goal_alignment."]
    });

    expect(result.percent).toBeGreaterThanOrEqual(80);
    expect(result.percent).toBeLessThan(100);
    expect(result.role).toBe("Evaluator");
    expect(result.phase).toBe("evaluator");
    expect(result.step).toContain("goal_alignment");
  });

  test("reports complete round during cooldown", () => {
    const result = deriveRoundProgress({
      state: "cooldown",
      round: 5,
      logs: ["[2026-03-02T12:02:00.000Z] Evaluator decision: pass."]
    });

    expect(result.percent).toBe(100);
    expect(result.role).toBe("System");
    expect(result.phase).toBe("cooldown");
    expect(result.step).toContain("cooldown");
  });

  test("prefers completed evaluator state over earlier dimension log lines", () => {
    const result = deriveRoundProgress({
      state: "running",
      round: 9,
      logs: [
        "[2026-03-02T12:03:00.000Z] Evaluator checking dimension: learning_yield.",
        "[2026-03-02T12:03:05.000Z] Evaluator completed LLM dimension checks (decision=pass)."
      ]
    });

    expect(result.percent).toBe(100);
    expect(result.role).toBe("Evaluator");
    expect(result.step).toContain("completed");
  });

  test("shows active auto-rework attempt number in executor stage", () => {
    const result = deriveRoundProgress({
      state: "running",
      round: 12,
      logs: [
        "[2026-03-02T12:05:00.000Z] Evaluator failed; triggering auto-rework attempt 2/3.",
        "[2026-03-02T12:05:01.000Z] [codex stdout] applying patch"
      ]
    });

    expect(result.role).toBe("Executor");
    expect(result.phase).toBe("executor");
    expect(result.step).toContain("2/3");
    expect(result.step).toContain("Auto-rework");
  });
});
