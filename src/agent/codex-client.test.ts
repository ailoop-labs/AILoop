import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  test("launches codex with an isolated AILoop-managed CODEX_HOME", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-codex-home-test-"));
    const workspaceDir = path.join(sandboxRoot, "workspace");
    const globalHomeDir = path.join(sandboxRoot, "global-home");
    const ailoopHomeDir = path.join(sandboxRoot, "ailoop-home");
    const globalCodexDir = path.join(globalHomeDir, ".codex");
    const globalAuthPath = path.join(globalCodexDir, "auth.json");
    const globalConfigPath = path.join(globalCodexDir, "config.toml");
    const expectedCodexHome = path.join(ailoopHomeDir, "codex-home");
    let capturedEnv: NodeJS.ProcessEnv | undefined;

    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(globalCodexDir, { recursive: true });
    await fs.mkdir(ailoopHomeDir, { recursive: true });
    await fs.writeFile(globalAuthPath, '{"OPENAI_API_KEY":"test-key"}\n', "utf8");
    await fs.writeFile(globalConfigPath, 'model = "broken"\nmodel = "duplicate"\n', "utf8");

    const originalHome = process.env.HOME;
    const originalAiloopHome = process.env.AILOOP_HOME;
    process.env.HOME = globalHomeDir;
    process.env.AILOOP_HOME = ailoopHomeDir;

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

      const client = new CodexClient(createCodexConfig(), runner);
      const result = await client.runJson<{ status: string }>({
        prompt: "Return JSON",
        schema: { type: "object" },
        cwd: workspaceDir,
        sandbox: "read-only",
        maxRetries: 0
      });

      expect(result.ok).toBe(true);
      expect(capturedEnv?.CODEX_HOME).toBe(expectedCodexHome);
      expect(await fs.readFile(path.join(expectedCodexHome, "auth.json"), "utf8")).toBe(
        await fs.readFile(globalAuthPath, "utf8")
      );
      expect(
        await fs
          .access(path.join(expectedCodexHome, "config.toml"))
          .then(() => true)
          .catch(() => false)
      ).toBe(false);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }

      if (originalAiloopHome === undefined) {
        delete process.env.AILOOP_HOME;
      } else {
        process.env.AILOOP_HOME = originalAiloopHome;
      }
    }
  });

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

    const client = new CodexClient(createCodexConfig(), runner);
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

    const client = new CodexClient(createCodexConfig(), runner);
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

    const client = new CodexClient(createCodexConfig(), runner);
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
    const runner: ProcessRunner = async (_cmd, args) => {
      await fs.writeFile(outputPathFromArgs(args), "", "utf8");
      return {
        code: 0,
        stdout: `preface log\n{"status":"success","source":"stdout"}\nsuffix log`,
        stderr: ""
      };
    };

    const client = new CodexClient(createCodexConfig(), runner);
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

    const client = new CodexClient(createCodexConfig(), runner);
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

    const client = new CodexClient(createCodexConfig(), runner);
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

    const client = new CodexClient(createCodexConfig(), runner, async (ms) => {
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
    expect(sleepCalls).toEqual([60_000, 60_000, 0]);
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

    const client = new CodexClient(createCodexConfig(), runner, async (ms) => {
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

    const client = new CodexClient(createCodexConfig(), runner, async (ms) => {
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

    const client = new CodexClient(createCodexConfig(), runner, async (ms) => {
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
    expect(sleepCalls).toEqual([60_000, 60_000, 60_000, 60_000, 60_000, 0]);
  });
});
