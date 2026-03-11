import { describe, expect, test } from "bun:test";
import { resolveLogTailFollowBehavior, shouldForceLogTailFollow } from "./log-follow";

describe("shouldForceLogTailFollow", () => {
  test("returns true for active startup and running states", () => {
    expect(shouldForceLogTailFollow("starting")).toBe(true);
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

describe("resolveLogTailFollowBehavior", () => {
  test("starts at latest line even when loop is not running", () => {
    expect(resolveLogTailFollowBehavior("idle")).toEqual({
      startFollowing: true,
      forceFollowing: false
    });
    expect(resolveLogTailFollowBehavior("paused")).toEqual({
      startFollowing: true,
      forceFollowing: false
    });
    expect(resolveLogTailFollowBehavior(null)).toEqual({
      startFollowing: true,
      forceFollowing: false
    });
  });
});
