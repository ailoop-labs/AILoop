import type { LoopPaths } from "./state";
import { hasFlag } from "./state";
import { sleep } from "../utils/time";

export async function cooldownWithControlChecks(paths: LoopPaths, seconds: number): Promise<"continue" | "stop"> {
  const totalMs = Math.max(0, seconds) * 1000;
  const intervalMs = 1_000;
  let elapsed = 0;

  while (elapsed < totalMs) {
    if (await hasFlag(paths.stopFlagPath)) {
      return "stop";
    }
    await sleep(intervalMs);
    elapsed += intervalMs;
  }

  return "continue";
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
