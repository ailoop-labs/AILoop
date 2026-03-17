import { createHash } from "node:crypto";
import path from "node:path";
import type { AppConfig } from "../config/env";
import type { LeaderContext, LeaderDecision } from "../types/contracts";
import { writeJsonFile } from "../utils/fs";
import { redactJsonStrings, SecretRedactor } from "../utils/redaction";
import { CodexClient, type CodexJsonCallResult, type JsonSchema } from "./codex-client";
import { loadProjectRoleDefinition } from "./role-definitions";
import { buildInternalRuntimeSessionGuide } from "./runtime-policy";

const LEADER_DECISION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    rationale: { type: "string" },
    action: { type: "string", enum: ["resume", "stop", "escalate_to_ccb"] },
    diagnosis_type: { type: "string", enum: ["implementation_failure", "constitutional_conflict"] },
    instructions: {
      type: "array",
      items: { type: "string" }
    },
    proposed_readme_change: { type: "string" }
  },
  required: ["rationale", "action", "diagnosis_type", "instructions"],
  additionalProperties: false
};

function normalizeDiagnosticExcerpt(value: string | undefined, redactor: SecretRedactor): string | null {
  const normalized = redactor.redact((value ?? "").replace(/\s+/g, " ").trim());
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, 500);
}

function extractUsefulDiagnosticExcerpt(value: string | undefined, redactor: SecretRedactor): string | null {
  const normalized = redactor.redact((value ?? "").replace(/\s+/g, " ").trim());
  if (!normalized) {
    return null;
  }

  const markers = [
    "429 too many requests",
    "too many requests",
    "502 bad gateway",
    "503 service unavailable",
    "504 gateway timeout",
    "unexpected status",
    "schema mismatch",
    "not valid json",
    "timed out",
    "stream disconnected before completion",
    "error sending request",
    "service unavailable",
    "bad gateway"
  ];
  const lower = normalized.toLowerCase();
  let markerIndex = -1;
  for (const marker of markers) {
    const index = lower.lastIndexOf(marker);
    if (index > markerIndex) {
      markerIndex = index;
    }
  }

  if (markerIndex >= 0) {
    const start = Math.max(0, markerIndex - 80);
    return normalized.slice(start, markerIndex + 320).trim();
  }

  if (/OpenAI Codex v/i.test(normalized) && /user # LeaderAgent Role Contract/i.test(normalized)) {
    return "Codex CLI exited before returning a structured diagnostic tail.";
  }

  return normalized.slice(Math.max(0, normalized.length - 500));
}

function compactLeaderEvidence(value: string | null | undefined): string {
  const redactor = new SecretRedactor(process.env);
  const normalized = (value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12)
    .join("\n");
  return normalizeDiagnosticExcerpt(normalized, redactor) ?? "None";
}

function classifyLeaderFailure(result: CodexJsonCallResult<LeaderDecision>): string {
  const combined = `${result.error ?? ""}\n${result.stderr}\n${result.rawMessage}`.toLowerCase();
  if (combined.includes("429 too many requests") || combined.includes("too many requests")) {
    return "provider_rate_limit";
  }
  if (combined.includes("502 bad gateway") || combined.includes("503 service unavailable") || combined.includes("504 gateway timeout")) {
    return "provider_upstream_error";
  }
  if (combined.includes("timed out")) {
    return "timeout";
  }
  if (combined.includes("schema mismatch") || combined.includes("not valid json")) {
    return "schema_or_json_failure";
  }
  return "nonzero_exit";
}

