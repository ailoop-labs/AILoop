import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import type { LoopPaths } from "../types/contracts";
import { WorkspaceManager } from "./workspace";

function run(cmd: string, cwd: string): void {
  execSync(cmd, {
    cwd,
    stdio: "pipe"
  });
}

function createLoopPaths(homeDir: string): LoopPaths {
  return {
    homeDir,
    runsDir: path.join(homeDir, "runs"),
    taskPath: path.join(homeDir, "goal.md"),
    plannerRolePath: path.join(homeDir, "PLANNER_ROLE.md"),
    executorRolePath: path.join(homeDir, "EXECUTOR_ROLE.md"),
    designerRolePath: path.join(homeDir, "DESIGNER_ROLE.md"),
    evaluatorRolePath: path.join(homeDir, "EVALUATOR_ROLE.md"),
    leaderRolePath: path.join(homeDir, "LEADER_ROLE.md"),
    instructionsPath: path.join(homeDir, "instructions.queue.json"),
    legacyInstructionsPath: path.join(homeDir, "instructions.json"),
    statePath: path.join(homeDir, "state.json"),
    legacyStatePath: path.join(homeDir, "loop.state"),
    pidPath: path.join(homeDir, "loop.pid"),
    lockPath: path.join(homeDir, "loop.lock"),
    pauseFlagPath: path.join(homeDir, "loop.pause"),
    stopFlagPath: path.join(homeDir, "loop.stop"),
    dbPath: path.join(homeDir, "ailoop.db")
  };
}

