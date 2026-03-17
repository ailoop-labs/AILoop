import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../config/env";
import type { SubTask } from "../types/contracts";
import { buildExecutorPrompt, ExecutorAgent, sanitizeCodexActionDetail } from "./executor";

const sampleSubTask: SubTask = {
  assignee: "executor",
  rationale: "test rationale",
  objective: "Update one file",
  expected_outcome: "tests pass",
  impacted_files: [],
  recommended_tools: ["read_file", "write_file", "run_shell"]
};

function makeConfig(homeDir: string): AppConfig {
  return {
    homeDir,
    intervalSeconds: 1,
    maxCycles: 1,
    exitOnError: false,
    evaluatorReworkMaxAttempts: 1,
    consoleHost: "127.0.0.1",
    consolePort: 3090,
    consoleAdminToken: "",
    maxRetainRuns: 10,
    budget: {
      usdPerRound: 0.5,
      timeMinutes: 15,
      actions: 30
    },
    codex: {
      bin: "codex",
      model: "",
      profile: "",
      plannerSandbox: "read-only",
      executorSandbox: "workspace-write",
      evaluatorSandbox: "workspace-write",
      timeoutMs: 30_000,
      llmEvaluatorDimensions: [
        "goal_alignment",
        "causal_validity",
        "constraint_compliance",
        "risk_externality",
        "reversibility_resilience",
        "learning_yield"
      ],
      llmEvaluatorMinPassScore: 75
    }
  };
}

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

  test("forbids executor from performing commits, pushes, and restarts", () => {
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

    expect(prompt).toContain("Do NOT commit, push, restart, or deploy. The engine handles these operational steps automatically after evaluation passes.");
    expect(prompt).toContain("If you run local verifications or test commands, capture the concrete evidence in both `summary` and `actions`.");
  });

  test("requires operational evidence in the output contract", () => {
    const prompt = buildExecutorPrompt(
      {
        round: 1,
        goal: "Ship feature",
        instructions: ["Keep scope minimal"],
        subTask: sampleSubTask,
        ailoopHome: "/tmp/.ailoop",
        workspaceRoot: "/tmp/workspace",
        availableTools: [{ name: "run_shell", description: "Execute shell command" }],
        availableSkills: []
      },
      "# Executor Role\n\nProject-specific executor instructions."
    );

    expect(prompt).toContain("operational_evidence");
    expect(prompt).toContain("direct verification command output");
    expect(prompt).toContain("key code excerpts");
  });

  test("adds runtime isolation guidance and repository-root navigation", () => {
    const prompt = buildExecutorPrompt(
      {
        round: 1,
        goal: "Ship feature",
        instructions: ["Keep scope minimal"],
        subTask: sampleSubTask,
        ailoopHome: "/tmp/.ailoop",
        workspaceRoot: "/tmp/workspace",
        availableTools: [{ name: "run_shell", description: "Execute shell command" }],
        availableSkills: []
      },
      "# Executor Role\n\nProject-specific executor instructions."
    );

    expect(prompt).toContain("Repository root: /tmp/workspace");
    expect(prompt).toContain("This internal runtime session is intentionally isolated");
    expect(prompt).toContain("use absolute paths under the repository root or explicitly `cd` into the repository root first");
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

describe("ExecutorAgent", () => {
  test("runs Codex execution in an isolated runtime session", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-executor-agent-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, "EXECUTOR_ROLE.md"), "# Executor Role\n\nCustom executor guidance.\n", "utf8");

    let capturedPrompt = "";
    let capturedCwd = "";
    let capturedIsolationEnabled = false;
    let capturedIsolationGuide = "";
    const mockCodex = {
      async runJson<T>(options?: {
        prompt?: string;
        cwd?: string;
        sessionIsolation?: {
          enabled?: boolean;
          agentsGuide?: string;
        };
      }) {
        capturedPrompt = options?.prompt ?? "";
        capturedCwd = options?.cwd ?? "";
        capturedIsolationEnabled = options?.sessionIsolation?.enabled === true;
        capturedIsolationGuide = options?.sessionIsolation?.agentsGuide ?? "";
        return {
          ok: true,
          data: {
            status: "success",
            summary: "Verified one file.",
            error_type: "",
            error_message: "",
            next_state_hint: "continue",
            actions: ["read_file: src/example.ts"]
          } as T,
          rawMessage: "{}",
          stdout: "",
          stderr: ""
        };
      }
    };
    const stubTools = {
      async initialize() {},
      listTools() {
        return [{ name: "read_file", description: "Reads a file." }];
      },
      getSkillManager() {
        return {
          getAvailableSkills() {
            return [];
          }
        };
      }
    };
    const guardrails = {
      recordAction() {}
    };

    const originalCwd = process.cwd();
    process.chdir(workspaceRoot);

    try {
      const realWorkspaceRoot = await fs.realpath(process.cwd());
      const agent = new ExecutorAgent(stubTools as never, makeConfig(homeDir), mockCodex as never);
      const result = await agent.execute({
        subTask: sampleSubTask,
        round: 2,
        goal: "Ship feature",
        instructions: ["Keep scope minimal"],
        guardrails: guardrails as never,
        paths: {
          homeDir,
          runsDir: path.join(homeDir, "runs"),
          taskPath: path.join(homeDir, "README.md"),
          productRequirementsDirPath: path.join(homeDir, "product-requirements"),
          activeRequirementPath: path.join(homeDir, "product-requirements/current.md"),
          plannerRolePath: path.join(homeDir, "PLANNER_ROLE.md"),
          productManagerRolePath: path.join(homeDir, "PRODUCT_MANAGER_ROLE.md"),
          executorRolePath: path.join(homeDir, "EXECUTOR_ROLE.md"),
          designerRolePath: path.join(homeDir, "DESIGNER_ROLE.md"),
          evaluatorRolePath: path.join(homeDir, "EVALUATOR_ROLE.md"),
          leaderRolePath: path.join(homeDir, "LEADER_ROLE.md"),
          instructionsPath: path.join(homeDir, "instructions.queue.json"),
          legacyInstructionsPath: path.join(homeDir, "instructions.queue.legacy.json"),
          statePath: path.join(homeDir, "loop.state.json"),
          legacyStatePath: path.join(homeDir, "loop.state.legacy.json"),
          pidPath: path.join(homeDir, "engine.pid"),
          stopFlagPath: path.join(homeDir, "STOP"),
          pauseFlagPath: path.join(homeDir, "PAUSE"),
          lockPath: path.join(homeDir, "engine.lock"),
          dbPath: path.join(homeDir, "ailoop.db")
        },
        onLog: async () => {}
      });

      expect(result.toolResult.status).toBe("success");
      expect(capturedPrompt).toContain("Custom executor guidance.");
      expect(capturedPrompt).toContain(`Repository root: ${realWorkspaceRoot}`);
      expect(capturedIsolationEnabled).toBe(true);
      expect(capturedIsolationGuide).toContain("Internal Runtime Agent Session");
      expect(capturedIsolationGuide).toContain("external skill catalogs");
      expect(capturedCwd).toBe(realWorkspaceRoot);
    } finally {
      process.chdir(originalCwd);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
