export function shouldForceLogTailFollow(state: string | null | undefined): boolean {
  return state === "running";
}
