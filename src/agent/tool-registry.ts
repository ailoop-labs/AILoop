import fs from "node:fs/promises";
import path from "node:path";
import { runShellCommand } from "../utils/exec";
import type { Tool, ToolContext, ToolResult, AgentRole } from "../types/contracts";
import { SkillManager } from "./skills/manager";

function normalizePath(homeDir: string, requestedPath: string): string {
  if (path.isAbsolute(requestedPath)) {
    return requestedPath;
  }
  return path.resolve(homeDir, requestedPath);
}

function ok(output: string): ToolResult {
  return { status: "success", summary: output, artifacts: { log_path: "", state_change_path: "" } };
}

function fail(message: string): ToolResult {
  return { status: "failure", summary: "", error: { type: "ToolExecutionError", message }, artifacts: { log_path: "", state_change_path: "" } };
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly skillManager: SkillManager;

  constructor() {
    this.registerBuiltinTools();
    // Dummy path for now, should be set per context ideally but SkillManager is being refactored
    this.skillManager = new SkillManager(""); 
  }

  async initialize() {
    // No-op for now but required for interface compatibility
  }

  getSkillManager() {
    return this.skillManager;
  }

  listTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  register(tool: Tool) {
    this.tools.set(tool.name, tool);
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAllTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  private registerBuiltinTools() {
    this.register({
      name: "activate_skill",
      description: "Activates a specialized skill by name to receive procedural guidance and resources.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The name of the skill to activate." }
        },
        required: ["name"]
      },
      execute: async (args: { name: string }, context: ToolContext) => {
        const manager = new SkillManager(context.paths.homeDir);
        try {
          const instructions = await manager.activateSkill(args.name);
          return ok(instructions);
        } catch (error) {
          return fail((error as Error).message);
        }
      }
    });

    this.register({
      name: "read_file",
      description: "Reads and returns the content of a specified file.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "The path to the file to read." }
        },
        required: ["file_path"]
      },
      execute: async (args: { file_path: string }, context: ToolContext) => {
        const fullPath = normalizePath(context.paths.homeDir, args.file_path);
        try {
          const content = await fs.readFile(fullPath, "utf8");
          return ok(content);
        } catch (error) {
          return fail(`Could not read file: ${(error as Error).message}`);
        }
      }
    });

    this.register({
      name: "write_file",
      description: "Writes the complete content to a file, creating parent directories if missing.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the file." },
          content: { type: "string", description: "Complete content to write." }
        },
        required: ["file_path", "content"]
      },
      execute: async (args: { file_path: string; content: string }, context: ToolContext) => {
        const fullPath = normalizePath(context.paths.homeDir, args.file_path);
        
        // Safety: Leader can only write directional docs
        const relPath = path.relative(process.cwd(), fullPath);
        const isDirectionalDoc = ["README.md", "GOAL.md", "ARCHITECTURE.md"].includes(relPath) || relPath.endsWith(".queue.json");
        
        if (context.role === "leader" && !isDirectionalDoc) {
          return fail(`Permission denied: Leader should only modify directional documents, not source code (${relPath}).`);
        }

        try {
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, args.content, "utf8");
          return ok(`Successfully wrote to ${args.file_path}`);
        } catch (error) {
          return fail(`Could not write file: ${(error as Error).message}`);
        }
      }
    });

    this.register({
      name: "run_shell_command",
      description: "Executes a shell command in the workspace.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The bash command to execute." }
        },
        required: ["command"]
      },
      execute: async (args: { command: string }, context: ToolContext) => {
        if (context.role === "leader") {
          return fail("Permission denied: Leader role cannot execute shell commands.");
        }
        const result = await runShellCommand(args.command, context.paths.homeDir);
        if (result.code !== 0) {
          return fail(`Command failed with code ${result.code}: ${result.stderr}`);
        }
        return ok(result.stdout);
      }
    });
  }
}
