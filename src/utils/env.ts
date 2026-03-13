import { execSync } from "node:child_process";

/**
 * Hydrates the current process.env by sourcing the user's login shell.
 * This ensures that background processes (like nohup/UI daemons) inherit 
 * PATH, CODEX_HOME, and all MCP/Skills related environment variables 
 * without requiring duplicate entries in .env.
 */
export function hydrateEnvFromShell(): void {
  // If we already have a reasonably rich environment, skip (unless forced)
  if ((process.env.PATH?.split(":").length ?? 0) > 8 && !process.env.AILOOP_FORCE_HYDRATE) {
    return;
  }

  try {
    const shell = process.env.SHELL || "/bin/bash";
    // -l: login shell, -c: command. We use "env" to get all exported variables.
    const rawEnv = execSync(`${shell} -l -c "env"`, { 
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000 
    });

    const lines = rawEnv.split("\n");
    for (const line of lines) {
      const splitIdx = line.indexOf("=");
      if (splitIdx > 0) {
        const key = line.slice(0, splitIdx);
        const value = line.slice(splitIdx + 1);
        
        // We only override if it's not already set in the current process 
        // (favoring explicit .env or command-line overrides)
        if (process.env[key] === undefined || process.env.AILOOP_FORCE_HYDRATE) {
          process.env[key] = value.trim();
        }
      }
    }
  } catch (error) {
    // Silent fail, fallback to current environment
    console.warn("[ENV] Failed to hydrate from shell, using current environment context.");
  }
}
