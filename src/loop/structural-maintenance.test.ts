import { describe, expect, test } from "bun:test";
import type { HotFileGovernanceResult } from "../types/contracts";
import { shouldTriggerStructuralMaintenance, buildStructuralMaintenanceInstructions } from "./structural-maintenance";

describe("shouldTriggerStructuralMaintenance", () => {
  test("returns true when recommendation matches structural-maintenance pattern", () => {
    const hotFileGovernance: HotFileGovernanceResult = {
      file_path: "src/loop/engine.ts",
      heuristic_labels: ["large_file", "high_churn"],
      result_class: "hot_file_growth_failure",
      reason: "File exceeds 1000 lines and has high recent churn",
      recommended_next_action: "pause and split the next change into a bounded structural-maintenance pass"
    };

    expect(shouldTriggerStructuralMaintenance(hotFileGovernance)).toBe(true);
  });

  test("returns false when recommendation does not match pattern", () => {
    const hotFileGovernance: HotFileGovernanceResult = {
      file_path: "src/loop/engine.ts",
      heuristic_labels: ["large_file"],
      result_class: "hot_file_growth_failure",
      reason: "File exceeds 1000 lines",
      recommended_next_action: "reduce scope of next change"
    };

    expect(shouldTriggerStructuralMaintenance(hotFileGovernance)).toBe(false);
  });

  test("returns false when hotFileGovernance is null", () => {
    expect(shouldTriggerStructuralMaintenance(null)).toBe(false);
  });

  test("returns false when hotFileGovernance is undefined", () => {
    expect(shouldTriggerStructuralMaintenance(undefined)).toBe(false);
  });

  test("matches case-insensitive pattern", () => {
    const hotFileGovernance: HotFileGovernanceResult = {
      file_path: "src/loop/engine.ts",
      heuristic_labels: ["large_file"],
      result_class: "hot_file_growth_failure",
      reason: "File exceeds 1000 lines",
      recommended_next_action: "PAUSE AND SPLIT the next change into a BOUNDED STRUCTURAL-MAINTENANCE PASS"
    };

    expect(shouldTriggerStructuralMaintenance(hotFileGovernance)).toBe(true);
  });
});

describe("buildStructuralMaintenanceInstructions", () => {
  test("builds instructions with hot-file governance context", () => {
    const hotFileGovernance: HotFileGovernanceResult = {
      file_path: "src/loop/engine.ts",
      heuristic_labels: ["large_file", "high_churn"],
      result_class: "hot_file_growth_failure",
      reason: "File exceeds 1000 lines and has high recent churn",
      recommended_next_action: "pause and split the next change into a bounded structural-maintenance pass"
    };

    const baseInstructions = ["Fix the bug in the authentication flow"];
    const instructions = buildStructuralMaintenanceInstructions(hotFileGovernance, baseInstructions);

    expect(instructions.length).toBe(2);
    expect(instructions[0]).toContain("[STRUCTURAL MAINTENANCE PASS]");
    expect(instructions[0]).toContain("src/loop/engine.ts");
    expect(instructions[0]).toContain("File exceeds 1000 lines and has high recent churn");
    expect(instructions[0]).toContain("large_file, high_churn");
    expect(instructions[0]).toContain("split this file into smaller, focused modules");
    expect(instructions[0]).toContain("pure refactoring pass");
    expect(instructions[0]).toContain("line count is reduced by at least 30%");
    expect(instructions[1]).toBe("Fix the bug in the authentication flow");
  });

  test("preserves base instructions order", () => {
    const hotFileGovernance: HotFileGovernanceResult = {
      file_path: "src/loop/engine.ts",
      heuristic_labels: ["large_file"],
      result_class: "hot_file_growth_failure",
      reason: "File exceeds 1000 lines",
      recommended_next_action: "pause and split the next change into a bounded structural-maintenance pass"
    };

    const baseInstructions = ["Instruction 1", "Instruction 2", "Instruction 3"];
    const instructions = buildStructuralMaintenanceInstructions(hotFileGovernance, baseInstructions);

    expect(instructions.length).toBe(4);
    expect(instructions[1]).toBe("Instruction 1");
    expect(instructions[2]).toBe("Instruction 2");
    expect(instructions[3]).toBe("Instruction 3");
  });

  test("handles empty base instructions", () => {
    const hotFileGovernance: HotFileGovernanceResult = {
      file_path: "src/loop/engine.ts",
      heuristic_labels: ["large_file"],
      result_class: "hot_file_growth_failure",
      reason: "File exceeds 1000 lines",
      recommended_next_action: "pause and split the next change into a bounded structural-maintenance pass"
    };

    const instructions = buildStructuralMaintenanceInstructions(hotFileGovernance, []);

    expect(instructions.length).toBe(1);
    expect(instructions[0]).toContain("[STRUCTURAL MAINTENANCE PASS]");
  });
});
