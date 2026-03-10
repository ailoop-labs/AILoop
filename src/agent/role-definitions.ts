import path from "node:path";
import type { AppConfig } from "../config/env";
import { buildLoopPaths, ensureLoopHome } from "../loop/state";
import { fileExists, readTextFile, writeTextFile } from "../utils/fs";
import { CodexClient, type JsonSchema } from "./codex-client";

export type ProjectRole = "planner" | "executor" | "evaluator" | "leader" | "designer";

export interface EnsureProjectRoleDefinitionsOptions {
  workspaceRoot?: string;
  regen?: boolean;
  codexClient?: Pick<CodexClient, "runJson">;
}

export interface EnsureProjectRoleDefinitionsResult {
  generated: ProjectRole[];
  skipped: ProjectRole[];
  source: "ai" | "template" | "none";
}

interface GeneratedRolePayload {
  planner_role_md: string;
  executor_role_md: string;
  evaluator_role_md: string;
  leader_role_md: string;
  designer_role_md: string;
}

const GENERATED_ROLE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    planner_role_md: { type: "string" },
    executor_role_md: { type: "string" },
    evaluator_role_md: { type: "string" },
    leader_role_md: { type: "string" },
    designer_role_md: { type: "string" }
  },
  required: ["planner_role_md", "executor_role_md", "evaluator_role_md", "leader_role_md", "designer_role_md"],
  additionalProperties: false
};

function normalizeMarkdown(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  return `${normalized}\n`;
}

function defaultPlannerRoleDefinition(): string {
  return normalizeMarkdown(`# Product Manager (Planner) Role

You are the Product Manager (Planning) role for this project.

Responsibilities:
- Translate project goals into one atomic, verifiable sub-task per round.
- Prioritize the highest-value step that can be validated quickly.
- Write clear, structured requirements using professional product frameworks (e.g., Why-What-Acceptance).
- Include explicit expected outcomes with re-runnable verification.
- [SELF-HEALING]: If \`previous_round_error\` is present and indicates a system, infrastructure, test framework, or tool bug, your HIGHEST priority is to generate a SubTask to investigate and fix that specific bug immediately. You must suspend the previous business objective until the infrastructure bug is resolved.
- Assign tasks appropriately: use "designer" for UI/UX, visual design, responsive layouts, or CSS architecture. Use "executor" for logic, API, infrastructure, or general coding.

Skills & Frameworks:
- You have access to professional product management skills (e.g., \`wwas\`, \`create-prd\`). 
- ALWAYS use the \`activate_skill\` tool to load the appropriate framework before writing complex requirements or breaking down new features.

Constraints:
- Respect human instructions as highest priority.
- Do not broaden scope into multi-task plans.
- Do not weaken budget, safety, or schema guardrails.

This file is project-scoped and editable. Update it to customize Product Manager behavior.`);
}

function defaultDesignerRoleDefinition(): string {
  return normalizeMarkdown(`# UI/UX Designer Role

You are the Designer role for this project.

Responsibilities:
- Focus strictly on UI/UX best practices, responsive layouts, typography, spacing, and visual harmony.
- Implement UI components using Tailwind CSS or Vanilla CSS, ensuring modularity and reusability.
- Provide comprehensive design specs or high-fidelity code for the executor to integrate.
- Ensure accessibility (a11y) standards are met across all interfaces.

Constraints:
- Do not modify complex backend business logic or database schemas unless strictly required for UI rendering.
- Maintain consistency with the project's existing design system and styling approach.
- Always provide verifiable visual or structural outcomes.

This file is project-scoped and editable. Update it to customize designer behavior.`);
}

function defaultExecutorRoleDefinition(): string {
  return normalizeMarkdown(`# Project Executor Role

You are the execution role for this project.

Responsibilities:
- Execute the current sub-task with deterministic, minimal actions.
- Verify state before mutate and verify outcomes after mutate.
- Capture concrete evidence (tests, command output, file diffs).

Constraints:
- Retry and self-correct on actionable errors.
- Stop and fail explicitly when blocked by missing prerequisites.
- Do not bypass safety, policy, or budget guardrails.
- [SELF-HEALING]: If you encounter a tool bug, testing framework error, or infrastructural failure while working on a business objective, DO NOT hack around it or modify out-of-scope files. Instead, cleanly fail the current SubTask with a detailed error message describing the infrastructure bug so the Planner can schedule a self-healing task in the next round.

This file is project-scoped and editable. Update it to customize executor behavior.`);
}

function defaultEvaluatorRoleDefinition(): string {
  return normalizeMarkdown(`# Project Evaluator Role

You are the evaluation role for this project.

Responsibilities:
- Compare objective and expected outcomes against observed state changes.
- Favor concrete evidence over assumptions.
- Return clear pass/fail decisions with actionable justification.

Constraints:
- Reject superficial completion claims without evidence.
- Treat scope expansion as a warning signal unless concrete risk is present.
- Do not override system guardrails or output schema requirements.

This file is project-scoped and editable. Update it to customize evaluator behavior.`);
}

