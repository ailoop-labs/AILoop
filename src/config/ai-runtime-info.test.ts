import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { detectAiCliProvider, getAiCliRuntimeInfo } from "./ai-runtime-info";

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("detectAiCliProvider", () => {
  test("classifies supported binaries by basename", () => {
    expect(detectAiCliProvider("codex")).toBe("codex");
    expect(detectAiCliProvider("/opt/homebrew/bin/claude")).toBe("claude");
    expect(detectAiCliProvider("/usr/local/bin/gemini")).toBe("gemini");
    expect(detectAiCliProvider("opencode")).toBe("opencode");
  });
});

describe("getAiCliRuntimeInfo", () => {
  test("reports an active Claude routing override from local settings", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-ai-runtime-info-"));
    tempDirs.add(homeDir);
    await fs.mkdir(path.join(homeDir, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".claude", "settings.json"),
      JSON.stringify(
        {
          env: {
            ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic",
            ANTHROPIC_MODEL: "MiniMax-M2.7"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const info = await getAiCliRuntimeInfo("/opt/homebrew/bin/claude", homeDir);

    expect(info).toMatchObject({
      bin: "/opt/homebrew/bin/claude",
      provider: "claude",
      claudeBaseUrlOverride: "https://api.minimaxi.com/anthropic",
      claudeModelOverride: "MiniMax-M2.7"
    });
    expect(info.warning).toContain("will consume that provider's quota");
  });

  test("reports an inactive Claude routing override while codex is selected", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-ai-runtime-info-"));
    tempDirs.add(homeDir);
    await fs.mkdir(path.join(homeDir, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".claude", "settings.json"),
      JSON.stringify(
        {
          env: {
            ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const info = await getAiCliRuntimeInfo("codex", homeDir);

    expect(info.provider).toBe("codex");
    expect(info.warning).toContain("inactive while the execution provider is codex");
  });
});
