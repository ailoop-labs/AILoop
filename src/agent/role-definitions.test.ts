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
    await fs.writeFile(path.join(homeDir, "DESIGNER_ROLE.md"), "# Designer Role\n\nEXISTING", "utf8");
    await fs.writeFile(path.join(homeDir, "SENIOR_DEV_ROLE.md"), "# Senior Dev Role\n\nEXISTING", "utf8");
    await fs.writeFile(path.join(homeDir, "QA_LEAD_ROLE.md"), "# QA Lead Role\n\nEXISTING", "utf8");
    await fs.writeFile(path.join(homeDir, "PRODUCT_OWNER_ROLE.md"), "# Product Owner Role\n\nEXISTING", "utf8");

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

    expect(await fs.readFile(path.join(homeDir, "PLANNER_ROLE.md"), "utf8")).toContain("Product Manager (Planner) Role");
    expect(await fs.readFile(path.join(homeDir, "DESIGNER_ROLE.md"), "utf8")).toContain("UI/UX Designer Role");
    expect(await fs.readFile(path.join(homeDir, "EXECUTOR_ROLE.md"), "utf8")).toContain("Project Executor Role");
    expect(await fs.readFile(path.join(homeDir, "EVALUATOR_ROLE.md"), "utf8")).toContain("Project Evaluator Role");

    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("regenerates roles when source hash changes with autoRefresh", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-role-defs-autorefresh-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.mkdir(homeDir, { recursive: true });

    // Write initial README, role files, and an old source hash
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "# Old README\n", "utf8");
    await fs.writeFile(path.join(homeDir, "PLANNER_ROLE.md"), "# Planner\n\nOLD", "utf8");
    await fs.writeFile(path.join(homeDir, "EXECUTOR_ROLE.md"), "# Executor\n\nOLD", "utf8");
    await fs.writeFile(path.join(homeDir, "EVALUATOR_ROLE.md"), "# Evaluator\n\nOLD", "utf8");
    await fs.writeFile(path.join(homeDir, "LEADER_ROLE.md"), "# Leader\n\nOLD", "utf8");
    await fs.writeFile(path.join(homeDir, "DESIGNER_ROLE.md"), "# Designer\n\nOLD", "utf8");
    await fs.writeFile(path.join(homeDir, "SENIOR_DEV_ROLE.md"), "# Senior Dev\n\nOLD", "utf8");
    await fs.writeFile(path.join(homeDir, "QA_LEAD_ROLE.md"), "# QA Lead\n\nOLD", "utf8");
    await fs.writeFile(path.join(homeDir, "PRODUCT_OWNER_ROLE.md"), "# Product Owner\n\nOLD", "utf8");
    await fs.writeFile(path.join(homeDir, ".roles_source_hash"), "stale_hash_value\n", "utf8");

    // Now change README to trigger hash mismatch
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "# Updated README\n\nNew content.\n", "utf8");

    let calls = 0;
    const mockCodex = {
      async runJson<T>() {
        calls += 1;
        return {
          ok: true,
          data: {
            planner_role_md: "# Planner\n\nREFRESHED",
            executor_role_md: "# Executor\n\nREFRESHED",
            evaluator_role_md: "# Evaluator\n\nREFRESHED",
            leader_role_md: "# Leader\n\nREFRESHED",
            designer_role_md: "# Designer\n\nREFRESHED",
            senior_dev_role_md: "# Senior Dev\n\nREFRESHED",
            qa_lead_role_md: "# QA Lead\n\nREFRESHED",
            product_owner_role_md: "# Product Owner\n\nREFRESHED"
          } as T,
          rawMessage: "{}",
          stdout: "",
          stderr: ""
        };
      }
    };

    const result = await ensureProjectRoleDefinitions(makeConfig(homeDir), {
      workspaceRoot,
      autoRefresh: true,
      codexClient: mockCodex as never
    });

    expect(calls).toBe(1);
    expect(result.generated.length).toBe(8);
    expect(result.source).toBe("ai");
    expect(await fs.readFile(path.join(homeDir, "PLANNER_ROLE.md"), "utf8")).toContain("REFRESHED");
    expect(await fs.readFile(path.join(homeDir, "LEADER_ROLE.md"), "utf8")).toContain("REFRESHED");

    // Hash file should now be updated
    const storedHash = (await fs.readFile(path.join(homeDir, ".roles_source_hash"), "utf8")).trim();
    expect(storedHash).not.toBe("stale_hash_value");
    expect(storedHash.length).toBe(64); // SHA-256 hex length

    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("skips regeneration when source hash matches with autoRefresh", async () => {
    const { computeSourceHash } = await import("./role-definitions");

    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-role-defs-autorefresh-skip-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.mkdir(homeDir, { recursive: true });

    const readmeContent = "# Stable README\n";
    const goalContent = "";
    await fs.writeFile(path.join(workspaceRoot, "README.md"), readmeContent, "utf8");

    // Write role files and a matching hash
    const matchingHash = computeSourceHash(readmeContent, goalContent);
    await fs.writeFile(path.join(homeDir, "PLANNER_ROLE.md"), "# Planner\n\nEXISTING", "utf8");
    await fs.writeFile(path.join(homeDir, "EXECUTOR_ROLE.md"), "# Executor\n\nEXISTING", "utf8");
    await fs.writeFile(path.join(homeDir, "EVALUATOR_ROLE.md"), "# Evaluator\n\nEXISTING", "utf8");
    await fs.writeFile(path.join(homeDir, "LEADER_ROLE.md"), "# Leader\n\nEXISTING", "utf8");
    await fs.writeFile(path.join(homeDir, "DESIGNER_ROLE.md"), "# Designer\n\nEXISTING", "utf8");
    await fs.writeFile(path.join(homeDir, "SENIOR_DEV_ROLE.md"), "# Senior Dev\n\nEXISTING", "utf8");
    await fs.writeFile(path.join(homeDir, "QA_LEAD_ROLE.md"), "# QA Lead\n\nEXISTING", "utf8");
    await fs.writeFile(path.join(homeDir, "PRODUCT_OWNER_ROLE.md"), "# Product Owner\n\nEXISTING", "utf8");
    await fs.writeFile(path.join(homeDir, ".roles_source_hash"), `${matchingHash}\n`, "utf8");

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

    const result = await ensureProjectRoleDefinitions(makeConfig(homeDir), {
      workspaceRoot,
      autoRefresh: true,
      codexClient: mockCodex as never
    });

    // Codex should NOT be called since hash matches
    expect(calls).toBe(0);
    expect(result.source).toBe("none");
    expect(result.skipped.length).toBe(8);
    expect(result.generated.length).toBe(0);

    // Roles should remain unchanged
    expect(await fs.readFile(path.join(homeDir, "PLANNER_ROLE.md"), "utf8")).toContain("EXISTING");

    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });
});

