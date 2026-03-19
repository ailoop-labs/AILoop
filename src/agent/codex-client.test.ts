import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { DEFAULT_LLM_EVALUATOR_DIMENSIONS, type CodexConfig } from "../config/env";
import { AIClient, type ProcessRunner } from "./ai-client";

function createCodexConfig(): CodexConfig {
  return {
    bin: "codex",
    model: "",
    profile: "",
    plannerSandbox: "read-only",
    executorSandbox: "workspace-write",
    evaluatorSandbox: "workspace-write",
    timeoutMs: 3000,
    llmEvaluatorDimensions: [...DEFAULT_LLM_EVALUATOR_DIMENSIONS],
    llmEvaluatorMinPassScore: 75
  };
}

function createClaudeConfig(): CodexConfig {
  return {
    ...createCodexConfig(),
    bin: "claude",
    model: "claude-sonnet-4-5"
  };
}

function outputPathFromArgs(args: string[]): string {
  const outputIndex = args.findIndex((item) => item === "-o");
  if (outputIndex < 0 || outputIndex + 1 >= args.length) {
    throw new Error("output path was not found in codex args");
  }
  return args[outputIndex + 1] ?? "";
}

describe("AIClient.runJson", () => {
  test("inherits environment without isolation in Zero-Config model", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-env-test-"));
    const workspaceDir = path.join(sandboxRoot, "workspace");
    let capturedEnv: NodeJS.ProcessEnv | undefined;

    await fs.mkdir(workspaceDir, { recursive: true });

    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/mock/global/codex-home";

    try {
      const runner = (async function (_cmd, args) {
        capturedEnv = arguments[5] as NodeJS.ProcessEnv | undefined;
        await fs.writeFile(outputPathFromArgs(args), '{"status":"success"}', "utf8");
        return {
          code: 0,
          stdout: "",
          stderr: ""
        };
      }) as ProcessRunner;

      const client = new AIClient(createCodexConfig(), runner);
      const result = await client.runJson<{ status: string }>({
        prompt: "Return JSON",
        schema: { type: "object" },
        cwd: workspaceDir,
        sandbox: "read-only",
        maxRetries: 0
      });

      expect(result.ok).toBe(true);
      // In Zero-Config model, it should inherit the existing CODEX_HOME if present,
      // and NOT create an isolated one in .ailoop/codex-home
      expect(capturedEnv?.CODEX_HOME).toBe("/mock/global/codex-home");
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  test("can run an isolated Codex session from a scratch directory with a local AGENTS guide", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-codex-isolation-"));
    const workspaceDir = path.join(sandboxRoot, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    let capturedCwd = "";
    let capturedAgentsGuide = "";

    try {
      const runner: ProcessRunner = async (_cmd, args, cwd) => {
        capturedCwd = cwd;
        capturedAgentsGuide = await fs.readFile(path.join(cwd, "AGENTS.md"), "utf8");
        await fs.writeFile(outputPathFromArgs(args), '{"status":"success"}', "utf8");
        return {
          code: 0,
          stdout: "",
          stderr: ""
        };
      };

      const client = new AIClient(createCodexConfig(), runner);
      const result = await client.runJson<{ status: string }>({
        prompt: "Return JSON",
        schema: { type: "object" },
        cwd: workspaceDir,
        sandbox: "read-only",
        maxRetries: 0,
        sessionIsolation: {
          enabled: true,
          agentsGuide: "# Internal Runtime Agent Session\n\nExternal coding-assistant workflows do not apply.\n"
        }
      });

      expect(result.ok).toBe(true);
      expect(capturedCwd).not.toBe(workspaceDir);
      expect(capturedAgentsGuide).toContain("Internal Runtime Agent Session");
      expect(capturedAgentsGuide).toContain("do not apply");
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  test("runs Claude CLI in print mode with mapped permissions and schema instructions", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-claude-cli-"));
    const workspaceDir = path.join(sandboxRoot, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    let capturedCmd = "";
    let capturedArgs: string[] = [];

    try {
      const runner: ProcessRunner = async (cmd, args) => {
        capturedCmd = cmd;
        capturedArgs = [...args];
        return {
          code: 0,
          stdout: '{"status":"success"}',
          stderr: ""
        };
      };

      const client = new AIClient(createClaudeConfig(), runner);
      const result = await client.runJson<{ status: string }>({
        prompt: "Return JSON",
        schema: {
          type: "object",
          properties: {
            status: { type: "string" }
          },
          required: ["status"],
          additionalProperties: false
        },
        cwd: workspaceDir,
        sandbox: "workspace-write",
        maxRetries: 0
      });

      expect(result.ok).toBe(true);
      expect(result.data?.status).toBe("success");
      expect(capturedCmd).toBe("claude");
      expect(capturedArgs).toContain("--print");
      expect(capturedArgs).toContain("--permission-mode");
      expect(capturedArgs).toContain("acceptEdits");
      expect(capturedArgs).toContain("--add-dir");
      expect(capturedArgs).toContain(workspaceDir);
      expect(capturedArgs).toContain("--model");
      expect(capturedArgs).toContain("claude-sonnet-4-5");
      expect(capturedArgs).not.toContain("--output-schema");
      expect(capturedArgs).not.toContain("-o");

      // For Claude CLI, the prompt is passed via stdin, not as a command-line argument
      // So the prompt should NOT be in args
      expect(capturedArgs).not.toContain("IMPORTANT: You MUST return a single JSON object");
      expect(capturedArgs).not.toContain("Return JSON");
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  test("runs Codex exec in JSON mode and passes the prompt via stdin", async () => {
    let capturedArgs: string[] = [];
    let capturedStdin = "";

    const runner = (async function (_cmd, args) {
      capturedArgs = [...args];
      capturedStdin = (arguments[6] as string | undefined) ?? "";
      await fs.writeFile(outputPathFromArgs(args), '{"status":"success"}', "utf8");
      return {
        code: 0,
        stdout: "",
        stderr: ""
      };
    }) as ProcessRunner;

    const client = new AIClient(createCodexConfig(), runner);
    const result = await client.runJson<{ status: string }>({
      prompt: "Return JSON from stdin",
      schema: { type: "object" },
      cwd: process.cwd(),
      sandbox: "read-only",
      maxRetries: 0
    });

    expect(result.ok).toBe(true);
    expect(capturedArgs).toContain("exec");
    expect(capturedArgs).toContain("--json");
    expect(capturedArgs.at(-1)).toBe("-");
    expect(capturedStdin).toBe("Return JSON from stdin");
    expect(capturedArgs).not.toContain("Return JSON from stdin");
  });

  test("omits skip-git-repo-check for valid git repositories", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-ai-client-git-repo-"));
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
    let capturedArgs: string[] = [];

    try {
      const runner: ProcessRunner = async (_cmd, args) => {
        capturedArgs = [...args];
        await fs.writeFile(outputPathFromArgs(args), '{"status":"success"}', "utf8");
        return {
          code: 0,
          stdout: "",
          stderr: ""
        };
      };

      const client = new AIClient(createCodexConfig(), runner);
      const result = await client.runJson<{ status: string }>({
        prompt: "Return JSON",
        schema: { type: "object" },
        cwd: repoDir,
        sandbox: "read-only",
        maxRetries: 0
      });

      expect(result.ok).toBe(true);
      expect(capturedArgs).toContain("--json");
      expect(capturedArgs).not.toContain("--skip-git-repo-check");
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  test("adds skip-git-repo-check when session isolation moves Codex into a non-git scratch directory", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-ai-client-session-git-repo-"));
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
    let capturedArgs: string[] = [];

    try {
      const runner: ProcessRunner = async (_cmd, args) => {
        capturedArgs = [...args];
        await fs.writeFile(outputPathFromArgs(args), '{"status":"success"}', "utf8");
        return {
          code: 0,
          stdout: "",
          stderr: ""
        };
      };

      const client = new AIClient(createCodexConfig(), runner);
      const result = await client.runJson<{ status: string }>({
        prompt: "Return JSON",
        schema: { type: "object" },
        cwd: repoDir,
        sandbox: "read-only",
        maxRetries: 0,
        sessionIsolation: {
          enabled: true,
          agentsGuide: "Use runtime-safe instructions only."
        }
      });

      expect(result.ok).toBe(true);
      expect(capturedArgs).toContain("--json");
      expect(capturedArgs).toContain("--skip-git-repo-check");
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  test("uses resume with the prior session id on retryable Codex failures", async () => {
    const prompts: string[] = [];
    const capturedArgv: string[][] = [];
    const attempts = [
      {
        code: 0,
        stdout: '{"type":"session.started","session_id":"123e4567-e89b-12d3-a456-426614174000"}\n',
        stderr: "",
        output: "{bad json"
      },
      {
        code: 0,
        stdout: '{"type":"turn.completed"}\n',
        stderr: "",
        output: '{"status":"success"}'
      }
    ];

    const runner = (async function (_cmd, args) {
      capturedArgv.push([...args]);
      prompts.push((arguments[6] as string | undefined) ?? "");
      const step = attempts.shift();
      if (!step) {
        throw new Error("unexpected additional attempt");
      }
      await fs.writeFile(outputPathFromArgs(args), step.output, "utf8");
      return {
        code: step.code,
        stdout: step.stdout,
        stderr: step.stderr
      };
    }) as ProcessRunner;

    const client = new AIClient(createCodexConfig(), runner);
    const result = await client.runJson<{ status: string }>({
      prompt: "Return JSON",
      schema: { type: "object" },
      cwd: process.cwd(),
      sandbox: "read-only",
      maxRetries: 1
    });

    expect(result.ok).toBe(true);
    expect(capturedArgv).toHaveLength(2);
    expect(capturedArgv[0]).toEqual(expect.arrayContaining(["exec", "--json"]));
    expect(capturedArgv[1][0]).toBe("exec");
    expect(capturedArgv[1][1]).toBe("resume");
    expect(capturedArgv[1]).toContain("123e4567-e89b-12d3-a456-426614174000");
    expect(capturedArgv[1]).not.toContain("--output-schema");
    expect(capturedArgv[1]).toContain("-o");
    expect(capturedArgv[1].at(-1)).toBe("-");
    expect(prompts[1]).toContain("Retry attempt 1");
    expect(prompts[1]).toContain("IMPORTANT: You MUST return a single JSON object");
  });

  test("extracts structured error details from Codex JSONL events", async () => {
    const runner: ProcessRunner = async (_cmd, args) => {
      await fs.writeFile(outputPathFromArgs(args), "", "utf8");
      return {
        code: 1,
        stdout:
          '{"type":"session.started","session_id":"123e4567-e89b-12d3-a456-426614174000"}\n' +
          '{"type":"turn.failed","error":{"message":"usage limit exceeded (2056)"}}\n',
        stderr: ""
      };
    };

    const client = new AIClient(createCodexConfig(), runner);
    const result = await client.runJson({
      prompt: "Return JSON",
      schema: { type: "object" },
      cwd: process.cwd(),
      sandbox: "read-only",
      maxRetries: 0
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("usage limit exceeded");
  });

  test("retries invalid JSON and succeeds on a later attempt", async () => {
    const prompts: string[] = [];
    const attempts = [
      { code: 0, output: "{bad json", stdout: "attempt1", stderr: "" },
      { code: 0, output: '{"status":"success"}', stdout: "attempt2", stderr: "" }
    ];
    const runner = (async function (_cmd, args) {
      const step = attempts.shift();
      if (!step) {
        throw new Error("unexpected additional attempt");
      }
      prompts.push((arguments[6] as string | undefined) ?? "");
      await fs.writeFile(outputPathFromArgs(args), step.output, "utf8");
      return {
        code: step.code,
        stdout: step.stdout,
        stderr: step.stderr
      };
    }) as ProcessRunner;

    const client = new AIClient(createCodexConfig(), runner);
    const result = await client.runJson<{ status: string }>({
      prompt: "Return JSON",
      schema: { type: "object" },
      cwd: process.cwd(),
      sandbox: "read-only",
      maxRetries: 1
    });

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("success");
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain("Retry attempt 1");
    expect(result.stdout).toContain("attempt1");
    expect(result.stdout).toContain("attempt2");
  });

  test("extracts first JSON object from noisy output payload", async () => {
    const runner: ProcessRunner = async (_cmd, args) => {
      await fs.writeFile(
        outputPathFromArgs(args),
        `noise line\n{"status":"success","source":"embedded"}\nmore noise`,
        "utf8"
      );
      return {
        code: 0,
        stdout: "",
        stderr: ""
      };
    };

    const client = new AIClient(createCodexConfig(), runner);
    const result = await client.runJson<{ status: string; source: string }>({
      prompt: "Return JSON",
      schema: { type: "object" },
      cwd: process.cwd(),
      sandbox: "read-only",
      maxRetries: 0
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      status: "success",
      source: "embedded"
    });
  });

  test("uses the last complete JSON object when multiple objects are present in payload", async () => {
    const runner: ProcessRunner = async (_cmd, args) => {
      await fs.writeFile(
        outputPathFromArgs(args),
        `prefix\n{"status":"success","attempt":1}\n{"status":"success","attempt":2}\nsuffix`,
        "utf8"
      );
      return {
        code: 0,
        stdout: "",
        stderr: ""
      };
    };

    const client = new AIClient(createCodexConfig(), runner);
    const result = await client.runJson<{ status: string; attempt: number }>({
      prompt: "Return JSON",
      schema: { type: "object" },
      cwd: process.cwd(),
      sandbox: "read-only",
      maxRetries: 0
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      status: "success",
      attempt: 2
    });
  });

  test("accepts schema-valid JSON output when codex exits non-zero", async () => {
    const runner: ProcessRunner = async (_cmd, args) => {
      await fs.writeFile(outputPathFromArgs(args), '{"status":"success","source":"output"}', "utf8");
      return {
        code: 1,
        stdout: "",
        stderr: "codex exited non-zero after writing output"
      };
    };

    const client = new AIClient(createCodexConfig(), runner);
    const result = await client.runJson<{ status: string; source: string }>({
      prompt: "Return JSON",
      schema: {
        type: "object",
        properties: {
          status: { type: "string" },
          source: { type: "string" }
        },
        required: ["status", "source"],
        additionalProperties: false
      },
      cwd: process.cwd(),
      sandbox: "read-only",
      maxRetries: 0
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      status: "success",
      source: "output"
    });
  });

  test("falls back to parsing JSON from stderr when output payload is invalid", async () => {
    const runner: ProcessRunner = async (_cmd, args) => {
      await fs.writeFile(outputPathFromArgs(args), "", "utf8");
      return {
        code: 0,
        stdout: "",
        stderr: `preface log\n{"status":"success","source":"stderr"}\nsuffix log`
      };
    };

    const client = new AIClient(createCodexConfig(), runner);
    const result = await client.runJson<{ status: string; source: string }>({
      prompt: "Return JSON",
      schema: {
        type: "object",
        properties: {
          status: { type: "string" },
          source: { type: "string" }
        },
        required: ["status", "source"],
        additionalProperties: false
      },
      cwd: process.cwd(),
      sandbox: "read-only",
      maxRetries: 0
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      status: "success",
      source: "stderr"
    });
  });

  test("falls back to parsing JSON from stdout when output payload is invalid", async () => {
    const runner: ProcessRunner = async () => {
      return {
        code: 0,
        stdout: `preface log\n{"status":"success","source":"stdout"}\nsuffix log`,
        stderr: ""
      };
    };

    const client = new AIClient(createClaudeConfig(), runner);
    const result = await client.runJson<{ status: string; source: string }>({
      prompt: "Return JSON",
      schema: {
        type: "object",
        properties: {
          status: { type: "string" },
          source: { type: "string" }
        },
        required: ["status", "source"],
        additionalProperties: false
      },
      cwd: process.cwd(),
      sandbox: "read-only",
      maxRetries: 0
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      status: "success",
      source: "stdout"
    });
  });

  test("selects a schema-valid later JSON object from stderr fallback", async () => {
    const runner: ProcessRunner = async (_cmd, args) => {
      await fs.writeFile(outputPathFromArgs(args), "{invalid", "utf8");
      return {
        code: 0,
        stdout: "",
        stderr:
          'noise {"status":"progress"} still running {"status":"done","next_state_hint":"continue","actions":["patched"]}'
      };
    };

    const client = new AIClient(createCodexConfig(), runner);
    const result = await client.runJson<{ status: string; next_state_hint: string; actions: string[] }>({
      prompt: "Return JSON",
      schema: {
        type: "object",
        properties: {
          status: { type: "string" },
          next_state_hint: { type: "string" },
          actions: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: ["status", "next_state_hint", "actions"],
        additionalProperties: false
      },
      cwd: process.cwd(),
      sandbox: "read-only",
      maxRetries: 0
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      status: "done",
      next_state_hint: "continue",
      actions: ["patched"]
    });
  });

  test("returns failure after retry budget is exhausted", async () => {
    const runner: ProcessRunner = async (_cmd, args) => {
      await fs.writeFile(outputPathFromArgs(args), "{still invalid", "utf8");
      return {
        code: 0,
        stdout: "",
        stderr: ""
      };
    };

    const client = new AIClient(createCodexConfig(), runner);
    const result = await client.runJson({
      prompt: "Return JSON",
      schema: { type: "object" },
      cwd: process.cwd(),
      sandbox: "read-only",
      maxRetries: 1
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not valid JSON");
  });

  test("retries timeout failures and then succeeds", async () => {
    const attempts = [
      { code: 1, timedOut: true, output: "", stdout: "", stderr: "timed out" },
      { code: 0, timedOut: false, output: '{"status":"ok"}', stdout: "", stderr: "" }
    ];

    const runner: ProcessRunner = async (_cmd, args) => {
      const step = attempts.shift();
      if (!step) {
        throw new Error("unexpected additional attempt");
      }
      await fs.writeFile(outputPathFromArgs(args), step.output, "utf8");
      return {
        code: step.code,
        stdout: step.stdout,
        stderr: step.stderr,
        timedOut: step.timedOut
      };
    };

    const client = new AIClient(createCodexConfig(), runner);
    const result = await client.runJson<{ status: string }>({
      prompt: "Return JSON",
      schema: { type: "object" },
      cwd: process.cwd(),
      sandbox: "read-only",
      maxRetries: 1
    });

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("ok");
  });

  test("reports timeout instead of JSON parse failure when process times out", async () => {
    const runner: ProcessRunner = async (_cmd, args) => {
      await fs.writeFile(outputPathFromArgs(args), "", "utf8");
      return {
        code: 0,
        stdout: "",
        stderr: "runner timed out",
        timedOut: true
      };
    };

    const client = new AIClient(createCodexConfig(), runner);
    const result = await client.runJson({
      prompt: "Return JSON",
      schema: { type: "object" },
      cwd: process.cwd(),
      sandbox: "read-only",
      maxRetries: 0
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
    expect(result.error).not.toContain("not valid JSON");
  });

  test("captures configured model and token counts in timeout diagnostics when provider metadata is available", async () => {
    const runner: ProcessRunner = async (_cmd, args) => {
      await fs.writeFile(outputPathFromArgs(args), "", "utf8");
      return {
        code: 0,
        stdout:
          '{"type":"session.started","model":"provider-fallback-model"}\n' +
          '{"type":"turn.completed","usage":{"input_tokens":321,"output_tokens":34,"total_tokens":355}}\n',
        stderr: "runner timed out",
        timedOut: true,
        signal: null,
        timing: {
          timeoutMs: 30_000,
          totalRuntimeMs: 30_120,
          sigtermSentAfterMs: 30_000,
          sigkillSentAfterMs: null,
          exitObservedAfterMs: 30_120,
          shutdownAfterSigtermMs: 120,
          requiredSigkill: false
        }
      };
    };

    const client = new AIClient(
      {
        ...createCodexConfig(),
        model: "gpt-5.4"
      },
      runner
    );
    const result = await client.runJson({
      prompt: "Return JSON",
      schema: { type: "object" },
      cwd: process.cwd(),
      sandbox: "read-only",
      maxRetries: 0
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual({
      timedOut: true,
      model: "gpt-5.4",
      promptChars: "Return JSON".length,
      inputTokens: 321,
      outputTokens: 34,
      totalTokens: 355,
      exitCode: 0,
      exitSignal: null,
      timingBreakdown: {
        timeoutMs: 30_000,
        totalRuntimeMs: 30_120,
        sigtermSentAfterMs: 30_000,
        sigkillSentAfterMs: null,
        exitObservedAfterMs: 30_120,
        shutdownAfterSigtermMs: 120,
        requiredSigkill: false
      },
      partialProgress: null
    });
  });

  test("captures the last assistant progress checkpoint from timeout stdout metadata", async () => {
    const runner: ProcessRunner = async (_cmd, args) => {
      await fs.writeFile(outputPathFromArgs(args), "", "utf8");
      return {
        code: 1,
        stdout:
          '{"type":"response.output_text.delta","delta":{"text":"Read executor diagnostics flow"}}\n' +
          '{"type":"response.output_text.done","text":"Read executor diagnostics flow and prepared timeout checkpoint artifact."}\n' +
          '{"type":"turn.completed","usage":{"input_tokens":210,"output_tokens":45,"total_tokens":255}}\n',
        stderr: "runner timed out",
        timedOut: true,
        signal: "SIGKILL",
        timing: {
          timeoutMs: 30_000,
          totalRuntimeMs: 30_260,
          sigtermSentAfterMs: 30_000,
          sigkillSentAfterMs: 30_250,
          exitObservedAfterMs: 30_260,
          shutdownAfterSigtermMs: 260,
          requiredSigkill: true
        }
      };
    };

    const client = new AIClient(createCodexConfig(), runner);
    const result = await client.runJson({
      prompt: "Return JSON",
      schema: { type: "object" },
      cwd: process.cwd(),
      sandbox: "read-only",
      maxRetries: 0
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics?.partialProgress).toEqual({
      source: "stdout",
      kind: "assistant_message",
      eventType: "response.output_text.done",
      sessionId: null,
      excerpt: "Read executor diagnostics flow and prepared timeout checkpoint artifact."
    });
    expect(result.diagnostics?.exitCode).toBe(1);
    expect(result.diagnostics?.exitSignal).toBe("SIGKILL");
    expect(result.diagnostics?.timingBreakdown).toEqual({
      timeoutMs: 30_000,
      totalRuntimeMs: 30_260,
      sigtermSentAfterMs: 30_000,
      sigkillSentAfterMs: 30_250,
      exitObservedAfterMs: 30_260,
      shutdownAfterSigtermMs: 260,
      requiredSigkill: true
    });
  });

  test("waits one minute and retries transient interface errors before succeeding", async () => {
    const attempts = [
      { code: 1, output: "", stdout: "", stderr: "ERROR: unexpected status 502 Bad Gateway: upstream" },
      { code: 1, output: "", stdout: "", stderr: "ERROR: unexpected status 502 Bad Gateway: upstream" },
      { code: 0, output: '{"status":"ok"}', stdout: "", stderr: "" }
    ];
    const sleepCalls: number[] = [];
    const stderrChunks: string[] = [];

    const runner: ProcessRunner = async (_cmd, args) => {
      const step = attempts.shift();
      if (!step) {
        throw new Error("unexpected additional attempt");
      }
      await fs.writeFile(outputPathFromArgs(args), step.output, "utf8");
      return {
        code: step.code,
        stdout: step.stdout,
        stderr: step.stderr
      };
    };

    const client = new AIClient(createCodexConfig(), runner, async (ms) => {
      sleepCalls.push(ms);
    });
    const result = await client.runJson<{ status: string }>({
      prompt: "Return JSON",
      schema: { type: "object" },
      cwd: process.cwd(),
      sandbox: "read-only",
      maxRetries: 0,
      onStderrChunk: (chunk) => {
        stderrChunks.push(chunk);
      }
    });

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("ok");
    expect(sleepCalls).toEqual([60_000, 120_000, 0]);
    const retryNotices = stderrChunks.filter((line) => line.includes("AILoop interface retry"));
    expect(retryNotices.length).toBe(2);
    expect(retryNotices[0]).toContain("waiting 60000ms");
  });

  test("retries stream-disconnect request failures and succeeds on a later attempt", async () => {
    const attempts = [
      {
        code: 1,
        output: "",
        stdout: "",
        stderr:
          "Codex exited with code 1\nstream disconnected before completion: error sending request for url (https://api.openai.com/v1/responses)"
      },
      { code: 0, output: '{"status":"ok"}', stdout: "", stderr: "" }
    ];
    const sleepCalls: number[] = [];
    const stderrChunks: string[] = [];

    const runner: ProcessRunner = async (_cmd, args) => {
      const step = attempts.shift();
      if (!step) {
        throw new Error("unexpected additional attempt");
      }
      await fs.writeFile(outputPathFromArgs(args), step.output, "utf8");
      return {
        code: step.code,
        stdout: step.stdout,
        stderr: step.stderr
      };
    };

    const client = new AIClient(createCodexConfig(), runner, async (ms) => {
      sleepCalls.push(ms);
    });
    const result = await client.runJson<{ status: string }>({
      prompt: "Return JSON",
      schema: { type: "object" },
      cwd: process.cwd(),
      sandbox: "read-only",
      maxRetries: 0,
      onStderrChunk: (chunk) => {
        stderrChunks.push(chunk);
      }
    });

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("ok");
    expect(sleepCalls).toEqual([60_000, 0]);
    expect(stderrChunks.some((line) => line.includes("AILoop interface retry 1/5"))).toBe(true);
  });

  test("does not retry generic request-send failures without a disconnect signal", async () => {
    let callCount = 0;
    const sleepCalls: number[] = [];

    const runner: ProcessRunner = async (_cmd, args) => {
      callCount += 1;
      await fs.writeFile(outputPathFromArgs(args), "", "utf8");
      return {
        code: 1,
        stdout: "",
        stderr: "Codex exited with code 1\nerror sending request for url (https://api.openai.com/v1/responses)"
      };
    };

    const client = new AIClient(createCodexConfig(), runner, async (ms) => {
      sleepCalls.push(ms);
    });
    const result = await client.runJson({
      prompt: "Return JSON",
      schema: { type: "object" },
      cwd: process.cwd(),
      sandbox: "read-only",
      maxRetries: 0
    });

    expect(result.ok).toBe(false);
    expect(callCount).toBe(1);
    expect(sleepCalls).toEqual([0]);
  });

  test("fails only after five interface-error retries are exhausted", async () => {
    let callCount = 0;
    const sleepCalls: number[] = [];

    const runner: ProcessRunner = async (_cmd, args) => {
      callCount += 1;
      await fs.writeFile(outputPathFromArgs(args), "", "utf8");
      return {
        code: 1,
        stdout: "",
        stderr: "ERROR: unexpected status 502 Bad Gateway: upstream"
      };
    };

    const client = new AIClient(createCodexConfig(), runner, async (ms) => {
      sleepCalls.push(ms);
    });
    const result = await client.runJson({
      prompt: "Return JSON",
      schema: { type: "object" },
      cwd: process.cwd(),
      sandbox: "read-only",
      maxRetries: 0
    });

    expect(result.ok).toBe(false);
    expect(callCount).toBe(6);
    expect(sleepCalls).toEqual([60_000, 120_000, 240_000, 300_000, 300_000, 0]);
  });
});
