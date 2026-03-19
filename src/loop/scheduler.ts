import type { LoopPaths } from "./state";
import { hasFlag } from "./state";
import { sleep } from "../utils/time";

type CooldownSecondsSource = number | (() => Promise<number>);

export async function cooldownWithControlChecks(
  paths: LoopPaths,
  secondsSource: CooldownSecondsSource
): Promise<"continue" | "stop"> {
  const intervalMs = 1_000;
  let elapsed = 0;

  while (true) {
    const seconds = typeof secondsSource === "function" ? await secondsSource() : secondsSource;
    const totalMs = Math.max(0, seconds) * 1000;
    if (elapsed >= totalMs) {
      return "continue";
    }
    if (await hasFlag(paths.stopFlagPath)) {
      return "stop";
    }
    await sleep(intervalMs);
    elapsed += intervalMs;
  }
}

export async function waitWhilePaused(paths: LoopPaths): Promise<"resumed" | "stopped"> {
  while (await hasFlag(paths.pauseFlagPath)) {
    if (await hasFlag(paths.stopFlagPath)) {
      return "stopped";
    }
    await sleep(1_000);
  }
  return "resumed";
}