function defaultLeaderRoleDefinition(): string {
  return normalizeMarkdown(`# Project Leader Role

You are the Leader role for this project.
The autonomous loop has entered a 'paused' state due to repeated errors, budget breaches, or continuous evaluation failures.

Responsibilities:
- Analyze the provided error messages, failure history, and previous round artifacts.
- Identify the root cause of why the Planner and Executor are stuck.
- Provide explicit, strategic instructions to unblock the system.

Constraints:
- If the issue is a simple operational blocker (e.g., missing dependency, port in use, type error), provide instructions to fix it and return "resume".
- If the overall project goal is fundamentally impossible or structurally broken, return "stop" to escalate to the human owner.
- You can read all files, but you may ONLY write to directional documents (README.md, GOAL.md, ARCHITECTURE.md, instructions.json).

This file is project-scoped and editable. Update it to customize leader behavior.`);
}

function defaultRoleDefinition(role: ProjectRole): string {
  if (role === "planner") {
    return defaultPlannerRoleDefinition();
  }
  if (role === "designer") {
    return defaultDesignerRoleDefinition();
  }
  if (role === "executor") {
    return defaultExecutorRoleDefinition();
  }
  if (role === "leader") {
    return defaultLeaderRoleDefinition();
  }
  return defaultEvaluatorRoleDefinition();
}

function buildRoleGenerationPrompt(input: { projectGoal: string; readme: string }): string {
  const truncate = (value: string, max: number): string =>
    value.length > max ? `${value.slice(0, max - 3)}...` : value;

  return [
    "You generate project-scoped agent role definition markdown files.",
    "Return strict JSON only.",
    "",
    "Output fields:",
    "- planner_role_md",
    "- designer_role_md",
    "- executor_role_md",
    "- evaluator_role_md",
    "- leader_role_md",
    "",
    "Requirements:",
    "- Make definitions specific to project context from readme.",
    "- Keep content concise, practical, and directly actionable.",
    "- Preserve core engine constraints (budget, safety, schema, rollback).",
    "- Include headings in each markdown document.",
    "",
    "Context:",
    JSON.stringify(
      {
        project_goal_md: truncate(input.projectGoal, 6000),
        project_readme_md: truncate(input.readme, 12000)
      },
      null,
      2
    )
  ].join("\n");
}

function rolePathFor(paths: ReturnType<typeof buildLoopPaths>, role: ProjectRole): string {
  if (role === "planner") {
    return paths.plannerRolePath;
  }
  if (role === "designer") {
    return paths.designerRolePath;
  }
  if (role === "executor") {
    return paths.executorRolePath;
  }
  if (role === "leader") {
    return paths.leaderRolePath;
  }
  return paths.evaluatorRolePath;
}

function rolePayloadFor(payload: GeneratedRolePayload | null, role: ProjectRole): string | null {
  if (!payload) {
    return null;
  }
  if (role === "planner") {
    return payload.planner_role_md;
  }
  if (role === "designer") {
    return payload.designer_role_md;
  }
  if (role === "executor") {
    return payload.executor_role_md;
  }
  if (role === "leader") {
    return payload.leader_role_md;
  }
  return payload.evaluator_role_md;
}

export async function loadProjectRoleDefinition(homeDir: string, role: ProjectRole): Promise<string> {
  const paths = buildLoopPaths(homeDir);
  const rolePath = rolePathFor(paths, role);
  const fallback = defaultRoleDefinition(role);
  const content = await readTextFile(rolePath, "");
  if (!content.trim()) {
    return fallback;
  }
  return normalizeMarkdown(content);
}

export async function ensureProjectRoleDefinitions(
  config: AppConfig,
  options: EnsureProjectRoleDefinitionsOptions = {}
): Promise<EnsureProjectRoleDefinitionsResult> {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const regen = options.regen === true;
  const paths = buildLoopPaths(config.homeDir);
  await ensureLoopHome(paths);

  const allRoles: ProjectRole[] = ["planner", "designer", "executor", "evaluator", "leader"];
  const generated: ProjectRole[] = [];
  const skipped: ProjectRole[] = [];
  const targets: ProjectRole[] = [];

  for (const role of allRoles) {
    const rolePath = rolePathFor(paths, role);
    const exists = await fileExists(rolePath);
    if (regen || !exists) {
      targets.push(role);
      continue;
    }
    skipped.push(role);
  }

  if (targets.length === 0) {
    return {
      generated,
      skipped,
      source: "none"
    };
  }

  const codex = options.codexClient ?? new CodexClient(config.codex);
  const projectGoal = await readTextFile(path.join(workspaceRoot, "GOAL.md"), "");
  const readme = await readTextFile(path.join(workspaceRoot, "README.md"), "");

  let payload: GeneratedRolePayload | null = null;
  let source: EnsureProjectRoleDefinitionsResult["source"] = "template";
  const generation = await codex.runJson<GeneratedRolePayload>({
    prompt: buildRoleGenerationPrompt({ projectGoal, readme }),
    schema: GENERATED_ROLE_SCHEMA,
    cwd: workspaceRoot,
    sandbox: config.codex.plannerSandbox
  });
  if (generation.ok && generation.data) {
    payload = generation.data;
    source = "ai";
  }

  for (const role of targets) {
    const rolePath = rolePathFor(paths, role);
    const generatedContent = rolePayloadFor(payload, role);
    const content =
      typeof generatedContent === "string" && generatedContent.trim()
        ? normalizeMarkdown(generatedContent)
        : defaultRoleDefinition(role);
    await writeTextFile(rolePath, content);
    generated.push(role);
  }

  return {
    generated,
    skipped,
    source: source === "ai" ? "ai" : "template"
  };
}