// 守住 src/ 的领域依赖方向。只做静态说明符检查，不执行源码。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
// `extra`（扩展能力）插在 agent 与 web 之间，web 因此从 4 顶到 5。三条推论都由这张表自动给出：
//   • `extra → {core, media, chat, qq, agent}` 合法（扩展要工具契约、媒体助手、存档、事件发射器）；
//   • `web → extra` 合法（组装根 import 注册表）；
//   • **`extra → web` 被拦** —— 扩展不认识 web。组装是 web 的活，这条同时排除了 web ↔ extra 成环。
// 反方向同理：`agent → extra` 也是反向依赖，所以扩展工具的 schema 由 web/app.ts 递进 Orchestrator，
// `buildToolDefs(extra)` 只负责拼 —— agent 层对 extra 一无所知。
const LEVEL = new Map([
  ['core', 0],
  ['llm', 1], ['chat', 1], ['qq', 1], ['media', 1],
  ['stickers', 2],
  ['agent', 3],
  ['extra', 4],
  ['web', 5]
]);

// T1 领域默认彼此隔离。若将来确有必要，只能登记精确的“源文件 -> 目标文件”。
const T1_ALLOW = new Set([]);

// **低层 import 高层的具名例外**（精确到"源文件 -> 目标文件"）。默认一望而知的规则是
// "依赖只能从高层指向低层"，这条清单是它唯一的出口，所以每加一条都要有理由，且理由写在下面。
//
// 目前只有一条：`core/prompt-catalog.ts` 要**转发** `extra/prompts.ts` 里那张扩展提示词表
// （模型可见的固定指令仍集中在目录里，只是扩展那一块单独一个文件；见 AGENTS.md「扩展能力（extra）」）。
//
// ⚠️ 这条例外的安全性**全靠目标是个叶子模块**：`extra/prompts.ts` 自己不 import 任何东西，
// 所以"core 依赖 extra"这件事不会成环（core/prompt-catalog → extra/prompts → 无）。
// 哪天有人往那个文件里加一句 import，环就可能成立，而 tsc 与运行期都不一定报错 ——
// 所以下面有一条专门的断言：**登记为例外目标的文件里不许出现任何相对 import**。
//
// ⚠️ 键的写法照**报错原文**：右边用的是 **import 说明符**（`.js`），不是源文件名（`.ts`）。
// 两个理由：报错可以直接照抄进这张表；而且这里的判据本来就是"哪一条 import"，不是"哪个文件"。
const LAYER_ALLOW = new Set([
  'core/prompt-catalog.ts -> extra/prompts.js'
]);
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

// 跑团规则层（`extra/trpg/rules/`）：**纯函数目录**，不许 import 到该目录之外。
//
// 判据是"它必须能脱离平台独立开发与测试"：掷骰是跑团里唯一"错了会毁掉整局信任"的东西，
// 所以解析与求值不许碰 I/O、配置、日志或任何平台对象 —— 连 `node:` 内置模块都不许。
// 真熵源（`randomInt`）因此住在 `extra/trpg/entropy.ts`、由调用方**注入**，规则层连它的名字都不认识。
// 这与 DiceRobot 的 `dicerobot/trpg/ruff.toml` 是同一条约束（那边用 ruff 的 banned-api 表达）。
//
// ⚠️ **这条只靠注释守不住**：第一次"顺手 import 一个 logger 调试一下"不会有任何报错，
// 而破坏是静默的 —— 纯函数目录一旦有了 I/O，那些"注入随机源所以可复现"的断言就全变成假的绿。
const rulesDir = path.join(SRC, 'extra', 'trpg', 'rules');
if (fs.existsSync(rulesDir)) {
  for (const source of filesUnder(rulesDir)) {
    const sourceRel = slash(path.relative(SRC, source));
    const text = fs.readFileSync(source, 'utf8');
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[1] || match[2] || match[3];
      if (!specifier.startsWith('.')) {
        errors.push(`${sourceRel} -> ${specifier}: 跑团规则层是纯函数目录，不得 import 任何外部模块`
          + '（真熵源在 extra/trpg/entropy.ts，由调用方注入）');
        continue;
      }
      const resolved = slash(path.relative(rulesDir, path.resolve(path.dirname(source), specifier)));
      if (resolved.startsWith('..') || path.isAbsolute(resolved)) {
        errors.push(`${sourceRel} -> ${specifier}: 跑团规则层不得 import 到 rules/ 之外`);
      }
    }
  }
}
// **能力目录要不要带 `index.ts` 桶文件，这里不强制**：五个能力有（消费方 import `<能力>/index.js`），
// 而 `hot-search/` 没有 —— 它的消费者直接用那四个文件、套件也直接取内部的纯函数，
// 桶文件对它只是多一层。写文档时别把"通常有"说成"必须有"。

