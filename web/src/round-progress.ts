export type LoopStateName = "idle" | "running" | "cooldown" | "paused" | "stopping" | "error";

export interface RoundProgressInput {
  state?: LoopStateName;
  round?: number;
  logs: string[];
}

export interface RoundProgressView {
  roundLabel: string;
  percent: number;
  role: "Planner" | "Executor" | "Evaluator" | "System";
  step: string;
}

const DIMENSION_ORDER = [
  "goal_alignment",
  "causal_validity",
  "constraint_compliance",
  "risk_externality",
  "reversibility_resilience",
  "learning_yield"
] as const;

function stripLogPrefix(line: string): string {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function deriveRoundProgress(input: RoundProgressInput): RoundProgressView {
  const normalizedLogs = input.logs.map(stripLogPrefix);
  const lastLine = normalizedLogs.at(-1) ?? "";
  const roundLabel = Number.isFinite(input.round) && (input.round ?? 0) > 0 ? `Round ${input.round}` : "Round -";

  if (input.state === "cooldown") {
    return {
      roundLabel,
      percent: 100,
      role: "System",
      step: "Round completed, cooldown in progress"
    };
  }

  if (input.state && input.state !== "running" && input.state !== "cooldown") {
    return {
      roundLabel,
      percent: 0,
      role: "System",
      step: `Loop state: ${input.state}`
    };
  }

  if (
    normalizedLogs.some((line) => line.includes("Evaluator completed LLM dimension checks")) ||
    normalizedLogs.some((line) => line.startsWith("Evaluator decision:")) ||
    normalizedLogs.some((line) => line.startsWith("Post-remediation evaluation decision:")) ||
    normalizedLogs.some((line) => line.startsWith("Post-auto-rework evaluation decision:"))
  ) {
    return {
      roundLabel,
      percent: 100,
      role: "Evaluator",
      step: "Evaluator completed checks"
    };
  }

  const evaluatorDimensionMatch = normalizedLogs
    .slice()
    .reverse()
    .map((line) => line.match(/^Evaluator checking dimension:\s*([a-z_]+)\.?$/i))
    .find(Boolean);
  if (evaluatorDimensionMatch && evaluatorDimensionMatch[1]) {
    const dimension = evaluatorDimensionMatch[1].toLowerCase();
    const index = DIMENSION_ORDER.indexOf(dimension as (typeof DIMENSION_ORDER)[number]);
    const progress = index >= 0 ? 80 + (index / DIMENSION_ORDER.length) * 15 : 82;
    return {
      roundLabel,
      percent: clampPercent(progress),
      role: "Evaluator",
      step: `Evaluator checking dimension: ${dimension}`
    };
  }

  if (
    normalizedLogs.some((line) => line.includes("Evaluator started LLM dimension checks.")) ||
    normalizedLogs.some((line) => line.startsWith("[evaluator codex "))
  ) {
    return {
      roundLabel,
      percent: 80,
      role: "Evaluator",
      step: "Evaluator running dimension checks"
    };
  }

  if (
    normalizedLogs.some((line) => line.includes("Executor Codex execution finished")) ||
    normalizedLogs.some((line) => line.includes("Executor finished with status"))
  ) {
    return {
      roundLabel,
      percent: 72,
      role: "Executor",
      step: "Executor finished task execution"
    };
  }

  if (
    normalizedLogs.some((line) => line.includes("Executor started Codex execution")) ||
    normalizedLogs.some((line) => line.startsWith("[codex stdout]")) ||
    normalizedLogs.some((line) => line.startsWith("[codex stderr]"))
  ) {
    return {
      roundLabel,
      percent: 55,
      role: "Executor",
      step: "Executor is executing sub-task"
    };
  }

  if (normalizedLogs.some((line) => line.includes("Planner Codex planning finished"))) {
    return {
      roundLabel,
      percent: 35,
      role: "Planner",
      step: "Planner produced next sub-task"
    };
  }

  if (
    normalizedLogs.some((line) => line.includes("Planner started Codex planning")) ||
    normalizedLogs.some((line) => line.startsWith("[planner codex "))
  ) {
    return {
      roundLabel,
      percent: 20,
      role: "Planner",
      step: "Planner is planning next sub-task"
    };
  }

  if (normalizedLogs.some((line) => /^Round \d+ started\./.test(line))) {
    return {
      roundLabel,
      percent: 8,
      role: "System",
      step: "Round started"
    };
  }

  return {
    roundLabel,
    percent: 0,
    role: "System",
    step: lastLine ? `Waiting (${lastLine})` : "Waiting for next round"
  };
}
