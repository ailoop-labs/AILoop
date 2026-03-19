import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseManager } from "../utils/db";
import {
  extractRuntimeLoopConfig,
  saveRuntimeLoopConfig,
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
      timeoutMs: 1_800_000,
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
    expect(env.AILOOP_AI_CLI_BIN).toBe("/Users/test/.bun/bin/codex");
    expect(env.AILOOP_CODEX_BIN).toBe("/Users/test/.bun/bin/codex");
  });

  test("runtimeLoopConfigToEnv omits legacy AILOOP_CODEX_* aliases for non-codex providers", () => {
    const env = runtimeLoopConfigToEnv({
      ...extractRuntimeLoopConfig(makeConfig()),
      codex: {
        ...extractRuntimeLoopConfig(makeConfig()).codex,
        bin: "/opt/homebrew/bin/claude",
        model: "claude-opus-4-6"
      }
    });

    expect(env.AILOOP_AI_CLI_BIN).toBe("/opt/homebrew/bin/claude");
    expect(env.AILOOP_CODEX_BIN).toBeUndefined();
    expect(env.AILOOP_CODEX_MODEL).toBeUndefined();
  });

  test("readRuntimeLoopConfig hydrates AI CLI overrides from the database", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-runtime-config-db-"));
    tempDirs.add(homeDir);

    const config = {
      ...makeConfig(),
      homeDir
    };
    const db = new DatabaseManager({ dbPath: path.join(homeDir, "ailoop.db") });

    try {
      await db.setConfig("AILOOP_INTERVAL_SECONDS", "75");
      await db.setConfig("AILOOP_BUDGET_ACTIONS", "44");
      await db.setConfig("AILOOP_AI_CLI_BIN", "/opt/homebrew/bin/claude");
      await db.setConfig("AILOOP_AI_CLI_MODEL", "claude-opus-4-6");
      await db.setConfig("AILOOP_AI_CLI_TIMEOUT_MS", "600000");

      await expect(readRuntimeLoopConfig(config)).resolves.toMatchObject({
        intervalSeconds: 75,
        budget: {
          usdPerRound: 0.5,
          timeMinutes: 60,
          actions: 44
        },
        codex: {
          bin: "/opt/homebrew/bin/claude",
          model: "claude-opus-4-6"
        }
      });
    } finally {
      db.close();
    }
  });

  test("readRuntimeLoopConfig migrates legacy runtime-config.json loop settings into the database", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-runtime-config-migrate-"));
    tempDirs.add(homeDir);

    const config = {
      ...makeConfig(),
      homeDir
    };

    await fs.writeFile(
      path.join(homeDir, "runtime-config.json"),
      JSON.stringify(
        {
          intervalSeconds: 60,
          maxCycles: 15,
          exitOnError: false,
          evaluatorReworkMaxAttempts: 3,
          budget: {
            usdPerRound: 0.1,
            timeMinutes: 10,
            actions: 10
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const runtime = await readRuntimeLoopConfig(config);

    expect(runtime).toMatchObject({
      intervalSeconds: 60,
      maxCycles: 15,
      exitOnError: false,
      evaluatorReworkMaxAttempts: 3,
      budget: {
        usdPerRound: 0.1,
        timeMinutes: 10,
        actions: 10
      }
    });

    const db = new DatabaseManager({ dbPath: path.join(homeDir, "ailoop.db") });
    try {
      await expect(db.getConfig("AILOOP_INTERVAL_SECONDS")).resolves.toBe("60");
      await expect(db.getConfig("AILOOP_MAX_CYCLES")).resolves.toBe("15");
      await expect(db.getConfig("AILOOP_EVAL_REWORK_MAX_ATTEMPTS")).resolves.toBe("3");
      await expect(db.getConfig("AILOOP_BUDGET_USD_PER_ROUND")).resolves.toBe("0.1");
      await expect(db.getConfig("AILOOP_BUDGET_TIME_MINUTES")).resolves.toBe("10");
      await expect(db.getConfig("AILOOP_BUDGET_ACTIONS")).resolves.toBe("10");
    } finally {
      db.close();
    }

    await expect(fs.stat(path.join(homeDir, "runtime-config.json"))).rejects.toThrow();
  });

  test("saveRuntimeLoopConfig persists AI CLI overrides in the database instead of runtime-config.json", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-runtime-config-save-"));
    tempDirs.add(homeDir);

    const config = {
      ...makeConfig(),
      homeDir
    };

    await saveRuntimeLoopConfig(config, {
      intervalSeconds: 75,
      codex: {
        bin: "/opt/homebrew/bin/claude",
        model: "claude-opus-4-6"
      }
    });

    const db = new DatabaseManager({ dbPath: path.join(homeDir, "ailoop.db") });

    try {
      await expect(db.getConfig("AILOOP_INTERVAL_SECONDS")).resolves.toBe("75");
      await expect(db.getConfig("AILOOP_MAX_CYCLES")).resolves.toBe("0");
      await expect(db.getConfig("AILOOP_EXIT_ON_ERROR")).resolves.toBe("0");
      await expect(db.getConfig("AILOOP_EVAL_REWORK_MAX_ATTEMPTS")).resolves.toBe("1");
      await expect(db.getConfig("AILOOP_BUDGET_USD_PER_ROUND")).resolves.toBe("0.5");
      await expect(db.getConfig("AILOOP_BUDGET_TIME_MINUTES")).resolves.toBe("60");
      await expect(db.getConfig("AILOOP_BUDGET_ACTIONS")).resolves.toBe("30");
      await expect(db.getConfig("AILOOP_AI_CLI_BIN")).resolves.toBe("/opt/homebrew/bin/claude");
      await expect(db.getConfig("AILOOP_AI_CLI_MODEL")).resolves.toBe("claude-opus-4-6");
      await expect(db.getConfig("AILOOP_AI_CLI_TIMEOUT_MS")).resolves.toBe(null);
    } finally {
      db.close();
    }

    await expect(fs.stat(path.join(homeDir, "runtime-config.json"))).rejects.toThrow();
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

    await fs.writeFile(
      path.join(homeDir, "runtime-config.json"),
      JSON.stringify({ intervalSeconds: 999 }, null, 2),
      "utf8"
    );

    const reset = await resetRuntimeLoopConfig(config);

    expect(reset).toEqual(extractRuntimeLoopConfig(config));
    expect(await readRuntimeLoopConfig(config)).toEqual(extractRuntimeLoopConfig(config));
    await expect(fs.stat(path.join(homeDir, "runtime-config.json"))).rejects.toThrow();
  });
});
