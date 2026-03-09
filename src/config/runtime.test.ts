import { describe, expect, test } from "bun:test";
import { extractRuntimeLoopConfig, runtimeLoopConfigToEnv } from "./runtime";
import type { AppConfig } from "./env";

function makeConfig(): AppConfig {
  return {
    homeDir: "/tmp/ailoop-runtime-test",
    intervalSeconds: 1200,
    maxCycles: 0,
    exitOnError: false,
    enableLeader: false,
    evaluatorReworkMaxAttempts: 1,
    consoleHost: "127.0.0.1",
    consolePort: 3090,
    consoleAdminToken: "",
    maxRetainRuns: 50,
    budget: {
      usdPerRound: 0.5,
      timeMinutes: 60,
      actions: 30
    },
    evaluatorType: "llm",
    evaluatorCmd: "",
    webhookEvaluatorUrl: "",
    codex: {
      bin: "/Users/test/.bun/bin/codex",
      model: "",
      profile: "",
      plannerSandbox: "read-only",
      executorSandbox: "danger-full-access",
      evaluatorSandbox: "danger-full-access",
      timeoutMs: 180000,
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

describe("runtime codex bin persistence", () => {
  test("extractRuntimeLoopConfig keeps codex.bin", () => {
    const runtime = extractRuntimeLoopConfig(makeConfig());
    expect(runtime.codex.bin).toBe("/Users/test/.bun/bin/codex");
  });

  test("runtimeLoopConfigToEnv exports AILOOP_CODEX_BIN", () => {
    const env = runtimeLoopConfigToEnv(extractRuntimeLoopConfig(makeConfig()));
    expect(env.AILOOP_CODEX_BIN).toBe("/Users/test/.bun/bin/codex");
  });
});
