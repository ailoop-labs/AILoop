import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { SubTask } from "../types/contracts";
import { extractSnapshotTargetsFromSubTask, resolveNextLastError } from "./engine";

describe("extractSnapshotTargetsFromSubTask", () => {
  test("extracts backticked file paths from objective and outcome", () => {
    const workspaceRoot = "/tmp/workspace";
    const subTask: SubTask = {
      rationale: "test",
      objective: "Create `.autoloop/plans/round-7.md` with checklist.",
      expected_outcome: "File `src/loop/engine.ts` updated and `.autoloop/runs/report.txt` written.",
      recommended_tools: ["write_file"]
    };

    const targets = extractSnapshotTargetsFromSubTask(subTask, workspaceRoot);
    expect(targets).toContain(path.join(workspaceRoot, ".autoloop/plans/round-7.md"));
    expect(targets).toContain(path.join(workspaceRoot, "src/loop/engine.ts"));
    expect(targets).toContain(path.join(workspaceRoot, ".autoloop/runs/report.txt"));
  });
});

describe("resolveNextLastError", () => {
  test("preserves previous error when transition does not provide one", () => {
    expect(resolveNextLastError("blocked", undefined)).toBe("blocked");
  });

  test("allows explicit clear when transition sets null", () => {
    expect(resolveNextLastError("blocked", null)).toBeNull();
  });

  test("writes explicit next error message when provided", () => {
    expect(resolveNextLastError("blocked", "new-error")).toBe("new-error");
  });
});
