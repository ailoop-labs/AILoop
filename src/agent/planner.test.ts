import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../config/env";
import type { PlannerContext } from "../types/contracts";
import { readJsonFile } from "../utils/fs";
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

function createStubTools() {
  return {
    async initialize() {},
    listTools() {
      return [{ name: "read_file", description: "Reads and returns the content of a specified file." }];
    },
    getSkillManager() {
      return {
        getAvailableSkills() {
          return [];
        }
      };
    }
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
    const originalCwd = process.cwd();
    process.chdir(workspaceRoot);

    try {
      const realWorkspaceRoot = await fs.realpath(process.cwd());
      const agent = new PlannerAgent(createStubTools() as never, makeConfig(homeDir), mockCodex as never);
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
    const originalCwd = process.cwd();
    process.chdir(workspaceRoot);

    try {
      const agent = new PlannerAgent(createStubTools() as never, makeConfig(homeDir), mockCodex as never);
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

  test("retries transient planner failures with exponential backoff and then succeeds", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-planner-retry-success-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, "PLANNER_ROLE.md"), "# Planner Role\n\nCustom planner guidance.\n", "utf8");

    let attempts = 0;
    const sleepCalls: number[] = [];
    const mockCodex = {
      async runJson<T>() {
        attempts += 1;
        if (attempts === 1) {
          return {
            ok: false,
            data: undefined as T | undefined,
            rawMessage: "",
            stdout: "",
            stderr: "API Error: 503 Service Unavailable",
            error: "AI CLI exited with code 1"
          };
        }

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

    const originalCwd = process.cwd();
    process.chdir(workspaceRoot);

    try {
      const agent = new PlannerAgent(
        createStubTools() as never,
        makeConfig(homeDir),
        mockCodex as never,
        async (ms) => {
          sleepCalls.push(ms);
        }
      );

      const result = await agent.plan(createContext(), { onLog: async () => {} });

      expect(result.objective).toBe("Inspect one file.");
      expect(attempts).toBe(2);
      expect(sleepCalls).toEqual([1000]);
    } finally {
      process.chdir(originalCwd);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("throws planner infrastructure failure after transient retry budget is exhausted", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-planner-rate-limit-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.mkdir(path.join(homeDir, "runs"), { recursive: true });
    await fs.writeFile(path.join(homeDir, "PLANNER_ROLE.md"), "# Planner Role\n\nCustom planner guidance.\n", "utf8");

    let attempts = 0;
    const sleepCalls: number[] = [];
    const logs: string[] = [];
    const mockCodex = {
      async runJson<T>() {
        attempts += 1;
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

    const originalCwd = process.cwd();
    process.chdir(workspaceRoot);

    try {
      const agent = new PlannerAgent(
        createStubTools() as never,
        makeConfig(homeDir),
        mockCodex as never,
        async (ms) => {
          sleepCalls.push(ms);
        }
      );

      let failure: unknown;
      try {
        await agent.plan(createContext(), {
          onLog: async (message) => {
            logs.push(message);
          }
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(PlannerInfrastructureError);
      expect((failure as Error).message).toContain("usage limit exceeded");
      expect((failure as Error).message).toMatch(/diagnostics: .*planner\.debug\.json/);
      expect(attempts).toBe(3);
      expect(sleepCalls).toEqual([1000, 2000]);

      const rateLimitContextLog = logs.find((message) => message.includes("ProjectPlanner provider rate limit context:"));
      expect(rateLimitContextLog).toBeTruthy();

      const rateLimitContext = JSON.parse(
        rateLimitContextLog!.split("ProjectPlanner provider rate limit context: ")[1]
      ) as Record<string, unknown>;
      expect(rateLimitContext.provider_error_context).toEqual({
        failure_kind: "provider_rate_limit",
        status_code: 429,
        retry_exhausted: true,
        error_excerpt: "AI CLI exited with code 1",
        stderr_excerpt:
          'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"usage limit exceeded (2056)"}}',
        raw_excerpt: null
      });

      const diagnosticsLog = logs.find((message) => message.includes("ProjectPlanner diagnostics artifact:"));
      expect(diagnosticsLog).toBeTruthy();

      const diagnosticsPath = diagnosticsLog!.split("ProjectPlanner diagnostics artifact: ")[1];
      const payload = await readJsonFile<Record<string, unknown>>(diagnosticsPath, {});

      expect(payload.failure_classification).toBe("provider_rate_limit");
      expect(payload.provider_error_context).toEqual({
        failure_kind: "provider_rate_limit",
        status_code: 429,
        retry_exhausted: true,
        error_excerpt: "AI CLI exited with code 1",
        stderr_excerpt:
          'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"usage limit exceeded (2056)"}}',
        raw_excerpt: null
      });
      expect(payload.stderr_tail).toContain("429");
      expect(payload.stderr_tail).toContain("usage limit exceeded");
    } finally {
      process.chdir(originalCwd);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("persists provider upstream diagnostics after exhausted 502/503/504 retries", async () => {
    const upstreamFailures = [
      { statusCode: 502, statusText: "Bad Gateway" },
      { statusCode: 503, statusText: "Service Unavailable" },
      { statusCode: 504, statusText: "Gateway Timeout" }
    ] as const;

    for (const { statusCode, statusText } of upstreamFailures) {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), `ailoop-planner-upstream-${statusCode}-`));
      const homeDir = path.join(workspaceRoot, ".ailoop");
      await fs.mkdir(path.join(homeDir, "runs"), { recursive: true });
      await fs.writeFile(path.join(homeDir, "PLANNER_ROLE.md"), "# Planner Role\n\nCustom planner guidance.\n", "utf8");

      let attempts = 0;
      const sleepCalls: number[] = [];
      const mockCodex = {
        async runJson<T>() {
          attempts += 1;
          return {
            ok: false,
            data: undefined as T | undefined,
            rawMessage: "",
            stdout: "",
            stderr: `API Error: ${statusCode} ${statusText}`,
            error: "AI CLI exited with code 1"
          };
        }
      };

      const originalCwd = process.cwd();
      process.chdir(workspaceRoot);

      try {
        const agent = new PlannerAgent(
          createStubTools() as never,
          makeConfig(homeDir),
          mockCodex as never,
          async (ms) => {
            sleepCalls.push(ms);
          }
        );

        let failure: unknown;
        try {
          await agent.plan(createContext(), { onLog: async () => {} });
        } catch (error) {
          failure = error;
        }

        expect(failure).toBeInstanceOf(PlannerInfrastructureError);
        expect(attempts).toBe(3);
        expect(sleepCalls).toEqual([1000, 2000]);

        const diagnosticsPathMatch = (failure as Error).message.match(/diagnostics: (.+\.planner\.debug\.json)/);
        expect(diagnosticsPathMatch).toBeTruthy();

        const diagnosticsPath = diagnosticsPathMatch![1];
        const payload = await readJsonFile<Record<string, unknown>>(diagnosticsPath, {});

        expect(payload.failure_classification).toBe("provider_upstream_error");
        expect(payload.provider_error_context).toEqual({
          failure_kind: "provider_upstream_error",
          status_code: statusCode,
          retry_exhausted: true,
          error_excerpt: "AI CLI exited with code 1",
          stderr_excerpt: `API Error: ${statusCode} ${statusText}`,
          raw_excerpt: null
        });
      } finally {
        process.chdir(originalCwd);
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    }
  });

  test("persists planner timeout diagnostics after retry budget exhaustion", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-planner-timeout-debug-artifact-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.mkdir(path.join(homeDir, "runs"), { recursive: true });
    await fs.writeFile(path.join(homeDir, "PLANNER_ROLE.md"), "# Planner Role\n\nCustom planner guidance.\n", "utf8");

    let attempts = 0;
    const sleepCalls: number[] = [];
    const logs: string[] = [];
    const mockCodex = {
      async runJson<T>() {
        attempts += 1;
        return {
          ok: false,
          data: undefined as T | undefined,
          rawMessage: "",
          stdout:
            '{"type":"response.output_text.done","text":"Planner reached timeout while collecting a sub-task."}\n',
          stderr: "planner request timed out after 30000ms",
          error: "AI CLI process timed out after 30000ms",
          diagnostics: {
            timedOut: true,
            model: "gpt-5.4",
            promptChars: 12,
            inputTokens: 21,
            outputTokens: 8,
            totalTokens: 29,
            exitCode: 1,
            exitSignal: "SIGKILL" as const,
            timingBreakdown: {
              timeoutMs: 30_000,
              totalRuntimeMs: 30_250,
              sigtermSentAfterMs: 30_000,
              sigkillSentAfterMs: 30_240,
              exitObservedAfterMs: 30_250,
              shutdownAfterSigtermMs: 250,
              requiredSigkill: true
            },
            partialProgress: {
              source: "stdout" as const,
              kind: "assistant_message" as const,
              eventType: "response.output_text.done",
              sessionId: null,
              excerpt: "Planner reached timeout while collecting a sub-task."
            }
          }
        };
      }
    };
    const failureSnapshot = {
      captured_at: "2026-03-19T00:00:00.000Z",
      cpu_state: {
        process_user_cpu_time_us: 101_000,
        process_system_cpu_time_us: 22_000,
        system_load_average: [0.12, 0.34, 0.56],
        available_parallelism: 8
      },
      memory_state: {
        process_rss_bytes: 4_096,
        process_heap_total_bytes: 8_192,
        process_heap_used_bytes: 2_048,
        process_external_bytes: 256,
        process_array_buffers_bytes: 128,
        system_total_bytes: 16_384,
        system_free_bytes: 8_192
      },
      network_connectivity: {
        status: "reachable",
        probe_target: "dns:example.com",
        probe_latency_ms: 24,
        timed_out: false,
        error: null,
        non_internal_interface_count: 1,
        interface_names: ["en0"]
      },
      tool_availability: {
        status: "available",
        registered_count: 3,
        registered_tools: ["activate_skill", "read_file", "run_shell_command"]
      }
    };

    const originalCwd = process.cwd();
    process.chdir(workspaceRoot);

    try {
      const realWorkspaceRoot = await fs.realpath(process.cwd());
      const agent = new PlannerAgent(
        createStubTools() as never,
        makeConfig(homeDir),
        mockCodex as never,
        async (ms) => {
          sleepCalls.push(ms);
        },
        async () => failureSnapshot
      );

      let failure: unknown;
      try {
        await agent.plan(createContext(), {
          onLog: async (message) => {
            logs.push(message);
          }
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(PlannerInfrastructureError);
      expect((failure as Error).message).toMatch(/diagnostics: .*planner\.debug\.json/);
      expect(attempts).toBe(3);
      expect(sleepCalls).toEqual([1000, 2000]);

      const timeoutContextLog = logs.find((message) => message.includes("ProjectPlanner timeout context:"));
      expect(timeoutContextLog).toBeTruthy();

      const timeoutContext = JSON.parse(timeoutContextLog!.split("ProjectPlanner timeout context: ")[1]) as Record<
        string,
        unknown
      >;
      expect(timeoutContext.timeout_duration_ms).toBe(30_000);
      expect(timeoutContext.exit_status).toEqual({
        exit_code: 1,
        exit_signal: "SIGKILL",
        timed_out: true
      });
      expect(timeoutContext.environment_state).toEqual({
        sandbox: "read-only",
        cwd: realWorkspaceRoot,
        process_cwd: realWorkspaceRoot,
        node_env: process.env.NODE_ENV ?? null,
        pid: process.pid
      });
      expect(timeoutContext.partial_output).toEqual({
        checkpoint: {
          source: "stdout",
          kind: "assistant_message",
          event_type: "response.output_text.done",
          session_id: null,
          excerpt: "Planner reached timeout while collecting a sub-task."
        },
        stdout_tail:
          '{"type":"response.output_text.done","text":"Planner reached timeout while collecting a sub-task."}',
        stderr_tail: "planner request timed out after 30000ms",
        raw_tail: null
      });
      expect(timeoutContext.failure_snapshot).toEqual(failureSnapshot);

      const diagnosticsLog = logs.find((message) => message.includes("ProjectPlanner diagnostics artifact:"));
      expect(diagnosticsLog).toBeTruthy();

      const diagnosticsPath = diagnosticsLog!.split("ProjectPlanner diagnostics artifact: ")[1];
      const payload = await readJsonFile<Record<string, unknown>>(diagnosticsPath, {});

      expect(payload.failure_classification).toBe("timeout");
      expect(payload.timed_out).toBe(true);
      expect(payload.timeout_duration_ms).toBe(30_000);
      expect(payload.exit_status).toEqual({
        exit_code: 1,
        exit_signal: "SIGKILL",
        timed_out: true
      });
      expect(payload.environment_state).toEqual({
        sandbox: "read-only",
        cwd: realWorkspaceRoot,
        process_cwd: realWorkspaceRoot,
        node_env: process.env.NODE_ENV ?? null,
        pid: process.pid
      });
      expect(payload.partial_progress_checkpoint).toEqual({
        source: "stdout",
        kind: "assistant_message",
        event_type: "response.output_text.done",
        session_id: null,
        excerpt: "Planner reached timeout while collecting a sub-task."
      });
      expect(payload.partial_output).toEqual({
        checkpoint: {
          source: "stdout",
          kind: "assistant_message",
          event_type: "response.output_text.done",
          session_id: null,
          excerpt: "Planner reached timeout while collecting a sub-task."
        },
        stdout_tail:
          '{"type":"response.output_text.done","text":"Planner reached timeout while collecting a sub-task."}',
        stderr_tail: "planner request timed out after 30000ms",
        raw_tail: null
      });
      expect(payload.failure_snapshot).toEqual(failureSnapshot);
    } finally {
      process.chdir(originalCwd);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
