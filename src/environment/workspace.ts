import path from "node:path";
import type { LoopPaths } from "../loop/state";
import { fileExists, readTextFile, writeTextFile } from "../utils/fs";

export interface FileSnapshot {
  path: string;
  content: string;
  existed: boolean;
}

export interface WorkspaceSnapshot {
  files: FileSnapshot[];
}

function toUnifiedLikeDiff(filePath: string, before: string, after: string): string {
  if (before === after) {
    return "";
  }

  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const body = [...beforeLines.map((line) => `-${line}`), ...afterLines.map((line) => `+${line}`)].join("\n");
  return `--- ${filePath}\n+++ ${filePath}\n@@ -1,${beforeLines.length} +1,${afterLines.length} @@\n${body}\n`;
}

export class WorkspaceManager {
  constructor(private readonly paths: LoopPaths) {}

  async createSnapshot(): Promise<WorkspaceSnapshot> {
    const targetFiles = [this.paths.taskPath];
    const files: FileSnapshot[] = [];

    for (const filePath of targetFiles) {
      const existed = await fileExists(filePath);
      const content = await readTextFile(filePath, "");
      files.push({ path: filePath, content, existed });
    }

    return { files };
  }

  async rollback(snapshot: WorkspaceSnapshot): Promise<void> {
    for (const file of snapshot.files) {
      if (!file.existed && !file.content) {
        await writeTextFile(file.path, "");
        continue;
      }
      await writeTextFile(file.path, file.content);
    }
  }

  async buildStateChange(snapshot: WorkspaceSnapshot): Promise<string> {
    const diffs: string[] = [];
    for (const file of snapshot.files) {
      const latest = await readTextFile(file.path, "");
      const relativePath = path.relative(process.cwd(), file.path) || file.path;
      const diff = toUnifiedLikeDiff(relativePath, file.content, latest);
      if (diff.trim()) {
        diffs.push(diff);
      }
    }

    if (diffs.length === 0) {
      return "No state changes detected.\n";
    }

    return `${diffs.join("\n")}\n`;
  }
}
