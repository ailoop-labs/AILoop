import type { AppConfig } from "../config/env";
import type { LoopPaths } from "../loop/state";
import type { ActionRecord, SubTask, ToolResult } from "../types/contracts";
import type { Guardrails } from "./guardrails";
import { CodexClient, type JsonSchema } from "./codex-client";
import { loadProjectRoleDefinition } from "./role-definitions";
import { ToolRegistry } from "./tool-registry";

interface ExecuteOptions {
  subTask: SubTask;
  round: number;
  goal: string;
  instructions: string[];
  guardrails: Guardrails;
  paths: LoopPaths;
  onLog?: (message: string) => void | Promise<void>;
}

export interface ExecuteResult {
  toolResult: ToolResult;
  actions: ActionRecord[];
}

interface CodexExecutorResponse {
  status: "success" | "failure";
  summary: string;
  error_type: string;
  error_message: string;
  next_state_hint: "continue" | "pause" | "stop";
  actions: string[];
}

export interface ExecutorPromptInput {
  round: number;
  goal: string;
  instructions: string[];
  subTask: SubTask;
  ailoopHome: string;
  workspaceRoot: string;
  availableTools: Array<{ name: string; description: string }>;
  availableSkills: Array<{ name: string; description: string }>;
}

const EXECUTOR_RESPONSE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["success", "failure"] },
    summary: { type: "string" },
    error_type: { type: "string" },
    error_message: { type: "string" },
    next_state_hint: { type: "string", enum: ["continue", "pause", "stop"] },
    actions: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: ["status", "summary", "error_type", "error_message", "next_state_hint", "actions"],
  additionalProperties: false
};

function normalizeActions(rawActions: string[], status: "success" | "failure", errorMessage: string): ActionRecord[] {
  const actions = rawActions.slice(0, 50).map((item, index) => ({
    tool: "codex_step",
    args: { index: index + 1 },
    ok: status === "success",
    output: String(item),
    error: status === "success" ? undefined : errorMessage
  }));

  return actions.length > 0
    ? actions
    : [
        {
          tool: "codex_step",
          args: { index: 1 },
          ok: status === "success",
          output: "No action details returned by Codex.",
          error: status === "success" ? undefined : errorMessage
        }
      ];
}

function toLogLines(source: "stdout" | "stderr", chunk: string): string[] {
  return chunk
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => `[codex ${source}] ${line}`);
}

function emitLog(options: ExecuteOptions, message: string): void {
  if (!options.onLog) {
    return;
  }

  void Promise.resolve(options.onLog(message)).catch(() => {
    // Logging must never block executor flow.
  });
}

export function buildExecutorPrompt(input: ExecutorPromptInput, executorRoleDefinition: string): string {
  return [
    "You are the AILoop Executor agent.",
    "Project-specific Executor Role Definition:",
    executorRoleDefinition.trim(),
    "",
    "Complete exactly one atomic sub-task in this workspace.",
    "",
    "Hard requirements:",
    "- Use observe -> reason -> act loop internally.",
    "- Verify target state before any mutation (read before write).",
    "- Retry at most 3 times for the same error before failing.",
    "- Keep actions minimal and deterministic.",
    "- Prioritize concrete progress toward subTask.expected_outcome; avoid cosmetic-only edits.",
    "- If blocked by missing context or unavailable prerequisites, fail explicitly instead of guessing.",
    "- Return final JSON strictly matching schema.",
    "",
    "For successful completion after verification, also:",
    "- create a git commit with a concise factual message",
    "- push the commit to origin on the current branch",
    "- restart production service with: bash scripts/prod.sh restart",
    "- Include evidence in your final response for:",
    "- verification commands and outcomes",
    "- commit hash/message",
    "- push result (remote/branch)",
    "- restart result (PID/log path if available)",
    "",
    "Available tool semantics for action log naming:",
    JSON.stringify(input.availableTools, null, 2),
    "",
    "Available Expert Skills (use activate_skill to load):",
    JSON.stringify(input.availableSkills, null, 2),
    "",
    "Round input:",
    JSON.stringify(
      {
        round: input.round,
        goal: input.goal,
        instructions: input.instructions,
        subTask: input.subTask,
        ailoopHome: input.ailoopHome,
        workspaceRoot: input.workspaceRoot
      },
      null,
      2
    ),
    "",
    "After performing actions in the workspace, output:",
    "- status: success or failure",
    "- summary: short factual sentence",
    "- error_type: empty string on success, otherwise a short machine-friendly type",
    "- error_message: empty string on success, otherwise a concrete failure reason",
    "- next_state_hint: continue/pause/stop",
    "- actions: ordered list of concise action strings"
  ].join("\n");
}

