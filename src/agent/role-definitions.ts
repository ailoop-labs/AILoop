import path from "node:path";
import type { AppConfig } from "../config/env";
import { buildLoopPaths, ensureLoopHome } from "../loop/state";
import { fileExists, readTextFile, writeTextFile } from "../utils/fs";
import { CodexClient, type JsonSchema } from "./codex-client";

export type ProjectRole = "planner" | "executor" | "evaluator" | "leader" | "designer" | "senior_dev" | "qa_lead" | "product_owner";

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
  senior_dev_role_md: string;
  qa_lead_role_md: string;
  product_owner_role_md: string;
}

const GENERATED_ROLE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    planner_role_md: { type: "string" },
    executor_role_md: { type: "string" },
    evaluator_role_md: { type: "string" },
    leader_role_md: { type: "string" },
    designer_role_md: { type: "string" },
    senior_dev_role_md: { type: "string" },
    qa_lead_role_md: { type: "string" },
    product_owner_role_md: { type: "string" }
  },
  required: [
    "planner_role_md", 
    "executor_role_md", 
    "evaluator_role_md", 
    "leader_role_md", 
    "designer_role_md",
    "senior_dev_role_md",
    "qa_lead_role_md",
    "product_owner_role_md"
  ],
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
- [SCOPE CONTROL]: You MUST explicitly list "Out of Scope" items in your plan to prevent the Executor from over-engineering or handling edge cases that distract from the main goal.
- [SELF-HEALING]: If infrastructure bugs are found, fix them immediately.
- Assign tasks: "designer" for UI, "executor" for logic/infra.`);
}

function defaultDesignerRoleDefinition(): string {
  return normalizeMarkdown(`# UI/UX Designer Role
You are the Designer role for this project.
Responsibilities:
- Focus on UI/UX, responsive layouts, typography, and visual harmony.
- Use Tailwind CSS or Vanilla CSS.
- [HIGH-BANDWIDTH UX]: Human information bandwidth is narrow. Always design for pattern recognition over text parsing. Prefer visual timelines, color-coded status lights, semantic diffs, and health dashboards over raw log dumps.`);
}

function defaultExecutorRoleDefinition(): string {
  return normalizeMarkdown(`# Project Executor Role
You are the execution role for this project.
Responsibilities:
- Execute the current sub-task with deterministic, minimal actions.
- Verify outcomes with concrete evidence (tests, command output).`);
}

function defaultEvaluatorRoleDefinition(): string {
  return normalizeMarkdown(`# Project Evaluator Role
You are the evaluation role for this project.
Responsibilities:
- Compare objective and expected outcomes against observed state changes.
- Return clear pass/fail decisions with actionable justification.
- [COMPLEXITY VETO]: You MUST fail the round if the Executor violates the "Ruthless Simplicity" rule (e.g., modifying 10 files for a simple UI change, introducing unnecessary abstractions, or installing unneeded libraries). Return 'root_cause: over_engineering' and demand a literal, simple rewrite.`);
}

function defaultLeaderRoleDefinition(): string {
  return normalizeMarkdown(`# Project Leader Role
You are the Leader role for this project.
The loop has failed its auto-rework attempts.
Responsibilities:
- Analyze root causes of why the Planner and Executor are stuck.
- Identify if the issue is an implementation failure or a Constitutional (README.md) conflict.
- [TELEMETRY DUTY]: Query the SQLite metrics to check the 'Friction Index' (Rework Churn Rate, Action Bloat, Hot-file Mutation Rate) for the failing component.
- [RABBIT HOLE DETECTION]: Ask yourself "Is this specific feature strictly necessary for the MVP?". If the Executor is stuck on an edge case, complex regex, or obscure dependency that is not central to the user value, you must CUT THE SCOPE.
- Decision Branch A: Issue "Strategic Instructions" to Executor for code/config fixes.
- Decision Branch B: If the overall project goal (README.md) is reachable but blocked by current rules, escalate to CCB.
- Decision Branch C: If the Friction Index exceeds concrete triggers (e.g., >3 failures in 5 rounds due to technical debt, or >200% cost explosion), escalate to CCB with an 'Architectural Migration' proposal.
- Decision Branch D: Issue a "Scope Cut Directive" to the Planner, instructing it to drop the problematic requirement and find a simpler path to the goal.`);
}

function defaultSeniorDevRoleDefinition(): string {
  return normalizeMarkdown(`# Senior Developer Expert (CCB)
