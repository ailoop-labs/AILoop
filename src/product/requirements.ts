import fs from "node:fs/promises";
import type { LoopPaths } from "../types/contracts";
import type { RequirementArtifactSnapshot } from "../types/contracts";
import { ensureDir, fileExists, readTextFile, writeTextFile } from "../utils/fs";
import { getRequirementLifecycleStatus } from "../planning/requirement-completion";

function normalizeRequirementMarkdown(markdown: string): string {
  return `${markdown.replace(/\r\n/g, "\n").trimEnd()}\n`;
}

function extractTitle(markdown: string): string | null {
  const line = markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.startsWith("# "));
  return line ? line.slice(2).trim() : null;
}

function extractProblemSummary(markdown: string): string | null {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const problemSectionMatch = normalized.match(/\n## Problem\b([\s\S]*?)(?=\n##\s+|\s*$)/);
  if (!problemSectionMatch) {
    return null;
  }

  const summary = problemSectionMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => !line.startsWith("-"));

  return summary?.trim() || null;
}

function extractAcceptanceCriteria(markdown: string): string[] {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const sectionMatch = normalized.match(/\n## Acceptance Criteria\b([\s\S]*?)(?=\n##\s+|\s*$)/);
  if (!sectionMatch) {
    return [];
  }

  return sectionMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function extractLifecycleCount(markdown: string, label: "Matched Acceptance Criteria" | "Remaining Acceptance Criteria"): number | null {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const match = normalized.match(new RegExp(`- ${label}:\\s*(\\d+)`, "i"));
  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export async function ensureProductRequirementsHome(paths: LoopPaths): Promise<void> {
  await ensureDir(paths.productRequirementsDirPath);
}

export async function hasActiveRequirementArtifact(paths: LoopPaths): Promise<boolean> {
  return fileExists(paths.activeRequirementPath);
}

export async function readActiveRequirementArtifact(paths: LoopPaths): Promise<string | null> {
  if (!(await hasActiveRequirementArtifact(paths))) {
    return null;
  }

  return readTextFile(paths.activeRequirementPath, "");
}

export async function writeActiveRequirementArtifact(
  paths: LoopPaths,
  markdown: string
): Promise<void> {
  await ensureProductRequirementsHome(paths);
  await writeTextFile(paths.activeRequirementPath, normalizeRequirementMarkdown(markdown));
}

export async function readActiveRequirementSnapshot(paths: LoopPaths): Promise<RequirementArtifactSnapshot> {
  const exists = await hasActiveRequirementArtifact(paths);
  if (!exists) {
    return {
      path: paths.activeRequirementPath,
      exists: false,
      artifact_status: "missing",
      lifecycle_status: "active",
      title: null,
      summary: null,
      acceptance_criteria_total: 0,
      acceptance_criteria_completed: 0,
      markdown: null,
      updated_at: null
    };
  }

  const markdown = normalizeRequirementMarkdown((await readTextFile(paths.activeRequirementPath, "")).trimEnd());
  const lifecycleStatus = getRequirementLifecycleStatus(markdown);
  const acceptanceCriteria = extractAcceptanceCriteria(markdown);
  const matchedCount = extractLifecycleCount(markdown, "Matched Acceptance Criteria");
  const completedCount = lifecycleStatus === "complete"
    ? matchedCount ?? acceptanceCriteria.length
    : matchedCount ?? 0;
  const stat = await fs.stat(paths.activeRequirementPath);

  return {
    path: paths.activeRequirementPath,
    exists: true,
    artifact_status: lifecycleStatus === "complete" ? "needs_refresh" : "ready",
    lifecycle_status: lifecycleStatus,
    title: extractTitle(markdown),
    summary: extractProblemSummary(markdown),
    acceptance_criteria_total: acceptanceCriteria.length,
    acceptance_criteria_completed: Math.min(completedCount, acceptanceCriteria.length),
    markdown,
    updated_at: stat.mtime.toISOString()
  };
}
