import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../config/env";
import type { ActionRecord, EvaluationResult, ProductManagerContext, SubTask, ToolResult } from "../types/contracts";
import { ensureLoopHome, readLoopState, type LoopPaths, writeLoopState } from "./state";
import { writeActiveRequirementArtifact } from "../product/requirements";
import {
  LoopEngine,
  buildEvaluatorReworkInstructions,
  collectOperationalEvidence,
  extractSnapshotTargetsFromSubTask,
  resolveNextLastError
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

describe("LoopEngine auto rework", () => {
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
        "Rollback: git revert --no-edit abc1234 && bash scripts/prod.sh restart"
      ],
      stateChangeNotes: [
        "Shell: git commit -m ... -> ok",
        "Shell: git push origin HEAD -> ok (Everything up-to-date)",
        "Shell: bash scripts/prod.sh restart -> ok (PID 4242, log .ailoop/prod.server.log)",
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
    expect(summaryText).toContain("- Rollback: git revert --no-edit abc1234 && bash scripts/prod.sh restart");

    const stateChangeText = await fs.readFile(path.join(homeDir, "runs", stateChangeFile as string), "utf8");
    expect(stateChangeText).toContain("### Operational Follow-up");
    expect(stateChangeText).toContain("Shell: git commit -m ... -> ok");
    expect(stateChangeText).toContain("Shell: git push origin HEAD -> ok (Everything up-to-date)");
    expect(stateChangeText).toContain("Shell: bash scripts/prod.sh restart -> ok (PID 4242, log .ailoop/prod.server.log)");
    expect(stateChangeText).toContain("Health: GET /api/health -> 200 ok ({\"ok\":true})");

    const persistedState = await readLoopState(paths);
    expect(persistedState.previous_tool_result?.operational_evidence).toEqual([
      "Commit: abc1234 AILoop Round 1: Persist operational follow-up evidence",
      "Push: Everything up-to-date",
      "Restart: PID 4242, log .ailoop/prod.server.log",
      "Health Check: GET /api/health -> 200 OK",
      "Rollback: git revert --no-edit abc1234 && bash scripts/prod.sh restart"
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
        "Rollback: git revert --no-edit abc1234 && bash scripts/prod.sh restart"
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
        if (command === "bash scripts/prod.sh restart") {
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
      "bash scripts/prod.sh restart"
    ]);
    expect(evidence.summaryNote).toContain("commit abc1234");
    expect(evidence.summaryNote).toContain("push ok");
    expect(evidence.summaryNote).toContain("restart ok");
    expect(evidence.summaryNote).toContain("health check ok");
    expect(evidence.lines).toContain("Commit: abc1234 AILoop Round 5: tighten deploy evidence");
    expect(evidence.lines).toContain("Push: Everything up-to-date");
    expect(evidence.lines).toContain("Restart: PID 4242, log .ailoop/prod.server.log");
    expect(evidence.lines).toContain("Health Check: GET /api/health -> 200 OK");
    expect(evidence.lines).toContain("Rollback: git revert --no-edit abc1234 && bash scripts/prod.sh restart");
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
        if (command === "bash scripts/prod.sh restart") {
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
    expect(evidence.lines).toContain("Rollback: git revert --no-edit def5678 && bash scripts/prod.sh restart");
    expect(evidence.stateChangeNotes).toContain(
      "Shell: git push origin HEAD -> failed (remote rejected: protected branch hook declined)"
    );
    expect(evidence.stateChangeNotes).toContain(
      "Shell: bash scripts/prod.sh restart -> failed (restart failed: service did not come back up)"
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
});

describe("LoopEngine round error handling", () => {
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
    const mutable = engine as unknown as {
      runRound: (round: number) => Promise<{ success: boolean; errorMessage?: string }>;
      run: () => Promise<void>;
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
    } finally {
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
});
