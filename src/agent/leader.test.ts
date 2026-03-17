import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../config/env";
import type { LeaderContext } from "../types/contracts";
import { LeaderAgent } from "./leader";

const sampleLeaderContext: LeaderContext = {
  goal: "Keep the runtime loop aligned with documented isolation guarantees.",
  lastError: "Evaluator reported missing runtime isolation coverage.",
  previousEvaluationJustification: "Leader path does not enforce the internal runtime session contract.",
  previousEvaluationDimensions: [
    {
      dimension: "constraint_compliance",
      decision: "fail",
      score: 42,
      confidence: 0.93,
      justification: "Leader still inherits repository-local assistant workflows.",
      evidence: ["src/agent/leader.ts does not pass sessionIsolation."],
      blocking_issues: ["Missing runtime isolation guard."],
      recommended_next_action: "Patch LeaderAgent and add focused coverage."
    }
  ],
  previousHotFileGovernance: {
    file_path: "src/agent/leader.ts",
    heuristic_labels: ["recent-touch hot-file pressure", "line-count pressure"],
    result_class: "hot_file_growth_failure",
    reason: "continued growth in pressured file without bounded justification",
    recommended_next_action: "Split the next change into a narrower structural-maintenance pass."
  },
  stateChange: null
};

function makeConfig(homeDir: string): AppConfig {
  return {
    homeDir,
    intervalSeconds: 1,
    maxCycles: 1,
    exitOnError: false,
    enableLeader: true,
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

describe("LeaderAgent", () => {
  test("runs Codex strategy generation in an isolated runtime session", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-leader-agent-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, "LEADER_ROLE.md"), "# Leader Role\n\nCustom leader guidance.\n", "utf8");

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
            rationale: "Leader can resume once the isolation gap is closed.",
            action: "resume",
            diagnosis_type: "implementation_failure",
            instructions: ["Patch the Leader runtime isolation path."],
            proposed_readme_change: ""
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
      const agent = new LeaderAgent(makeConfig(homeDir));
      (agent as { codex: typeof mockCodex }).codex = mockCodex;

      const result = await agent.execute({
        context: sampleLeaderContext,
        paths: { homeDir },
        onLog: async () => {}
      });

      expect(result.action).toBe("resume");
      expect(capturedPrompt).toContain("Custom leader guidance.");
      expect(capturedPrompt).toContain(sampleLeaderContext.goal);
      expect(capturedPrompt).toContain(sampleLeaderContext.lastError ?? "");
      expect(capturedPrompt).toContain("Pause Diagnostic: Hot-file governance block in src/agent/leader.ts");
      expect(capturedPrompt).toContain("Hot-File Governance Signal");
      expect(capturedPrompt).toContain("recent-touch hot-file pressure, line-count pressure");
      expect(capturedPrompt).toContain("Split the next change into a narrower structural-maintenance pass.");
      expect(capturedIsolationEnabled).toBe(true);
      expect(capturedIsolationGuide).toContain("Internal Runtime Agent Session");
      expect(capturedIsolationGuide).toContain("You are the internal Leader agent inside the AILoop product.");
      expect(capturedIsolationGuide).toContain("Repository-local AGENTS.md instructions and external skill catalogs");
      expect(capturedIsolationGuide).toContain(
        "Keep reasoning anchored to the supplied failure, evaluation, and governance context unless the runtime prompt explicitly broadens scope."
      );
      expect(capturedCwd).toBe(realWorkspaceRoot);
    } finally {
      process.chdir(originalCwd);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("surfaces redacted Codex stderr and raw output when strategy generation fails", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-leader-agent-error-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, "LEADER_ROLE.md"), "# Leader Role\n\nCustom leader guidance.\n", "utf8");

    const logs: string[] = [];
    const mockCodex = {
      async runJson() {
        return {
          ok: false,
          data: undefined,
          rawMessage: '{"detail":"returned non-json strategy blob"}',
          stdout: "",
          stderr: "upstream apiToken=supersecret123 returned 502 Bad Gateway",
          error: "Codex exited with code 1"
        };
      }
    };

    const originalCwd = process.cwd();
    process.chdir(workspaceRoot);

    try {
      const agent = new LeaderAgent(makeConfig(homeDir));
      (agent as { codex: typeof mockCodex }).codex = mockCodex;

      await expect(
        agent.execute({
          context: sampleLeaderContext,
          paths: { homeDir },
          onLog: async (message) => {
            logs.push(message);
          }
        })
      ).rejects.toThrow(
        "Codex exited with code 1 | stderr: upstream apiToken=[REDACTED] returned 502 Bad Gateway | raw: {\"detail\":\"returned non-json strategy blob\"}"
      );

      expect(logs).toContain("Leader analyzing failures and formulating strategy...");
      expect(
        logs.some((message) =>
          message.includes(
            "Leader Error: Codex exited with code 1 | stderr: upstream apiToken=[REDACTED] returned 502 Bad Gateway | raw: {\"detail\":\"returned non-json strategy blob\"}"
          )
        )
      ).toBe(true);
    } finally {
      process.chdir(originalCwd);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
