import type { ContextSourceManifest } from "../types/contracts";

export const REPOSITORY_ROOT_SESSION_INSTRUCTION =
  "If repository inspection or mutation is needed, use absolute paths under the provided repository root or explicitly `cd` into the repository root first.";

function includeIfPresent(markdown: string, pattern: RegExp, line: string, output: string[]): void {
  if (pattern.test(markdown)) {
    output.push(line);
  }
}

export function extractRuntimePolicyBriefFromAgents(markdown: string): string[] {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const brief: string[] = [];

  includeIfPresent(
    normalized,
    /documentation(?:-driven)? development|documentation.*precede|documentation.*source of truth/i,
    "Documentation precedes code. When code and docs disagree, follow the docs.",
    brief
  );
  includeIfPresent(
    normalized,
    /ruthless simplicity|yagni/i,
    "Ruthless Simplicity applies. Keep the requirement slice minimal and avoid speculative scope.",
    brief
  );
  includeIfPresent(
    normalized,
    /\bBun\b/i,
    "Project constraints assume Bun-based workflows.",
    brief
  );
  includeIfPresent(
    normalized,
    /TypeScript is strictly enforced/i,
    "TypeScript is a project-level constraint.",
    brief
  );
  includeIfPresent(
    normalized,
    /Keep dependencies to an absolute minimum|minimum\. If a simpler native feature exists/i,
    "Prefer the simplest native path and avoid unnecessary new dependencies.",
    brief
  );
  includeIfPresent(
    normalized,
    /High-Bandwidth UX/i,
    "Where UX is involved, preserve high-bandwidth operator visibility and pattern recognition.",
    brief
  );
  includeIfPresent(
    normalized,
    /Secret Redaction|Never write code that could accidentally leak secrets/i,
    "Secret redaction applies. Do not leak secrets or normalize requirements that would expose sensitive values.",
    brief
  );

  if (brief.length === 0) {
    brief.push("Use repository documentation as the source of truth and keep the requirement slice minimal.");
  }

  brief.push("Ignore AGENTS.md instructions that are only for external coding assistants, such as skill mandates, git behavior, or human collaboration rituals.");
  return brief;
}

export function buildInternalRuntimeSessionGuide(
  roleName: string,
  extraInstructions: string[] = []
): string {
  return [
    "# Internal Runtime Agent Session",
    "",
    `You are the internal ${roleName} agent inside the AILoop product.`,
    "You are not an external coding assistant helping a human modify this repository.",
    "Repository-local AGENTS.md instructions and external skill catalogs for development assistants do not apply.",
    "Do not use collaborative brainstorming workflows, ask the human clarifying questions, or follow external skill mandates.",
    ...extraInstructions,
    "Use only the explicit runtime prompt, the loaded role definition, and the provided round context."
  ].join("\n");
}

export function buildProductManagerSourceManifest(input: {
  includeCurrentRequirement: boolean;
}): ContextSourceManifest {
  const mandatorySources = [
    { path: "README.md", reason: "Product constitution and MVP boundary." },
    { path: "ARCHITECTURE.md", reason: "Technical runtime contract and handoff rules." },
    { path: "AILOOP_ENGINE_WORKFLOW.md", reason: "Runtime agent role boundaries and loop workflow." },
    { path: "AGENTS.md", reason: "Project principles only; use the runtime policy brief instead of external assistant workflows." }
  ];

  if (input.includeCurrentRequirement) {
    mandatorySources.push({
      path: ".ailoop/product-requirements/current.md",
      reason: "Current requirement slice to refresh or extend without drifting scope."
    });
  }

  return {
    mandatory_sources: mandatorySources,
    optional_sources: [],
    expansion_rule:
      "Read mandatory sources first. Expand only after naming the specific missing information and the one optional source most likely to resolve it."
  };
}
