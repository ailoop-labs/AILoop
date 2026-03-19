import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../config/env";
import type { PlannerContext } from "../types/contracts";
import {
  buildAdaptivePlannerDirectives,
  buildPlannerPrompt,
  PlannerAgent,
  PlannerInfrastructureError,
  resolvePlannerRequirementMode
} from "./planner";

function createContext(overrides: Partial<PlannerContext> = {}): PlannerContext {
  return {
    goal: "Improve core loop implementation.",
    instructions: [],
    round: 8,
    budget: {
      usdPerRound: 0.5,
      timeMinutes: 15,
      actions: 30
    },
    previous_tool_result: null,
    previous_round_error: null,
    consecutive_evaluator_failures: 0,
    requirement_artifact_status: "ready",
    requirement_artifact_summary: null,
    ...overrides
  };
}

function makeConfig(homeDir: string): AppConfig {
  const aiConfig = {
    bin: "codex",
    model: "",
    profile: "",
    plannerSandbox: "read-only" as const,
    executorSandbox: "workspace-write" as const,
    evaluatorSandbox: "workspace-write" as const,
    timeoutMs: 30_000,
    llmEvaluatorDimensions: [
      "goal_alignment",
      "causal_validity",
      "constraint_compliance",
      "risk_externality",
      "reversibility_resilience",
      "learning_yield"
    ] as const,
    llmEvaluatorMinPassScore: 75
  };

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
    ai: aiConfig,
    codex: aiConfig
  };
}

describe("resolvePlannerRequirementMode", () => {
  test("requests requirement creation when no active requirement artifact exists", () => {
    expect(
      resolvePlannerRequirementMode(
        createContext({
          requirement_artifact_status: "missing"
        })
      )
    ).toBe("create_requirement");
  });

  test("requests requirement refresh when the active slice is exhausted or insufficient", () => {
    expect(
      resolvePlannerRequirementMode(
        createContext({
          requirement_artifact_status: "needs_refresh"
        })
      )
    ).toBe("refresh_requirement");
  });

  test("stays in normal execution mode when a requirement slice is available", () => {
    expect(resolvePlannerRequirementMode(createContext())).toBe("normal_execution");
  });
});

describe("buildAdaptivePlannerDirectives", () => {
  test("adds implementation-first directive after repeated evaluator failures", () => {
    const directives = buildAdaptivePlannerDirectives(
      createContext({
        consecutive_evaluator_failures: 3,
        previous_round_error: "No observable file creation or content diff for `.ailoop/plans/round-5-core-loop-baseline.md`."
      })
    );

    const joined = directives.join("\n");
    expect(joined).toContain("Do not output documentation-only audit/checklist/report tasks");
    expect(joined).toContain("src/");
    expect(joined).toContain("scripts/");
  });

  test("keeps base directives when no failure signal exists", () => {
    const directives = buildAdaptivePlannerDirectives(createContext());
    expect(directives.length).toBe(0);
  });

  test("adds a requirement lifecycle directive when the active requirement artifact is missing", () => {
    const directives = buildAdaptivePlannerDirectives(
      createContext({
        requirement_artifact_status: "missing"
      })
    );

    expect(directives.join("\n")).toContain(".ailoop/product-requirements/current.md");
  });
});

describe("buildPlannerPrompt", () => {
  test("injects project-specific planner role definition block", () => {
    const prompt = buildPlannerPrompt(createContext(), [], "# Planner Role\n\nProject-specific planner instructions.");
    expect(prompt).toContain("Project-specific Planner Role Definition");
    expect(prompt).toContain("Project-specific planner instructions.");
  });

  test("includes requirement artifact status and summary in planner input", () => {
    const prompt = buildPlannerPrompt(
      createContext({
        requirement_artifact_status: "needs_refresh",
        requirement_artifact_summary: "Current slice shipped console health checks but lacks operator-facing UX acceptance."
      }),
      [],
      "# Planner Role\n\nProject-specific planner instructions."
    );

    expect(prompt).toContain("\"requirement_artifact_status\": \"needs_refresh\"");
    expect(prompt).toContain("lacks operator-facing UX acceptance");
  });

  test("adds runtime isolation guidance and repository-root navigation", () => {
    const prompt = buildPlannerPrompt(
      createContext(),
      [],
      "# Planner Role\n\nProject-specific planner instructions.",
      [],
      "/tmp/example-repo"
    );

    expect(prompt).toContain("Repository root: /tmp/example-repo");
    expect(prompt).toContain("This internal runtime session is intentionally isolated");
    expect(prompt).toContain("use absolute paths under the repository root or explicitly `cd` into the repository root first");
  });
});

