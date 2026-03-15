import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { buildLoopPaths } from "../loop/state";
import {
  ensureProductRequirementsHome,
  hasActiveRequirementArtifact,
  readActiveRequirementArtifact,
  readActiveRequirementSnapshot,
  writeActiveRequirementArtifact
} from "./requirements";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function createTempHomeDir(): Promise<string> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ailoop-product-requirements-"));
  tempDirs.push(homeDir);
  return homeDir;
}

describe("product requirement artifacts", () => {
  test("buildLoopPaths exposes the canonical active requirement artifact path", () => {
    const paths = buildLoopPaths("/tmp/ailoop-home");
    expect(paths.productRequirementsDirPath).toBe("/tmp/ailoop-home/product-requirements");
    expect(paths.activeRequirementPath).toBe("/tmp/ailoop-home/product-requirements/current.md");
  });

  test("ensureProductRequirementsHome creates the requirement directory idempotently", async () => {
    const homeDir = await createTempHomeDir();
    const paths = buildLoopPaths(homeDir);

    await ensureProductRequirementsHome(paths);
    await ensureProductRequirementsHome(paths);

    const stat = await fs.stat(paths.productRequirementsDirPath);
    expect(stat.isDirectory()).toBe(true);
  });

  test("missing active requirement artifact can be detected and read without throwing", async () => {
    const homeDir = await createTempHomeDir();
    const paths = buildLoopPaths(homeDir);

    await ensureProductRequirementsHome(paths);

    await expect(hasActiveRequirementArtifact(paths)).resolves.toBe(false);
    await expect(readActiveRequirementArtifact(paths)).resolves.toBeNull();
  });

  test("writing the active requirement artifact produces stable markdown output", async () => {
    const homeDir = await createTempHomeDir();
    const paths = buildLoopPaths(homeDir);
    const markdown = [
      "# Requirement Slice: Console Health",
      "",
      "## Problem",
      "Operators cannot tell whether the web console is healthy.",
      "",
      "## Acceptance Criteria",
      "- status endpoint returns OK",
      "- console exposes health state"
    ].join("\n");

    await writeActiveRequirementArtifact(paths, markdown);

    expect(await hasActiveRequirementArtifact(paths)).toBe(true);
    expect(await readActiveRequirementArtifact(paths)).toBe(`${markdown}\n`);
    expect(await fs.readFile(paths.activeRequirementPath, "utf8")).toBe(`${markdown}\n`);
  });

  test("reads snapshots from the current crash-recovery artifact shape", async () => {
    const homeDir = await createTempHomeDir();
    const paths = buildLoopPaths(homeDir);
    const markdown = [
      "# Title",
      "Crash-Recovered Start and Status Visibility",
      "",
      "## Problem or Opportunity",
      "Status should explain crash recovery clearly.",
      "",
      "## Acceptance Criteria",
      "- Status explains the interruption state.",
      "",
      "## Lifecycle Status",
      "- Status: complete",
      "- Matched Acceptance Criteria: 1",
      "- Remaining Acceptance Criteria: 0"
    ].join("\n");

    await writeActiveRequirementArtifact(paths, markdown);

    const snapshot = await readActiveRequirementSnapshot(paths);

    expect(snapshot.title).toBe("Crash-Recovered Start and Status Visibility");
    expect(snapshot.summary).toBe("Status should explain crash recovery clearly.");
    expect(snapshot.artifact_status).toBe("needs_refresh");
    expect(snapshot.lifecycle_status).toBe("complete");
  });
});
