import fs from 'node:fs';
import path from 'node:path';
import { readUI, uiFile } from './lib/src.mjs';

let pass = 0, fail = 0;
const ok = (label, condition, extra = '') => {
  if (condition) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` → ${extra}` : ''}`); }
};

const root = uiFile('js');
const files = fs.readdirSync(root, { recursive: true })
  .filter((name) => String(name).endsWith('.js'))
  .map((name) => String(name).split(path.sep).join('/'));
const sources = new Map(files.map((name) => [name, fs.readFileSync(path.join(root, name), 'utf8')]));
const importsOf = (name) => [...sources.get(name).matchAll(/\b(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g)].map((match) => match[1]);
const resolveImport = (from, specifier) => path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));

console.log('\n═══ UI ES Module 图 ═══');
const html = readUI('index.html');
ok('首页只有一个 module 入口', (html.match(/<script\s+type="module"\s+src="\/js\/main\.js"><\/script>/g) || []).length === 1);
ok('首页不再引用旧 /app.js', !/<script[^>]+src="\/app\.js"/.test(html));
ok('旧 ui/app.js 已删除', !fs.existsSync(uiFile('app.js')));
ok('存在多个领域模块', files.length >= 10, `实际 ${files.length}`);

const badBare = [];
const missingExt = [];
const missingTargets = [];
const graph = new Map();
for (const file of files) {
  const deps = [];
  for (const specifier of importsOf(file)) {
    if (!specifier.startsWith('.')) { badBare.push(`${file} → ${specifier}`); continue; }
    if (!specifier.endsWith('.js')) missingExt.push(`${file} → ${specifier}`);
    const target = resolveImport(file, specifier);
    if (!sources.has(target)) missingTargets.push(`${file} → ${target}`);
    else deps.push(target);
  }
  graph.set(file, deps);
}
ok('不存在 bare import', badBare.length === 0, badBare.join(', '));
ok('相对 import 全部显式带 .js', missingExt.length === 0, missingExt.join(', '));
ok('所有 import 目标都存在', missingTargets.length === 0, missingTargets.join(', '));

const reachable = new Set();
const visit = (file) => { if (reachable.has(file)) return; reachable.add(file); for (const dep of graph.get(file) || []) visit(dep); };
visit('main.js');
const unreachable = files.filter((file) => !reachable.has(file));
ok('所有模块都能从 main.js 到达', unreachable.length === 0, unreachable.join(', '));

const cycles = [];
const visiting = new Set();
const visited = new Set();
const walk = (file, stack = []) => {
  if (visiting.has(file)) { cycles.push([...stack, file].join(' → ')); return; }
  if (visited.has(file)) return;
  visiting.add(file);
  for (const dep of graph.get(file) || []) walk(dep, [...stack, file]);
  visiting.delete(file);
  visited.add(file);
};
walk('main.js');
ok('模块图没有循环依赖', cycles.length === 0, cycles[0] || '');

console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail === 0 ? 0 : 1);
