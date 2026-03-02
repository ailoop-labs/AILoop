import { describe, expect, test } from "bun:test";
import type { SubTask } from "../types/contracts";
import { buildExecutorPrompt } from "./executor";

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
        autoloopHome: "/tmp/.autoloop",
        workspaceRoot: "/tmp/workspace",
        availableTools: [{ name: "run_shell", description: "Execute shell command" }]
      },
      "# Executor Role\n\nProject-specific executor instructions."
    );

    expect(prompt).toContain("Project-specific Executor Role Definition");
    expect(prompt).toContain("Project-specific executor instructions.");
  });
});
