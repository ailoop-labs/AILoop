import type { AppConfig } from "../config/env";
import { CodexClient, type JsonSchema } from "../agent/codex-client";
import { loadProjectRoleDefinition } from "../agent/role-definitions";
import type { ExpertOpinion, CCBResult, LeaderDecision } from "../types/contracts";

const EXPERT_OPINION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    expert_role: { type: "string", enum: ["senior_dev", "qa_lead", "product_owner"] },
    vote: { type: "string", enum: ["approve", "reject"] },
    rationale: { type: "string" },
    incapacity_flag: { type: "boolean" },
    remediation_hints: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: ["expert_role", "vote", "rationale", "incapacity_flag"],
  additionalProperties: false
};

export class CCBSession {
  private codex: CodexClient;

  constructor(private config: AppConfig) {
    this.codex = new CodexClient(config.codex);
  }

  async run(round: number, leaderDecision: LeaderDecision, readme: string): Promise<CCBResult> {
    const roles: ("senior_dev" | "qa_lead" | "product_owner")[] = ["senior_dev", "qa_lead", "product_owner"];
    
    console.log(`[CCB] Meeting convened for Round ${round} to evaluate README.md change.`);
    
    const opinions = await Promise.all(roles.map(role => this.review(role, leaderDecision, readme)));
    
    const incapacity = opinions.some(o => o.incapacity_flag);
    if (incapacity) {
      return {
        decision: "escalate_to_human",
        experts: opinions,
        rationale: "Expert agent reported incapacity to evaluate this change."
      };
    }

    const qaVote = opinions.find(o => o.expert_role === "qa_lead")?.vote;
    const poVote = opinions.find(o => o.expert_role === "product_owner")?.vote;
    const devVote = opinions.find(o => o.expert_role === "senior_dev")?.vote;

    // Rule: QA and PO have Veto Power. Senior Dev contributes to consensus.
    const decision = (qaVote === "approve" && poVote === "approve" && devVote === "approve") ? "approve" : "reject";

    return {
      decision,
      experts: opinions,
      rationale: decision === "approve" 
        ? "Unanimous approval for Constitutional modification."
        : "Vetoed or majority rejection for the proposed Change Request."
    };
  }

  private async review(role: "senior_dev" | "qa_lead" | "product_owner", leaderDecision: LeaderDecision, readme: string): Promise<ExpertOpinion> {
    const roleDef = await loadProjectRoleDefinition(this.config.homeDir, role);
    const prompt = [
      roleDef,
      "",
      "## Current README.md (Constitution)",
      readme,
      "",
      "## Proposed Change Request (Leader Proposal)",
      `Rationale: ${leaderDecision.rationale}`,
      `Proposed Change: ${leaderDecision.proposed_readme_change ?? "N/A"}`,
      "",
      "## Your Task",
      "As a CCB expert, evaluate this change request.",
      "1. Decide whether to 'approve' or 'reject'.",
      "2. If 'reject', provide clear 'remediation_hints' to guide the next retry.",
      "3. If this task is fundamentally beyond AI capabilities, set 'incapacity_flag' to true.",
      "Return result as JSON."
    ].join("\n");

    const result = await this.codex.runJson<ExpertOpinion>({
      prompt,
      schema: EXPERT_OPINION_SCHEMA,
      cwd: process.cwd(),
      sandbox: "workspace-write"
    });

    if (!result.ok || !result.data) {
      throw new Error(`CCB Review failed for ${role}: ${result.error}`);
    }

    return result.data;
  }
}
