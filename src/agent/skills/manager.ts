import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface SkillMetadata {
  name: string;
  description: string;
  location: string;
}

export class SkillManager {
  private readonly builtInSkillsDir: string;
  private readonly projectSkillsDir: string;
  private readonly skills = new Map<string, SkillMetadata>();
  private initialized = false;

  constructor(workspaceRoot: string) {
    this.builtInSkillsDir = path.join(__dirname, "built-in");
    this.projectSkillsDir = path.join(workspaceRoot, "skills");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.scanDir(this.builtInSkillsDir);
    await this.scanDir(this.projectSkillsDir); // Project overrides built-in
    
    this.initialized = true;
  }

  getAvailableSkills(): SkillMetadata[] {
    return Array.from(this.skills.values());
  }

  async activateSkill(name: string): Promise<string> {
    if (!this.initialized) {
      await this.initialize();
    }

    const skill = this.skills.get(name);
    if (!skill) {
      throw new Error(`Skill not found: ${name}. Did you misspell it?`);
    }

    try {
      const content = await fs.readFile(skill.location, "utf8");
      // Strip frontmatter but preserve everything else as per agentskills.io spec
      const stripped = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
      return `<activated_skill name="${name}">\n${stripped}\n\nSkill directory: ${path.dirname(skill.location)}\nRelative paths in this skill are relative to the skill directory.\n</activated_skill>`;
    } catch (e) {
      throw new Error(`Failed to load skill ${name} from ${skill.location}: ${(e as Error).message}`);
    }
  }

  private async scanDir(dir: string): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        
        const skillPath = path.join(dir, entry.name, "SKILL.md");
        try {
          const stat = await fs.stat(skillPath);
          if (stat.isFile()) {
            const content = await fs.readFile(skillPath, "utf8");
            const meta = this.parseFrontmatter(content);
            if (meta) {
              // Be lenient with name mismatches per spec, but prefer frontmatter name
              const skillName = meta.name || entry.name;
              this.skills.set(skillName, {
                name: skillName,
                description: meta.description,
                location: skillPath
              });
            }
          }
        } catch {
          // Ignore missing SKILL.md or unreadable files
        }
      }
    } catch {
      // Ignore if skills directory does not exist
    }
  }

  private parseFrontmatter(content: string): { name?: string; description: string } | null {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;

    const lines = match[1].split("\n");
    const result: { name?: string; description: string } = { description: "" };

    for (const line of lines) {
      // Lenient parsing for name and description, removing quotes if any
      const nameMatch = line.match(/^name:\s*(?:"|')?([^"']+)(?:"|')?/);
      if (nameMatch) result.name = nameMatch[1].trim();

      const descMatch = line.match(/^description:\s*(?:"|')?([^"']+)(?:"|')?/);
      if (descMatch) result.description = descMatch[1].trim();
    }

    if (!result.description) return null; // Description is required by spec for catalog
    return result;
  }
}
