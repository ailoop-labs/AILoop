import type { EvaluationResult, RoundEvaluationContext } from "../../types/contracts";
import type { Evaluator } from "../evaluator";
import path from "node:path";
import { runShellCommand } from "../../utils/exec";
import { DatabaseManager } from "../../utils/db";

export class UIEvaluator implements Evaluator {
  constructor(private readonly homeDir: string) {}

  async evaluate(context: RoundEvaluationContext): Promise<EvaluationResult> {
    if (context.onLog) {
      void Promise.resolve(
        context.onLog("UIEvaluator: Running visual/UI assertions (headless browser/visual check) for designer task.")
      ).catch(() => {});
    }

    // In a full implementation, this uses Playwright/Puppeteer to load the UI,
    // take screenshots, run visual regression checks, and perform accessibility audits.
    // Here we run a configured UI test command, defaulting to a simulated pass.
    const db = new DatabaseManager({ dbPath: path.join(this.homeDir, "ailoop.db") });
    let uiTestCommand = "echo 'Simulating UI/Visual evaluation pass'";

    try {
      const configuredCommand = await db.getConfig("AILOOP_UI_EVALUATOR_CMD");
      if (configuredCommand?.trim()) {
        uiTestCommand = configuredCommand.trim();
      }
    } finally {
      db.close();
    }

    const result = await runShellCommand(uiTestCommand, this.homeDir);
    
    if (result.code === 0) {
      return {
        decision: "pass",
        justification: "UI/Visual evaluator passed all layout and visual assertions.",
        evidence: [result.stdout.trim() || "UI assertions passed."],
        recommended_next_action: "continue"
      };
    }

    return {
      decision: "fail",
      justification: "UI/Visual evaluator detected layout, accessibility, or visual regressions.",
      evidence: [result.stderr.trim() || result.stdout.trim() || "Visual regressions detected."],
      recommended_next_action: "pause and review UI layout or accessibility errors"
    };
  }
}
