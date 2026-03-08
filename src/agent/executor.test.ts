import { describe, expect, test } from "bun:test";
import type { SubTask } from "../types/contracts";
import { buildExecutorPrompt, sanitizeCodexActionDetail } from "./executor";

const sampleSubTask: SubTask = {
  rationale: "test rationale",
  objective: "Update one file",
  expected_outcome: "tests pass",
  recommended_tools: ["read_file", "write_file", "run_shell"]
};

describe("buildExecutorPrompt", () => {
  test("injects project-specific executor role definition block", () => {
    const prompt = buildExecutorPrompt(
      {
        round: 1,
        goal: "Ship feature",
        instructions: ["Keep scope minimal"],
        subTask: sampleSubTask,
        ailoopHome: "/tmp/.ailoop",
        workspaceRoot: "/tmp/workspace",
        availableTools: [{ name: "run_shell", description: "Execute shell command" }], availableSkills: []
      },
      "# Executor Role\n\nProject-specific executor instructions."
    );

    expect(prompt).toContain("Project-specific Executor Role Definition");
    expect(prompt).toContain("Project-specific executor instructions.");
  });

  test("tells codex not to claim engine-managed run artifacts", () => {
    const prompt = buildExecutorPrompt(
      {
        round: 1,
        goal: "Ship feature",
        instructions: ["Keep scope minimal"],
        subTask: sampleSubTask,
        ailoopHome: "/tmp/.ailoop",
        workspaceRoot: "/tmp/workspace",
        availableTools: [{ name: "run_shell", description: "Execute shell command" }], availableSkills: []
      },
      "# Executor Role\n\nProject-specific executor instructions."
    );

    expect(prompt).toContain("Do not create or claim `.ailoop/runs/*` artifacts");
    expect(prompt).toContain("The engine writes canonical round artifacts and populates `tool_result.artifacts`");
  });
});

describe("sanitizeCodexActionDetail", () => {
  test("replaces engine-managed run artifact paths in executor action details", () => {
    expect(
      sanitizeCodexActionDetail(
        "Wrote evidence to /tmp/workspace/.ailoop/runs/2026-03-08T12-42-46-955Z.round.state_change.txt and .ailoop/runs/2026-03-08T12-42-46-955Z.round.log"
      )
    ).toBe(
      "Wrote evidence to .ailoop/runs/<engine-managed-artifact> and .ailoop/runs/<engine-managed-artifact>"
    );
  });
});
