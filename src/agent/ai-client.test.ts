import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { AIClient, PROCESS_TIMEOUT_GRACE_MS, type ProcessRunner, runProcess } from "./ai-client";

function outputPathFromArgs(args: string[]): string {
  const outputIndex = args.findIndex((item) => item === "-o");
  if (outputIndex < 0 || outputIndex + 1 >= args.length) {
    throw new Error("output path was not found in AI client args");
  }
  return args[outputIndex + 1] ?? "";
}

describe("runProcess timeout handling", () => {
  test("captures final output from a process that exits during the SIGTERM grace window", async () => {
    const result = await runProcess(
      process.execPath,
      [
        "-e",
        [
          "process.stdout.write('started\\n');",
          "process.stderr.write('waiting\\n');",
          "process.on('SIGTERM', () => {",
          "  process.stdout.write('final stdout\\n');",
          "  process.stderr.write('final stderr\\n');",
          "  setTimeout(() => process.exit(0), 20);",
          "});",
          "setInterval(() => {}, 1000);"
        ].join("\n")
      ],
      process.cwd(),
      50
    );

    expect(result.timedOut).toBe(true);
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain("started");
    expect(result.stdout).toContain("final stdout");
    expect(result.stderr).toContain("waiting");
    expect(result.stderr).toContain("final stderr");
    expect(result.timing?.timeoutMs).toBe(50);
    expect(result.timing?.sigtermSentAfterMs).toBeGreaterThanOrEqual(50);
    expect(result.timing?.sigkillSentAfterMs).toBeNull();
    expect(result.timing?.shutdownAfterSigtermMs).not.toBeNull();
    expect(result.timing?.requiredSigkill).toBe(false);
  });

  test("escalates to SIGKILL when a process ignores SIGTERM", async () => {
    const startedAt = Date.now();
    const result = await runProcess(
      process.execPath,
      [
        "-e",
        [
          "process.stdout.write('started\\n');",
          "process.on('SIGTERM', () => {",
          "  process.stdout.write('ignoring sigterm\\n');",
          "});",
          "setInterval(() => {}, 1000);"
        ].join("\n")
      ],
      process.cwd(),
      50
    );

    const elapsedMs = Date.now() - startedAt;

    expect(result.timedOut).toBe(true);
    expect(result.code).toBe(1);
    expect(result.signal).toBe("SIGKILL");
    expect(result.stdout).toContain("started");
    expect(result.stdout).toContain("ignoring sigterm");
    expect(elapsedMs).toBeGreaterThanOrEqual(PROCESS_TIMEOUT_GRACE_MS);
    expect(result.timing?.timeoutMs).toBe(50);
    expect(result.timing?.sigtermSentAfterMs).toBeGreaterThanOrEqual(50);
    expect(result.timing?.sigkillSentAfterMs).toBeGreaterThanOrEqual(50 + PROCESS_TIMEOUT_GRACE_MS);
    expect(result.timing?.requiredSigkill).toBe(true);
  });
});

describe("AIClient.runJson configured provider execution", () => {
  test("invokes only the configured CLI binary on a successful JSON call", async () => {
    const configuredBin = "/mock/bin/custom-codex";
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-ai-client-single-provider-"));
    const invocations: Array<{ cmd: string; args: string[] }> = [];

    try {
      const runner: ProcessRunner = async (cmd, args) => {
        invocations.push({ cmd, args: [...args] });
        await fs.writeFile(outputPathFromArgs(args), '{"status":"success"}', "utf8");
        return {
          code: 0,
          stdout: "",
          stderr: ""
        };
      };

      const client = new AIClient(
        {
          bin: configuredBin,
          model: "",
          profile: "",
          plannerSandbox: "read-only",
          executorSandbox: "workspace-write",
          evaluatorSandbox: "workspace-write",
          timeoutMs: 1000,
          llmEvaluatorDimensions: [],
          llmEvaluatorMinPassScore: 75
        },
        runner
      );

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
        sandbox: "read-only",
        maxRetries: 0
      });

      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ status: "success" });
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toEqual({
        cmd: configuredBin,
        args: expect.arrayContaining(["exec", "--json"])
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