export class ExecutorAgent {
  private readonly codex: CodexClient;
  private readonly sandbox: AppConfig["codex"]["executorSandbox"];
  private readonly homeDir: string;

  constructor(
    private readonly tools: ToolRegistry,
    config: AppConfig
  ) {
    this.codex = new CodexClient(config.codex);
    this.sandbox = config.codex.executorSandbox;
    this.homeDir = config.homeDir;
  }

  async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    await this.tools.initialize();
    const availableTools = this.tools.listTools().map((tool) => ({
      name: tool.name,
      description: tool.description
    }));
    const availableSkills = this.tools.getSkillManager().getAvailableSkills().map((skill) => ({
      name: skill.name,
      description: skill.description
    }));
    const executorRoleDefinition = await loadProjectRoleDefinition(this.homeDir, "executor");
    const prompt = buildExecutorPrompt(
      {
        round: options.round,
        goal: options.goal,
        instructions: options.instructions,
        subTask: options.subTask,
        ailoopHome: options.paths.homeDir,
        workspaceRoot: process.cwd(),
        availableTools,
        availableSkills
      },
      executorRoleDefinition
    );

    emitLog(options, "Executor started Codex execution.");
    const heartbeatStartedAt = Date.now();
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - heartbeatStartedAt) / 1000);
      emitLog(options, `Executor running... ${elapsedSeconds}s elapsed.`);
    }, 15_000);

    const codexResult = await this.codex
      .runJson<CodexExecutorResponse>({
        prompt,
        schema: EXECUTOR_RESPONSE_SCHEMA,
        cwd: process.cwd(),
        sandbox: this.sandbox,
        onStdoutChunk: (chunk) => {
          for (const line of toLogLines("stdout", chunk)) {
            emitLog(options, line);
          }
        },
        onStderrChunk: (chunk) => {
          for (const line of toLogLines("stderr", chunk)) {
            emitLog(options, line);
          }
        }
      })
      .finally(() => {
        clearInterval(heartbeat);
      });
    emitLog(options, `Executor Codex execution finished (ok=${codexResult.ok}).`);

    if (!codexResult.ok || !codexResult.data) {
      options.guardrails.recordAction(0);
      return {
        actions: [
          {
            tool: "codex_exec",
            args: { round: options.round },
            ok: false,
            output: codexResult.stdout,
            error: codexResult.error ?? codexResult.stderr ?? "Codex execution failed"
          }
        ],
        toolResult: {
          status: "failure",
          summary: "Executor could not complete the task because Codex execution failed.",
          artifacts: {
            state_change_path: "",
            log_path: ""
          },
          error: {
            type: "CodexExecError",
            message: codexResult.error ?? codexResult.stderr ?? "Unknown Codex execution error"
          },
          next_state_hint: "pause"
        }
      };
    }

    const safeStatus = codexResult.data.status === "success" ? "success" : "failure";
    const safeErrorMessage = String(codexResult.data.error_message ?? "").trim();
    const safeErrorType = String(codexResult.data.error_type ?? "").trim() || "ExecutorFailure";
    const normalizedActions = normalizeActions(codexResult.data.actions ?? [], safeStatus, safeErrorMessage);
    const countedActions = Math.max(1, normalizedActions.length);
    for (let index = 0; index < countedActions; index += 1) {
      options.guardrails.recordAction(0);
    }

    const safeError =
      safeStatus === "success"
        ? null
        : {
            type: safeErrorType,
            message: safeErrorMessage || "Codex reported failure without detailed error"
          };

    return {
      actions: normalizedActions,
      toolResult: {
        status: safeStatus,
        summary: String(codexResult.data.summary || "No summary provided by Codex executor."),
        artifacts: {
          state_change_path: "",
          log_path: ""
        },
        error: safeError,
        next_state_hint: codexResult.data.next_state_hint ?? (safeStatus === "success" ? "continue" : "pause")
      }
    };
  }
}
