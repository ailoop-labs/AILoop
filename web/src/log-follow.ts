interface LogTailFollowBehavior {
  startFollowing: boolean;
  forceFollowing: boolean;
}

export function shouldForceLogTailFollow(state: string | null | undefined): boolean {
  return state === "running";
}

export function resolveLogTailFollowBehavior(state: string | null | undefined): LogTailFollowBehavior {
  return {
    startFollowing: true,
    forceFollowing: shouldForceLogTailFollow(state)
  };
}
