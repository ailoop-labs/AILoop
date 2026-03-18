import type { HotFileGovernanceResult } from "../types/contracts";

const STRUCTURAL_MAINTENANCE_RECOMMENDATION_PATTERN = /pause and split.*bounded structural-maintenance pass/i;

export function shouldTriggerStructuralMaintenance(
  hotFileGovernance: HotFileGovernanceResult | null | undefined
): boolean {
  if (!hotFileGovernance) {
    return false;
  }

  return STRUCTURAL_MAINTENANCE_RECOMMENDATION_PATTERN.test(
    hotFileGovernance.recommended_next_action
  );
}

export function buildStructuralMaintenanceInstructions(
  hotFileGovernance: HotFileGovernanceResult,
  baseInstructions: string[]
): string[] {
  const maintenanceInstruction = [
    `[STRUCTURAL MAINTENANCE PASS]`,
    `File: ${hotFileGovernance.file_path}`,
    `Reason: ${hotFileGovernance.reason}`,
    `Heuristic labels: ${hotFileGovernance.heuristic_labels.join(", ")}`,
    ``,
    `Your task is to split this file into smaller, focused modules without changing behavior.`,
    ``,
    `Requirements:`,
    `1. Extract logical units (functions, classes, types) into separate files`,
    `2. Maintain all existing functionality - this is a pure refactoring pass`,
    `3. Update imports/exports to maintain the same public API`,
    `4. Verify the split reduced line count and complexity`,
    `5. Run tests to ensure no behavioral changes`,
    ``,
    `Success criteria:`,
    `- The original file is split into 2+ smaller files`,
    `- Each new file has a clear, focused responsibility`,
    `- All tests pass`,
    `- The original file's line count is reduced by at least 30%`
  ].join("\n");

  return [maintenanceInstruction, ...baseInstructions];
}
