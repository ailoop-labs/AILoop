import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../config/env";
import type { SubTask } from "../types/contracts";
import { buildDesignerPrompt, DesignerAgent } from "./designer";

const sampleSubTask: SubTask = {
  assignee: "designer",
  rationale: "test rationale",
  objective: "Tighten the console status layout",
  expected_outcome: "one operator-facing UI slice is updated",
  impacted_files: ["src/server.ts"],
  recommended_tools: ["read_file", "write_file", "run_shell"]
};

function makeConfig(homeDir: string): AppConfig {
  return {
    homeDir,
    intervalSeconds: 1,
    maxCycles: 1,
    exitOnError: false,
    enableLeader: false,
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

describe("buildDesignerPrompt", () => {
  test("adds runtime isolation guidance and repository-root navigation", () => {
    const prompt = buildDesignerPrompt(
      {
        round: 3,
        goal: "Improve operator-facing console UX",
        instructions: ["Keep the change reviewable."],
        subTask: sampleSubTask,
        ailoopHome: "/tmp/.ailoop",
        workspaceRoot: "/tmp/workspace",
        availableTools: [{ name: "read_file", description: "Reads a file." }],
        availableSkills: []
      },
      "# Designer Role\n\nProject-specific designer instructions."
    );

    expect(prompt).toContain("Project-specific Designer Role Definition");
    expect(prompt).toContain("Project-specific designer instructions.");
    expect(prompt).toContain("Repository root: /tmp/workspace");
    expect(prompt).toContain("This internal runtime session is intentionally isolated");
    expect(prompt).toContain(
      "use absolute paths under the repository root or explicitly `cd` into the repository root first"
    );
  });
});

describe("DesignerAgent", () => {
  test("runs Codex execution in an isolated runtime session", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-designer-agent-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, "DESIGNER_ROLE.md"), "# Designer Role\n\nCustom designer guidance.\n", "utf8");

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
            summary: "Updated one visual state.",
            error_type: "",
            error_message: "",
            next_state_hint: "continue",
            actions: ["read_file: src/server.ts"]
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
      const agent = new DesignerAgent(stubTools as never, makeConfig(homeDir), mockCodex as never);
      const result = await agent.execute({
        subTask: sampleSubTask,
        round: 3,
        goal: "Improve operator-facing console UX",
        instructions: ["Keep the change reviewable."],
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
      expect(capturedPrompt).toContain("Custom designer guidance.");
      expect(capturedPrompt).toContain(`Repository root: ${realWorkspaceRoot}`);
      expect(capturedPrompt).toContain("Do not use external development-assistant skills");
      expect(capturedIsolationEnabled).toBe(true);
      expect(capturedIsolationGuide).toContain("Internal Runtime Agent Session");
      expect(capturedIsolationGuide).toContain("You are the internal Designer agent inside the AILoop product.");
      expect(capturedIsolationGuide).toContain("external skill catalogs");
      expect(capturedIsolationGuide).toContain(
        "use absolute paths under the provided repository root or explicitly `cd` into the repository root first"
      );
      expect(capturedCwd).toBe(realWorkspaceRoot);
    } finally {
      process.chdir(originalCwd);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
