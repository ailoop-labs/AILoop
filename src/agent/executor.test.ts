import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../config/env";
import type { SubTask } from "../types/contracts";
import { readJsonFile } from "../utils/fs";
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
    codex: aiConfig // Backward compatibility
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

  test("writes a redacted executor diagnostics artifact on AI CLI failure", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-executor-agent-debug-artifact-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    const runsDir = path.join(homeDir, "runs");
    await fs.mkdir(runsDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, "EXECUTOR_ROLE.md"), "# Executor Role\n\nCustom executor guidance.\n", "utf8");

    const logs: string[] = [];
    const originalSecret = process.env.AILOOP_EXECUTOR_TEST_SECRET;
    process.env.AILOOP_EXECUTOR_TEST_SECRET = "supersecret123";

    const longRawPayload = `{"partial":"${"x".repeat(1200)}","secret":"supersecret123","inline":"apiToken=supersecret123"}`;
    const mockCodex = {
      async runJson() {
        return {
          ok: false,
          data: undefined,
          rawMessage: longRawPayload,
          stdout: `${"s".repeat(1100)} partial stdout supersecret123`,
          stderr: "stderr apiToken=supersecret123 returned 502 Bad Gateway",
          error: "AI CLI exited with code 7"
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
      const agent = new ExecutorAgent(stubTools as never, makeConfig(homeDir), mockCodex as never);
      const result = await agent.execute({
        subTask: sampleSubTask,
        round: 2,
        goal: "Ship feature",
        instructions: ["Keep scope minimal"],
        guardrails: guardrails as never,
        paths: {
          homeDir,
          runsDir,
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
        onLog: async (message) => {
          logs.push(message);
        }
      });

      expect(result.toolResult.status).toBe("failure");
      expect(result.toolResult.error?.type).toBe("AIExecError");
      expect(result.toolResult.error?.message).toMatch(/diagnostics: .*executor\.debug\.json/);
      expect(result.toolResult.error?.message).toContain("AI CLI exited with code 7");
      expect(result.actions[0]?.error).toBe(result.toolResult.error?.message);
      expect(logs.some((message) => message.includes("Executor diagnostics artifact:"))).toBe(true);

      const diagnosticsPath = result.toolResult.error?.message.match(/diagnostics: ([^|]+)/)?.[1]?.trim();
      expect(diagnosticsPath).toBeTruthy();

      const payload = await readJsonFile<Record<string, unknown>>(diagnosticsPath!, {});
      expect(payload.exit_code).toBe(7);
      expect(payload.timed_out).toBe(false);
      expect(payload.model).toBeNull();
      expect(payload.input_tokens).toBeNull();
      expect(payload.output_tokens).toBeNull();
      expect(payload.total_tokens).toBeNull();
      expect(String(payload.stdout_tail || "")).toContain("[REDACTED]");
      expect(String(payload.stdout_tail || "")).not.toContain("supersecret123");
      expect(String(payload.stderr_tail || "")).toContain("apiToken=[REDACTED]");
      expect(String(payload.raw_tail || "")).toContain("[REDACTED]");
      expect(String(payload.raw_tail || "")).not.toContain("supersecret123");
      expect(String(payload.raw_tail || "").length).toBeLessThan(longRawPayload.length);
    } finally {
      process.chdir(originalCwd);
      if (originalSecret === undefined) {
        delete process.env.AILOOP_EXECUTOR_TEST_SECRET;
      } else {
        process.env.AILOOP_EXECUTOR_TEST_SECRET = originalSecret;
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("preserves the AI CLI failure when diagnostics artifact writing fails", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-executor-agent-debug-write-failure-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    const runsDir = path.join(homeDir, "runs-blocked");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(runsDir, "not a directory\n", "utf8");
    await fs.writeFile(path.join(homeDir, "EXECUTOR_ROLE.md"), "# Executor Role\n\nCustom executor guidance.\n", "utf8");

    const logs: string[] = [];
    const mockCodex = {
      async runJson() {
        return {
          ok: false,
          data: undefined,
          rawMessage: "",
          stdout: "",
          stderr: "stderr output",
          error: "AI CLI exited with code 9"
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
      const agent = new ExecutorAgent(stubTools as never, makeConfig(homeDir), mockCodex as never);
      const result = await agent.execute({
        subTask: sampleSubTask,
        round: 2,
        goal: "Ship feature",
        instructions: ["Keep scope minimal"],
        guardrails: guardrails as never,
        paths: {
          homeDir,
          runsDir,
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
        onLog: async (message) => {
          logs.push(message);
        }
      });

      expect(result.toolResult.status).toBe("failure");
      expect(result.toolResult.error?.type).toBe("AIExecError");
      expect(result.toolResult.error?.message).toContain("AI CLI exited with code 9");
      expect(result.toolResult.error?.message).toContain("diagnostics_write_error:");
      expect(result.toolResult.error?.message).not.toContain("diagnostics:");
      expect(result.actions[0]?.error).toBe(result.toolResult.error?.message);
      expect(logs.some((message) => message.includes("Executor diagnostics artifact failed:"))).toBe(true);
    } finally {
      process.chdir(originalCwd);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("writes structured timeout context into executor diagnostics artifacts", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-executor-agent-timeout-debug-artifact-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    const runsDir = path.join(homeDir, "runs");
    await fs.mkdir(runsDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, "EXECUTOR_ROLE.md"), "# Executor Role\n\nCustom executor guidance.\n", "utf8");

    const logs: string[] = [];
    const originalSecret = process.env.AILOOP_TIMEOUT_CHECKPOINT_SECRET;
    process.env.AILOOP_TIMEOUT_CHECKPOINT_SECRET = "checkpointsecret456";
    const mockCodex = {
      async runJson() {
        return {
          ok: false,
          data: undefined,
          rawMessage: "",
          stdout:
            '{"type":"response.output_text.done","text":"Read files and staged checkpointsecret456 timeout checkpoint."}\n' +
            '{"type":"turn.completed","usage":{"input_tokens":210,"output_tokens":45,"total_tokens":255}}',
          stderr: "runner timed out",
          error: "AI CLI process timed out after 30000ms",
          diagnostics: {
            timedOut: true,
            model: "gpt-5.4",
            promptChars: 4321,
            inputTokens: 210,
            outputTokens: 45,
            totalTokens: 255,
            exitCode: 137,
            exitSignal: "SIGKILL",
            timingBreakdown: {
              timeoutMs: 30_000,
              totalRuntimeMs: 30_260,
              sigtermSentAfterMs: 30_000,
              sigkillSentAfterMs: 30_250,
              exitObservedAfterMs: 30_260,
              shutdownAfterSigtermMs: 260,
              requiredSigkill: true
            },
            partialProgress: {
              source: "stdout",
              kind: "assistant_message",
              eventType: "response.output_text.done",
              sessionId: null,
              excerpt: "Read files and staged checkpointsecret456 timeout checkpoint."
            }
          }
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
      const agent = new ExecutorAgent(stubTools as never, makeConfig(homeDir), mockCodex as never);
      const result = await agent.execute({
        subTask: sampleSubTask,
        round: 2,
        goal: "Ship feature",
        instructions: ["Keep scope minimal"],
        guardrails: guardrails as never,
        paths: {
          homeDir,
          runsDir,
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
        onLog: async (message) => {
          logs.push(message);
        }
      });

      expect(result.toolResult.status).toBe("failure");
      const timeoutContextLog = logs.find((message) => message.includes("Executor timeout context:"));
      expect(timeoutContextLog).toBeTruthy();
      expect(timeoutContextLog).toContain("\"exit_code\":137");
      expect(timeoutContextLog).toContain("\"exit_signal\":\"SIGKILL\"");
      expect(timeoutContextLog).toContain("\"timing_breakdown\":{\"timeout_ms\":30000");

      const diagnosticsPath = result.toolResult.error?.message.match(/diagnostics: ([^|]+)/)?.[1]?.trim();
      expect(diagnosticsPath).toBeTruthy();

      const payload = await readJsonFile<Record<string, unknown>>(diagnosticsPath!, {});
      expect(payload.timed_out).toBe(true);
      expect(payload.exit_code).toBe(137);
      expect(payload.exit_signal).toBe("SIGKILL");
      expect(payload.model).toBe("gpt-5.4");
      expect(payload.prompt_chars).toBe(4321);
      expect(payload.input_tokens).toBe(210);
      expect(payload.output_tokens).toBe(45);
      expect(payload.total_tokens).toBe(255);
      expect(payload.timing_breakdown).toEqual({
        timeout_ms: 30_000,
        total_runtime_ms: 30_260,
        sigterm_sent_after_ms: 30_000,
        sigkill_sent_after_ms: 30_250,
        exit_observed_after_ms: 30_260,
        shutdown_after_sigterm_ms: 260,
        required_sigkill: true
      });
      expect(payload.partial_progress_checkpoint).toEqual({
        source: "stdout",
        kind: "assistant_message",
        eventType: "response.output_text.done",
        sessionId: null,
        excerpt: "Read files and staged [REDACTED] timeout checkpoint."
      });
    } finally {
      process.chdir(originalCwd);
      if (originalSecret === undefined) {
        delete process.env.AILOOP_TIMEOUT_CHECKPOINT_SECRET;
      } else {
        process.env.AILOOP_TIMEOUT_CHECKPOINT_SECRET = originalSecret;
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
