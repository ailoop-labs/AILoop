import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function ensureParentDir(filePath: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
}

export async function readTextFile(filePath: string, fallback = ""): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await ensureParentDir(filePath);
  await fs.writeFile(filePath, content, "utf8");
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  const raw = await readTextFile(filePath, "");
  if (!raw.trim()) {
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await writeTextFile(filePath, payload);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
