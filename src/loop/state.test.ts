import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  appendInstruction,
  buildLoopPaths,
  defaultLoopState,
  ensureLoopHome,
  readLoopState,
  writeLoopState
} from "./state";

describe("loop state persistence", () => {
  test("buildLoopPaths includes project role definition paths and canonical instruction queue path", () => {
    const paths = buildLoopPaths("/tmp/ailoop-home");
    expect(paths.plannerRolePath).toBe("/tmp/ailoop-home/PLANNER_ROLE.md");
    expect(paths.productManagerRolePath).toBe("/tmp/ailoop-home/PRODUCT_MANAGER_ROLE.md");
    expect(paths.executorRolePath).toBe("/tmp/ailoop-home/EXECUTOR_ROLE.md");
    expect(paths.evaluatorRolePath).toBe("/tmp/ailoop-home/EVALUATOR_ROLE.md");
    expect(paths.productRequirementsDirPath).toBe("/tmp/ailoop-home/product-requirements");
    expect(paths.activeRequirementPath).toBe("/tmp/ailoop-home/product-requirements/current.md");
    expect(paths.instructionsPath).toBe("/tmp/ailoop-home/instructions.queue.json");
    expect(paths.legacyInstructionsPath).toBe("/tmp/ailoop-home/instructions.json");
  });

  test("defaultLoopState initializes previous_tool_result", () => {
    const state = defaultLoopState();
    expect(state.previous_tool_result).toBeNull();
  });

  test("readLoopState normalizes missing optional fields", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-state-test-"));
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
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-state-write-test-"));
    const paths = buildLoopPaths(homeDir);

    const state = defaultLoopState();
    state.previous_tool_result = {
      status: "success",
      summary: "round succeeded",
      artifacts: {
        state_change_path: "state_change.txt",
        log_path: "round.log"
      },
      error: undefined,
      next_state_hint: "continue"
    };
    await writeLoopState(paths, state);

    const persisted = await readLoopState(paths);
    expect(persisted.previous_tool_result?.summary).toBe("round succeeded");

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("ensureLoopHome heals instructions.queue.json when it is a directory", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-state-heal-instructions-"));
    const paths = buildLoopPaths(homeDir);

    await fs.mkdir(paths.instructionsPath, { recursive: true });
    await fs.writeFile(path.join(paths.instructionsPath, "stale.txt"), "stale", "utf8");

    await ensureLoopHome(paths);

    const instructionsStat = await fs.stat(paths.instructionsPath);
    expect(instructionsStat.isFile()).toBe(true);
    const instructionsContent = await fs.readFile(paths.instructionsPath, "utf8");
    expect(JSON.parse(instructionsContent)).toEqual([]);

    const homeEntries = await fs.readdir(homeDir);
    expect(homeEntries.some((entry) => entry.startsWith("instructions.queue.json.invalid-type-"))).toBe(true);

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("ensureLoopHome migrates legacy instructions.json into the canonical queue file", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-state-migrate-instructions-"));
    const paths = buildLoopPaths(homeDir);

    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(paths.legacyInstructionsPath, `${JSON.stringify(["legacy instruction"], null, 2)}\n`, "utf8");

    await ensureLoopHome(paths);

    expect(JSON.parse(await fs.readFile(paths.instructionsPath, "utf8"))).toEqual(["legacy instruction"]);
    expect(JSON.parse(await fs.readFile(paths.legacyInstructionsPath, "utf8"))).toEqual([]);

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("migrates legacy loop.state into state.json", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-state-migrate-legacy-state-"));
    const paths = buildLoopPaths(homeDir);

    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(
      path.join(homeDir, "loop.state"),
      JSON.stringify(
        {
          state: "paused",
          round: 7,
          updated_at: "2026-03-12T00:00:00.000Z",
          pid: 4321,
          last_error: "legacy state"
        },
        null,
        2
      ),
      "utf8"
    );

    await ensureLoopHome(paths);

    const migrated = await readLoopState(paths);
    expect(migrated.state).toBe("paused");
    expect(migrated.round).toBe(7);
    expect(migrated.last_error).toBe("legacy state");
    expect(migrated.pid).toBe(4321);

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("ensureLoopHome removes legacy loop.state when canonical state.json already exists", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-state-clean-legacy-state-"));
    const paths = buildLoopPaths(homeDir);

    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(
      paths.statePath,
      JSON.stringify(
        {
          state: "running",
          round: 11,
          updated_at: "2026-03-12T00:00:00.000Z",
          pid: 8765,
          last_error: "canonical state"
        },
        null,
        2
      ),
      "utf8"
    );
    await fs.writeFile(
      paths.legacyStatePath,
      JSON.stringify(
        {
          state: "paused",
          round: 3,
          updated_at: "2026-03-11T00:00:00.000Z",
          pid: 1234,
          last_error: "stale legacy state"
        },
        null,
        2
      ),
      "utf8"
    );

    await ensureLoopHome(paths);

    expect(await readLoopState(paths)).toMatchObject({
      state: "running",
      round: 11,
      pid: 8765,
      last_error: "canonical state"
    });
    // Both legacy and transition files should be removed once migrated to DB
    await expect(fs.stat(paths.statePath)).rejects.toThrow();
    await expect(fs.access(paths.legacyStatePath)).rejects.toThrow();

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("ensureLoopHome preserves legacy loop.state when canonical state.json is invalid", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-state-invalid-canonical-state-"));
    const paths = buildLoopPaths(homeDir);

    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(paths.statePath, "{\n", "utf8");
    await fs.writeFile(
      paths.legacyStatePath,
      JSON.stringify(
        {
          state: "paused",
          round: 5,
          updated_at: "2026-03-12T00:00:00.000Z",
          pid: 5555,
          last_error: "legacy state"
        },
        null,
        2
      ),
      "utf8"
    );

    await ensureLoopHome(paths);

    expect(await readLoopState(paths)).toMatchObject({
      state: "paused",
      round: 5,
      pid: 5555,
      last_error: "legacy state"
    });
    // Migration should have happened and files unlinked
    await expect(fs.access(paths.legacyStatePath)).rejects.toThrow();
    await expect(fs.access(paths.statePath)).rejects.toThrow();

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("appendInstruction preserves legacy queued items and heals them to the canonical queue file", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-state-append-instructions-"));
    const paths = buildLoopPaths(homeDir);

    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(paths.instructionsPath, `${JSON.stringify(["canonical instruction"], null, 2)}\n`, "utf8");
    await fs.writeFile(paths.legacyInstructionsPath, `${JSON.stringify(["legacy instruction"], null, 2)}\n`, "utf8");

    await appendInstruction(paths, "new instruction");

    expect(JSON.parse(await fs.readFile(paths.instructionsPath, "utf8"))).toEqual([
      "legacy instruction",
      "canonical instruction",
      "new instruction"
    ]);
    expect(JSON.parse(await fs.readFile(paths.legacyInstructionsPath, "utf8"))).toEqual([]);

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});
