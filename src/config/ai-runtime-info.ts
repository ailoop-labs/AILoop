import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type AiCliProvider = "codex" | "claude" | "gemini" | "opencode";

export interface AiCliRuntimeInfo {
  bin: string;
  provider: AiCliProvider;
  claudeSettingsPath: string | null;
  claudeBaseUrlOverride: string | null;
  claudeModelOverride: string | null;
  warning: string | null;
}

interface ClaudeSettingsSummary {
  settingsPath: string;
  anthropicBaseUrl: string | null;
  anthropicModel: string | null;
}

function trimString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function detectAiCliProvider(bin: string): AiCliProvider {
  const normalized = path.basename(bin.trim()).toLowerCase();
  if (normalized === "claude" || normalized.includes("claude")) {
    return "claude";
  }
  if (normalized === "gemini" || normalized.includes("gemini")) {
    return "gemini";
  }
  if (normalized === "opencode" || normalized.includes("opencode")) {
    return "opencode";
  }
  return "codex";
}

async function readClaudeSettings(homeDir = os.homedir()): Promise<ClaudeSettingsSummary | null> {
  const settingsPath = path.join(homeDir, ".claude", "settings.json");

  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as {
      env?: Record<string, unknown>;
    };
    const env = parsed.env ?? {};

    return {
      settingsPath,
      anthropicBaseUrl: trimString(env.ANTHROPIC_BASE_URL),
      anthropicModel:
        trimString(env.ANTHROPIC_MODEL) ??
        trimString(env.ANTHROPIC_DEFAULT_OPUS_MODEL) ??
        trimString(env.ANTHROPIC_DEFAULT_SONNET_MODEL) ??
        trimString(env.ANTHROPIC_DEFAULT_HAIKU_MODEL)
    };
  } catch {
    return null;
  }
}

export async function getAiCliRuntimeInfo(bin: string, homeDir = os.homedir()): Promise<AiCliRuntimeInfo> {
  const provider = detectAiCliProvider(bin);
  const claudeSettings = await readClaudeSettings(homeDir);
  const claudeBaseUrlOverride = claudeSettings?.anthropicBaseUrl ?? null;
  const claudeModelOverride = claudeSettings?.anthropicModel ?? null;

  let warning: string | null = null;
  if (claudeBaseUrlOverride) {
    if (provider === "claude") {
      warning = `Claude CLI on this machine is routed through ${claudeBaseUrlOverride} via ${claudeSettings?.settingsPath}; selecting Claude here will consume that provider's quota.`;
    } else {
      warning = `Local Claude routing override detected at ${claudeSettings?.settingsPath}: ${claudeBaseUrlOverride}. It is inactive while the execution provider is ${provider}.`;
    }
  }

  return {
    bin,
    provider,
    claudeSettingsPath: claudeSettings?.settingsPath ?? null,
    claudeBaseUrlOverride,
    claudeModelOverride,
    warning
  };
}
