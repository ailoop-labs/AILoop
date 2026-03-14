export interface RequirementArtifactView {
  path: string;
  exists: boolean;
  artifact_status: "missing" | "ready" | "needs_refresh";
  lifecycle_status: "active" | "complete";
  title: string | null;
  summary: string | null;
  acceptance_criteria_total: number;
  acceptance_criteria_completed: number;
  markdown: string | null;
  updated_at: string | null;
}

interface RequirementSnapshotCardProps {
  artifact: RequirementArtifactView | null;
  onOpen: () => void;
}

function requirementStatusLabel(artifact: RequirementArtifactView | null): string {
  if (!artifact || !artifact.exists || artifact.artifact_status === "missing") {
    return "No Active Requirement";
  }
  if (artifact.artifact_status === "needs_refresh") {
    return "Needs Refresh";
  }
  return "Active Requirement";
}

function requirementStatusTone(artifact: RequirementArtifactView | null): string {
  if (!artifact || !artifact.exists || artifact.artifact_status === "missing") {
    return "bg-slate text-mist/80";
  }
  if (artifact.artifact_status === "needs_refresh") {
    return "bg-warning/20 text-warning";
  }
  return "bg-accent/20 text-accent";
}

export function RequirementSnapshotCard({ artifact, onOpen }: RequirementSnapshotCardProps) {
  const exists = Boolean(artifact?.exists);
  const totalCriteria = artifact?.acceptance_criteria_total ?? 0;
  const completedCriteria = artifact?.acceptance_criteria_completed ?? 0;

  return (
    <div className="rounded-xl border border-white/10 bg-ink/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-mist/60">Requirement Snapshot</p>
          <h3 className="mt-2 text-base font-semibold text-mist">
            {exists ? artifact?.title || "Untitled requirement slice" : "No Active Requirement"}
          </h3>
        </div>
        <span className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.15em] ${requirementStatusTone(artifact)}`}>
          {requirementStatusLabel(artifact)}
        </span>
      </div>

      <p className="mt-3 text-sm text-mist/80">
        {exists
          ? artifact?.summary || "No summary captured in the current requirement artifact."
          : "Project Planner will wake Product Manager when a new requirement slice is needed."}
      </p>

      <div className="mt-4 grid gap-2 text-xs text-mist/70 sm:grid-cols-3">
        <p className="rounded-lg border border-white/10 bg-ink/70 px-2 py-1">
          Progress: {completedCriteria} / {totalCriteria} criteria
        </p>
        <p className="rounded-lg border border-white/10 bg-ink/70 px-2 py-1">
          Lifecycle: {artifact?.lifecycle_status ?? "active"}
        </p>
        <p className="rounded-lg border border-white/10 bg-ink/70 px-2 py-1 break-all">
          Path: {artifact?.path ?? ".ailoop/product-requirements/current.md"}
        </p>
      </div>

      {exists && artifact?.markdown ? (
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-[11px] uppercase tracking-[0.18em] text-mist/55">
            {artifact.updated_at ? `Updated ${artifact.updated_at}` : "Markdown available"}
          </p>
          <button
            onClick={onOpen}
            className="rounded-lg border border-white/20 px-3 py-1 text-xs uppercase tracking-[0.2em] text-mist/70 transition hover:border-accent hover:text-accent"
          >
            Open Requirement
          </button>
        </div>
      ) : null}
    </div>
  );
}
