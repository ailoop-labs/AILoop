import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

async function reserveFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to reserve a port"));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

describe("production server runtime helpers", () => {
  test("spawns a detached Bun server process that stays healthy without a tty", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-prod-runtime-"));
    tempDirs.add(tempDir);

    const { spawnDetachedProcess, stopProcess, waitForHttpHealth } = await import(
      `./prod-runtime.ts?test=${Date.now()}-${Math.random()}`
    );
    const bunBin = Bun.which("bun");
    expect(bunBin).toBeTruthy();

    const port = await reserveFreePort();
    const logPath = path.join(tempDir, "server.log");
    const pid = spawnDetachedProcess({
      command: bunBin!,
      args: [
        "-e",
        `const server=Bun.serve({hostname:"127.0.0.1",port:${port},fetch(){return new Response("ok")}}); console.log("ready:"+server.port);`
      ],
      cwd: tempDir,
      logPath
    });

    expect(pid).toBeGreaterThan(0);
    expect(await waitForHttpHealth(`http://127.0.0.1:${port}/`, pid, 3_000)).toBe(true);

    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");

    await stopProcess(pid, 2_000);

    expect(() => process.kill(pid, 0)).toThrow();
    expect(await fs.readFile(logPath, "utf8")).toContain("ready:");
  });
});
