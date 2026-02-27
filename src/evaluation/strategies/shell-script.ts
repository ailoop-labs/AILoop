import type { EvaluationResult, RoundEvaluationContext } from "../../types/contracts";
import type { Evaluator } from "../evaluator";
import { runShellCommand } from "../../utils/exec";

export class ShellEvaluator implements Evaluator {
  constructor(
    private readonly command: string,
    private readonly cwd: string
  ) {}

  async evaluate(context: RoundEvaluationContext): Promise<EvaluationResult> {
    if (!this.command.trim()) {
      return {
        decision: context.toolResult.status === "success" ? "pass" : "fail",
        justification:
          context.toolResult.status === "success"
            ? "No shell evaluator command configured; using executor status for MVP validation."
            : "Executor failed and no shell evaluator command was configured.",
        evidence: [context.toolResult.summary],
        recommended_next_action:
          context.toolResult.status === "success" ? "continue" : "Inspect executor error and retry with instructions"
      };
    }

    const result = await runShellCommand(this.command, this.cwd);
    if (result.code === 0) {
      return {
        decision: "pass",
        justification: `Shell evaluator command succeeded: ${this.command}`,
        evidence: [result.stdout.trim() || "No output"],
        recommended_next_action: "continue"
      };
    }

    return {
      decision: "fail",
      justification: `Shell evaluator command failed: ${this.command}`,
      evidence: [result.stderr.trim() || result.stdout.trim() || "Command failed without output"],
      recommended_next_action: "pause and inspect failing check"
    };
  }
}