function resolveLeaderDiagnosticsPath(homeDir: string, context: LeaderContext): string {
  const rawLogPath = context.previousToolResult?.artifacts.log_path?.trim();
  if (rawLogPath) {
    const logPath = path.isAbsolute(rawLogPath) ? rawLogPath : path.resolve(process.cwd(), rawLogPath);
    if (logPath.endsWith(".round.log")) {
      return logPath.replace(/\.round\.log$/, ".leader.debug.json");
    }
    if (logPath.endsWith(".log")) {
      return logPath.replace(/\.log$/, ".leader.debug.json");
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(homeDir, "runs", `${stamp}.leader.debug.json`);
}

async function writeLeaderDiagnosticsArtifact(
  homeDir: string,
  context: LeaderContext,
  prompt: string,
  result: CodexJsonCallResult<LeaderDecision>,
  sandbox: AppConfig["codex"]["executorSandbox"],
  cwd: string
): Promise<string> {
  const redactor = new SecretRedactor(process.env);
  const diagnosticsPath = resolveLeaderDiagnosticsPath(homeDir, context);
  await writeJsonFile(diagnosticsPath, {
    created_at: new Date().toISOString(),
    failure_classification: classifyLeaderFailure(result),
    exit_code: (() => {
      const match = (result.error ?? "").match(/code (\d+)/i);
      return match ? Number(match[1]) : null;
    })(),
    timed_out: /timed out/i.test(result.error ?? ""),
    sandbox,
    cwd,
    prompt_chars: prompt.length,
    prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
    role_contract_mode: "runtime_json_v1",
    source_artifacts: {
      log_path: context.previousToolResult?.artifacts.log_path ?? null,
      state_change_path: context.previousToolResult?.artifacts.state_change_path ?? null
    },
    ...(context.previousHotFileGovernance
      ? {
          previous_hot_file_governance: redactJsonStrings(context.previousHotFileGovernance, redactor)
        }
      : {}),
    stderr_tail: extractUsefulDiagnosticExcerpt(result.stderr, redactor),
    raw_tail: extractUsefulDiagnosticExcerpt(result.rawMessage, redactor),
    error: normalizeDiagnosticExcerpt(result.error, redactor)
  });
  return diagnosticsPath;
}

function buildLeaderFailureMessage(
  result: CodexJsonCallResult<LeaderDecision>,
  diagnosticsPath?: string
): string {
  const redactor = new SecretRedactor(process.env);
  const baseMessage = normalizeDiagnosticExcerpt(result.error, redactor) ?? "Leader strategy execution failed";
  const details: string[] = [];
  const seen = new Set<string>([baseMessage]);
  const candidates: Array<{ label: "stderr" | "raw"; value: string | undefined }> = [
    { label: "stderr", value: result.stderr },
    { label: "raw", value: result.rawMessage }
  ];

  for (const candidate of candidates) {
    const excerpt = extractUsefulDiagnosticExcerpt(candidate.value, redactor);
    if (!excerpt || seen.has(excerpt)) {
      continue;
    }
    seen.add(excerpt);
    details.push(`${candidate.label}: ${excerpt}`);
  }

  if (diagnosticsPath) {
    details.push(`diagnostics: ${diagnosticsPath}`);
  }

  return details.length > 0 ? `${baseMessage} | ${details.join(" | ")}` : baseMessage;
}

function buildLeaderPrompt(context: LeaderContext, roleDefinition: string): string {
  const previousToolResultSummary = context.previousToolResult?.summary?.trim() ?? "None";
  const previousArtifactRefs = context.previousToolResult
    ? [
        `- Log Artifact: ${context.previousToolResult.artifacts.log_path || "None"}`,
        `- State Change Artifact: ${context.previousToolResult.artifacts.state_change_path || "None"}`
      ].join("\n")
    : "None";
  const dimensionsSummary = context.previousEvaluationDimensions
    ? context.previousEvaluationDimensions.map(d => 
        `- ${d.dimension}: ${d.decision} (score=${d.score}, confidence=${d.confidence}) - ${d.justification}`
      ).join("\n")
    : "None";
  const pauseDiagnosticSummary = context.previousHotFileGovernance
    ? `Hot-file governance block in ${context.previousHotFileGovernance.file_path} (${context.previousHotFileGovernance.result_class}): ${context.previousHotFileGovernance.reason}`
    : context.lastError ?? "None";
  const hotFileGovernanceSummary = context.previousHotFileGovernance
    ? [
        `- Class: ${context.previousHotFileGovernance.result_class}`,
        `- File: ${context.previousHotFileGovernance.file_path}`,
        `- Labels: ${context.previousHotFileGovernance.heuristic_labels.join(", ")}`,
        `- Reason: ${context.previousHotFileGovernance.reason}`,
        `- Next Action: ${context.previousHotFileGovernance.recommended_next_action}`
      ].join("\n")
    : "None";

  return [
    roleDefinition,
    "",
    "## Current State",
    `- Goal: ${context.goal}`,
    `- Last Error: ${context.lastError ?? "None"}`,
    `- Pause Diagnostic: ${pauseDiagnosticSummary}`,
    `- Previous Tool Result Summary: ${previousToolResultSummary}`,
    `- Previous Artifact References:\n${previousArtifactRefs}`,
    `- Previous Evaluation Dimensions:`,
    dimensionsSummary,
    "",
    `- Hot-File Governance Signal:`,
    hotFileGovernanceSummary,
    "",
    `- Recent State Change Evidence:`,
    compactLeaderEvidence(context.stateChange),
    "",
    "## Task",
    "Analyze the situation and decide the next move.",
    "If the executor claims success but the evaluator failed for missing evidence, treat that as a validation/evidence-handoff failure first, not as a product-code failure.",
    "1. If it's an 'implementation_failure', provide strategic instructions for the Executor and set action='resume'.",
    "2. If the goal in README.md is unreachable given the current constraints/logic, it's a 'constitutional_conflict'. Set action='escalate_to_ccb' and propose a change to README.md.",
    "3. Return strict JSON only.",
    "4. JSON fields must be exactly:",
    '{',
    '  "rationale": "short diagnosis",',
    '  "action": "resume" | "stop" | "escalate_to_ccb",',
    '  "diagnosis_type": "implementation_failure" | "constitutional_conflict",',
    '  "instructions": ["compact next-step instruction"],',
    '  "proposed_readme_change": "optional markdown when action=escalate_to_ccb"',
    '}'
  ].join("\n");
}

export interface LeaderExecuteOptions {
  context: LeaderContext;
  paths: { homeDir: string };
  onLog: (message: string) => void | Promise<void>;
}

export class LeaderAgent {
  private readonly codex: CodexClient;
  private readonly sandbox: AppConfig["codex"]["executorSandbox"];

  constructor(private readonly config: AppConfig) {
    this.codex = new CodexClient(config.codex);
    this.sandbox = "workspace-write";
  }

  async execute(options: LeaderExecuteOptions): Promise<LeaderDecision> {
    const roleDefinition = await loadProjectRoleDefinition(options.paths.homeDir, "leader");
    const prompt = buildLeaderPrompt(options.context, roleDefinition);

    await options.onLog("Leader analyzing failures and formulating strategy...");
    
    try {
      const result = await this.codex.runJson<LeaderDecision>({
        prompt,
        schema: LEADER_DECISION_SCHEMA,
        cwd: process.cwd(),
        sandbox: this.sandbox,
        sessionIsolation: {
          enabled: true,
          agentsGuide: buildInternalRuntimeSessionGuide("Leader", [
            "Keep reasoning anchored to the supplied failure, evaluation, and governance context unless the runtime prompt explicitly broadens scope."
          ])
        }
      });

      if (!result.ok || !result.data) {
        const diagnosticsPath = await writeLeaderDiagnosticsArtifact(
          options.paths.homeDir,
          options.context,
          prompt,
          result,
          this.sandbox,
          process.cwd()
        );
        await options.onLog(`Leader diagnostics artifact: ${diagnosticsPath}`);
        throw new Error(buildLeaderFailureMessage(result, diagnosticsPath));
      }

      await options.onLog(`Leader Diagnosis: ${result.data.diagnosis_type}. Action: ${result.data.action}.`);
      return result.data;
    } catch (err) {
      await options.onLog(`Leader Error: ${(err as Error).message}`);
      throw err;
    }
  }
}
