import fs from "node:fs/promises";
import path from "node:path";
import type { GoalReference } from "../types/contracts";
import { readTextFile, writeTextFile } from "../utils/fs";

const GOAL_PLACEHOLDER = "# AILoop Task Log";

function normalizeGoalMarkdown(markdown: string): string {
  return `${markdown.replace(/\r\n/g, "\n").trimEnd()}\n`;
}

function isPlaceholderGoal(markdown: string): boolean {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  return !normalized || normalized === GOAL_PLACEHOLDER;
}

export function resolveWorkspaceRootFromHome(homeDir: string): string {
  return path.basename(homeDir) === ".ailoop" ? path.dirname(homeDir) : homeDir;
}

export async function buildDeterministicGoal(workspaceRoot: string = process.cwd()): Promise<string> {
  const entries = await fs.readdir(workspaceRoot).catch(() => [] as string[]);
  if (entries.includes("GOAL.md")) {
    const goalMd = await readTextFile(path.join(workspaceRoot, "GOAL.md"), "");
    if (goalMd.trim()) {
      return goalMd;
    }
  }

  const readmeMd = await readTextFile(path.join(workspaceRoot, "README.md"), "");
  if (readmeMd.trim()) {
    return `# Project Goal (Derived from README.md)\n\n${readmeMd}`;
  }

  return "# AILoop Goal\n\nDescribe the top-level goal this autonomous loop should pursue. Keep it outcome-focused and measurable.\n";
}

export async function ensureGoalFile(goalPath: string, workspaceRoot: string): Promise<string> {
  const existing = await readTextFile(goalPath, "");
  if (!isPlaceholderGoal(existing)) {
    return normalizeGoalMarkdown(existing);
  }

  const deterministicGoal = normalizeGoalMarkdown(await buildDeterministicGoal(workspaceRoot));
  await writeTextFile(goalPath, deterministicGoal);
  return deterministicGoal;
}

export async function readGoalFile(goalPath: string, workspaceRoot: string): Promise<string> {
  const existing = await readTextFile(goalPath, "");
  if (!isPlaceholderGoal(existing)) {
    return normalizeGoalMarkdown(existing);
  }

  return normalizeGoalMarkdown(await buildDeterministicGoal(workspaceRoot));
}

export function extractGoalReference(markdown: string): GoalReference | null {
  const lines = markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim());

  const nonEmpty = lines.filter(Boolean);
  if (nonEmpty.length === 0) {
    return null;
  }

  const heading = nonEmpty.find((line) => line.startsWith("# "));
  const title = heading ? heading.slice(2).trim() : nonEmpty[0] ?? "";
  const summary = nonEmpty.find((line) => line !== heading && !line.startsWith("#") && !line.startsWith("-")) ?? "";

  if (!title && !summary) {
    return null;
  }

  return {
    title: title || "Goal",
    summary: summary || title || "Goal"
  };
}
