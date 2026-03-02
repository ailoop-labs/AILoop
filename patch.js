const fs = require('fs');
const file = 'src/loop/control.ts';
let content = fs.readFileSync(file, 'utf8');

const helper = `
export async function ensureLoopHomeWithGoal(config: AppConfig): Promise<LoopPaths> {
  const paths = buildLoopPaths(config.homeDir);
  if (!(await fileExists(paths.goalPath))) {
    await ensureLoopHome(paths, await generateProjectGoal(config));
  } else {
    await ensureLoopHome(paths);
  }
  return paths;
}
`;

content = content.replace("export async function listProjectRoles", helper + "\nexport async function listProjectRoles");

const pattern = /const paths = buildLoopPaths\(config\.homeDir\);\n\s+await ensureLoopHome\(paths\);/g;
const replacement = "const paths = await ensureLoopHomeWithGoal(config);";

content = content.replace(pattern, replacement);

const startBgPattern = /const paths = buildLoopPaths\(config\.homeDir\);\n\s+if \(!\(await fileExists\(paths\.goalPath\)\)\) \{\n\s+await ensureLoopHome\(paths, await generateProjectGoal\(config\)\);\n\s+\} else \{\n\s+await ensureLoopHome\(paths\);\n\s+\}/g;
content = content.replace(startBgPattern, replacement);

fs.writeFileSync(file, content);
