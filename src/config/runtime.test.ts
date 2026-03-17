import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  extractRuntimeLoopConfig,
  patchRuntimeLoopConfig,
  readRuntimeLoopConfig,
  resetRuntimeLoopConfig,
  runtimeLoopConfigToEnv
} from "./runtime";
import type { AppConfig } from "./env";

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function makeConfig(): AppConfig {
  return {
    homeDir: "/tmp/ailoop-runtime-test",
    intervalSeconds: 1200,
    maxCycles: 0,
    exitOnError: false,
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

  test("patchRuntimeLoopConfig persists partial overrides without dropping defaults", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-runtime-config-"));
    tempDirs.add(homeDir);

    const runtime = await patchRuntimeLoopConfig(
      {
        ...makeConfig(),
        homeDir
      },
      {
        intervalSeconds: 75,
        budget: {
          actions: 44
        },
        codex: {
          profile: "runtime-test"
        }
      }
    );

    expect(runtime).toMatchObject({
      intervalSeconds: 75,
      budget: {
        usdPerRound: 0.5,
        timeMinutes: 60,
        actions: 44
      },
      codex: {
        bin: "/Users/test/.bun/bin/codex",
        profile: "runtime-test"
      }
    });
    expect(
      await readRuntimeLoopConfig({
        ...makeConfig(),
        homeDir
      })
    ).toEqual(runtime);
  });

  test("resetRuntimeLoopConfig removes persisted overrides and returns base defaults", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-runtime-config-"));
    tempDirs.add(homeDir);

    const config = {
      ...makeConfig(),
      homeDir
    };

    await patchRuntimeLoopConfig(config, {
      intervalSeconds: 75,
      exitOnError: true,
      codex: {
        profile: "reset-me"
      }
    });

    const reset = await resetRuntimeLoopConfig(config);

    expect(reset).toEqual(extractRuntimeLoopConfig(config));
    expect(await readRuntimeLoopConfig(config)).toEqual(extractRuntimeLoopConfig(config));
  });
});
