import type { AppConfig } from "../config/env";
import type { ProductManagerContext } from "../types/contracts";
import { type JsonSchema, CodexClient } from "./codex-client";
import { loadProjectRoleDefinition } from "./role-definitions";

interface ProductManagerResponse {
  requirement_markdown: string;
}

interface CodexLike {
  runJson<T>(options: {
    prompt: string;
    schema: JsonSchema;
    cwd: string;
    sandbox: AppConfig["codex"]["plannerSandbox"];
    sessionIsolation?: {
      enabled: boolean;
      agentsGuide?: string;
    };
    onStdoutChunk?: (chunk: string) => void;
    onStderrChunk?: (chunk: string) => void;
  }): Promise<{
    ok: boolean;
    data?: T;
    rawMessage: string;
    stdout: string;
    stderr: string;
    error?: string;
  }>;
}

const PRODUCT_MANAGER_RESPONSE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    requirement_markdown: { type: "string" }
  },
  required: ["requirement_markdown"],
  additionalProperties: false
};

function normalizeRequirementMarkdown(markdown: string): string {
  return `${String(markdown).replace(/\r\n/g, "\n").trimEnd()}\n`;
}

function buildFallbackRequirementTitle(goal: string): string {
  const normalized = goal.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized.slice(0, 80) : "Clarification Needed";
}

function fallbackRequirement(context: ProductManagerContext): string {
  const title = buildFallbackRequirementTitle(context.goal);
  const latestInstruction = context.instructions.at(-1)?.trim();

  return normalizeRequirementMarkdown(
    [
      `# Requirement Slice: ${title}`,
      "",
      "## Problem",
      context.goal.trim() || "The active goal is underspecified and needs product clarification before execution continues.",
      "",
      "## User Value",
      context.goal.trim() || "Enable safe human-supervised progress toward the top-level goal.",
      "",
      "## Scope",
      "- Define one reviewable requirement slice that the ProjectPlanner can turn into the next atomic round.",
      latestInstruction ? `- Respect operator instruction: ${latestInstruction}` : "- Keep scope narrow and operator-reviewable.",
      "",
      "## Non-Goals",
      "- Do not prescribe low-level implementation steps.",
      "- Do not expand the requirement slice beyond the next reviewable milestone.",
      "",
      "## Acceptance Criteria",
      "- A human can read the requirement slice directly in Markdown.",
      "- The ProjectPlanner can derive one atomic next step without inventing missing product scope.",
      "",
      "## Design / UX Requirements",
      "- Preserve high-bandwidth operator visibility where UI changes are involved.",
      "",
      "## Constraints",
      "- Keep the MVP solution simple and bounded.",
      "",
      "## Open Questions",
      "- What is the smallest next slice that advances the top-level goal safely?",
      "",
      "## Completion Notes",
      "- Initial fallback requirement skeleton generated because ProductManager output was unavailable."
    ].join("\n")
  );
}

function buildProductManagerRuntimeSessionGuide(): string {
  return [
    "# Internal Runtime Agent Session",
    "",
    "You are an internal runtime agent inside the AILoop product.",
    "You are not an external coding assistant helping a human modify this repository.",
    "Repository-local AGENTS.md instructions and external skill catalogs for development assistants do not apply.",
    "Do not use collaborative brainstorming workflows, ask the human clarifying questions, or follow external skill mandates.",
    "Use only the explicit runtime prompt, the loaded Product Manager role definition, and the provided round context."
  ].join("\n");
}

export function buildProductManagerPrompt(
  context: ProductManagerContext,
  productManagerRoleDefinition: string,
  workspaceRoot: string
): string {
  return [
    "You are the AILoop ProductManager agent.",
    "Project-specific Product Manager Role Definition:",
    productManagerRoleDefinition.trim(),
    "",
    `Repository root: ${workspaceRoot}`,
    "",
    "Runtime execution notes:",
    "- This internal runtime session is intentionally isolated from repository-local AGENTS.md files and development-assistant skill workflows.",
    "- If you inspect repository files, use absolute paths under the repository root or explicitly `cd` into the repository root first.",
    "- Do not use external development-assistant skills, collaborative brainstorming workflows, or human question-asking patterns.",
    "",
    "Produce or refresh exactly one human-readable requirement slice in Markdown.",
    "",
    "Rules:",
    "- Return Markdown requirement content for the active requirement slice.",
    "- Do not emit round-level execution tasks, implementation plans, or SubTask JSON.",
    "- Clarify problem, user value, scope, non-goals, acceptance criteria, and design expectations.",
    "- Keep the requirement slice directly reviewable by a human operator.",
    "- If key context is missing, surface concise open questions instead of guessing.",
    "- Keep scope minimal and aligned to the top-level goal.",
    "",
    "ProductManager input:",
    JSON.stringify(context, null, 2)
  ].join("\n");
}

export class ProductManagerAgent {
  private readonly codex: CodexLike;
  private readonly sandbox: AppConfig["codex"]["plannerSandbox"];
  private readonly homeDir: string;
  private readonly workspaceRoot: string;

  constructor(config: AppConfig, codexClient?: CodexLike) {
    this.codex = codexClient ?? new CodexClient(config.codex);
    this.sandbox = config.codex.plannerSandbox;
    this.homeDir = config.homeDir;
    this.workspaceRoot = process.cwd();
  }

  async generateRequirement(
    context: ProductManagerContext,
    options?: {
      onLog?: (message: string) => void | Promise<void>;
    }
  ): Promise<string> {
    const emitLog = (message: string): void => {
      if (!options?.onLog) {
        return;
      }

      void Promise.resolve(options.onLog(message)).catch(() => {
        // ProductManager logging is best-effort.
      });
    };

    const toLogLines = (_source: "stdout" | "stderr", chunk: string): string[] =>
      chunk
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line) => `[product_manager] ${line}`);

    const roleDefinition = await loadProjectRoleDefinition(this.homeDir, "product_manager");
    const prompt = buildProductManagerPrompt(context, roleDefinition, this.workspaceRoot);

    emitLog("ProductManager started Codex generation.");
    const heartbeatStartedAt = Date.now();
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - heartbeatStartedAt) / 1000);
      emitLog(`ProductManager running... ${elapsedSeconds}s elapsed.`);
    }, 15_000);

    const result = await this.codex
      .runJson<ProductManagerResponse>({
        prompt,
        schema: PRODUCT_MANAGER_RESPONSE_SCHEMA,
        cwd: this.workspaceRoot,
        sandbox: this.sandbox,
        sessionIsolation: {
          enabled: true,
          agentsGuide: buildProductManagerRuntimeSessionGuide()
        },
        onStdoutChunk: (chunk) => {
          for (const line of toLogLines("stdout", chunk)) {
            emitLog(line);
          }
        },
        onStderrChunk: (chunk) => {
          for (const line of toLogLines("stderr", chunk)) {
            emitLog(line);
          }
        }
      })
      .finally(() => {
        clearInterval(heartbeat);
      });

    emitLog(`ProductManager Codex generation finished (ok=${result.ok}).`);

    if (!result.ok || !result.data) {
      return fallbackRequirement(context);
    }

    const markdown = normalizeRequirementMarkdown(result.data.requirement_markdown);
    if (!markdown.trim()) {
      return fallbackRequirement(context);
    }

    return markdown;
  }
}