describe("PlannerAgent", () => {
  test("runs Codex planning in an isolated runtime session", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-planner-agent-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, "PLANNER_ROLE.md"), "# Planner Role\n\nCustom planner guidance.\n", "utf8");

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
            rationale: "Use a narrow step.",
            assignee: "executor",
            objective: "Inspect one file.",
            expected_outcome: "A minimal next step is defined.",
            impacted_files: ["src/example.ts"],
            recommended_tools: ["read_file"]
          } as T,
          rawMessage: "{}",
          stdout: "",
          stderr: ""
        };
      }
    };
    const stubTools = {
      async initialize() {},
      getSkillManager() {
        return {
          getAvailableSkills() {
            return [];
          }
        };
      }
    };

    const originalCwd = process.cwd();
    process.chdir(workspaceRoot);

    try {
      const realWorkspaceRoot = await fs.realpath(process.cwd());
      const agent = new PlannerAgent(stubTools as never, makeConfig(homeDir), mockCodex as never);
      const result = await agent.plan(createContext(), { onLog: async () => {} });

      expect(result.objective).toBe("Inspect one file.");
      expect(capturedPrompt).toContain("Custom planner guidance.");
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

  test("rewrites documentation-only subtasks into implementation-first work when the active requirement is already ready", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-planner-doc-only-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, "PLANNER_ROLE.md"), "# Planner Role\n\nCustom planner guidance.\n", "utf8");

    const mockCodex = {
      async runJson<T>() {
        return {
          ok: true,
          data: {
            rationale: "Refresh the requirement wording before implementation.",
            assignee: "executor",
            objective: "Refresh .ailoop/product-requirements/current.md to clarify the next slice.",
            expected_outcome: "The requirement markdown is updated with clearer acceptance criteria.",
            impacted_files: [".ailoop/product-requirements/current.md"],
            recommended_tools: ["read_file"]
          } as T,
          rawMessage: "{}",
          stdout: "",
          stderr: ""
        };
      }
    };
    const stubTools = {
      async initialize() {},
      getSkillManager() {
        return {
          getAvailableSkills() {
            return [];
          }
        };
      }
    };

    const originalCwd = process.cwd();
    process.chdir(workspaceRoot);

    try {
      const agent = new PlannerAgent(stubTools as never, makeConfig(homeDir), mockCodex as never);
      const result = await agent.plan(
        createContext({
          requirement_artifact_status: "ready"
        }),
        { onLog: async () => {} }
      );

      expect(result.objective).toContain("Implement one minimal code or test change");
      expect(result.expected_outcome).toContain("At least one file under src/, scripts/, or web/src/ changes");
      expect(result.impacted_files).toEqual(["src/", "scripts/", "web/src/"]);
      expect(result.recommended_tools).toEqual(["read_file", "write_file", "run_shell"]);
    } finally {
      process.chdir(originalCwd);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("throws planner infrastructure failure instead of falling back when the provider reports usage-limit exhaustion", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-planner-rate-limit-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, "PLANNER_ROLE.md"), "# Planner Role\n\nCustom planner guidance.\n", "utf8");

    const mockCodex = {
      async runJson<T>() {
        return {
          ok: false,
          data: undefined as T | undefined,
          rawMessage: "",
          stdout: "",
          stderr:
            'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"usage limit exceeded (2056)"}}',
          error: "AI CLI exited with code 1"
        };
      }
    };
    const stubTools = {
      async initialize() {},
      getSkillManager() {
        return {
          getAvailableSkills() {
            return [];
          }
        };
      }
    };

    const originalCwd = process.cwd();
    process.chdir(workspaceRoot);

    try {
      const agent = new PlannerAgent(stubTools as never, makeConfig(homeDir), mockCodex as never);

      await expect(agent.plan(createContext(), { onLog: async () => {} })).rejects.toBeInstanceOf(PlannerInfrastructureError);
      await expect(agent.plan(createContext(), { onLog: async () => {} })).rejects.toThrow("usage limit exceeded");
    } finally {
      process.chdir(originalCwd);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
