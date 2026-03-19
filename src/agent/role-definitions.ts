import { createHash } from "node:crypto";
import path from "node:path";
import type { AppConfig } from "../config/env";
import { buildLoopPaths, ensureLoopHome } from "../loop/state";
import { fileExists, readTextFile, writeTextFile } from "../utils/fs";
import { CodexClient, type JsonSchema } from "./codex-client";

export type ProjectRole = "planner" | "product_manager" | "executor" | "evaluator" | "leader" | "designer" | "senior_dev" | "qa_lead" | "product_owner";

export interface EnsureProjectRoleDefinitionsOptions {
  workspaceRoot?: string;
  regen?: boolean;
  autoRefresh?: boolean;
  codexClient?: Pick<CodexClient, "runJson">;
}

export interface EnsureProjectRoleDefinitionsResult {
  generated: ProjectRole[];
  skipped: ProjectRole[];
  source: "ai" | "template" | "none";
}

interface GeneratedRolePayload {
  planner_role_md: string;
  product_manager_role_md: string;
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
    product_manager_role_md: { type: "string" },
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
    "product_manager_role_md",
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

function leaderJsonOutputContractMarkdown(): string {
  return [
    "## Output Contract",
    "Return strict JSON only.",
    "- Fields: rationale, action, diagnosis_type, instructions, proposed_readme_change.",
    "- action must be one of: resume, stop, escalate_to_ccb.",
    "- diagnosis_type must be one of: implementation_failure, constitutional_conflict.",
    "- If executor success claims conflict with evaluator evidence-insufficiency failure, treat the issue as evidence/validation handoff failure before retrying product code."
  ].join("\n");
}

function normalizeLeaderRoleDefinition(content: string): string {
  const normalized = normalizeMarkdown(content);
  const hasLegacyOutputContract =
    /Return a Markdown governance memo/i.test(normalized) ||
    /resume_with_instruction|ccb_review|hard_pause_for_human/i.test(normalized);

  if (!hasLegacyOutputContract) {
    return normalized;
  }

  const withoutLegacyOutput = normalized
    .replace(/\n## Output Contract[\s\S]*?(?=\n##\s|\n#\s|$)/, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return normalizeMarkdown([withoutLegacyOutput, leaderJsonOutputContractMarkdown()].join("\n\n"));
}

const ROLES_SOURCE_HASH_FILENAME = ".roles_source_hash";

export function computeSourceHash(readme: string, goal: string, architecture: string = "", workflow: string = ""): string {
  return createHash("sha256")
    .update(`${readme}\n---\n${goal}\n---\n${architecture}\n---\n${workflow}`)
    .digest("hex");
}

async function shouldAutoRegenerate(homeDir: string, currentHash: string): Promise<boolean> {
  const hashPath = path.join(homeDir, ROLES_SOURCE_HASH_FILENAME);
  const storedHash = (await readTextFile(hashPath, "")).trim();
  return storedHash !== currentHash;
}

async function writeSourceHash(homeDir: string, hash: string): Promise<void> {
  const hashPath = path.join(homeDir, ROLES_SOURCE_HASH_FILENAME);
  await writeTextFile(hashPath, `${hash}\n`);
}

function defaultPlannerRoleDefinition(): string {
  return normalizeMarkdown(`# Project Planner Role
You are the Project Planner role for this project.
Responsibilities:
- Translate project goals, current requirement artifacts, and recent execution history into one atomic, verifiable sub-task per round.
- Detect when product definition is missing, stale, contradictory, or complete for the current requirement slice.
- Wake the Product Manager role when requirement artifacts need to be created or refreshed.
- Include explicit expected outcomes with re-runnable verification.
- [SCOPE CONTROL]: You MUST explicitly list "Out of Scope" items in your plan to prevent the Executor from over-engineering or handling edge cases that distract from the main goal.
- [SELF-HEALING]: If infrastructure bugs are found, fix them immediately.
- Assign tasks: "designer" for UI, "executor" for logic/infra.`);
}

function defaultProductManagerRoleDefinition(): string {
  return normalizeMarkdown(`# Product Manager Role
You are the Product Manager role for this project.
Responsibilities:
- Produce and refresh human-readable Markdown requirement documents for the current requirement slice.
- Define problem, user value, scope, non-goals, acceptance criteria, design expectations, and open questions.
- Keep requirement artifacts easy for a human operator to inspect directly.
- Do not emit round-level execution tasks or prescribe low-level implementation details.`);
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
**CODE-FIRST DELIVERABLES: Always prioritize tangible code artifacts (implementations, tests, builds) before documentation work.**

Responsibilities:
- Execute the current sub-task with deterministic, minimal actions.
- Verify outcomes with concrete evidence (tests, command output).
- **CRITICAL: Produce actual code deliverables first.** Before creating any documentation (README, ARCHITECTURE, comments), first implement and verify the code. Documentation is secondary and only necessary when required for verification or as explicitly requested.
- **CRITICAL: Provide operational evidence.** After running verification commands (tests, builds, checks), you MUST capture the direct command output showing pass/fail results. Include these as compact excerpts in the operational_evidence array field of your tool result. The Evaluator requires direct behavioral proof, not just claims of success. Include:
  1. Direct command outputs (e.g., "$ bun test src/file.test.ts\\n42 pass, 0 fail")
  2. Key implementation code excerpts that directly support the claimed changes (e.g., the new function signature, the modified route handler)`);
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
- Analyze root causes of why the ProjectPlanner and Executor are stuck.
- Identify if the issue is an implementation failure or a Constitutional (README.md) conflict.
- [TELEMETRY DUTY]: Query the SQLite metrics to check the 'Friction Index' (Rework Churn Rate, Action Bloat, Hot-file Mutation Rate) for the failing component.
- [RABBIT HOLE DETECTION]: Ask yourself "Is this specific feature strictly necessary for the MVP?". If the Executor is stuck on an edge case, complex regex, or obscure dependency that is not central to the user value, you must CUT THE SCOPE.
- Decision Branch A: Issue "Strategic Instructions" to Executor for code/config fixes.
- Decision Branch B: If the overall project goal (README.md) is reachable but blocked by current rules, escalate to CCB.
- Decision Branch C: If the Friction Index exceeds concrete triggers (e.g., >3 failures in 5 rounds due to technical debt, or >200% cost explosion), escalate to CCB with an 'Architectural Migration' proposal.
- Decision Branch D: Issue a "Scope Cut Directive" to the ProjectPlanner, instructing it to drop the problematic requirement and find a simpler path to the goal.
Output:
- Return strict JSON only.
- Fields: rationale, action, diagnosis_type, instructions, proposed_readme_change.
- action must be one of: resume, stop, escalate_to_ccb.
- diagnosis_type must be one of: implementation_failure, constitutional_conflict.
- If executor success claims conflict with evaluator evidence-insufficiency failure, treat the issue as evidence/validation handoff failure before retrying product code.`);
}

function defaultSeniorDevRoleDefinition(): string {
  return normalizeMarkdown(`# Senior Developer Expert (CCB)
You are a Senior Developer acting as a technical expert on the Change Control Board (CCB).
Your goal is to ensure technical integrity, prevent technical debt, and maintain architectural consistency.
When reviewing a proposal to change the README.md (Constitution) or an 'Architectural Migration' proposal, evaluate if the adjustment is due to "lazy implementation" or a genuine technical impossibility.
[REFACTORING LAW]: You MUST reject any "Big Bang Rewrite" (e.g., rewriting the entire frontend in one go). You must enforce the "Strangler Fig Pattern" – demanding that the ProjectPlanner breaks the migration into Infrastructure -> Coexistence -> Slice Migration -> Cleanup phases, ensuring existing tests pass at every step.`);
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
  if (role === "product_manager") return defaultProductManagerRoleDefinition();
  if (role === "designer") return defaultDesignerRoleDefinition();
  if (role === "executor") return defaultExecutorRoleDefinition();
  if (role === "leader") return defaultLeaderRoleDefinition();
  if (role === "senior_dev") return defaultSeniorDevRoleDefinition();
  if (role === "qa_lead") return defaultQALeadRoleDefinition();
  if (role === "product_owner") return defaultProductOwnerRoleDefinition();
  return defaultEvaluatorRoleDefinition();
}

function buildRoleGenerationPrompt(input: { projectGoal: string; readme: string; architecture: string; workflow: string }): string {
  const truncate = (value: string, max: number): string =>
    value.length > max ? `${value.slice(0, max - 3)}...` : value;

  return [
    "You generate project-scoped agent role definition markdown files.",
    "Return strict JSON only.",
    "",
    "Output fields: planner_role_md, product_manager_role_md, designer_role_md, executor_role_md, evaluator_role_md, leader_role_md, senior_dev_role_md, qa_lead_role_md, product_owner_role_md",
    "",
    "Context:",
    JSON.stringify(
      {
        project_goal_md: truncate(input.projectGoal, 6000),
        project_readme_md: truncate(input.readme, 12000),
        project_architecture_md: truncate(input.architecture, 12000),
        project_workflow_md: truncate(input.workflow, 12000)
      },
      null,
      2
    )
  ].join("\n");
}

function rolePathFor(paths: ReturnType<typeof buildLoopPaths>, role: ProjectRole): string {
  if (role === "planner") return paths.plannerRolePath;
  if (role === "product_manager") return paths.productManagerRolePath;
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
  if (role === "product_manager") return payload.product_manager_role_md;
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
  if (role === "leader") {
    return normalizeLeaderRoleDefinition(content);
  }
  return normalizeMarkdown(content);
}

export async function ensureProjectRoleDefinitions(
  config: AppConfig,
  options: EnsureProjectRoleDefinitionsOptions = {}
): Promise<EnsureProjectRoleDefinitionsResult> {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  let regen = options.regen === true;
  const autoRefresh = options.autoRefresh === true;
  const paths = buildLoopPaths(config.homeDir);
  await ensureLoopHome(paths);

  // Read source documents early for both hash computation and role generation
  const projectGoal = await readTextFile(path.join(workspaceRoot, "GOAL.md"), "");
  const readme = await readTextFile(path.join(workspaceRoot, "README.md"), "");
  const architecture = await readTextFile(path.join(workspaceRoot, "ARCHITECTURE.md"), "");
  const workflow = await readTextFile(path.join(workspaceRoot, "AILOOP_ENGINE_WORKFLOW.md"), "");

  // Auto-refresh: compare source hash to decide if regeneration is needed
  let currentHash: string | null = null;
  if (autoRefresh && !regen) {
    currentHash = computeSourceHash(readme, projectGoal, architecture, workflow);
    if (await shouldAutoRegenerate(config.homeDir, currentHash)) {
      regen = true;
    }
  }

  const allRoles: ProjectRole[] = ["planner", "product_manager", "designer", "executor", "evaluator", "leader", "senior_dev", "qa_lead", "product_owner"];
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
    // Even if no roles need regeneration, update hash if autoRefresh is active
    if (autoRefresh && currentHash) {
      await writeSourceHash(config.homeDir, currentHash);
    }
    return { generated, skipped, source: "none" };
  }

  const codex = options.codexClient ?? new CodexClient(config.codex);

  let payload: GeneratedRolePayload | null = null;
  let source: EnsureProjectRoleDefinitionsResult["source"] = "template";
  const generation = await codex.runJson<GeneratedRolePayload>({
    prompt: buildRoleGenerationPrompt({ projectGoal, readme, architecture, workflow }),
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

  // Persist source hash after successful generation
  if (autoRefresh) {
    const hashToStore = currentHash ?? computeSourceHash(readme, projectGoal, architecture, workflow);
    await writeSourceHash(config.homeDir, hashToStore);
  }

  return { generated, skipped, source: source === "ai" ? "ai" : "template" };
}
