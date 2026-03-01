import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import type { LoopPaths } from "../loop/state";
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
    goalPath: path.join(homeDir, "goal.md"),
    taskPath: path.join(homeDir, "task.md"),
    instructionsPath: path.join(homeDir, "instructions.json"),
    statePath: path.join(homeDir, "loop.state"),
    pidPath: path.join(homeDir, "loop.pid"),
    lockPath: path.join(homeDir, "loop.lock"),
    pauseFlagPath: path.join(homeDir, "loop.pause"),
    stopFlagPath: path.join(homeDir, "loop.stop")
  };
}

describe("WorkspaceManager.buildStateChange", () => {
  test("reports only round delta instead of pre-existing dirty changes", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoloop-workspace-test-"));
    const homeDir = path.join(repoDir, ".autoloop");
    const paths = createLoopPaths(homeDir);
    await fs.mkdir(paths.homeDir, { recursive: true });
    await fs.mkdir(paths.runsDir, { recursive: true });

    run("git init", repoDir);
    run("git config user.email test@example.com", repoDir);
    run("git config user.name tester", repoDir);

    await fs.writeFile(path.join(repoDir, "existing.txt"), "base\n", "utf8");
    await fs.writeFile(paths.taskPath, "# task\n", "utf8");
    run("git add existing.txt .autoloop/task.md", repoDir);
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

  test("captures diff for explicitly tracked .autoloop target files", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoloop-workspace-target-test-"));
    const homeDir = path.join(repoDir, ".autoloop");
    const paths = createLoopPaths(homeDir);
    await fs.mkdir(paths.homeDir, { recursive: true });
    await fs.mkdir(paths.runsDir, { recursive: true });
    await fs.writeFile(paths.taskPath, "# task\n", "utf8");

    run("git init", repoDir);
    run("git config user.email test@example.com", repoDir);
    run("git config user.name tester", repoDir);
    await fs.writeFile(path.join(repoDir, ".gitignore"), ".autoloop/*\n!.autoloop/task.md\n", "utf8");
    run("git add .autoloop/task.md", repoDir);
    run("git add .gitignore", repoDir);
    run("git commit -m 'init'", repoDir);

    const targetPath = path.join(paths.homeDir, "plans", "round-x.md");
    const manager = new WorkspaceManager(paths, repoDir);
    const snapshot = await manager.createSnapshot([targetPath]);

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, "# created in round\n", "utf8");

    const stateChange = await manager.buildStateChange(snapshot);
    expect(stateChange).toContain(".autoloop/plans/round-x.md");
    expect(stateChange).toContain("+# created in round");

    await fs.rm(repoDir, { recursive: true, force: true });
  });

  test("rollback removes files that did not exist before snapshot", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoloop-workspace-rollback-test-"));
    const homeDir = path.join(repoDir, ".autoloop");
    const paths = createLoopPaths(homeDir);
    await fs.mkdir(paths.homeDir, { recursive: true });
    await fs.mkdir(paths.runsDir, { recursive: true });
    await fs.writeFile(paths.taskPath, "# task\n", "utf8");

    run("git init", repoDir);
    run("git config user.email test@example.com", repoDir);
    run("git config user.name tester", repoDir);
    await fs.writeFile(path.join(repoDir, ".gitignore"), ".autoloop/*\n!.autoloop/task.md\n", "utf8");
    run("git add .autoloop/task.md", repoDir);
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
});
