import path from "node:path";
import type { Tool, ToolCallResult, ToolContext } from "../types/contracts";
import { readTextFile, writeTextFile } from "../utils/fs";
import { runShellCommand } from "../utils/exec";

function toStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`Invalid '${key}' argument`);
  }
  return value;
}

function normalizePath(homeDir: string, requestedPath: string): string {
  if (path.isAbsolute(requestedPath)) {
    return requestedPath;
  }
  return path.resolve(homeDir, requestedPath);
}

function ok(output: string, data?: unknown): ToolCallResult {
  return { ok: true, output, data };
}

function fail(message: string): ToolCallResult {
  return { ok: false, output: "", error: message };
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor() {
    this.registerBuiltins();
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  listTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  async call(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolCallResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return fail(`Unknown tool: ${name}`);
    }

    return tool.execute(args, context);
  }

  private registerBuiltins(): void {
    this.register({
      name: "read_file",
      description: "Read a UTF-8 text file.",
      costEstimate: () => 0,
      execute: async (args: Record<string, unknown>, context: ToolContext) => {
        try {
          const requestedPath = toStringArg(args, "path");
          const fullPath = normalizePath(context.homeDir, requestedPath);
          const content = await readTextFile(fullPath, "");
          return ok(`Read ${fullPath}`, { path: fullPath, content });
        } catch (error) {
          return fail((error as Error).message);
        }
      }
    });

    this.register({
      name: "write_file",
      description: "Write UTF-8 text content to a file.",
      costEstimate: () => 0,
      execute: async (args: Record<string, unknown>, context: ToolContext) => {
        try {
          const requestedPath = toStringArg(args, "path");
          const content = toStringArg(args, "content");
          const fullPath = normalizePath(context.homeDir, requestedPath);
          await writeTextFile(fullPath, content);
          return ok(`Wrote ${fullPath}`);
        } catch (error) {
          return fail((error as Error).message);
        }
      }
    });

    this.register({
      name: "run_shell",
      description: "Run a shell command in the workspace.",
      costEstimate: () => 0,
      execute: async (args: Record<string, unknown>, context: ToolContext) => {
        try {
          const cmd = toStringArg(args, "cmd");
          const cwdRaw = typeof args.cwd === "string" ? args.cwd : context.homeDir;
          const cwd = normalizePath(context.homeDir, cwdRaw);
          const result = await runShellCommand(cmd, cwd);
          const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
          if (result.code === 0) {
            return ok(output || `Command succeeded: ${cmd}`, { code: result.code });
          }
          return fail(output || `Command failed with exit code ${result.code}`);
        } catch (error) {
          return fail((error as Error).message);
        }
      }
    });

    this.register({
      name: "http_request",
      description: "Perform an HTTP request.",
      costEstimate: () => 0,
      execute: async (args: Record<string, unknown>) => {
        try {
          const url = toStringArg(args, "url");
          const method = typeof args.method === "string" ? args.method.toUpperCase() : "GET";
          const headers = (typeof args.headers === "object" && args.headers !== null
            ? (args.headers as Record<string, string>)
            : {}) as HeadersInit;
          const body = typeof args.body === "string" ? args.body : undefined;

          const response = await fetch(url, { method, headers, body });
          const text = await response.text();
          const output = `HTTP ${response.status} ${response.statusText}`;
          if (!response.ok) {
            return fail(`${output}\n${text}`.trim());
          }

          return ok(output, {
            status: response.status,
            body: text
          });
        } catch (error) {
          return fail((error as Error).message);
        }
      }
    });
  }
}
