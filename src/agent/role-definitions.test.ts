import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../config/env";
import { ensureProjectRoleDefinitions } from "./role-definitions";

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
    evaluatorType: "llm",
    evaluatorCmd: "",
    webhookEvaluatorUrl: "",
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

describe("ensureProjectRoleDefinitions", () => {
  test("creates missing role files from AI output", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-role-defs-create-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "# Project README\n\nBuild CLI tooling.\n", "utf8");

    let calls = 0;
    const mockCodex = {
      async runJson<T>() {
        calls += 1;
        return {
          ok: true,
          data: {
            planner_role_md: "# Planner Role\n\nAI planner role",
            executor_role_md: "# Executor Role\n\nAI executor role",
            evaluator_role_md: "# Evaluator Role\n\nAI evaluator role",
            leader_role_md: "# Leader Role\n\nAI leader role"
          } as T,
          rawMessage: "{}",
          stdout: "",
          stderr: ""
        };
      }
    };

    await ensureProjectRoleDefinitions(makeConfig(homeDir), {
      workspaceRoot,
      regen: false,
      codexClient: mockCodex as never
    });

    expect(calls).toBe(1);
    expect(await fs.readFile(path.join(homeDir, "PLANNER_ROLE.md"), "utf8")).toContain("AI planner role");
    expect(await fs.readFile(path.join(homeDir, "EXECUTOR_ROLE.md"), "utf8")).toContain("AI executor role");
    expect(await fs.readFile(path.join(homeDir, "EVALUATOR_ROLE.md"), "utf8")).toContain("AI evaluator role");

    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("does not overwrite existing role files when regen=false", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-role-defs-no-overwrite-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, "PLANNER_ROLE.md"), "# Planner Role\n\nEXISTING", "utf8");
    await fs.writeFile(path.join(homeDir, "EXECUTOR_ROLE.md"), "# Executor Role\n\nEXISTING", "utf8");
    await fs.writeFile(path.join(homeDir, "EVALUATOR_ROLE.md"), "# Evaluator Role\n\nEXISTING", "utf8");
    await fs.writeFile(path.join(homeDir, "LEADER_ROLE.md"), "# Leader Role\n\nEXISTING", "utf8");

    let calls = 0;
    const mockCodex = {
      async runJson<T>() {
        calls += 1;
        return {
          ok: true,
          data: {} as T,
          rawMessage: "{}",
          stdout: "",
          stderr: ""
        };
      }
    };

    await ensureProjectRoleDefinitions(makeConfig(homeDir), {
      workspaceRoot,
      regen: false,
      codexClient: mockCodex as never
    });

    expect(calls).toBe(0);
    expect(await fs.readFile(path.join(homeDir, "PLANNER_ROLE.md"), "utf8")).toContain("EXISTING");

    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("overwrites role files when regen=true", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-role-defs-regen-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, "PLANNER_ROLE.md"), "# Planner Role\n\nOLD", "utf8");
    await fs.writeFile(path.join(homeDir, "EXECUTOR_ROLE.md"), "# Executor Role\n\nOLD", "utf8");
    await fs.writeFile(path.join(homeDir, "EVALUATOR_ROLE.md"), "# Evaluator Role\n\nOLD", "utf8");
    await fs.writeFile(path.join(homeDir, "LEADER_ROLE.md"), "# Leader Role\n\nOLD", "utf8");

    const mockCodex = {
      async runJson<T>() {
        return {
          ok: true,
          data: {
            planner_role_md: "# Planner Role\n\nNEW",
            executor_role_md: "# Executor Role\n\nNEW",
            evaluator_role_md: "# Evaluator Role\n\nNEW",
            leader_role_md: "# Leader Role\n\nNEW"
          } as T,
          rawMessage: "{}",
          stdout: "",
          stderr: ""
        };
      }
    };

    await ensureProjectRoleDefinitions(makeConfig(homeDir), {
      workspaceRoot,
      regen: true,
      codexClient: mockCodex as never
    });

    expect(await fs.readFile(path.join(homeDir, "PLANNER_ROLE.md"), "utf8")).toContain("NEW");
    expect(await fs.readFile(path.join(homeDir, "EXECUTOR_ROLE.md"), "utf8")).toContain("NEW");
    expect(await fs.readFile(path.join(homeDir, "EVALUATOR_ROLE.md"), "utf8")).toContain("NEW");

    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("falls back to deterministic templates when AI generation fails", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-role-defs-fallback-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");

    const mockCodex = {
      async runJson<T>() {
        return {
          ok: false,
          data: undefined as T | undefined,
          rawMessage: "",
          stdout: "",
          stderr: "mock failure",
          error: "mock failure"
        };
      }
    };

    await ensureProjectRoleDefinitions(makeConfig(homeDir), {
      workspaceRoot,
      regen: true,
      codexClient: mockCodex as never
    });

    expect(await fs.readFile(path.join(homeDir, "PLANNER_ROLE.md"), "utf8")).toContain("Project Planner Role");
    expect(await fs.readFile(path.join(homeDir, "EXECUTOR_ROLE.md"), "utf8")).toContain("Project Executor Role");
    expect(await fs.readFile(path.join(homeDir, "EVALUATOR_ROLE.md"), "utf8")).toContain("Project Evaluator Role");

    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });
});
