import path from "node:path";
import type { AppConfig } from "../config/env";
import { readTextFile } from "../utils/fs";
import { CodexClient, type JsonSchema } from "./codex-client";

const GENERATED_GOAL_SCHEMA: JsonSchema = {
    type: "object",
    properties: {
        goal_md: { type: "string" }
    },
    required: ["goal_md"],
    additionalProperties: false
};

export async function generateProjectGoal(
    config: AppConfig,
    workspaceRoot: string = process.cwd()
): Promise<string> {
    const codex = new CodexClient(config.codex);
    const projectGoal = await readTextFile(path.join(workspaceRoot, "GOAL.md"), "");
    const readme = await readTextFile(path.join(workspaceRoot, "README.md"), "");

    const truncate = (value: string, max: number): string =>
        value.length > max ? `${value.slice(0, max - 3)}...` : value;

    const prompt = [
        "You are an AI tasked with generating an initial `.autoloop/goal.md` for an autonomous loop.",
        "Return strict JSON with a `goal_md` field.",
        "The goal should be outcome-focused, measurable, and based on the project context.",
        "Do NOT use placeholder text. Be specific enough that the agent can start working.",
        "Include appropriate markdown headings.",
        "",
        "Project Context:",
        JSON.stringify(
            {
                project_goal_md: truncate(projectGoal, 6000),
                project_readme_md: truncate(readme, 12000)
            },
            null,
            2
        )
    ].join("\n");

    const result = await codex.runJson<{ goal_md: string }>({
        prompt,
        schema: GENERATED_GOAL_SCHEMA,
        cwd: workspaceRoot,
        sandbox: config.codex.plannerSandbox
    });

    if (result.ok && result.data && result.data.goal_md.trim()) {
        return `${result.data.goal_md.trim()}\n`;
    }

    return "# AutoLoop Goal\n\nDescribe the top-level goal this autonomous loop should pursue. Keep it outcome-focused and measurable.\n";
}