// 跑团（`extra/trpg/`）：**七个分层子目录 + 一个只放组装/声明/入口的根**。
//
// 判据与 `agent/` / `web/` 那两条逐字相同：**没有闸门，搬进子目录的东西会一个一个搬回来**。
// 跑团在 2026-10-16 那次重构里从 17 个平铺文件长成 30+，根目录白名单是那次重构唯一的机检约束。
// 七个子目录各自的分工见 `src/extra/trpg/index.ts` 与 AGENTS.md「跑团（TRPG）」。
const trpgRoot = path.join(SRC, 'extra', 'trpg');
const TRPG_GROUPS = ['rules', 'model', 'store', 'scenario', 'commands', 'tools', 'render'];
const TRPG_ROOT_ALLOW = new Set(['index.ts', 'types.ts', 'spec.ts', 'impl.ts', 'entropy.ts', 'suggest.ts']);
if (fs.existsSync(trpgRoot)) {
  for (const group of TRPG_GROUPS) {
    if (!fs.existsSync(path.join(trpgRoot, group))) errors.push(`extra/trpg/${group}: 缺少跑团分层目录`);
  }
  for (const entry of fs.readdirSync(trpgRoot, { withFileTypes: true })) {
    if (entry.isFile() && SOURCE_EXT.test(entry.name) && !TRPG_ROOT_ALLOW.has(entry.name)) {
      errors.push(`extra/trpg/${entry.name}: 跑团根目录只许放桶文件/领域类型/声明/组装/熵源/兜底建议，`
        + `实现请落进 ${TRPG_GROUPS.join(' / ')} 之一`);
    }
  }
}

// 跑团的**领域模型层**（`extra/trpg/model/`）：纯数据变换，**不碰外部世界**。
//
// 判据是"给一份状态，返回新状态"：归一化、钳制、状态机都在这里，而需要读写时一律**收 store
// 端口作参数**（`beginCampaign(chatKey, args, { store, rules, scenarios })` 就是这个形状）。
// 所以它不该认识 `node:fs` / `node:path` —— 那两样一出现，"这一层能不能脱离磁盘被测"就没了答案。
//
// ⚠️ 与 `rules/` 那条不同，这里**允许** import 本模块之外的东西（它要用 `agent` 的 `ok`/`err`），
// 只拦那两个内置模块。**这条也只靠注释守不住**：顺手 import 一个 `node:path` 去 join 个路径
// 不会有任何报错，而破坏是静默的（测试开始需要建真目录）。
const modelDir = path.join(trpgRoot, 'model');
if (fs.existsSync(modelDir)) {
  for (const source of filesUnder(modelDir)) {
    const sourceRel = slash(path.relative(SRC, source));
    const text = fs.readFileSync(source, 'utf8');
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[1] || match[2] || match[3];
      if (specifier === 'node:fs' || specifier === 'node:path') {
        errors.push(`${sourceRel} -> ${specifier}: 跑团领域模型层不做 I/O，需要读写时收 store 端口作参数`);
      }
    }
  }
}

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
    if (targetLevel > sourceLevel && !LAYER_ALLOW.has(`${sourceRel} -> ${targetRel}`)) {
      errors.push(`${sourceRel} -> ${targetRel}: T${sourceLevel} 不得反向依赖 T${targetLevel}`
        + '（确有必要时只能登记进 LAYER_ALLOW，见那里的说明）');
      continue;
    }
    if (sourceLevel === 1 && targetLevel === 1 && !T1_ALLOW.has(`${sourceRel} -> ${targetRel}`)) {
      errors.push(`${sourceRel} -> ${targetRel}: T1 领域间引用未登记精确白名单`);
    }
  }
}

// ── 具名例外的自带守卫：登记进 LAYER_ALLOW 的目标必须是**叶子模块** ──
// 一次"低层 import 高层"之所以不成环，靠的就是目标自己不 import 任何东西。
// 往那个文件里加一句 import，环就可能成立（core → extra → core），而 tsc 不一定报错、
// 运行期也只在特定加载顺序下才炸。所以这条例外必须由它自己守着，不能靠人记。
for (const pair of LAYER_ALLOW) {
  // 键右边是 import 说明符（`.js`），落到磁盘上的源文件是 `.ts`。
  const targetRel = (pair.split(' -> ')[1] || '').replace(/\.js$/, '.ts');
  const target = path.join(SRC, targetRel);
  if (!fs.existsSync(target)) {
    errors.push(`LAYER_ALLOW 里的目标文件不存在：${targetRel}（例外应当随目标一起删掉）`);
    continue;
  }
  const text = fs.readFileSync(target, 'utf8');
  SPECIFIER.lastIndex = 0;
  const relatives = [...text.matchAll(SPECIFIER)]
    .map((m) => m[1] || m[2] || m[3])
    .filter((specifier) => specifier && specifier.startsWith('.'));
  if (relatives.length) {
    errors.push(`${targetRel}: 它是 LAYER_ALLOW 的例外目标（低层要 import 它），`
      + `因此必须是叶子模块，但里面出现了相对 import：${relatives.join('、')}`);
  }
}

if (errors.length) {
  console.error(`依赖层级检查失败（${errors.length}）：`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`依赖层级检查通过：${files.length} 个源码文件`);
