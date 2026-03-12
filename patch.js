import fs from "node:fs/promises";
import path from "node:path";

const files = [
  "src/agent/designer.ts",
  "src/agent/executor.ts",
  "src/environment/workspace.test.ts",
  "src/environment/workspace.ts",
  "src/evaluation/evaluator.ts",
  "src/evaluation/strategies/llm-judge.test.ts",
  "src/evaluation/strategies/llm-judge.ts",
  "src/evaluation/strategies/ui-evaluator.ts",
  "src/loop/control.ts",
  "src/loop/engine.budget.test.ts",
  "src/loop/engine.summary-artifact.test.ts",
  "src/loop/engine.test.ts",
  "src/loop/loop.pause-on-evaluator-failures.test.ts",
  "src/loop/scheduler.ts",
  "src/loop/state.test.ts",
  "src/reporting/summary.test.ts",
  "src/reporting/summary.ts",
  "src/server.test.ts"
];

const replacements = [
  {
    old: /import type \{ ([^}]*LoopPaths[^}]*) \} from "(\.\.\/)*loop\/state"/g,
    new: 'import type { $1 } from "$2types/contracts"'
  },
  {
    old: /error: null,/g,
    new: 'error: undefined,'
  },
  {
    old: /"unknown"/g,
    new: '"unknown"'
  }
];

async function patch() {
  for (const file of files) {
    try {
      let content = await fs.readFile(file, "utf8");
      let original = content;

      for (const r of replacements) {
        content = content.replace(r.old, r.new);
      }

      if (content !== original) {
        await fs.writeFile(file, content, "utf8");
        console.log(`Patched: ${file}`);
      }
    } catch (e) {
      console.error(`Failed to patch ${file}: ${e.message}`);
    }
  }
}

patch();
