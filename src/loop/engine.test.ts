import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../config/env";
import type {
  ActionRecord,
  EvaluationResult,
  LeaderContext,
  LeaderDecision,
  ProductManagerContext,
  SubTask,
  ToolResult
} from "../types/contracts";
import { ensureLoopHome, readLoopState, setFlag, type LoopPaths, writeLoopState } from "./state";
import { writeActiveRequirementArtifact } from "../product/requirements";
import { WorkspaceManager } from "../environment/workspace";
import { fileExists } from "../utils/fs";
import {
  LoopEngine,
  buildEvaluatorReworkInstructions,
  collectOperationalEvidence,
  decideEvaluationFailureRecoveryPath,
  extractSnapshotTargetsFromSubTask,
  resolveNextLastError,
  summarizeGovernanceFailureForState
} from "./engine";

async function waitForPausedState(paths: LoopPaths, timeoutMs = 6_000): Promise<Awaited<ReturnType<typeof readLoopState>>> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await readLoopState(paths);
    if (state.state === "paused") {
      return state;
    }
    await Bun.sleep(50);
  }

  throw new Error("Timed out waiting for paused state.");
}

function makeToolResult(summary: string): ToolResult {
  return {
    status: "success",
    summary,
    artifacts: {
      log_path: "",
      state_change_path: ""
    },
    error: undefined,
    next_state_hint: "continue"
  };
}

function makeEvaluation(decision: EvaluationResult["decision"], justification: string): EvaluationResult {
  return {
    decision,
    justification,
    evidence: ["test-evidence"],
    recommended_next_action: "add targeted verification"
  };
}

function makeAction(tool: string): ActionRecord {
  return {
    tool,
    args: {},
    ok: true,
    output: `${tool} ok`
  };
}

