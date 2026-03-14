import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RequirementSnapshotCard, type RequirementArtifactView } from "./requirement-snapshot";

function createRequirement(overrides: Partial<RequirementArtifactView> = {}): RequirementArtifactView {
  return {
    path: ".ailoop/product-requirements/current.md",
    exists: true,
    artifact_status: "ready",
    lifecycle_status: "active",
    title: "Requirement Slice: Console Health",
    summary: "Operators need to inspect the active requirement from the console.",
    acceptance_criteria_total: 2,
    acceptance_criteria_completed: 0,
    markdown: "# Requirement Slice: Console Health",
    updated_at: "2026-03-14T08:00:00.000Z",
    ...overrides
  };
}

describe("RequirementSnapshotCard", () => {
  test("renders a high-signal summary for the active requirement", () => {
    const html = renderToStaticMarkup(
      <RequirementSnapshotCard artifact={createRequirement()} onOpen={() => undefined} />
    );

    expect(html).toContain("Active Requirement");
    expect(html).toContain("Requirement Slice: Console Health");
    expect(html).toContain("Operators need to inspect the active requirement from the console.");
    expect(html).toContain("0 / 2 criteria");
    expect(html).toContain("Open Requirement");
  });

  test("surfaces completed slices as needing refresh", () => {
    const html = renderToStaticMarkup(
      <RequirementSnapshotCard
        artifact={createRequirement({
          artifact_status: "needs_refresh",
          lifecycle_status: "complete",
          acceptance_criteria_completed: 2
        })}
        onOpen={() => undefined}
      />
    );

    expect(html).toContain("Needs Refresh");
    expect(html).toContain("2 / 2 criteria");
  });

  test("shows a safe empty state when no active requirement artifact exists", () => {
    const html = renderToStaticMarkup(
      <RequirementSnapshotCard
        artifact={createRequirement({
          exists: false,
          artifact_status: "missing",
          title: null,
          summary: null,
          markdown: null,
          updated_at: null
        })}
        onOpen={() => undefined}
      />
    );

    expect(html).toContain("No Active Requirement");
    expect(html).toContain("Project Planner will wake Product Manager");
    expect(html).not.toContain("Open Requirement");
  });
});
