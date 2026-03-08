const fs = require('fs');
let content = fs.readFileSync('src/loop/engine.ts', 'utf8');
content = content.replace(
  /if \(shouldGenerate\) \{\s*await ensureLoopHome\(this\.paths, await buildDeterministicGoal\(process\.cwd\(\)\)\);\s*\} else \{\s*await ensureLoopHome\(this\.paths\);\s*\}/,
  `await ensureLoopHome(this.paths);\n    if (shouldGenerate) {\n      await fs.writeFile(this.paths.taskPath, await buildDeterministicGoal(process.cwd()), "utf8");\n    }`
);
fs.writeFileSync('src/loop/engine.ts', content);

let execContent = fs.readFileSync('src/agent/executor.test.ts', 'utf8');
execContent = execContent.replace(/availableTools: \[.*?\]/g, '$&, availableSkills: []');
fs.writeFileSync('src/agent/executor.test.ts', execContent);
