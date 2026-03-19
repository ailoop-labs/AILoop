import { describe, expect, test } from "bun:test";
import { PROCESS_TIMEOUT_GRACE_MS, runProcess } from "./ai-client";

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
    expect(result.stdout).toContain("started");
    expect(result.stdout).toContain("final stdout");
    expect(result.stderr).toContain("waiting");
    expect(result.stderr).toContain("final stderr");
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
    expect(result.stdout).toContain("started");
    expect(result.stdout).toContain("ignoring sigterm");
    expect(elapsedMs).toBeGreaterThanOrEqual(PROCESS_TIMEOUT_GRACE_MS);
  });
});
