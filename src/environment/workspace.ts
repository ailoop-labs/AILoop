import fs from "node:fs/promises";
import path from "node:path";
import type { LoopPaths } from "../loop/state";
import { runShellCommand } from "../utils/exec";
import { fileExists, readTextFile, writeTextFile } from "../utils/fs";

export interface FileSnapshot {
  path: string;
  content: string;
  existed: boolean;
}

export interface WorkspaceSnapshot {
  files: FileSnapshot[];
  gitStatusBaseline: string;
  trackedDiffBaseline: string;
  untrackedBaseline: string;
}

interface SnapshotTarget {
  path: string;
}

function splitLines(input: string): string[] {
  if (!input) {
    return [];
  }
  return input.split("\n");
}

function buildLineCountMap(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

function toDeltaLines(beforeLines: string[], afterLines: string[]): string[] {
  const removed: string[] = [];
  const afterCounts = buildLineCountMap(afterLines);
  for (const line of beforeLines) {
    const count = afterCounts.get(line) ?? 0;
    if (count > 0) {
      afterCounts.set(line, count - 1);
      continue;
    }
    removed.push(`-${line}`);
  }

  const added: string[] = [];
  const beforeCounts = buildLineCountMap(beforeLines);
  for (const line of afterLines) {
    const count = beforeCounts.get(line) ?? 0;
    if (count > 0) {
      beforeCounts.set(line, count - 1);
      continue;
    }
    added.push(`+${line}`);
  }

  return [...removed, ...added];
}

function toUnifiedLikeDiff(filePath: string, before: string, after: string): string {
  if (before === after) {
    return "";
  }

  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const deltaLines = toDeltaLines(beforeLines, afterLines);
  if (deltaLines.length === 0) {
    return "";
  }

  const body = deltaLines.join("\n");
  return `--- ${filePath}\n+++ ${filePath}\n@@ -1,${beforeLines.length} +1,${afterLines.length} @@\n${body}\n`;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

function normalizeSnapshotTargets(
  workspaceRoot: string,
  taskPath: string,
  extraTargetFiles: string[]
): SnapshotTarget[] {
  const targetMap = new Map<string, SnapshotTarget>();
  for (const rawPath of [taskPath, ...extraTargetFiles]) {
    const resolvedPath = path.isAbsolute(rawPath)
      ? path.normalize(rawPath)
      : path.resolve(workspaceRoot, rawPath);
    if (!isPathInside(workspaceRoot, resolvedPath)) {
      continue;
    }

    if (targetMap.has(resolvedPath)) {
      continue;
    }

    targetMap.set(resolvedPath, {
      path: resolvedPath
    });
  }

  return Array.from(targetMap.values());
}

async function statIfExists(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function collectDirectoryFiles(rootDir: string, workspaceRoot: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [rootDir];

  while (pending.length > 0) {
    const currentDir = pending.pop();
    if (!currentDir) {
      continue;
    }

    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => null);
    if (!entries) {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (!isPathInside(workspaceRoot, entryPath) || entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }

  return files;
}

export class WorkspaceManager {
  constructor(
    private readonly paths: LoopPaths,
    private readonly workspaceRoot: string = process.cwd()
  ) {}

  private async runGitCommand(command: string): Promise<string> {
    const result = await runShellCommand(command, this.workspaceRoot);
    if (result.code !== 0) {
      return "";
    }
    return result.stdout.trim();
  }

  private async readGitStatusPorcelain(): Promise<string> {
    return this.runGitCommand("git status --porcelain --untracked-files=all");
  }

  private async readTrackedDiff(): Promise<string> {
    return this.runGitCommand("git diff --no-ext-diff");
  }

  private async readUntrackedFiles(): Promise<string> {
    return this.runGitCommand("git ls-files --others --exclude-standard");
  }

  private async buildGitEvidence(snapshot: WorkspaceSnapshot): Promise<string[]> {
    const sections: string[] = [];

    const currentStatus = await this.readGitStatusPorcelain();
    const statusDelta = toUnifiedLikeDiff(
      "git-status-porcelain",
      snapshot.gitStatusBaseline,
      currentStatus
    ).trim();
    if (statusDelta) {
      sections.push(["### Git Status Delta", "```diff", statusDelta, "```"].join("\n"));
    }

    const currentTrackedDiff = await this.readTrackedDiff();
    const trackedDiffDelta = toUnifiedLikeDiff(
      "git-tracked-diff",
      snapshot.trackedDiffBaseline,
      currentTrackedDiff
    ).trim();
    if (trackedDiffDelta) {
      sections.push(["### Git Tracked Diff Delta", "```diff", trackedDiffDelta, "```"].join("\n"));
    }

    const currentUntracked = await this.readUntrackedFiles();
    const untrackedDelta = toUnifiedLikeDiff(
      "git-untracked-files",
      snapshot.untrackedBaseline,
      currentUntracked
    ).trim();
    if (untrackedDelta) {
      sections.push(["### Git Untracked Delta", "```diff", untrackedDelta, "```"].join("\n"));
    }

    return sections;
  }

  async createSnapshot(extraTargetFiles: string[] = []): Promise<WorkspaceSnapshot> {
    const normalizedTargets = normalizeSnapshotTargets(
      this.workspaceRoot,
      this.paths.taskPath,
      extraTargetFiles
    );
    const snapshotTargets = uniquePaths(
      (
        await Promise.all(
          normalizedTargets.map(async (target) => {
            if (!(await fileExists(target.path))) {
              return [target.path];
            }

            const stat = await fs.lstat(target.path);
            if (stat.isDirectory()) {
              return collectDirectoryFiles(target.path, this.workspaceRoot);
            }

            return [target.path];
          })
        )
      ).flat()
    );
    const files: FileSnapshot[] = [];

    for (const filePath of snapshotTargets) {
      const existed = await fileExists(filePath);
      if (existed) {
        const stat = await fs.lstat(filePath);
        if (!stat.isFile()) {
          continue;
        }
      }
      const content = await readTextFile(filePath, "");
      files.push({ path: filePath, content, existed });
    }

    return {
      files,
      gitStatusBaseline: await this.readGitStatusPorcelain(),
      trackedDiffBaseline: await this.readTrackedDiff(),
      untrackedBaseline: await this.readUntrackedFiles()
    };
  }

  async rollback(snapshot: WorkspaceSnapshot): Promise<void> {
    for (const file of snapshot.files) {
      if (!file.existed) {
        const stat = await statIfExists(file.path);
        if (!stat) {
          continue;
        }
        await fs.rm(file.path, { force: true, recursive: stat.isDirectory() });
        continue;
      }
      await writeTextFile(file.path, file.content);
    }
  }

  async buildStateChange(snapshot: WorkspaceSnapshot): Promise<string> {
    const sections: string[] = [];
    const fileDiffs: string[] = [];
    for (const file of snapshot.files) {
      const stat = await statIfExists(file.path);
      if (stat && !stat.isFile()) {
        continue;
      }
      const latest = await readTextFile(file.path, "");
      const relativePath = path.relative(this.workspaceRoot, file.path) || file.path;
      const diff = toUnifiedLikeDiff(relativePath, file.content, latest);
      if (diff.trim()) {
        fileDiffs.push(diff);
      }
    }

    if (fileDiffs.length > 0) {
      sections.push(["### Snapshot File Diffs", "```diff", fileDiffs.join("\n").trim(), "```"].join("\n"));
    }

    const gitEvidence = await this.buildGitEvidence(snapshot);
    sections.push(...gitEvidence);

    if (sections.length === 0) {
      return "No state changes detected.\n";
    }

    return `${sections.join("\n\n")}\n`;
  }
}
