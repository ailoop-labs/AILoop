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
        ailoopHome: "/tmp/.ailoop",
        workspaceRoot: "/tmp/workspace",
        availableTools: [{ name: "run_shell", description: "Execute shell command" }]
      },
      "# Executor Role\n\nProject-specific executor instructions."
    );

    expect(prompt).toContain("Project-specific Executor Role Definition");
    expect(prompt).toContain("Project-specific executor instructions.");
  });

  test("requires commit, push, restart, and evidence reporting after successful verification", () => {
    const prompt = buildExecutorPrompt(
      {
        round: 1,
        goal: "Ship feature",
        instructions: ["Keep scope minimal"],
        subTask: sampleSubTask,
        ailoopHome: "/tmp/.ailoop",
        workspaceRoot: "/tmp/workspace",
        availableTools: [{ name: "run_shell", description: "Execute shell command" }]
      },
      "# Executor Role\n\nProject-specific executor instructions."
    );

    expect(prompt).toContain("For successful completion after verification, also:");
    expect(prompt).toContain("create a git commit with a concise factual message");
    expect(prompt).toContain("push the commit to origin on the current branch");
    expect(prompt).toContain("restart production service with: bash scripts/prod.sh restart");
    expect(prompt).toContain("verification commands and outcomes");
    expect(prompt).toContain("commit hash/message");
    expect(prompt).toContain("push result (remote/branch)");
    expect(prompt).toContain("restart result (PID/log path if available)");
  });
});
