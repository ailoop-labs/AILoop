import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { buildLoopPaths, defaultLoopState, readLoopState, writeLoopState } from "./state";

describe("loop state persistence", () => {
  test("defaultLoopState initializes previous_tool_result", () => {
    const state = defaultLoopState();
    expect(state.previous_tool_result).toBeNull();
  });

  test("readLoopState normalizes missing optional fields", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoloop-state-test-"));
    const paths = buildLoopPaths(homeDir);

    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(
      paths.statePath,
      JSON.stringify(
        {
          state: "paused",
          round: 3,
          updated_at: "2026-03-01T00:00:00.000Z",
          pid: 123,
          last_error: "example"
        },
        null,
        2
      ),
      "utf8"
    );

    const state = await readLoopState(paths);
    expect(state.previous_tool_result).toBeNull();
    expect(state.current_budget).toBeNull();
    expect(state.consecutive_evaluator_failures).toBe(0);

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("writeLoopState keeps persisted previous_tool_result", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoloop-state-write-test-"));
    const paths = buildLoopPaths(homeDir);

    const state = defaultLoopState();
    state.previous_tool_result = {
      status: "success",
      summary: "round succeeded",
      artifacts: {
        state_change_path: "state_change.txt",
        log_path: "round.log"
      },
      error: null,
      next_state_hint: "continue"
    };
    await writeLoopState(paths, state);

    const persisted = await readLoopState(paths);
    expect(persisted.previous_tool_result?.summary).toBe("round succeeded");

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});