You are a Senior Developer acting as a technical expert on the Change Control Board (CCB).
Your goal is to ensure technical integrity, prevent technical debt, and maintain architectural consistency.
When reviewing a proposal to change the README.md (Constitution) or an 'Architectural Migration' proposal, evaluate if the adjustment is due to "lazy implementation" or a genuine technical impossibility.
[REFACTORING LAW]: You MUST reject any "Big Bang Rewrite" (e.g., rewriting the entire frontend in one go). You must enforce the "Strangler Fig Pattern" – demanding that the Planner breaks the migration into Infrastructure -> Coexistence -> Slice Migration -> Cleanup phases, ensuring existing tests pass at every step.`);
}

function defaultQALeadRoleDefinition(): string {
  return normalizeMarkdown(`# QA Lead Expert (CCB)
You are a QA Lead acting as a quality expert on the Change Control Board (CCB).
Your goal is to ensure high test coverage, robust verification, and prevent regressions.
You MUST reject proposals that lower the quality bar without adequate verification or those that omit critical regression tests.`);
}

function defaultProductOwnerRoleDefinition(): string {
  return normalizeMarkdown(`# Product Owner Expert (CCB)
You are a Product Owner acting as a business value expert on the Change Control Board (CCB).
Your goal is to protect the original mission and user value defined in the README.md.
Evaluate if lowering the goals or expectations significantly compromises the product's core value proposition.
You MUST reject any architectural or UI change that violates the 'High-Bandwidth UX' constitutional mandate (i.e., making the system harder for humans to monitor via pattern recognition).`);
}

function defaultRoleDefinition(role: ProjectRole): string {
  if (role === "planner") return defaultPlannerRoleDefinition();
  if (role === "designer") return defaultDesignerRoleDefinition();
  if (role === "executor") return defaultExecutorRoleDefinition();
  if (role === "leader") return defaultLeaderRoleDefinition();
  if (role === "senior_dev") return defaultSeniorDevRoleDefinition();
  if (role === "qa_lead") return defaultQALeadRoleDefinition();
  if (role === "product_owner") return defaultProductOwnerRoleDefinition();
  return defaultEvaluatorRoleDefinition();
}

function buildRoleGenerationPrompt(input: { projectGoal: string; readme: string }): string {
  const truncate = (value: string, max: number): string =>
    value.length > max ? `${value.slice(0, max - 3)}...` : value;

  return [
    "You generate project-scoped agent role definition markdown files.",
    "Return strict JSON only.",
    "",
    "Output fields: planner_role_md, designer_role_md, executor_role_md, evaluator_role_md, leader_role_md, senior_dev_role_md, qa_lead_role_md, product_owner_role_md",
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
  if (role === "planner") return paths.plannerRolePath;
  if (role === "designer") return paths.designerRolePath;
  if (role === "executor") return paths.executorRolePath;
  if (role === "leader") return paths.leaderRolePath;
  if (role === "senior_dev") return path.join(paths.homeDir, "SENIOR_DEV_ROLE.md");
  if (role === "qa_lead") return path.join(paths.homeDir, "QA_LEAD_ROLE.md");
  if (role === "product_owner") return path.join(paths.homeDir, "PRODUCT_OWNER_ROLE.md");
  return paths.evaluatorRolePath;
}

function rolePayloadFor(payload: GeneratedRolePayload | null, role: ProjectRole): string | null {
  if (!payload) return null;
  if (role === "planner") return payload.planner_role_md;
  if (role === "designer") return payload.designer_role_md;
  if (role === "executor") return payload.executor_role_md;
  if (role === "leader") return payload.leader_role_md;
  if (role === "senior_dev") return payload.senior_dev_role_md;
  if (role === "qa_lead") return payload.qa_lead_role_md;
  if (role === "product_owner") return payload.product_owner_role_md;
  return payload.evaluator_role_md;
}

export async function loadProjectRoleDefinition(homeDir: string, role: ProjectRole): Promise<string> {
  const paths = buildLoopPaths(homeDir);
  const rolePath = rolePathFor(paths, role);
  const fallback = defaultRoleDefinition(role);
  const content = await readTextFile(rolePath, "");
  if (!content.trim()) return fallback;
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

  const allRoles: ProjectRole[] = ["planner", "designer", "executor", "evaluator", "leader", "senior_dev", "qa_lead", "product_owner"];
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

  if (targets.length === 0) return { generated, skipped, source: "none" };

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
    const content = typeof generatedContent === "string" && generatedContent.trim() ? normalizeMarkdown(generatedContent) : defaultRoleDefinition(role);
    await writeTextFile(rolePath, content);
    generated.push(role);
  }

  return { generated, skipped, source: source === "ai" ? "ai" : "template" };
}