describe("extractSnapshotTargetsFromSubTask", () => {
  async function createWorkspace(files: string[]): Promise<string> {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-snapshot-targets-"));
    for (const file of files) {
      const fullPath = path.join(workspaceRoot, file);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, `${file}\n`, "utf8");
    }
    return workspaceRoot;
  }

  test("extracts backticked file paths from objective and outcome", async () => {
    const workspaceRoot = await createWorkspace([
      ".ailoop/plans/round-7.md",
      "src/loop/engine.ts",
      ".ailoop/runs/report.txt"
    ]);
    const subTask: SubTask = {
      assignee: "executor",
      rationale: "test",
      objective: "Create `.ailoop/plans/round-7.md` with checklist.",
      expected_outcome: "File `src/loop/engine.ts` updated and `.ailoop/runs/report.txt` written.",
      impacted_files: [],
      recommended_tools: ["write_file"]
    };

    const targets = extractSnapshotTargetsFromSubTask(subTask, workspaceRoot);
    expect(targets).toContain(path.join(workspaceRoot, ".ailoop/plans/round-7.md"));
    expect(targets).toContain(path.join(workspaceRoot, "src/loop/engine.ts"));
    expect(targets).toContain(path.join(workspaceRoot, ".ailoop/runs/report.txt"));

    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("ignores numeric literals, commands, directories, and error strings in backticks", async () => {
    const workspaceRoot = await createWorkspace(["src/loop/engine.ts", "src/loop/engine.test.ts"]);
    const subTask: SubTask = {
      assignee: "executor",
      rationale: "test",
      objective:
        "Update `src/loop/engine.ts`, investigate `EISDIR: illegal operation on a directory, read`, avoid `src/loop`, and rerun `bun test src/loop/engine.test.ts` for round `23`.",
      expected_outcome:
        "Only `src/loop/engine.test.ts` is snapshotted while ignoring `src/loop`, `bun test src/loop/engine.test.ts`, and `123`.",
      impacted_files: [],
      recommended_tools: ["write_file"]
    };

    const targets = extractSnapshotTargetsFromSubTask(subTask, workspaceRoot);

    expect(targets).toContain(path.join(workspaceRoot, "src/loop/engine.ts"));
    expect(targets).toContain(path.join(workspaceRoot, "src/loop/engine.test.ts"));
    expect(targets).not.toContain(path.join(workspaceRoot, "src/loop"));
    expect(targets).not.toContain(path.join(workspaceRoot, "bun test src/loop/engine.test.ts"));
    expect(targets).not.toContain(path.join(workspaceRoot, "EISDIR: illegal operation on a directory, read"));
    expect(targets).not.toContain(path.join(workspaceRoot, "23"));
    expect(targets).not.toContain(path.join(workspaceRoot, "123"));

    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("excludes nonexistent dotted backticked tokens from snapshot targets", async () => {
    const workspaceRoot = await createWorkspace(["src/loop/engine.ts"]);
    const subTask: SubTask = {
      assignee: "executor",
      rationale: "test",
      objective: "Update `src/loop/engine.ts` and ignore nonexistent `foo.txt`.",
      expected_outcome: "Only real workspace files are snapshotted.",
      impacted_files: [],
      recommended_tools: ["write_file"]
    };

    const targets = extractSnapshotTargetsFromSubTask(subTask, workspaceRoot);

    expect(targets).toContain(path.join(workspaceRoot, "src/loop/engine.ts"));
    expect(targets).not.toContain(path.join(workspaceRoot, "foo.txt"));

    await fs.rm(workspaceRoot, { recursive: true, force: true });
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

describe("summarizeGovernanceFailureForState", () => {
  test("collapses recursive leader prompt dumps into a concise diagnostic summary", () => {
    const summary = summarizeGovernanceFailureForState(
      "Codex exited with code 1 | stderr: OpenAI Codex v0.114.0 -------- user # LeaderAgent Role Contract ## Mission Intervene when the loop pauses | diagnostics: /tmp/2026-03-17T03-37-02-645Z.leader.debug.json"
    );

    expect(summary).toContain("Codex exited with code 1");
    expect(summary).toContain("/tmp/2026-03-17T03-37-02-645Z.leader.debug.json");
    expect(summary).not.toContain("# LeaderAgent Role Contract");
    expect(summary).not.toContain("OpenAI Codex v0.114.0");
  });

  test("preserves provider credit exhaustion details without dumping the full raw error", () => {
    const summary = summarizeGovernanceFailureForState(
      "AI CLI exited with code 1 | stderr: API Error: 402 This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 44565. | diagnostics: /tmp/leader.debug.json"
    );

    expect(summary).toContain("AI CLI exited with code 1");
    expect(summary).toContain("detail:");
    expect(summary).toContain("more credits");
    expect(summary).toContain("max_tokens");
    expect(summary).toContain("/tmp/leader.debug.json");
  });

  test("preserves provider rate-limit details reported as usage-limit errors", () => {
    const summary = summarizeGovernanceFailureForState(
      'AI CLI exited with code 1 | stderr: API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"usage limit exceeded (2056)"}} | diagnostics: /tmp/leader.debug.json'
    );

    expect(summary).toContain("AI CLI exited with code 1");
    expect(summary).toContain("detail:");
    expect(summary).toContain("429");
    expect(summary).toContain("usage limit exceeded");
    expect(summary).toContain("/tmp/leader.debug.json");
  });
});

describe("buildEvaluatorReworkInstructions", () => {
  test("uses compact navigational rework instructions instead of embedding the full raw state change", () => {
    const instructions = buildEvaluatorReworkInstructions(
      ["Human instruction: stay minimal."],
      {
        decision: "fail",
        justification: "goal_alignment failed because verification evidence is missing.",
        evidence: ["State change references src/loop/engine.state-json-contract.test.ts."],
        recommended_next_action: "rerun the targeted bun test and capture its concrete output"
      },
      1,
      3,
      "### Snapshot File Diffs\n```diff\n+very large raw diff body\n```",
      {
        logPath: "/tmp/example.round.log",
        stateChangePath: "/tmp/example.round.state_change.txt"
      }
    );

    expect(instructions.some((line) => line.includes("Evaluator failure: goal_alignment failed"))).toBe(true);
    expect(instructions.some((line) => line.includes("Evaluator recommended next action"))).toBe(true);
    expect(instructions.some((line) => line.includes("/tmp/example.round.state_change.txt"))).toBe(true);
    expect(instructions.some((line) => line.includes("/tmp/example.round.log"))).toBe(true);
    expect(instructions.some((line) => line.includes("Current Modified Content"))).toBe(false);
    expect(instructions.some((line) => line.includes("very large raw diff body"))).toBe(false);
  });
});

describe("decideEvaluationFailureRecoveryPath", () => {
  test("routes insufficient evidence failures to Leader before auto rework", () => {
    const path = decideEvaluationFailureRecoveryPath(
      {
        decision: "fail",
        justification: "Insufficient evidence for key dimensions: goal_alignment, causal_validity, constraint_compliance.",
        root_cause: "insufficient_evidence:goal_alignment",
        evidence: ["No behavioral verification excerpt was attached."],
        recommended_next_action: "Attach minimal proof.",
        dimensions: [
          {
            dimension: "goal_alignment",
            decision: "unknown",
            score: 58,
            confidence: 0.94,
            justification: "No direct verification excerpt was attached.",
            evidence: ["The executor summary is not enough on its own."],
            blocking_issues: ["No code or state-change excerpt demonstrates the requested behavior."],
            recommended_next_action: "Attach minimal proof."
          }
        ]
      },
      makeToolResult("Executor claims the targeted bun test passed with 61 pass, 0 fail.")
    );

    expect(path).toBe("leader");
  });

  test("honors an explicit strategic recovery signal even when the root cause looks tactical", () => {
    const path = decideEvaluationFailureRecoveryPath(
      {
        decision: "fail",
        justification: "Scope reduction is required before more executor retries.",
        root_cause: "dimension_failure:risk_externality",
        evidence: ["Further retries in the same file would expand hot-file pressure."],
        recommended_next_action: "Pause and split the work into a smaller structural pass.",
        recovery_path: "strategic_governance"
      },
      makeToolResult("Executor completed the requested change, but the evaluator wants governance review.")
    );

    expect(path).toBe("leader");
  });

  test("keeps clear implementation failures on the auto rework path", () => {
    const path = decideEvaluationFailureRecoveryPath(
      {
        decision: "fail",
        justification: "A focused regression test still fails after the change.",
        root_cause: "implementation_failure:test_regression",
        evidence: ["bun test src/loop/engine.test.ts failed with one assertion mismatch."],
        recommended_next_action: "Fix the failing assertion and rerun the focused test."
      },
      makeToolResult("Updated the failing code path but one regression still fails.")
    );

    expect(path).toBe("auto_rework");
  });
});

describe("LoopEngine auto rework", () => {
  test("persists detailed governance failures from Leader execution into loop state", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-governance-error-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir,
      AILOOP_MAX_CYCLES: "1"
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const seeded = await readLoopState(paths);
    await writeLoopState(paths, {
      ...seeded,
      state: "paused",
      round: 23,
      last_error: "Evaluator blocked the round."
    });
    await setFlag(paths.pauseFlagPath);

    const mutable = engine as unknown as {
      leader: {
        execute: (input: { paths: LoopPaths }) => Promise<never>;
      };
      run: () => Promise<void>;
    };

    mutable.leader = {
      execute: async () => {
        await setFlag(paths.stopFlagPath);
        throw new Error(
          "Codex exited with code 1 | stderr: OpenAI Codex v0.114.0 -------- user # LeaderAgent Role Contract ## Mission Intervene when the loop pauses | raw: {\"detail\":\"returned non-json strategy blob\"} | diagnostics: /tmp/leader.debug.json"
        );
      }
    };

    await mutable.run();

    const finalState = await readLoopState(paths);
    expect(finalState.last_error).toBe("Governance failed: Codex exited with code 1 | diagnostics: /tmp/leader.debug.json");

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("keeps the run paused when governance fails due to provider credit exhaustion", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-governance-quota-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir,
      AILOOP_MAX_CYCLES: "1"
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const seeded = await readLoopState(paths);
    await writeLoopState(paths, {
      ...seeded,
      state: "paused",
      round: 24,
      last_error: "Evaluator blocked the round."
    });
    await setFlag(paths.pauseFlagPath);

    const mutable = engine as unknown as {
      leader: {
        execute: (input: { paths: LoopPaths }) => Promise<never>;
      };
      run: () => Promise<void>;
    };

    mutable.leader = {
      execute: async () => {
        throw new Error(
          "AI CLI exited with code 1 | stderr: API Error: 402 This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 44565. | diagnostics: /tmp/leader.debug.json"
        );
      }
    };

    await mutable.run();

    const finalState = await readLoopState(paths);
    expect(finalState.state).toBe("paused");
    expect(finalState.last_error).toContain("Governance failed due to provider/network error:");
    expect(finalState.last_error).toContain("more credits");
    expect(finalState.last_error).toContain("/tmp/leader.debug.json");

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("keeps the run paused when governance fails due to provider rate limiting", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-governance-rate-limit-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir,
      AILOOP_MAX_CYCLES: "1"
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const seeded = await readLoopState(paths);
    await writeLoopState(paths, {
      ...seeded,
      state: "paused",
      round: 25,
      last_error: "Evaluator blocked the round."
    });
    await setFlag(paths.pauseFlagPath);

    const mutable = engine as unknown as {
      leader: {
        execute: (input: { paths: LoopPaths }) => Promise<never>;
      };
      run: () => Promise<void>;
    };

    mutable.leader = {
      execute: async () => {
        throw new Error(
          'AI CLI exited with code 1 | stderr: API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"usage limit exceeded (2056)"}} | diagnostics: /tmp/leader.debug.json'
        );
      }
    };

    await mutable.run();

    const finalState = await readLoopState(paths);
    expect(finalState.state).toBe("paused");
    expect(finalState.last_error).toContain("Governance failed due to provider/network error:");
    expect(finalState.last_error).toContain("usage limit exceeded");
    expect(finalState.last_error).toContain("/tmp/leader.debug.json");

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("skips tactical auto rework and returns failure immediately when evidence insufficiency should go to Leader", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-leader-first-routing-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir,
      AILOOP_EVAL_REWORK_MAX_ATTEMPTS: "2"
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const plan: SubTask = {
      assignee: "executor",
      rationale: "test rationale",
      objective: "Add hot-file pressure telemetry evidence",
      expected_outcome: "The evaluator can verify the telemetry through compact evidence",
      impacted_files: [],
      recommended_tools: ["read_file", "write_file", "run_shell"]
    };

    let executeCall = 0;
    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      executor: {
        execute: () => Promise<{
          actions: ActionRecord[];
          toolResult: ToolResult;
        }>;
      };
      evaluator: { evaluate: () => Promise<EvaluationResult> };
      collectOperationalEvidence: () => Promise<{
        summaryNote: string;
        lines: string[];
        stateChangeNotes: string[];
      }>;
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };

    mutable.planner = { plan: async () => plan };
    mutable.executor = {
      execute: async () => {
        executeCall += 1;
        return {
          actions: [makeAction("write_file"), makeAction("run_shell")],
          toolResult: {
            ...makeToolResult("Executor reports bun test passed with 61 pass, 0 fail."),
            operational_evidence: [
              "run_shell_command: Ran bun test src/server.test.ts web/src/App.test.tsx and observed 61 pass, 0 fail."
            ]
          }
        };
      }
    };
    mutable.evaluator = {
      evaluate: async () => ({
        decision: "fail",
        justification: "Insufficient evidence for key dimensions: goal_alignment, causal_validity, constraint_compliance.",
        root_cause: "insufficient_evidence:goal_alignment",
        evidence: ["No behavioral verification excerpt was attached."],
        recommended_next_action: "Attach minimal proof from the round artifacts.",
        recovery_path: "strategic_governance",
        dimensions: [
          {
            dimension: "goal_alignment",
            decision: "unknown",
            score: 58,
            confidence: 0.94,
            justification: "The executor claims success, but no compact evidence excerpt proves it.",
            evidence: ["No targeted artifact excerpt shows the expected metric or test output."],
            blocking_issues: ["Validation evidence is missing."],
            recommended_next_action: "Attach minimal proof."
          }
        ]
      })
    };
    mutable.collectOperationalEvidence = async () => ({
      summaryNote: "",
      lines: [],
      stateChangeNotes: []
    });

    const outcome = await mutable.runRound(1);

    expect(outcome.success).toBe(false);
    expect(outcome.errorMessage).toContain("EvaluatorStrategicBlock:");
    expect(outcome.errorMessage).toContain("Insufficient evidence");
    expect(executeCall).toBe(1);

    const runArtifacts = await fs.readdir(path.join(homeDir, "runs"));
    const summaryFile = runArtifacts.find((entry) => entry.endsWith(".round.summary.md"));
    expect(summaryFile).toBeDefined();
    const summaryText = await fs.readFile(path.join(homeDir, "runs", summaryFile as string), "utf8");
    expect(summaryText).toContain("## Auto Rework Attempts");
    expect(summaryText).not.toContain("Attempt 1/2:");

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("passes prior executor evidence into Leader governance context before intervention", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-leader-context-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir,
      AILOOP_MAX_CYCLES: "1"
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const runTimestamp = "2026-03-17T02-13-19-554Z";
    const stateChangePath = path.join(paths.runsDir, `${runTimestamp}.round.state_change.txt`);
    const logPath = path.join(paths.runsDir, `${runTimestamp}.round.log`);
    await fs.mkdir(paths.runsDir, { recursive: true });
    await fs.writeFile(
      stateChangePath,
      [
        "### Snapshot File Diffs",
        "+      hotFilePressureCount: hotFilePressure?.count || 0,",
        "+          <p className=\"text-[10px] uppercase tracking-widest text-mist/50\">Hot-File Pressure</p>"
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(logPath, "[executor] bun test src/server.test.ts web/src/App.test.tsx -> 61 pass, 0 fail\n", "utf8");

    const seeded = await readLoopState(paths);
    await writeLoopState(paths, {
      ...seeded,
      state: "paused",
      round: 24,
      last_error: "Insufficient evidence for key dimensions: goal_alignment, causal_validity, constraint_compliance.",
      previous_tool_result: {
        status: "success",
        summary:
          "Verified the existing workspace change set computes hot-file-pressure telemetry in `src/utils/db.ts`, surfaces it in the Web Console health view in `web/src/App.tsx`, and passes the targeted Bun test command with `61 pass, 0 fail`.",
        artifacts: {
          log_path: logPath,
          state_change_path: stateChangePath
        },
        next_state_hint: "continue"
      },
      previous_evaluation_dimensions: [
        {
          dimension: "goal_alignment",
          decision: "unknown",
          score: 58,
          confidence: 0.94,
          justification: "The evidence bundle is not sufficient to verify goal alignment.",
          evidence: ["No behavioral verification excerpt shows the focused bun test actually ran and passed."],
          blocking_issues: ["No code or state-change excerpt demonstrates the required metric/UI change."],
          recommended_next_action:
            "Attach minimal proof: one excerpt from src/utils/db.ts, one excerpt from web/src/App.tsx, and the actual output of bun test src/server.test.ts web/src/App.test.tsx."
        }
      ]
    });
    await setFlag(paths.pauseFlagPath);

    let capturedContext: LeaderContext | null = null;
    const mutable = engine as unknown as {
      leader: {
        execute: (input: { context: LeaderContext; paths: LoopPaths }) => Promise<LeaderDecision>;
      };
      run: () => Promise<void>;
    };

    mutable.leader = {
      execute: async (input) => {
        capturedContext = input.context;
        await setFlag(paths.stopFlagPath);
        return {
          rationale: "This is an evidence-handoff failure, not a product-code failure.",
          action: "stop",
          diagnosis_type: "implementation_failure",
          instructions: ["Patch the evaluator evidence handoff before retrying the feature round."]
        };
      }
    };

    await mutable.run();

    expect(capturedContext).not.toBeNull();
    if (!capturedContext) {
      throw new Error("Expected Leader context to be captured.");
    }
    expect(capturedContext.previousToolResult?.summary).toContain("61 pass, 0 fail");
    expect(capturedContext.previousToolResult?.artifacts.state_change_path).toBe(stateChangePath);
    expect(capturedContext.stateChange).toContain("hotFilePressureCount");
    expect(capturedContext.stateChange).toContain("Hot-File Pressure");

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("invokes ProductManager and persists the active requirement artifact before normal execution when requirements are missing", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-product-manager-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const plannerCalls: Array<{ requirement_artifact_status?: string; requirement_artifact_summary?: string | null }> = [];
    const requirementPlan: SubTask = {
      assignee: "executor",
      rationale: "Requirement artifact is missing.",
      objective: "Create the active requirement artifact at .ailoop/product-requirements/current.md via the ProductManager before normal execution planning resumes.",
      expected_outcome: "The active requirement artifact exists as human-readable Markdown and is specific enough for the next atomic round.",
      impacted_files: [".ailoop/product-requirements/current.md"],
      recommended_tools: ["read_file"]
    };
    const finalPlan: SubTask = {
      assignee: "executor",
      rationale: "Requirements are now available.",
      objective: "Implement the first requirement-backed console health improvement",
      expected_outcome: "A tracked change demonstrates requirement-backed execution",
      impacted_files: ["src/"],
      recommended_tools: ["read_file", "write_file", "run_shell"]
    };

    let capturedProductManagerContext: ProductManagerContext | null = null;

    const mutable = engine as unknown as {
      planner: { plan: (context: Record<string, unknown>) => Promise<SubTask> };
      productManager: { generateRequirement: (context: ProductManagerContext) => Promise<string> };
      executor: {
        execute: () => Promise<{
          actions: ActionRecord[];
          toolResult: ToolResult;
        }>;
      };
      evaluator: { evaluate: () => Promise<EvaluationResult> };
      collectOperationalEvidence: () => Promise<{
        summaryNote: string;
        lines: string[];
        stateChangeNotes: string[];
      }>;
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };

    mutable.planner = {
      plan: async (context) => {
        plannerCalls.push({
          requirement_artifact_status: context.requirement_artifact_status as string | undefined,
          requirement_artifact_summary: (context.requirement_artifact_summary as string | null | undefined) ?? null
        });
        return plannerCalls.length === 1 ? requirementPlan : finalPlan;
      }
    };
    mutable.productManager = {
      generateRequirement: async (context) => {
        capturedProductManagerContext = context;
        return (
        "# Requirement Slice: Console Health\n\n## Problem\nOperators need a reviewable health signal.\n"
        );
      }
    };
    mutable.executor = {
      execute: async () => ({
        actions: [makeAction("read_file"), makeAction("write_file")],
        toolResult: makeToolResult("Executed requirement-backed round")
      })
    };
    mutable.evaluator = {
      evaluate: async () => makeEvaluation("pass", "Requirement-backed execution succeeded.")
    };
    mutable.collectOperationalEvidence = async () => ({
      summaryNote: "",
      lines: [],
      stateChangeNotes: []
    });

    const outcome = await mutable.runRound(1);

    expect(outcome.success).toBe(true);
    expect(plannerCalls).toHaveLength(2);
    expect(plannerCalls[0]).toEqual({
      requirement_artifact_status: "missing",
      requirement_artifact_summary: null
    });
    expect(plannerCalls[1].requirement_artifact_status).toBe("ready");
    expect(plannerCalls[1].requirement_artifact_summary).toContain("Requirement Slice: Console Health");
    expect(await fs.readFile(paths.activeRequirementPath, "utf8")).toContain("# Requirement Slice: Console Health");
    expect(capturedProductManagerContext).not.toBeNull();
    if (!capturedProductManagerContext) {
      throw new Error("Expected ProductManager context to be captured.");
    }
    const productManagerContext: ProductManagerContext =
      capturedProductManagerContext as unknown as ProductManagerContext;
    expect(productManagerContext.runtime_policy_brief).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Documentation precedes code"),
        expect.stringContaining("Ruthless Simplicity"),
        expect.stringContaining("Secret redaction")
      ])
    );
    expect(productManagerContext.source_manifest).toEqual(
      expect.objectContaining({
        mandatory_sources: expect.arrayContaining([
          expect.objectContaining({ path: "README.md" }),
          expect.objectContaining({ path: "ARCHITECTURE.md" }),
          expect.objectContaining({ path: "AILOOP_ENGINE_WORKFLOW.md" }),
          expect.objectContaining({ path: "AGENTS.md", reason: expect.stringContaining("Project principles only") })
        ]),
        optional_sources: expect.any(Array),
        expansion_rule: expect.stringContaining("Read mandatory sources first")
      })
    );

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("marks a completed requirement slice and asks for ProductManager refresh on the next round", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-requirement-refresh-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);
    await writeActiveRequirementArtifact(
      paths,
      [
        "# Requirement Slice: Requirement Lifecycle",
        "",
        "## Acceptance Criteria",
        "- src/planning/requirement-completion.ts records a lifecycle status update for the active requirement artifact.",
        "- ProjectPlanner requests a ProductManager refresh after the current slice is complete."
      ].join("\n")
    );

    const plannerCalls: Array<{ round: number; requirement_artifact_status?: string }> = [];
    const implementationPlan: SubTask = {
      assignee: "executor",
      rationale: "Current slice is still active.",
      objective: "Implement requirement completion tracking in src/planning/requirement-completion.ts",
      expected_outcome:
        "A passing round proves src/planning/requirement-completion.ts records completion and ProjectPlanner requests a ProductManager refresh.",
      impacted_files: ["src/planning/requirement-completion.ts"],
      recommended_tools: ["read_file", "write_file", "run_shell"]
    };
    const refreshPlan: SubTask = {
      assignee: "executor",
      rationale: "The active requirement slice is complete.",
      objective: "Refresh the active requirement artifact at .ailoop/product-requirements/current.md via the ProductManager before normal execution planning resumes.",
      expected_outcome: "A new human-readable requirement slice replaces the completed one.",
      impacted_files: [".ailoop/product-requirements/current.md"],
      recommended_tools: ["read_file"]
    };
    const postRefreshPlan: SubTask = {
      assignee: "executor",
      rationale: "A refreshed requirement slice is available.",
      objective: "Implement the next requirement-backed execution step",
      expected_outcome: "A tracked change advances the refreshed requirement slice",
      impacted_files: ["src/"],
      recommended_tools: ["read_file", "write_file", "run_shell"]
    };

    const mutable = engine as unknown as {
      planner: { plan: (context: Record<string, unknown>) => Promise<SubTask> };
      productManager: { generateRequirement: () => Promise<string> };
      executor: {
        execute: () => Promise<{
          actions: ActionRecord[];
          toolResult: ToolResult;
        }>;
      };
      evaluator: { evaluate: () => Promise<EvaluationResult> };
      collectOperationalEvidence: () => Promise<{
        summaryNote: string;
        lines: string[];
        stateChangeNotes: string[];
      }>;
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };

    mutable.planner = {
      plan: async (context) => {
        plannerCalls.push({
          round: Number(context.round),
          requirement_artifact_status: context.requirement_artifact_status as string | undefined
        });

        if (plannerCalls.length === 1) {
          return implementationPlan;
        }

        if ((context.requirement_artifact_status as string | undefined) === "needs_refresh") {
          return refreshPlan;
        }

        return postRefreshPlan;
      }
    };
    mutable.productManager = {
      generateRequirement: async () =>
        "# Requirement Slice: Refreshed\n\n## Acceptance Criteria\n- The next atomic execution task is clearly defined.\n"
    };
    mutable.executor = {
      execute: async () => ({
        actions: [makeAction("write_file"), makeAction("run_shell")],
        toolResult: {
          ...makeToolResult("Completed requirement slice"),
          next_state_hint: "continue"
        }
      })
    };
    mutable.evaluator = {
      evaluate: async () => ({
        decision: "pass",
        justification:
          "src/planning/requirement-completion.ts records a lifecycle status update for the active requirement artifact.",
        evidence: [
          "src/planning/requirement-completion.ts records a lifecycle status update for the active requirement artifact.",
          "ProjectPlanner requests a ProductManager refresh after the current slice is complete."
        ],
        recommended_next_action: "continue"
      })
    };
    mutable.collectOperationalEvidence = async () => ({
      summaryNote: "",
      lines: [],
      stateChangeNotes: []
    });

    const firstOutcome = await mutable.runRound(1);
    expect(firstOutcome.success).toBe(true);

    const completedRequirement = await fs.readFile(paths.activeRequirementPath, "utf8");
    expect(completedRequirement).toContain("## Lifecycle Status");
    expect(completedRequirement).toContain("- Status: complete");

    const secondOutcome = await mutable.runRound(2);
    expect(secondOutcome.success).toBe(true);
    expect(plannerCalls.map((call) => `${call.round}:${call.requirement_artifact_status}`)).toEqual([
      "1:ready",
      "2:needs_refresh",
      "2:ready"
    ]);

    const refreshedRequirement = await fs.readFile(paths.activeRequirementPath, "utf8");
    expect(refreshedRequirement).toContain("# Requirement Slice: Refreshed");
    expect(refreshedRequirement).not.toContain("- Status: complete");

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("does not mark the requirement slice complete when evaluator fails", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-requirement-fail-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);
    await writeActiveRequirementArtifact(
      paths,
      [
        "# Requirement Slice: Requirement Lifecycle",
        "",
        "## Acceptance Criteria",
        "- src/planning/requirement-completion.ts records a lifecycle status update for the active requirement artifact.",
        "- ProjectPlanner requests a ProductManager refresh after the current slice is complete."
      ].join("\n")
    );

    const plan: SubTask = {
      assignee: "executor",
      rationale: "Current slice is still active.",
      objective: "Implement requirement completion tracking in src/planning/requirement-completion.ts",
      expected_outcome:
        "A passing round proves src/planning/requirement-completion.ts records completion and ProjectPlanner requests a ProductManager refresh.",
      impacted_files: ["src/planning/requirement-completion.ts"],
      recommended_tools: ["read_file", "write_file", "run_shell"]
    };

    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      executor: {
        execute: () => Promise<{
          actions: ActionRecord[];
          toolResult: ToolResult;
        }>;
      };
      evaluator: { evaluate: () => Promise<EvaluationResult> };
      collectOperationalEvidence: () => Promise<{
        summaryNote: string;
        lines: string[];
        stateChangeNotes: string[];
      }>;
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };

    mutable.planner = { plan: async () => plan };
    mutable.executor = {
      execute: async () => ({
        actions: [makeAction("write_file")],
        toolResult: {
          ...makeToolResult("Attempted requirement completion change"),
          next_state_hint: "continue"
        }
      })
    };
    mutable.evaluator = {
      evaluate: async () => ({
        decision: "fail",
        justification:
          "src/planning/requirement-completion.ts records a lifecycle status update for the active requirement artifact.",
        evidence: [
          "src/planning/requirement-completion.ts records a lifecycle status update for the active requirement artifact.",
          "ProjectPlanner requests a ProductManager refresh after the current slice is complete."
        ],
        recommended_next_action: "add targeted verification"
      })
    };
    mutable.collectOperationalEvidence = async () => ({
      summaryNote: "",
      lines: [],
      stateChangeNotes: []
    });

    const outcome = await mutable.runRound(1);

    expect(outcome.success).toBe(false);
    const persistedRequirement = await fs.readFile(paths.activeRequirementPath, "utf8");
    expect(persistedRequirement).not.toContain("## Lifecycle Status");

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("writes a markdown summary artifact with core round details after a successful round", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-summary-artifact-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const plan: SubTask = {
      assignee: "executor",
      rationale: "test rationale",
      objective: "Persist markdown round summary",
      expected_outcome: "round summary artifact exists with core sections",
      impacted_files: [],
      recommended_tools: ["read_file", "run_shell"]
    };

    const execute = async () => ({
      actions: [makeAction("read_file"), makeAction("run_shell")],
      toolResult: makeToolResult("Created markdown summary artifact")
    });
    const evaluate = async (): Promise<EvaluationResult> => makeEvaluation("pass", "All checks satisfied.");

    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      executor: { execute: typeof execute };
      evaluator: { evaluate: typeof evaluate };
      collectOperationalEvidence: () => Promise<{
        summaryNote: string;
        lines: string[];
        stateChangeNotes: string[];
      }>;
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };
    mutable.planner = { plan: async () => plan };
    mutable.executor = { execute };
    mutable.evaluator = { evaluate };
    mutable.collectOperationalEvidence = async () => ({
      summaryNote: "",
      lines: [],
      stateChangeNotes: []
    });

    const outcome = await mutable.runRound(1);

    expect(outcome.success).toBe(true);
    const runArtifacts = await fs.readdir(path.join(homeDir, "runs"));
    const summaryFile = runArtifacts.find((entry) => entry.endsWith(".round.summary.md"));
    expect(summaryFile).toBeDefined();

    const summaryText = await fs.readFile(path.join(homeDir, "runs", summaryFile as string), "utf8");
    expect(summaryText).toContain("# AILoop Round Summary");
    expect(summaryText).toContain("## Round Metadata");
    expect(summaryText).toContain("- Round: 1");
    expect(summaryText).toMatch(/- Timestamp: \d{4}-\d{2}-\d{2}T/);
    expect(summaryText).toContain("## Planned Sub-task");
    expect(summaryText).toContain("- Objective: Persist markdown round summary");
    expect(summaryText).toContain("## Execution Result");
    expect(summaryText).toContain("- Work Summary: Created markdown summary artifact");
    expect(summaryText).toContain("## Artifact References");
    expect(summaryText).toContain(`- Summary: ${path.join(homeDir, "runs", summaryFile as string)}`);
    expect(summaryText).toContain(
      `- Metrics: ${path.join(homeDir, "runs", (summaryFile as string).replace(".round.summary.md", ".round.metrics.json"))}`
    );
    expect(summaryText).toContain(
      `- Log: ${path.join(homeDir, "runs", (summaryFile as string).replace(".round.summary.md", ".round.log"))}`
    );
    expect(summaryText).toContain(
      `- State Change: ${path.join(homeDir, "runs", (summaryFile as string).replace(".round.summary.md", ".round.state_change.txt"))}`
    );
    expect(summaryText).toContain(
      `- Evaluation: ${path.join(homeDir, "runs", (summaryFile as string).replace(".round.summary.md", ".round.evaluation.json"))}`
    );
    expect(summaryText).toContain("## Evaluation Result");
    expect(summaryText).toContain("- Decision: pass");

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("persists post-pass operational evidence into the round summary and state-change artifacts", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-operational-evidence-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const plan: SubTask = {
      assignee: "executor",
      rationale: "test rationale",
      objective: "Persist operational follow-up evidence",
      expected_outcome: "summary and state-change artifacts include deploy evidence",
      impacted_files: [],
      recommended_tools: ["read_file", "run_shell"]
    };

    const execute = async () => ({
      actions: [makeAction("read_file"), makeAction("run_shell")],
      toolResult: makeToolResult("Created operational evidence regression")
    });
    const evaluate = async (): Promise<EvaluationResult> => makeEvaluation("pass", "All checks satisfied.");

    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      executor: { execute: typeof execute };
      evaluator: { evaluate: typeof evaluate };
      collectOperationalEvidence: () => Promise<{
        summaryNote: string;
        lines: string[];
        stateChangeNotes: string[];
      }>;
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };
    mutable.planner = { plan: async () => plan };
    mutable.executor = { execute };
    mutable.evaluator = { evaluate };
    mutable.collectOperationalEvidence = async () => ({
      summaryNote: "commit abc1234, push ok, restart ok, health check ok",
      lines: [
        "Commit: abc1234 AILoop Round 1: Persist operational follow-up evidence",
        "Push: Everything up-to-date",
        "Restart: PID 4242, log .ailoop/prod.server.log",
        "Health Check: GET /api/health -> 200 OK",
        "Rollback: git revert --no-edit abc1234 && bun run scripts/prod.ts restart"
      ],
      stateChangeNotes: [
        "Shell: git commit -m ... -> ok",
        "Shell: git push origin HEAD -> ok (Everything up-to-date)",
        "Shell: bun run scripts/prod.ts restart -> ok (PID 4242, log .ailoop/prod.server.log)",
        "Health: GET /api/health -> 200 ok ({\"ok\":true})"
      ]
    });

    const outcome = await mutable.runRound(1);

    expect(outcome.success).toBe(true);
    const runArtifacts = await fs.readdir(path.join(homeDir, "runs"));
    const summaryFile = runArtifacts.find((entry) => entry.endsWith(".round.summary.md"));
    const stateChangeFile = runArtifacts.find((entry) => entry.endsWith(".round.state_change.txt"));
    expect(summaryFile).toBeDefined();
    expect(stateChangeFile).toBeDefined();

    const summaryText = await fs.readFile(path.join(homeDir, "runs", summaryFile as string), "utf8");
    expect(summaryText).toContain("## Operational Evidence");
    expect(summaryText).toContain("- Commit: abc1234 AILoop Round 1: Persist operational follow-up evidence");
    expect(summaryText).toContain("- Push: Everything up-to-date");
    expect(summaryText).toContain("- Restart: PID 4242, log .ailoop/prod.server.log");
    expect(summaryText).toContain("- Health Check: GET /api/health -> 200 OK");
    expect(summaryText).toContain("- Rollback: git revert --no-edit abc1234 && bun run scripts/prod.ts restart");

    const stateChangeText = await fs.readFile(path.join(homeDir, "runs", stateChangeFile as string), "utf8");
    expect(stateChangeText).toContain("### Operational Follow-up");
    expect(stateChangeText).toContain("Shell: git commit -m ... -> ok");
    expect(stateChangeText).toContain("Shell: git push origin HEAD -> ok (Everything up-to-date)");
    expect(stateChangeText).toContain("Shell: bun run scripts/prod.ts restart -> ok (PID 4242, log .ailoop/prod.server.log)");
    expect(stateChangeText).toContain("Health: GET /api/health -> 200 ok ({\"ok\":true})");

    const persistedState = await readLoopState(paths);
    expect(persistedState.previous_tool_result?.operational_evidence).toEqual([
      "Commit: abc1234 AILoop Round 1: Persist operational follow-up evidence",
      "Push: Everything up-to-date",
      "Restart: PID 4242, log .ailoop/prod.server.log",
      "Health Check: GET /api/health -> 200 OK",
      "Rollback: git revert --no-edit abc1234 && bun run scripts/prod.ts restart"
    ]);

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("passes concrete round artifact file paths to the evaluator and persisted loop state", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-artifact-contract-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const plan: SubTask = {
      assignee: "executor",
      rationale: "test rationale",
      objective: "Keep concrete artifact paths in tool results",
      expected_outcome: "evaluator and loop state observe timestamped artifact files",
      impacted_files: [],
      recommended_tools: ["read_file", "run_shell"]
    };

    let evaluatedToolResult: ToolResult | null = null;
    let stateChangeArtifactExistedDuringEvaluation = false;
    const execute = async () => ({
      actions: [makeAction("read_file")],
      toolResult: makeToolResult("Created artifact references")
    });
    const evaluate = async ({
      toolResult
    }: {
      toolResult: ToolResult;
    }): Promise<EvaluationResult> => {
      evaluatedToolResult = toolResult;
      await fs.access(toolResult.artifacts.state_change_path);
      stateChangeArtifactExistedDuringEvaluation = true;
      return makeEvaluation("pass", "Artifact contract satisfied.");
    };

    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      executor: { execute: typeof execute };
      evaluator: { evaluate: typeof evaluate };
      collectOperationalEvidence: () => Promise<{
        summaryNote: string;
        lines: string[];
        stateChangeNotes: string[];
      }>;
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };
    mutable.planner = { plan: async () => plan };
    mutable.executor = { execute };
    mutable.evaluator = { evaluate };
    mutable.collectOperationalEvidence = async () => ({
      summaryNote: "",
      lines: [],
      stateChangeNotes: []
    });

    const outcome = await mutable.runRound(1);

    expect(outcome.success).toBe(true);
    expect((evaluatedToolResult as ToolResult | null)?.artifacts.log_path).toMatch(/\.round\.log$/);
    expect((evaluatedToolResult as ToolResult | null)?.artifacts.state_change_path).toMatch(/\.round\.state_change\.txt$/);
    expect(stateChangeArtifactExistedDuringEvaluation).toBe(true);

    const persistedState = await readLoopState(paths);
    expect(persistedState.previous_tool_result?.artifacts.log_path).toMatch(/\.round\.log$/);
    expect(persistedState.previous_tool_result?.artifacts.state_change_path).toMatch(/\.round\.state_change\.txt$/);

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("writes a metrics artifact with round metadata, retry counts, and phase timings after a successful round", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-metrics-artifact-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const plan: SubTask = {
      assignee: "executor",
      rationale: "test rationale",
      objective: "Persist metrics artifact",
      expected_outcome: "round metrics artifact exists with core fields",
      impacted_files: [],
      recommended_tools: ["read_file", "run_shell"]
    };

    const execute = async () => ({
      actions: [makeAction("read_file"), makeAction("run_shell")],
      toolResult: makeToolResult("Created metrics artifact")
    });
    const evaluate = async (): Promise<EvaluationResult> => makeEvaluation("pass", "All checks satisfied.");

    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      executor: { execute: typeof execute };
      evaluator: { evaluate: typeof evaluate };
      collectOperationalEvidence: () => Promise<{
        summaryNote: string;
        lines: string[];
        stateChangeNotes: string[];
      }>;
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };
    mutable.planner = { plan: async () => plan };
    mutable.executor = { execute };
    mutable.evaluator = { evaluate };
    mutable.collectOperationalEvidence = async () => ({
      summaryNote: "",
      lines: [],
      stateChangeNotes: []
    });

    const outcome = await mutable.runRound(1);

    expect(outcome.success).toBe(true);
    const runArtifacts = await fs.readdir(path.join(homeDir, "runs"));
    const metricsFile = runArtifacts.find((entry) => entry.endsWith(".round.metrics.json"));
    expect(metricsFile).toBeDefined();

    const metrics = JSON.parse(
      await fs.readFile(path.join(homeDir, "runs", metricsFile as string), "utf8")
    ) as Record<string, unknown>;
    expect(metrics.round).toBe(1);
    expect(metrics.run_timestamp).toEqual(expect.any(String));
    expect(metrics.duration_ms).toEqual(expect.any(Number));
    expect(metrics.budget_usage).toEqual(
      expect.objectContaining({
        usdUsed: expect.any(Number),
        actionsUsed: expect.any(Number),
        elapsedMs: expect.any(Number)
      })
    );
    expect(metrics.retries).toEqual({
      evidence_remediation_attempts: 0,
      auto_rework_attempts: 0,
      auto_rework_limit: config.evaluatorReworkMaxAttempts
    });
    expect(metrics.phase_timings_ms).toEqual(
      expect.objectContaining({
        planning: expect.any(Number),
        execution: expect.any(Number),
        evaluation: expect.any(Number),
        operational_followup: expect.any(Number)
      })
    );

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("writes an evaluation artifact for each completed round", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-evaluation-artifact-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const plan: SubTask = {
      assignee: "executor",
      rationale: "test rationale",
      objective: "Persist evaluator output",
      expected_outcome: "round evaluation artifact exists",
      impacted_files: [],
      recommended_tools: ["read_file", "write_file"]
    };

    const execute = async () => ({
      actions: [makeAction("read_file")],
      toolResult: makeToolResult("persisted evaluation artifact")
    });
    const evaluate = async (): Promise<EvaluationResult> => makeEvaluation("pass", "All checks satisfied.");

    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      executor: { execute: typeof execute };
      evaluator: { evaluate: typeof evaluate };
      collectOperationalEvidence: () => Promise<{
        summaryNote: string;
        lines: string[];
        stateChangeNotes: string[];
      }>;
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };
    mutable.planner = { plan: async () => plan };
    mutable.executor = { execute };
    mutable.evaluator = { evaluate };
    mutable.collectOperationalEvidence = async () => ({
      summaryNote: "",
      lines: [],
      stateChangeNotes: []
    });

    const outcome = await mutable.runRound(1);

    expect(outcome.success).toBe(true);
    const runArtifacts = await fs.readdir(path.join(homeDir, "runs"));
    const evaluationFile = runArtifacts.find((entry) => entry.endsWith(".round.evaluation.json"));
    expect(evaluationFile).toBeDefined();

    const evaluation = JSON.parse(
      await fs.readFile(path.join(homeDir, "runs", evaluationFile as string), "utf8")
    ) as Record<string, unknown>;
    expect(evaluation.decision).toBe("pass");
    expect(evaluation.justification).toBe("All checks satisfied.");
    expect(evaluation.evidence).toEqual(["test-evidence"]);

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("retries once after evaluator fail by feeding failure reason back to executor", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-rework-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir,
      AILOOP_EVAL_REWORK_MAX_ATTEMPTS: "1"
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const plan: SubTask = {
      assignee: "executor",
      rationale: "test rationale",
      objective: "Implement one change",
      expected_outcome: "one verification passes",
      impacted_files: [],
      recommended_tools: ["read_file", "write_file", "run_shell"]
    };

    const executorInputs: Array<{ subTask: SubTask; instructions: string[] }> = [];
    const execute = async (input: { subTask: SubTask; instructions: string[] }) => {
      executorInputs.push(input);
      if (executorInputs.length === 1) {
        return {
          actions: [makeAction("read_file")],
          toolResult: makeToolResult("initial change")
        };
      }
      return {
        actions: [makeAction("write_file"), makeAction("run_shell")],
        toolResult: makeToolResult("rework change")
      };
    };

    let evalCall = 0;
    const evaluate = async (): Promise<EvaluationResult> => {
      evalCall += 1;
      if (evalCall === 1) {
        return makeEvaluation("fail", "Missing negative tests for edge cases.");
      }
      return makeEvaluation("pass", "All checks satisfied.");
    };

    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      executor: { execute: typeof execute };
      evaluator: { evaluate: typeof evaluate };
      collectOperationalEvidence: () => Promise<{
        summaryNote: string;
        lines: string[];
        stateChangeNotes: string[];
      }>;
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };
    mutable.planner = { plan: async () => plan };
    mutable.executor = { execute };
    mutable.evaluator = { evaluate };
    mutable.collectOperationalEvidence = async () => ({
      summaryNote: "commit abc1234, push ok, restart ok, health check ok",
      lines: [
        "Commit: abc1234 test",
        "Push: Everything up-to-date",
        "Restart: PID 4242, log .ailoop/prod.server.log",
        "Health Check: GET /api/health -> 200 OK",
        "Rollback: git revert --no-edit abc1234 && bun run scripts/prod.ts restart"
      ],
      stateChangeNotes: ["Shell: git push origin HEAD -> ok (Everything up-to-date)"]
    });

    const outcome = await mutable.runRound(1);

    expect(outcome.success).toBe(true);
    expect(executorInputs.length).toBe(2);
    expect(evalCall).toBe(2);
    expect(executorInputs[1]?.instructions.join("\n")).toContain("Evaluator failure");
    expect(executorInputs[1]?.instructions.join("\n")).toContain("Missing negative tests");
    const runArtifacts = await fs.readdir(path.join(homeDir, "runs"));
    const summaryFile = runArtifacts.find((entry) => entry.endsWith(".round.summary.md"));
    expect(summaryFile).toBeDefined();
    const summaryText = await fs.readFile(path.join(homeDir, "runs", summaryFile as string), "utf8");
    expect(summaryText).toContain("## Auto Rework Attempts");
    expect(summaryText).toContain("Attempt 1/1:");
    expect(summaryText).toContain("trigger='Missing negative tests for edge cases.'");
    expect(summaryText).toContain("evaluation=pass");

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("preserves first successful execution evidence in the summary when later rework execution fails", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-rework-summary-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir,
      AILOOP_EVAL_REWORK_MAX_ATTEMPTS: "1"
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const plan: SubTask = {
      assignee: "executor",
      rationale: "test rationale",
      objective: "Add one failing regression test",
      expected_outcome: "The workspace records one red regression test with clear evidence",
      impacted_files: [],
      recommended_tools: ["read_file", "write_file", "run_shell"]
    };

    let executeCall = 0;
    const execute = async () => {
      executeCall += 1;
      if (executeCall === 1) {
        return {
          actions: [makeAction("write_file"), makeAction("run_shell")],
          toolResult: makeToolResult("Added focused regression test and captured the expected red signal")
        };
      }

      return {
        actions: [
          {
            tool: "codex_step",
            args: { index: 1 },
            ok: false,
            output: "No action details returned by Codex.",
            error: "Codex exited with code 1"
          }
        ],
        toolResult: {
          status: "failure",
          summary: "Executor could not complete the task because Codex execution failed.",
          artifacts: {
            log_path: "",
            state_change_path: ""
          },
          error: {
            type: "CodexExecError",
            message: "Codex exited with code 1"
          },
          next_state_hint: "pause"
        }
      };
    };

    let evaluationCall = 0;
    const evaluate = async (): Promise<EvaluationResult> => {
      evaluationCall += 1;
      return makeEvaluation("fail", evaluationCall === 1 ? "Evaluator infrastructure failed." : "Still blocked.");
    };

    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      executor: { execute: typeof execute };
      evaluator: { evaluate: typeof evaluate };
      collectOperationalEvidence: () => Promise<{
        summaryNote: string;
        lines: string[];
        stateChangeNotes: string[];
      }>;
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };
    mutable.planner = { plan: async () => plan };
    mutable.executor = { execute };
    mutable.evaluator = { evaluate };
    mutable.collectOperationalEvidence = async () => ({
      summaryNote: "",
      lines: [],
      stateChangeNotes: []
    });

    const outcome = await mutable.runRound(1);

    expect(outcome.success).toBe(false);
    const runArtifacts = await fs.readdir(path.join(homeDir, "runs"));
    const summaryFile = runArtifacts.find((entry) => entry.endsWith(".round.summary.md"));
    expect(summaryFile).toBeDefined();

    const summaryText = await fs.readFile(path.join(homeDir, "runs", summaryFile as string), "utf8");
    expect(summaryText).toContain("Initial executor pass succeeded before later rework/governance failure");
    expect(summaryText).toContain("Added focused regression test and captured the expected red signal");
    expect(summaryText).toContain("write_file ok");
    expect(summaryText).toContain("Later tactical rework/governance step failed after an earlier successful executor pass.");

    const persistedState = await readLoopState(paths);
    expect(persistedState.previous_tool_result?.summary).toContain(
      "Initial executor pass succeeded before later rework/governance failure"
    );

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("collectOperationalEvidence records commit, push, restart, health, and rollback details", async () => {
    const commands: string[] = [];
    const evidence = await collectOperationalEvidence(
      {
        round: 5,
        objective: "tighten deploy evidence",
        expectedOutcome: "summary includes deploy evidence",
        consolePort: 3090,
        log: async () => {
          // no-op
        }
      },
      async (command) => {
        commands.push(command);
        if (command === "git add .") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git diff --cached --quiet") {
          return { code: 1, stdout: "", stderr: "" };
        }
        if (command.startsWith("git commit -m ")) {
          return { code: 0, stdout: "[main abc1234] AILoop Round 5: tighten deploy evidence", stderr: "" };
        }
        if (command === "git rev-parse --short HEAD") {
          return { code: 0, stdout: "abc1234\n", stderr: "" };
        }
        if (command === "git log -1 --pretty=%s") {
          return { code: 0, stdout: "AILoop Round 5: tighten deploy evidence\n", stderr: "" };
        }
        if (command === "git push origin HEAD") {
          return { code: 0, stdout: "Everything up-to-date", stderr: "" };
        }
        if (command === "bun run scripts/prod.ts restart") {
          return {
            code: 0,
            stdout: [
              "Restart requested: stopping current server gracefully.",
              "Started in daemon mode.",
              "PID: 4242",
              "Log: .ailoop/prod.server.log"
            ].join("\n"),
            stderr: ""
          };
        }
        throw new Error(`Unexpected command: ${command}`);
      },
      async () => ({
        ok: true,
        status: 200,
        body: '{"ok":true,"service":"ailoop-console"}'
      })
    );

    expect(commands).toEqual([
      "git add .",
      "git diff --cached --quiet",
      expect.stringContaining("git commit -m \"AILoop Round 5: tighten deploy evidence"),
      "git rev-parse --short HEAD",
      "git log -1 --pretty=%s",
      "git push origin HEAD",
      "bun run scripts/prod.ts restart"
    ]);
    expect(evidence.summaryNote).toContain("commit abc1234");
    expect(evidence.summaryNote).toContain("push ok");
    expect(evidence.summaryNote).toContain("restart ok");
    expect(evidence.summaryNote).toContain("health check ok");
    expect(evidence.lines).toContain("Commit: abc1234 AILoop Round 5: tighten deploy evidence");
    expect(evidence.lines).toContain("Push: Everything up-to-date");
    expect(evidence.lines).toContain("Restart: PID 4242, log .ailoop/prod.server.log");
    expect(evidence.lines).toContain("Health Check: GET /api/health -> 200 OK");
    expect(evidence.lines).toContain("Rollback: git revert --no-edit abc1234 && bun run scripts/prod.ts restart");
    expect(evidence.stateChangeNotes).toContain("Shell: git push origin HEAD -> ok (Everything up-to-date)");
  });

  test("collectOperationalEvidence records degraded push, restart, and health results for follow-up failure handling", async () => {
    const evidence = await collectOperationalEvidence(
      {
        round: 6,
        objective: "capture degraded deploy evidence",
        expectedOutcome: "artifacts record operational follow-up failures",
        consolePort: 3090,
        log: async () => {
          // no-op
        }
      },
      async (command) => {
        if (command === "git add .") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git diff --cached --quiet") {
          return { code: 1, stdout: "", stderr: "" };
        }
        if (command.startsWith("git commit -m ")) {
          return { code: 0, stdout: "[main def5678] AILoop Round 6: capture degraded deploy evidence", stderr: "" };
        }
        if (command === "git rev-parse --short HEAD") {
          return { code: 0, stdout: "def5678\n", stderr: "" };
        }
        if (command === "git log -1 --pretty=%s") {
          return { code: 0, stdout: "AILoop Round 6: capture degraded deploy evidence\n", stderr: "" };
        }
        if (command === "git push origin HEAD") {
          return { code: 1, stdout: "", stderr: "remote rejected: protected branch hook declined" };
        }
        if (command === "bun run scripts/prod.ts restart") {
          return { code: 1, stdout: "", stderr: "restart failed: service did not come back up" };
        }
        throw new Error(`Unexpected command: ${command}`);
      },
      async () => ({
        ok: false,
        status: 503,
        body: '{"ok":false,"error":"service unavailable"}'
      })
    );

    expect(evidence.summaryNote).toContain("commit def5678");
    expect(evidence.summaryNote).toContain("push failed");
    expect(evidence.summaryNote).toContain("restart failed");
    expect(evidence.summaryNote).toContain("health check failed");
    expect(evidence.lines).toContain("Commit: def5678 AILoop Round 6: capture degraded deploy evidence");
    expect(evidence.lines).toContain("Push: remote rejected: protected branch hook declined");
    expect(evidence.lines).toContain("Restart: restart failed: service did not come back up");
    expect(evidence.lines).toContain("Health Check: GET /api/health -> 503 FAIL");
    expect(evidence.lines).toContain("Rollback: git revert --no-edit def5678 && bun run scripts/prod.ts restart");
    expect(evidence.stateChangeNotes).toContain(
      "Shell: git push origin HEAD -> failed (remote rejected: protected branch hook declined)"
    );
    expect(evidence.stateChangeNotes).toContain(
      "Shell: bun run scripts/prod.ts restart -> failed (restart failed: service did not come back up)"
    );
    expect(evidence.stateChangeNotes).toContain(
      'Health: GET /api/health -> 503 failed ({"ok":false,"error":"service unavailable"})'
    );
  });
});

describe("LoopEngine time budget guard", () => {
  test("pauses before next action when elapsed round time exceeds limit", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-time-guard-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir,
      AILOOP_BUDGET_TIME_MINUTES: "0.001" // 60ms
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const plan: SubTask = {
      assignee: "executor",
      rationale: "test rationale",
      objective: "Execute bounded task",
      expected_outcome: "executor runs after planning",
      impacted_files: [],
      recommended_tools: ["read_file", "run_shell"]
    };

    let executorCalls = 0;
    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      executor: { execute: () => Promise<{ actions: ActionRecord[]; toolResult: ToolResult }> };
      evaluator: { evaluate: () => Promise<EvaluationResult> };
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };
    mutable.planner = {
      plan: async () => {
        await Bun.sleep(80);
        return plan;
      }
    };
    mutable.executor = {
      execute: async () => {
        executorCalls += 1;
        return {
          actions: [makeAction("run_shell")],
          toolResult: makeToolResult("executor should not run when time budget is exceeded")
        } as any;
      }
    };
    mutable.evaluator = {
      evaluate: async () => makeEvaluation("pass", "unused")
    };

    const outcome = await mutable.runRound(1);

    expect(outcome.success).toBe(false);
    expect(outcome.errorMessage).toContain("BudgetBreach: time budget exceeded");
    expect(executorCalls).toBe(0);

    const state = await readLoopState(paths);
    expect(state.state).toBe("paused");
    expect(state.last_error).toContain("BudgetBreach: time budget exceeded");

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("marks the refreshed requirement artifact complete instead of rewriting the stale pre-refresh artifact", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-refresh-completion-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);
    await writeActiveRequirementArtifact(
      paths,
      [
        "# Requirement Slice: Crash-Recovered Start and Status Visibility",
        "",
        "## Acceptance Criteria",
        "- status output preserves crash recovery evidence.",
        "",
        "## Lifecycle Status",
        "- Status: complete",
        "- Matched Acceptance Criteria: 1",
        "- Remaining Acceptance Criteria: 0"
      ].join("\n")
    );

    const refreshPlan: SubTask = {
      assignee: "executor",
      rationale: "The active requirement slice is complete.",
      objective: "Refresh the active requirement artifact at .ailoop/product-requirements/current.md via the ProductManager before normal execution planning resumes.",
      expected_outcome: "A new human-readable requirement slice replaces the completed one.",
      impacted_files: [".ailoop/product-requirements/current.md"],
      recommended_tools: ["read_file"]
    };
    const refreshedRequirement = [
      "# Requirement Slice: Runtime Agent Session Isolation",
      "",
      "## Acceptance Criteria",
      "- Runtime Agent Session Isolation is the active requirement slice."
    ].join("\n");

    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      productManager: { generateRequirement: () => Promise<string> };
      executor: {
        execute: () => Promise<{
          actions: ActionRecord[];
          toolResult: ToolResult;
        }>;
      };
      evaluator: { evaluate: () => Promise<EvaluationResult> };
      collectOperationalEvidence: () => Promise<{
        summaryNote: string;
        lines: string[];
        stateChangeNotes: string[];
      }>;
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };

    mutable.planner = {
      plan: async () => refreshPlan
    };
    mutable.productManager = {
      generateRequirement: async () => refreshedRequirement
    };
    mutable.executor = {
      execute: async () => ({
        actions: [makeAction("write_file"), makeAction("run_shell")],
        toolResult: makeToolResult(
          "Rewrote .ailoop/product-requirements/current.md into Runtime Agent Session Isolation."
        )
      })
    };
    mutable.evaluator = {
      evaluate: async () => ({
        decision: "pass",
        justification: "Runtime Agent Session Isolation is the active requirement slice.",
        evidence: ["Runtime Agent Session Isolation is the active requirement slice."],
        recommended_next_action: "continue"
      })
    };
    mutable.collectOperationalEvidence = async () => ({
      summaryNote: "",
      lines: [],
      stateChangeNotes: []
    });

    const outcome = await mutable.runRound(1);

    expect(outcome.success).toBe(true);
    const persistedRequirement = await fs.readFile(paths.activeRequirementPath, "utf8");
    expect(persistedRequirement).toContain("# Requirement Slice: Runtime Agent Session Isolation");
    expect(persistedRequirement).toContain("## Lifecycle Status");
    expect(persistedRequirement).toContain("- Status: complete");
    expect(persistedRequirement).not.toContain("# Requirement Slice: Crash-Recovered Start and Status Visibility");

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});

describe("LoopEngine round error handling", () => {
  test("uses the persisted goal in round-error summaries instead of rendering an empty goal", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-round-error-goal-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);
    await fs.writeFile(
      paths.taskPath,
      [
        "# Goal",
        "",
        "Keep rollback failures reviewable for the operator."
      ].join("\n"),
      "utf8"
    );

    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };
    mutable.planner = {
      plan: async () => {
        throw new Error("planner exploded before execution");
      }
    };

    const outcome = await mutable.runRound(1);
    expect(outcome.success).toBe(false);

    const runArtifacts = await fs.readdir(path.join(homeDir, "runs"));
    const summaryFile = runArtifacts.find((entry) => entry.endsWith(".round.summary.md"));
    expect(summaryFile).toBeDefined();

    const summaryText = await fs.readFile(path.join(homeDir, "runs", summaryFile as string), "utf8");
    expect(summaryText).toContain("# Goal");
    expect(summaryText).toContain("Keep rollback failures reviewable for the operator.");
    expect(summaryText).not.toContain("Goal was empty.");

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("preserves seeded evaluator failure count on pre-evaluation execution errors", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-round-error-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);
    const seededState = await readLoopState(paths);
    await writeLoopState(paths, {
      ...seededState,
      consecutive_evaluator_failures: 2
    });

    const mutable = engine as unknown as {
      planner: { plan: () => Promise<SubTask> };
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
    };
    mutable.planner = {
      plan: async () => {
        // Simulate an intermediate state write before the round errors out.
        const midRoundState = await readLoopState(paths);
        await writeLoopState(paths, {
          ...midRoundState,
          consecutive_evaluator_failures: 9
        });
        throw new Error("planner exploded before execution");
      }
    };

    const outcome = await mutable.runRound(1);
    expect(outcome.success).toBe(false);
    expect(outcome.errorMessage).toBe("planner exploded before execution");

    const state = await readLoopState(paths);
    expect(state.consecutive_evaluator_failures).toBe(9);

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("pauses and records rollback failure when automatic rollback cannot complete", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-rollback-failure-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const plan: SubTask = {
      assignee: "executor",
      rationale: "test rationale",
      objective: "Trigger a round error after a snapshot exists",
      expected_outcome: "rollback failure is recorded and the loop pauses",
      impacted_files: ["src/loop/engine.ts"],
      recommended_tools: ["read_file", "write_file"]
    };

    const originalCreateSnapshot = WorkspaceManager.prototype.createSnapshot;
    const originalRollback = WorkspaceManager.prototype.rollback;

    WorkspaceManager.prototype.createSnapshot = async function createSnapshotStub() {
      return {
        type: "stub"
      } as any;
    };
    WorkspaceManager.prototype.rollback = async function rollbackStub() {
      throw new Error("git restore failed");
    };

    try {
      const mutable = engine as unknown as {
        planner: { plan: () => Promise<SubTask> };
        executor: {
          execute: () => Promise<{
            actions: ActionRecord[];
            toolResult: ToolResult;
          }>;
        };
        runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
      };
      mutable.planner = { plan: async () => plan };
      mutable.executor = {
        execute: async () => {
          throw new Error("executor exploded");
        }
      };

      const outcome = await mutable.runRound(1);
      expect(outcome.success).toBe(false);
      expect(outcome.errorMessage).toContain("executor exploded");
      expect(outcome.errorMessage).toContain("Rollback failed after round error: git restore failed");

      const state = await readLoopState(paths);
      expect(state.state).toBe("paused");
      expect(state.last_error).toContain("Rollback failed after round error: git restore failed");

      const runArtifacts = await fs.readdir(path.join(homeDir, "runs"));
      const summaryFile = runArtifacts.find((entry) => entry.endsWith(".round.summary.md"));
      const stateChangeFile = runArtifacts.find((entry) => entry.endsWith(".round.state_change.txt"));
      expect(summaryFile).toBeDefined();
      expect(stateChangeFile).toBeDefined();

      const summaryText = await fs.readFile(path.join(homeDir, "runs", summaryFile as string), "utf8");
      expect(summaryText).toContain("Rollback failed after round error: git restore failed");
      expect(summaryText).toContain("pause");

      const stateChangeText = await fs.readFile(path.join(homeDir, "runs", stateChangeFile as string), "utf8");
      expect(stateChangeText).toContain("Rollback: failed to restore workspace snapshot after round error (git restore failed).");
      expect(stateChangeText).not.toContain("Rollback: workspace snapshot restored after round error.");
    } finally {
      WorkspaceManager.prototype.createSnapshot = originalCreateSnapshot;
      WorkspaceManager.prototype.rollback = originalRollback;
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });
});

describe("LoopEngine crash recovery on startup", () => {
  test("pauses before starting a new round when persisted state shows an interrupted run", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-crash-recovery-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir,
      AILOOP_MAX_CYCLES: "1"
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    const seededState = await readLoopState(paths);
    await writeLoopState(paths, {
      ...seededState,
      round: 4,
      state: "running",
      pid: 999999,
      current_budget: {
        limits: {
          usdPerRound: 0.5,
          timeMinutes: 15,
          actions: 30
        },
        usage: {
          usdUsed: 0.2,
          actionsUsed: 7,
          elapsedMs: 12_000
        }
      }
    });

    let runRoundCalls = 0;
    let releaseLeader = () => {};
    const leaderGate = new Promise<void>((resolve) => {
      releaseLeader = resolve;
    });
    const mutable = engine as unknown as {
      leader: {
        execute: () => Promise<LeaderDecision>;
      };
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
      run: () => Promise<void>;
    };
    mutable.leader = {
      execute: async () => {
        await leaderGate;
        await setFlag(paths.stopFlagPath);
        return {
          rationale: "Crash recovery requires human review before new work starts.",
          action: "stop",
          diagnosis_type: "implementation_failure",
          instructions: []
        };
      }
    };
    mutable.runRound = async () => {
      runRoundCalls += 1;
      return { success: true };
    };

    let runPromise: Promise<void> | null = null;
    try {
      runPromise = mutable.run();
      const pausedState = await waitForPausedState(paths);

      expect(runRoundCalls).toBe(0);
      expect(pausedState.state).toBe("paused");
      expect(pausedState.round).toBe(4);
      expect(pausedState.current_budget).toEqual({
        limits: {
          usdPerRound: 0.5,
          timeMinutes: 15,
          actions: 30
        },
        usage: {
          usdUsed: 0.2,
          actionsUsed: 7,
          elapsedMs: 12_000
        }
      });
      expect(pausedState.last_error || "").toContain("Interrupted");
      expect(pausedState.last_error || "").toContain("startup");
      releaseLeader();
    } finally {
      releaseLeader();
      await fs.writeFile(paths.stopFlagPath, "1\n", "utf8");
      if (runPromise) {
        await Promise.race([
          runPromise,
          Bun.sleep(6_000).then(() => {
            throw new Error("Timed out stopping loop engine.");
          })
        ]);
      }
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  test("stops immediately when stop flag is set during Leader execution", async () => {
    const originalCwd = process.cwd();
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-stop-during-leader-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    const paths = {
      homeDir,
      taskPath: path.join(homeDir, "goal.md"),
      plannerRolePath: path.join(homeDir, "PLANNER_ROLE.md"),
      productManagerRolePath: path.join(homeDir, "PRODUCT_MANAGER_ROLE.md"),
      executorRolePath: path.join(homeDir, "EXECUTOR_ROLE.md"),
      evaluatorRolePath: path.join(homeDir, "EVALUATOR_ROLE.md"),
      designerRolePath: path.join(homeDir, "DESIGNER_ROLE.md"),
      leaderRolePath: path.join(homeDir, "LEADER_ROLE.md"),
      runsDir: path.join(homeDir, "runs"),
      loopLogPath: path.join(homeDir, "loop.run.log"),
      lockPath: path.join(homeDir, "loop.lock"),
      pidPath: path.join(homeDir, "loop.pid"),
      stopFlagPath: path.join(homeDir, "loop.stop"),
      pauseFlagPath: path.join(homeDir, "loop.pause"),
      instructionsPath: path.join(homeDir, "instructions.queue.json"),
      legacyInstructionsPath: path.join(homeDir, "instructions.json"),
      statePath: path.join(homeDir, "state.json"),
      legacyStatePath: path.join(homeDir, "loop.state"),
      dbPath: path.join(homeDir, "ailoop.db"),
      productRequirementsDirPath: path.join(homeDir, "product-requirements"),
      activeRequirementPath: path.join(homeDir, "product-requirements", "current.md")
    };

    try {
      process.chdir(workspaceRoot);
      await ensureLoopHome(paths);
      await fs.writeFile(paths.taskPath, "Test goal", "utf8");
      await fs.writeFile(path.join(workspaceRoot, "README.md"), "Test README", "utf8");
      await writeActiveRequirementArtifact(paths, "# Test requirement\n\nTest markdown content");

      const initialState = {
        state: "paused" as const,
        round: 5,
        updated_at: new Date().toISOString(),
        pid: process.pid,
        goal_reference: {
          title: "Test Goal",
          summary: "Test summary"
        },
        pause_reason: "Test pause",
        last_error: "Test error",
        consecutive_evaluator_failures: 1,
        previous_tool_result: makeToolResult("Test result"),
        current_budget: null,
        previous_evaluation_dimensions: null,
        previous_hot_file_governance: null
      };

      await writeLoopState(paths, initialState);
      await setFlag(paths.pauseFlagPath);
      await fs.writeFile(paths.instructionsPath, "[]", "utf8");

      const config = await loadConfig();
      const mutable = new LoopEngine({
        ...config,
        homeDir,
        intervalSeconds: 1
      });

      let leaderStarted = false;
      let leaderCompleted = false;

      mutable.leader = {
        execute: async () => {
          leaderStarted = true;
          await Bun.sleep(5000);
          leaderCompleted = true;
          return {
            rationale: "Test rationale",
            action: "resume",
            diagnosis_type: "implementation_failure",
            instructions: ["Test instruction"]
          };
        }
      };

      const runPromise = mutable.run();

      while (!leaderStarted) {
        await Bun.sleep(50);
      }

      await setFlag(paths.stopFlagPath);

      await Promise.race([
        runPromise,
        Bun.sleep(3000).then(() => {
          throw new Error("Loop did not stop within 3 seconds after stop flag was set");
        })
      ]);

      expect(leaderCompleted).toBe(false);

      const finalState = await readLoopState(paths);
      expect(finalState.state).toBe("idle");
    } finally {
      process.chdir(originalCwd);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("LoopEngine structural-maintenance pass", () => {
  test("triggers structural-maintenance round when evaluator recommends split", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-structural-maintenance-test-"));
    const config = loadConfig({
      AILOOP_HOME: homeDir,
      AILOOP_MAX_CYCLES: "2"
    });
    const engine = new LoopEngine(config);
    const paths = (engine as unknown as { paths: LoopPaths }).paths;
    await ensureLoopHome(paths);

    // Seed state with hot-file governance recommendation
    const seeded = await readLoopState(paths);
    await writeLoopState(paths, {
      ...seeded,
      state: "running",
      round: 5,
      previous_hot_file_governance: {
        file_path: "src/loop/engine.ts",
        heuristic_labels: ["large_file", "high_churn"],
        result_class: "hot_file_growth_failure",
        reason: "File exceeds 1000 lines and has high recent churn",
        recommended_next_action: "pause and split the next change into a bounded structural-maintenance pass"
      },
      last_error: "EvaluatorStrategicBlock: Hot-file governance failure"
    });
    await setFlag(paths.pauseFlagPath);

    let runRoundCalls = 0;

    const mutable = engine as unknown as {
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
      run: () => Promise<void>;
    };

    const originalRunRound = mutable.runRound.bind(engine);
    mutable.runRound = async (round: number) => {
      runRoundCalls += 1;

      // Stop after structural-maintenance round
      if (runRoundCalls === 1) {
        await setFlag(paths.stopFlagPath);
      }

      return { success: true };
    };

    await mutable.run();

    // Verify structural-maintenance round was triggered
    expect(runRoundCalls).toBe(1);

    // Verify hot-file governance was cleared (null or undefined)
    const finalState = await readLoopState(paths);
    expect(finalState.previous_hot_file_governance ?? null).toBeNull();
    expect(finalState.last_error ?? null).toBeNull();

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});
