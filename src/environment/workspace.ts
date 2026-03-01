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
    const normalizedTargets = uniquePaths(
      [this.paths.taskPath, ...extraTargetFiles]
        .map((filePath) => (path.isAbsolute(filePath) ? filePath : path.resolve(this.workspaceRoot, filePath)))
        .filter((filePath) => isPathInside(this.workspaceRoot, filePath))
    );
    const files: FileSnapshot[] = [];

    for (const filePath of normalizedTargets) {
      const existed = await fileExists(filePath);
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
        await fs.rm(file.path, { force: true });
        continue;
      }
      await writeTextFile(file.path, file.content);
    }
  }

  async buildStateChange(snapshot: WorkspaceSnapshot): Promise<string> {
    const sections: string[] = [];
    const fileDiffs: string[] = [];
    for (const file of snapshot.files) {
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
