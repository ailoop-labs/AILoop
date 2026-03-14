import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../config/env";
import type { ProductManagerContext } from "../types/contracts";
import { buildProductManagerPrompt, ProductManagerAgent } from "./product-manager";

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

function createContext(overrides: Partial<ProductManagerContext> = {}): ProductManagerContext {
  return {
    goal: "Make the web console status easier for operators to understand.",
    instructions: ["Keep the requirement slice human-readable."],
    round: 4,
    current_requirement_markdown: null,
    previous_round_error: null,
    previous_tool_result: null,
    ...overrides
  };
}

describe("buildProductManagerPrompt", () => {
  test("injects the project-specific product manager role definition", () => {
    const prompt = buildProductManagerPrompt(
      createContext(),
      "# Product Manager Role\n\nProject-specific PM guidance."
    );

    expect(prompt).toContain("Project-specific Product Manager Role Definition");
    expect(prompt).toContain("Project-specific PM guidance.");
  });

  test("forbids execution-task output and requires markdown requirement content", () => {
    const prompt = buildProductManagerPrompt(
      createContext({
        current_requirement_markdown: "# Requirement Slice: Existing\n"
      }),
      "# Product Manager Role\n\nProject-specific PM guidance."
    );

    expect(prompt).toContain("Do not emit round-level execution tasks");
    expect(prompt).toContain("Return Markdown requirement content");
    expect(prompt).toContain("# Requirement Slice: Existing");
  });
});

describe("ProductManagerAgent", () => {
  test("loads the project product manager role and normalizes successful markdown output", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-product-manager-agent-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(
      path.join(homeDir, "PRODUCT_MANAGER_ROLE.md"),
      "# Product Manager Role\n\nCustom product manager guidance.",
      "utf8"
    );

    let capturedPrompt = "";
    const mockCodex = {
      async runJson<T>(options?: { prompt?: string }) {
        capturedPrompt = options?.prompt ?? "";
        return {
          ok: true,
          data: {
            requirement_markdown: "# Requirement Slice: Console Health\n\n## Problem\nOperators need a clear health view."
          } as T,
          rawMessage: "{}",
          stdout: "",
          stderr: ""
        };
      }
    };

    const agent = new ProductManagerAgent(makeConfig(homeDir), mockCodex as never);
    const markdown = await agent.generateRequirement(createContext());

    expect(capturedPrompt).toContain("Custom product manager guidance.");
    expect(markdown).toBe("# Requirement Slice: Console Health\n\n## Problem\nOperators need a clear health view.\n");

    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("falls back to a usable markdown requirement skeleton when codex fails", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-product-manager-fallback-"));
    const homeDir = path.join(workspaceRoot, ".ailoop");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, "PRODUCT_MANAGER_ROLE.md"), "# Product Manager Role\n", "utf8");

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

    const agent = new ProductManagerAgent(makeConfig(homeDir), mockCodex as never);
    const markdown = await agent.generateRequirement(
      createContext({
        goal: "Clarify the next requirement slice for operator-visible console health."
      })
    );

    expect(markdown).toContain("# Requirement Slice:");
    expect(markdown).toContain("## Problem");
    expect(markdown).toContain("## Acceptance Criteria");
    expect(markdown).toContain("Clarify the next requirement slice for operator-visible console health.");

    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });
});
