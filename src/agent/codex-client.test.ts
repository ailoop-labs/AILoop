import fs from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { DEFAULT_LLM_EVALUATOR_DIMENSIONS, type CodexConfig } from "../config/env";
import { CodexClient, type ProcessRunner } from "./codex-client";

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

function outputPathFromArgs(args: string[]): string {
  const outputIndex = args.findIndex((item) => item === "-o");
  if (outputIndex < 0 || outputIndex + 1 >= args.length) {
    throw new Error("output path was not found in codex args");
  }
  return args[outputIndex + 1] ?? "";
}

describe("CodexClient.runJson", () => {
  test("retries invalid JSON and succeeds on a later attempt", async () => {
    const prompts: string[] = [];
    const attempts = [
      { code: 0, output: "{bad json", stdout: "attempt1", stderr: "" },
      { code: 0, output: '{"status":"success"}', stdout: "attempt2", stderr: "" }
    ];
    const runner: ProcessRunner = async (_cmd, args) => {
      const step = attempts.shift();
      if (!step) {
        throw new Error("unexpected additional attempt");
      }
      prompts.push(args.at(-1) ?? "");
      await fs.writeFile(outputPathFromArgs(args), step.output, "utf8");
      return {
        code: step.code,
        stdout: step.stdout,
        stderr: step.stderr
      };
    };

    const client = new CodexClient(createCodexConfig(), runner);
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

    const client = new CodexClient(createCodexConfig(), runner);
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

  test("returns failure after retry budget is exhausted", async () => {
    const runner: ProcessRunner = async (_cmd, args) => {
      await fs.writeFile(outputPathFromArgs(args), "{still invalid", "utf8");
      return {
        code: 0,
        stdout: "",
        stderr: ""
      };
    };

    const client = new CodexClient(createCodexConfig(), runner);
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

    const client = new CodexClient(createCodexConfig(), runner);
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
});