describe("WorkspaceManager.buildStateChange", () => {
  test("uses current .ailoop goal and state filenames", () => {
    const paths = createLoopPaths("/tmp/ailoop-home");

    expect(paths.taskPath).toBe("/tmp/ailoop-home/goal.md");
    expect(paths.instructionsPath).toBe("/tmp/ailoop-home/instructions.queue.json");
    expect(paths.statePath).toBe("/tmp/ailoop-home/state.json");
  });

  test("reports only round delta instead of pre-existing dirty changes", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-workspace-test-"));
    const homeDir = path.join(repoDir, ".ailoop");
    const paths = createLoopPaths(homeDir);
    await fs.mkdir(paths.homeDir, { recursive: true });
    await fs.mkdir(paths.runsDir, { recursive: true });

    run("git init", repoDir);
    run("git config user.email test@example.com", repoDir);
    run("git config user.name tester", repoDir);

    await fs.writeFile(path.join(repoDir, "existing.txt"), "base\n", "utf8");
    await fs.writeFile(paths.taskPath, "# task\n", "utf8");
    run("git add existing.txt .ailoop/goal.md", repoDir);
    run("git commit -m 'init'", repoDir);

    await fs.writeFile(path.join(repoDir, "existing.txt"), "base\nold-dirty-change\n", "utf8");

    const manager = new WorkspaceManager(paths, repoDir);
    const snapshot = await manager.createSnapshot();

    await fs.writeFile(path.join(repoDir, "new-evidence.txt"), "created-in-round\n", "utf8");

    const stateChange = await manager.buildStateChange(snapshot);

    expect(stateChange).toContain("new-evidence.txt");
    expect(stateChange).not.toContain("old-dirty-change");

    await fs.rm(repoDir, { recursive: true, force: true });
  });

  test("captures diff for explicitly tracked .ailoop target files", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-workspace-target-test-"));
    const homeDir = path.join(repoDir, ".ailoop");
    const paths = createLoopPaths(homeDir);
    await fs.mkdir(paths.homeDir, { recursive: true });
    await fs.mkdir(paths.runsDir, { recursive: true });
    await fs.writeFile(paths.taskPath, "# task\n", "utf8");

    run("git init", repoDir);
    run("git config user.email test@example.com", repoDir);
    run("git config user.name tester", repoDir);
    await fs.writeFile(path.join(repoDir, ".gitignore"), ".ailoop/*\n!.ailoop/goal.md\n", "utf8");
    run("git add .ailoop/goal.md", repoDir);
    run("git add .gitignore", repoDir);
    run("git commit -m 'init'", repoDir);

    const targetPath = path.join(paths.homeDir, "plans", "round-x.md");
    const manager = new WorkspaceManager(paths, repoDir);
    const snapshot = await manager.createSnapshot([targetPath]);

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, "# created in round\n", "utf8");

    const stateChange = await manager.buildStateChange(snapshot);
    expect(stateChange).toContain(".ailoop/plans/round-x.md");
    expect(stateChange).toContain("+# created in round");

    await fs.rm(repoDir, { recursive: true, force: true });
  });

  test("rollback removes files that did not exist before snapshot", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-workspace-rollback-test-"));
    const homeDir = path.join(repoDir, ".ailoop");
    const paths = createLoopPaths(homeDir);
    await fs.mkdir(paths.homeDir, { recursive: true });
    await fs.mkdir(paths.runsDir, { recursive: true });
    await fs.writeFile(paths.taskPath, "# task\n", "utf8");

    run("git init", repoDir);
    run("git config user.email test@example.com", repoDir);
    run("git config user.name tester", repoDir);
    await fs.writeFile(path.join(repoDir, ".gitignore"), ".ailoop/*\n!.ailoop/goal.md\n", "utf8");
    run("git add .ailoop/goal.md", repoDir);
    run("git add .gitignore", repoDir);
    run("git commit -m 'init'", repoDir);

    const createdPath = path.join(paths.homeDir, "plans", "created-during-round.md");
    const manager = new WorkspaceManager(paths, repoDir);
    const snapshot = await manager.createSnapshot([createdPath]);

    await fs.mkdir(path.dirname(createdPath), { recursive: true });
    await fs.writeFile(createdPath, "temp\n", "utf8");
    expect(await fs.stat(createdPath)).toBeDefined();

    await manager.rollback(snapshot);

    await expect(fs.stat(createdPath)).rejects.toThrow();
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  test("expands directory targets into concrete workspace files", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-workspace-dir-test-"));
    const homeDir = path.join(repoDir, ".ailoop");
    const paths = createLoopPaths(homeDir);
    await fs.mkdir(paths.homeDir, { recursive: true });
    await fs.mkdir(paths.runsDir, { recursive: true });
    await fs.writeFile(paths.taskPath, "# task\n", "utf8");

    const srcDir = path.join(repoDir, "src");
    const nestedDir = path.join(srcDir, "nested");
    await fs.mkdir(nestedDir, { recursive: true });
    const entryPath = path.join(srcDir, "index.ts");
    const nestedPath = path.join(nestedDir, "util.ts");
    await fs.writeFile(entryPath, "export const entry = true;\n", "utf8");
    await fs.writeFile(nestedPath, "export const util = true;\n", "utf8");

    const manager = new WorkspaceManager(paths, repoDir);
    const snapshot = await manager.createSnapshot([srcDir]);

    expect(snapshot.files.find((file) => file.path === srcDir)).toBeUndefined();
    expect(snapshot.files.map((file) => file.path).sort()).toEqual(
      [paths.taskPath, entryPath, nestedPath].sort()
    );

    await fs.rm(repoDir, { recursive: true, force: true });
  });

  test("ignores nested directory read errors while snapshotting directory targets", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-workspace-dir-error-test-"));
    const homeDir = path.join(repoDir, ".ailoop");
    const paths = createLoopPaths(homeDir);
    await fs.mkdir(paths.homeDir, { recursive: true });
    await fs.mkdir(paths.runsDir, { recursive: true });
    await fs.writeFile(paths.taskPath, "# task\n", "utf8");

    const srcDir = path.join(repoDir, "src");
    const okDir = path.join(srcDir, "ok");
    const brokenDir = path.join(srcDir, "broken");
    await fs.mkdir(okDir, { recursive: true });
    await fs.mkdir(brokenDir, { recursive: true });
    const okPath = path.join(okDir, "index.ts");
    await fs.writeFile(okPath, "export const ok = true;\n", "utf8");

    const originalReaddir = fs.readdir;
    fs.readdir = (async (targetPath, options) => {
      if (String(targetPath) === brokenDir) {
        throw new Error("simulated readdir failure");
      }
      return originalReaddir(targetPath, options as never);
    }) as typeof fs.readdir;

    try {
      const manager = new WorkspaceManager(paths, repoDir);
      const snapshot = await manager.createSnapshot([srcDir]);

      expect(snapshot.files.map((file) => file.path).sort()).toEqual([paths.taskPath, okPath].sort());
    } finally {
      fs.readdir = originalReaddir;
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  test("handles nonexistent directory placeholders without throwing during state capture or rollback", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-workspace-future-dir-test-"));
    const homeDir = path.join(repoDir, ".ailoop");
    const paths = createLoopPaths(homeDir);
    await fs.mkdir(paths.homeDir, { recursive: true });
    await fs.mkdir(paths.runsDir, { recursive: true });
    await fs.writeFile(paths.taskPath, "# task\n", "utf8");

    run("git init", repoDir);
    run("git config user.email test@example.com", repoDir);
    run("git config user.name tester", repoDir);
    run("git add .ailoop/goal.md", repoDir);
    run("git commit -m 'init'", repoDir);

    const futureDir = path.join(repoDir, ".github", "ISSUE_TEMPLATE") + path.sep;
    const createdDir = path.join(repoDir, ".github", "ISSUE_TEMPLATE");
    const createdFile = path.join(createdDir, "bug.yml");
    const manager = new WorkspaceManager(paths, repoDir);
    const snapshot = await manager.createSnapshot([futureDir]);
    expect(snapshot.files.some((file) => file.path.replace(/[\\/]$/, "") === createdDir)).toBeTrue();

    await fs.mkdir(createdDir, { recursive: true });
    await fs.writeFile(createdFile, "name: Bug report\n", "utf8");

    const stateChange = await manager.buildStateChange(snapshot);
    expect(stateChange).toContain(".github/ISSUE_TEMPLATE/bug.yml");

    await manager.rollback(snapshot);

    await expect(fs.stat(createdFile)).rejects.toThrow();
    await expect(fs.stat(createdDir)).rejects.toThrow();
    await fs.rm(repoDir, { recursive: true, force: true });
  });
});
