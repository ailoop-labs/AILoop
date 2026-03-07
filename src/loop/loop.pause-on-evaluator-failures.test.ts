import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../config/env";
import { LoopEngine } from "./engine";
import { ensureLoopHome, readLoopState, setFlag, type LoopPaths, writeLoopState } from "./state";

const EVALUATOR_FAILURE_LIMIT = 3;

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

describe("LoopEngine evaluator failure threshold guard", () => {
  test("pauses before starting a new round once failure limit is already reached", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-engine-failure-limit-test-"));
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
      consecutive_evaluator_failures: EVALUATOR_FAILURE_LIMIT
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
      expect(pausedState.last_error || "").toContain("EvaluatorFailureLimit");
      expect(pausedState.last_error || "").toContain(`${EVALUATOR_FAILURE_LIMIT}`);
      expect(pausedState.consecutive_evaluator_failures).toBe(EVALUATOR_FAILURE_LIMIT);
    } finally {
      await setFlag(paths.stopFlagPath);
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
