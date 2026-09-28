import fs from 'node:fs';
import path from 'node:path';
import { readUI, stripComments, uiFile } from './lib/src.mjs';

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

// ── 共享 helper 用了却没 import ──────────────────────────────────────────
// 起因：parts/whitelist.js 从 dom.js 只 import 了 { $$, esc }，却调了 $(...)。
// 浏览器里模块作用域没有全局 $，于是点「选择群」当场 ReferenceError，而上面四条
// 断言全绿——它们验的是"路径能不能解析"，坏的是"名字有没有绑上"，两件事。
// 边界：只查**被别的 ui 模块 export 出去**的名字，且只认调用形态 N(...)。
// 本地拼错一个非 export 的名字（如 `escc(`）不在此列，那要真解析器。
const code = new Map(files.map((name) => [name, stripComments(sources.get(name))]));
const exporters = new Map();
const addExport = (name, file) => {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return;
  if (!exporters.has(name)) exporters.set(name, []);
  exporters.get(name).push(file);
};
for (const file of files) {
  const text = code.get(file);
  for (const m of text.matchAll(/\bexport\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) addExport(m[1], file);
  for (const m of text.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) addExport(part.split(/\s+as\s+/).pop().trim(), file);
  }
}
// 这个文件里"绑上了名字"的一切：import 进来的 + 自己声明的
const bindingsOf = (file) => {
  const bound = new Set();
  for (const m of code.get(file).matchAll(/\bimport\s+([\s\S]*?)\s+from\s*['"][^'"]*['"]/g)) {
    const clause = m[1];
    const brace = clause.match(/\{([\s\S]*?)\}/);
    if (brace) for (const part of brace[1].split(',')) bound.add(part.split(/\s+as\s+/).pop().trim());
    const namespace = clause.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/);
    if (namespace) bound.add(namespace[1]);
    // 去掉命名/命名空间子句后剩下的就是默认导入那一个名字
    const rest = clause.replace(/\{[\s\S]*?\}/, ' ').replace(/\*\s*as\s+[A-Za-z_$][\w$]*/, ' ').replace(/,/g, ' ').trim();
    if (rest) bound.add(rest);
  }
  for (const m of code.get(file).matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
  return bound;
};
const unboundCalls = [];
for (const file of files) {
  const bound = bindingsOf(file);
  const text = code.get(file);
  for (const [name, definers] of exporters) {
    if (definers.includes(file) || bound.has(name)) continue;
    const pattern = new RegExp(`(^|[^\\w.$])${name.replace(/\$/g, '\\$')}\\s*\\(`);
    if (pattern.test(text)) unboundCalls.push(`${file} 调了 ${name}()（定义在 ${definers.join(', ')}），却既没 import 也没声明`);
  }
}
ok('调用跨模块 helper 前都先 import 了它', unboundCalls.length === 0, unboundCalls.join('; '));

console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail === 0 ? 0 : 1);
