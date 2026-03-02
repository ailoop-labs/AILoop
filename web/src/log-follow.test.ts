import { describe, expect, test } from "bun:test";
import { shouldForceLogTailFollow } from "./log-follow";

describe("shouldForceLogTailFollow", () => {
  test("returns true only for running state", () => {
    expect(shouldForceLogTailFollow("running")).toBe(true);
    expect(shouldForceLogTailFollow("paused")).toBe(false);
    expect(shouldForceLogTailFollow("cooldown")).toBe(false);
    expect(shouldForceLogTailFollow("idle")).toBe(false);
    expect(shouldForceLogTailFollow("stopping")).toBe(false);
    expect(shouldForceLogTailFollow("error")).toBe(false);
    expect(shouldForceLogTailFollow(undefined)).toBe(false);
    expect(shouldForceLogTailFollow(null)).toBe(false);
  });
});
