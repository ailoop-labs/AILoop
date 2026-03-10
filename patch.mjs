import fs from 'fs';

let content = fs.readFileSync('src/loop/engine.ts', 'utf8');

// Import UIEvaluator
content = content.replace(
  'import { LeaderAgent } from "../agent/leader";',
  'import { LeaderAgent } from "../agent/leader";\nimport { UIEvaluator } from "../evaluation/strategies/ui-evaluator";'
);

// Add uiEvaluator to class properties
content = content.replace(
  'private readonly evaluator;',
  'private readonly evaluator;\n  private readonly uiEvaluator: UIEvaluator;'
);

// Initialize uiEvaluator in constructor
content = content.replace(
  'this.evaluator = createEvaluator(config);',
  'this.evaluator = createEvaluator(config);\n    this.uiEvaluator = new UIEvaluator(config.homeDir);'
);

// Replace evaluation calls
// First evaluation call
content = content.replace(
  'let evaluation: EvaluationResult = await this.evaluator.evaluate({',
  'const activeEvaluator = subTask.assignee === "designer" ? this.uiEvaluator : this.evaluator;\n      let evaluation: EvaluationResult = await activeEvaluator.evaluate({'
);

// Remediation evaluation call
content = content.replace(
  'evaluation = await this.evaluator.evaluate({',
  'const remediationEvaluator = remediationTask.assignee === "designer" ? this.uiEvaluator : this.evaluator;\n          evaluation = await remediationEvaluator.evaluate({'
);

// Rework evaluation call
content = content.replace(
  /await enforceBudgetBeforeAction\(`evaluator\.evaluate auto-rework \$\{attempt\}`\);\n\s*evaluation = await this\.evaluator\.evaluate\(\{/g,
  'const reworkEvaluator = reworkTask.assignee === "designer" ? this.uiEvaluator : this.evaluator;\n          await enforceBudgetBeforeAction(`evaluator.evaluate auto-rework ${attempt}`);\n          evaluation = await reworkEvaluator.evaluate({'
);

fs.writeFileSync('src/loop/engine.ts', content);
