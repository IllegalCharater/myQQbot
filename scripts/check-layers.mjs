// 守住 src/ 的领域依赖方向。只做静态说明符检查，不执行源码。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const LEVEL = new Map([
  ['core', 0],
  ['llm', 1], ['chat', 1], ['qq', 1], ['media', 1],
  ['stickers', 2],
  ['agent', 3],
  ['web', 4]
]);

// T1 领域默认彼此隔离。若将来确有必要，只能登记精确的“源文件 -> 目标文件”。
const T1_ALLOW = new Set([]);
const SOURCE_EXT = /\.(?:js|ts)$/;
const SPECIFIER = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : (SOURCE_EXT.test(entry.name) ? [full] : []);
  });
}

function slash(value) {
  return value.split(path.sep).join('/');
}

const errors = [];
const files = filesUnder(SRC);

// Agent 内部实现必须按职责落入子目录；不再允许大型实现回到根目录。
const agentRoot = path.join(SRC, 'agent');
const agentGroups = ['runtime', 'context', 'prompting', 'tools', 'maintenance', 'shared'];
for (const group of agentGroups) {
  if (!fs.existsSync(path.join(agentRoot, group))) errors.push(`agent/${group}: 缺少 Agent 分层目录`);
}
for (const entry of fs.readdirSync(agentRoot, { withFileTypes: true })) {
  if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
    errors.push(`agent/${entry.name}: Agent 实现不得平铺在根目录`);
  }
}

// web 根目录只放**组装、入口、领域类型与读模型**；其余实现必须落进子目录。
// 与 agent/ 那条规则同一个理由：没有这道闸门，搬进子目录的东西会一个一个搬回来。
const webRoot = path.join(SRC, 'web');
const WEB_GROUPS = ['http', 'runtime', 'routes', 'onebot'];
const WEB_ROOT_ALLOW = new Set(['app.ts', 'server.ts', 'types.ts', 'usage-service.ts']);
for (const group of WEB_GROUPS) {
  if (!fs.existsSync(path.join(webRoot, group))) errors.push(`web/${group}: 缺少 web 分层目录`);
}
for (const entry of fs.readdirSync(webRoot, { withFileTypes: true })) {
  if (entry.isFile() && SOURCE_EXT.test(entry.name) && !WEB_ROOT_ALLOW.has(entry.name)) {
    errors.push(`web/${entry.name}: web 根目录只许放组装根/入口/领域类型/读模型，实现请落进子目录`);
  }
}
// media/ 的规则与前两条**相反**：平铺的单文件是**通用工具类**（谁都能用、没有自己的领域状态），
// 而**每个能力占一个目录**（目录内怎么分是自由的）。
// 判据是"它有没有自己的领域状态"：`safe-fetch` / `call-budget` / `task-queue` 只有一个功能；
// 而 `jmcomic` / `transcription` / `image-gen` 各带一整套任务状态机、持久化与投递。
// 没有这道闸门，新建能力的人会顺手在 media/ 根下开一个文件，然后目录与平铺就混成一锅。
const mediaRoot = path.join(SRC, 'media');
const MEDIA_FLAT_ALLOW = new Set([
  'safe-fetch.ts',        // SSRF 安全抓取
  'html-to-text.ts',      // HTML 剥文本
  'call-budget.ts',       // 滑动窗口调用闸门
  'bookmark-request.ts',  // 收藏夹的「请求结构」取数
  'task-queue.ts',        // 异步任务队列的机械部分
  'task-error.ts'         // 异步任务的错误形状
]);
for (const entry of fs.readdirSync(mediaRoot, { withFileTypes: true })) {
  if (entry.isFile() && SOURCE_EXT.test(entry.name) && !MEDIA_FLAT_ALLOW.has(entry.name)) {
    errors.push(`media/${entry.name}: media/ 根目录只许放通用工具类 —— 能力请开一个目录`);
  }
}
// **能力目录要不要带 `index.ts` 桶文件，这里不强制**：五个能力有（消费方 import `<能力>/index.js`），
// 而 `hot-search/` 没有 —— 它的消费者直接用那四个文件、套件也直接取内部的纯函数，
// 桶文件对它只是多一层。写文档时别把"通常有"说成"必须有"。

for (const source of files) {
  const sourceRel = slash(path.relative(SRC, source));
  const sourceDomain = sourceRel.split('/')[0];
  if (!LEVEL.has(sourceDomain)) {
    errors.push(`${sourceRel}: 源文件不在已知领域目录中`);
    continue;
  }

  const text = fs.readFileSync(source, 'utf8');
  for (const match of text.matchAll(SPECIFIER)) {
    const specifier = match[1] || match[2] || match[3];
    if (!specifier.startsWith('.')) continue;
    if (!/\.[a-z0-9]+$/i.test(specifier)) {
      errors.push(`${sourceRel} -> ${specifier}: NodeNext 相对说明符必须显式带扩展名`);
      continue;
    }

    const resolved = path.resolve(path.dirname(source), specifier);
    const targetRel = slash(path.relative(SRC, resolved));
    if (targetRel.startsWith('../') || path.isAbsolute(targetRel)) {
      errors.push(`${sourceRel} -> ${specifier}: 相对引用越出 src/`);
      continue;
    }

    const targetDomain = targetRel.split('/')[0];
    if (!LEVEL.has(targetDomain)) {
      errors.push(`${sourceRel} -> ${targetRel}: 目标不在已知领域目录中`);
      continue;
    }
    const sourceTarget = fs.existsSync(resolved)
      || (specifier.endsWith('.js') && fs.existsSync(resolved.slice(0, -3) + '.ts'));
    if (!sourceTarget) {
      errors.push(`${sourceRel} -> ${targetRel}: 目标文件不存在`);
      continue;
    }
    if (sourceDomain === targetDomain) continue;

    const sourceLevel = LEVEL.get(sourceDomain);
    const targetLevel = LEVEL.get(targetDomain);
    if (targetLevel > sourceLevel) {
      errors.push(`${sourceRel} -> ${targetRel}: T${sourceLevel} 不得反向依赖 T${targetLevel}`);
      continue;
    }
    if (sourceLevel === 1 && targetLevel === 1 && !T1_ALLOW.has(`${sourceRel} -> ${targetRel}`)) {
      errors.push(`${sourceRel} -> ${targetRel}: T1 领域间引用未登记精确白名单`);
    }
  }
}

if (errors.length) {
  console.error(`依赖层级检查失败（${errors.length}）：`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`依赖层级检查通过：${files.length} 个源码文件`);
