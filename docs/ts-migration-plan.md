# TypeScript 重构方案（qq-agent / myQQbot）

> 状态：**计划已批准，尚未开工**。S0 已落库（就是这份文档）；S1 及之后每步都要单独确认再动。
> 写作日期：2026-09-24

## Context

**问题**：项目已经长到"扁平结构拖后腿"的规模，而且仍然裸奔在无类型检查的状态下。

- `src/` 28 个文件平铺在一起、13107 行；`src/app.js` 一个文件 2258 行，里面是 ~65 条 `if (pathname === …)` 路由分支。
- `ui/app.js` 5924 行、单文件经典脚本、90 个顶层函数共享一个全局作用域，改动一处要通读一片。
- 仓库里**没有任何构建/类型检查/lint/CI**：没有 `tsconfig`、没有 ESLint、没有 `.github/`，`package.json` 只有 `start` 和 `server` 两条脚本；`node_modules` 目前是空的。
- 唯一的安全网是 `%TEMP%` 下的 21 个断言套件（约 1000 条断言），不在版本库里，清一次临时目录就全没。
- 代价已经真实发生过：`detectMime` 被搬到 `safe-fetch.js` 后用 `export { … } from` 转出，漏了本地 import，**整条读图链路**在生产上炸成 `detectMime is not defined`（2026-09-24）。同一类事故还有 `normalizeStickerEntry` 的字段白名单——新字段不加进去就静默丢失（注释里专门写了警告）。这两类问题 TypeScript 都能在 `npm run typecheck` 时就拦住。

**目标**：把扁平结构拆成按域分的目录，逐步迁到 TypeScript，并补上类型检查与仓库内测试这两道闸门；**运行行为、HTTP 接口、数据格式一律不变**。

### 已与用户确认的四条决策（不再讨论）

| 决策 | 结论 | 理由 |
|---|---|---|
| 最终怎么跑 | **tsc 编译到 `dist/`**，Node / Electron / scripts / 测试都跑 `dist` 产物 | 运行时零新增依赖；`dist` 与 `src` 目录结构 1:1，加 sourcemap 后堆栈仍指回 `.ts` 行号 |
| 目录重构粒度 | **先只搬目录**（`git mv`，仍全是 `.js`）；拆 `app.js` 路由留到后面单独一步 | 一次只动一种东西：先路径、后类型。每步都能单独跑测试、单独回滚 |
| 前端 UI | **拆成 ES 模块，仍是 `.js`，不打包**（`index.html` 改 `<script type="module">`） | 不引入任何新工具链，浏览器直接跑；UI 拆文件的价值主要来自模块边界，不来自类型 |
| 测试套件 | **搬进仓库 `tests/`**；本次只出文档，**不动任何代码** | 它们会被这次重构改到 import 路径，先有安全网再动结构；顺带解决"临时目录一清就全丢" |

---

## 一、目标形态

```
src/
├─ core/      config.ts  paths.ts  util.ts  personas.ts  tier-slider.ts
├─ llm/       llm.ts  providers.ts  model-prices.ts  price-feed.ts
│             vision-scan.ts  model-vision-docs.ts
├─ chat/      store.ts  memory.ts  sessions.ts            (+ types.ts)
├─ qq/        onebot.ts  sender.ts  md-to-plain.ts        (+ types.ts)
├─ media/     safe-fetch.ts  web-search.ts  jmcomic.ts
├─ stickers/  stickers.ts  sticker-manager.ts  sticker-cache.ts  (+ types.ts)
├─ agent/     orchestrator.ts  prompt.ts  tools.ts  context-window.ts  (+ types.ts)
└─ web/       app.ts  server.ts                          (S6 后再加 routes/)
```

**依赖只能向下，跨目录禁止反向/同层互引**（同目录内部随意）：

```
T0 core
T1 llm / chat / qq / media
T2 stickers
T3 agent
T4 web          ← 只有它 import 所有人，没人 import 它
```

现有的 28 个文件的依赖图**已经符合这个分层**（例：`sticker-manager → onebot` 是 T2→T1 ✓，`prompt → stickers` 是 T3→T2 ✓，`config → personas/tier-slider` 是目录内 ✓），所以搬迁只是改路径，不需要动逻辑。搬迁后建议加一个 `scripts/check-layers.mjs`（grep import 语句、按目录判层，越界就报错）把这条规则钉住。

`dist/` 镜像 `src/`（`rootDir: src` + `outDir: dist`），且 `.gitignore` 里**已经有** `dist/`。

---

## 二、分阶段（每阶段一个可回滚的提交/PR）

### S0 计划落文档（✅ 已完成，不碰代码）

把本文档写进仓库 `docs/ts-migration-plan.md`（多周的事，需要它能被随时翻出来；`docs/` 现在只有生成的 `model-prices.md`）。

**已做**：仅新增本文件。
**未做**：任何源码、配置、依赖改动。

### S1 安全网进仓库（仍是 `src/*.js`，零风险）

```
tests/
├─ run.mjs            一条命令跑全部：先 build（若需要），再逐个套件起子进程，最后汇总，失败非零退出
├─ register.mjs       loader hook（顶掉 ws/js-yaml，照搬 %TEMP% 那份）
├─ lib/harness.mjs    ok() / mkdtemp+QQ_AGENT_DATA_DIR / 假图床 / 假模型端点 / vm 假 DOM
└─ t-*.mjs            21 个套件原样搬入
```

- **关键设计：所有套件不再硬写源码路径**，统一走 `tests/lib/src.mjs`：
  ```js
  // 只在这一处决定"被测代码在哪"，S4/S5 之后改成 dist 就是一行
  const BASE = process.env.QQ_AGENT_SRC ?? new URL('../dist/', import.meta.url);
  export const load = (rel) => import(new URL(rel, BASE).href);
  ```
  ⚠️ `QQ_AGENT_DATA_DIR` 必须在任何 `import` 之前设好（`config.js` 在模块加载时就把 `DATA_DIR` 定死了），所以 `load()` 必须是**动态** import，helper 本身不能在顶层 import 被测模块。
- 21 个套件里 10 个（t-cfg/t-compact/t-orch/t-orch2/t-diag/t-final/t-final2/t-reentry/t-stall/t-fire）是**打印式诊断脚本**、不是断言套件，runner 要单独分组（默认跑断言套件，`--all` 才带上它们）。
- 首次入库要跑一遍、把已经腐烂的套件**要么修好要么明确删掉**，不留"红的也照样跑"的习惯。
- 顺手加质量闸门脚本：`"check": "npm run typecheck && node tests/run.mjs"`（没有 CI，就靠它）。
- 验证：`node tests/run.mjs` 全绿。

### S2 工具链与 `dist` 切换（此时 **0 个 `.ts` 文件**）

1. devDependencies 加 `typescript@~5.6`、`@types/node@^20`（`ws` 若在 `.ts` 里 import 需 `@types/ws`；`undici` / `electron` 自带类型）。首次要 `npm ci`——**注意会拉 Electron（约 100MB+）**，这台机器现在 `node_modules` 是空的。
2. `tsconfig.json`：
   ```jsonc
   {
     "compilerOptions": {
       "module": "NodeNext", "moduleResolution": "NodeNext", "target": "ES2022",
       "rootDir": "src", "outDir": "dist",
       "allowJs": true, "checkJs": false,        // ← 增量迁移的关键：只查 .ts
       "strict": true, "isolatedModules": true,
       "sourceMap": true, "removeComments": false,  // 注释是这个仓库的文档，必须保留
       "skipLibCheck": true, "esModuleInterop": true, "incremental": true
     },
     "include": ["src/**/*.ts", "src/**/*.js"], "exclude": ["dist", "node_modules"]
   }
   ```
   **禁止 `baseUrl`/`paths` 别名**：Node 直接跑 `dist` 时不认别名，除非再引 loader/打包器——显式相对路径是这里唯一安全的选择。同理，`.ts` 里的 import 说明符**继续写 `.js` 后缀**（NodeNext 约定），这样编译产物的说明符一个字符都不用变。
3. `package.json` scripts：`build` / `typecheck` / `dev`（`tsc -w`）/ `check`，`server` 改成 `node dist/server.js`，并加 `prestart`/`preserver` 自动 build（防"改了源码忘了 build，跑的是旧 dist"）。
4. 入口改指 `dist`（见第四节清单）。
5. 两个入口顶部调 `process.setSourceMapsEnabled?.(true)`，否则日志里的 `at async Orchestrator.wake (…:558:11)` 会指到 `dist` 的行号。
6. **为什么必须先做这步**：一旦有文件改成 `.ts`，Node 20 就跑不了它（`--experimental-strip-types` 是 22.6+，Electron 33 内嵌的是 Node 20），运行时只能靠 `dist`。所以构建必须排在第一个 `.ts` 之前。先在全 `.js` 状态下把工具链跑通，出问题就百分百是工具链的问题，跟类型无关。
7. 验证：`npm run build` 无错 → `node dist/server.js` 起服务、浏览器开 `127.0.0.1:3210` 面板正常 → `npx electron .` 窗口正常 → `node tests/run.mjs` 全绿（此时 `QQ_AGENT_SRC=dist`）。

### S3 路径锚点集中（第一个 `.ts` 文件）

现状是**深度敏感**的，这是搬迁前必须拆掉的地雷：

- `src/config.js`：`ROOT = resolve(__dirname, '..')` → `DATA_DIR`、`CONFIG_FILE`
- `src/app.js`：`UI_DIR = resolve(__dirname, '..', 'ui')`
- 两者都基于 `fileURLToPath(import.meta.url)`，**文件下沉一层就会指错**（编到 `dist/core/config.js` 后 `..` 变成 `dist/`，`python-tools/`、`assets/`、`ui/`、`data/` 全找不到）。

新增 `src/paths.ts`（先平铺，S4 再随大流搬进 `core/`）：

```ts
/** 从本文件向上找 package.json，找到就是项目根。不数 `..`，因此对目录深度免疫。 */
export const ROOT: string;         // 向上最多 6 层找 package.json
export const DATA_DIR: string;     // process.env.QQ_AGENT_DATA_DIR || ROOT/data
export const UI_DIR: string;       // ROOT/ui
export const CONFIG_FILE: string;  // DATA_DIR/config.json
```

`config.js` / `app.js` / `jmcomic.js` / `price-feed.js` 改成从它取；`config.js` 暂时**转出**这三个常量以免一次改太多调用点（转出时记得同时 import 进来——就是 2026-09-24 那个坑）。

新增 `tests/t-paths.mjs`：断言 `ROOT` 下有 `package.json`、`DATA_DIR` 指向 `QQ_AGENT_DATA_DIR`、`UI_DIR/index.html` 存在；**并且从 `src/` 与 `dist/` 两个位置各跑一次**。

验证：`npm run build && node tests/run.mjs` 全绿。

### S4 目录搬迁（`git mv`，全是 `.js`）

- 按第一节的树 `git mv`，**只改路径、不改代码语义**；import 说明符从 `'./x.js'` 改成 `'../core/x.js'` 之类（约 100 条边），全部机械可验。
- 跨界引用只有 5 处（见第四节），一次改到位。
- `tests/lib/src.mjs` 的 `BASE` 仍是 `dist`，套件里改成 `load('chat/store.js')` 这种相对路径。
- 验证：`npm run build && node tests/run.mjs` 全绿；`node dist/server.js` 起得来；`node scripts/*.mjs` 三个脚本仍能跑。搬迁后顺手跑一下 `git log --follow` 确认历史跟得住（`git mv` 的目的就是这个）。
- 回滚：整体 revert 一个提交即可。

### S5 逐目录 `.js` → `.ts`（体量最大的一步，但可以按目录切碎）

顺序（叶子优先，先啃没依赖的）：

1. `core/`：`util`、`md-to-plain`、`tier-slider`、`personas`、`paths`（已是 .ts）、`config`
2. `llm/`：`model-vision-docs`、`model-prices`、`price-feed`、`llm`、`providers`、`vision-scan`
3. `chat/`：`sessions`、`store`、`memory`
4. `qq/`：`md-to-plain` 已转、`sender`、`onebot`
5. `media/`：`safe-fetch`、`web-search`、`jmcomic`
6. `stickers/`：`stickers`、`sticker-cache`、`sticker-manager`
7. `agent/`：`context-window`、`prompt`、`tools`、`orchestrator`（最后，1793 行）
8. `web/`：`app`（留到 S6 拆路由时一起转，避免同一个文件改两遍）

**一个目录转完再动下一个**，每次 `npm run typecheck && node tests/run.mjs` 必须绿——因为只检查 `.ts`（`checkJs: false`），未转换的 `.js` 不参与检查，不会出现"几万个错误糊在一起"的局面。

`.ts` 文件一律按 `strict` 写；个别为了兼容旧写法确实需要 `any` 的地方，用**带注释的局部 `any`**（说明为什么），不要全文件放宽。

### S6 `app.js` 拆路由（2258 行 → `web/` 子树）

按域分成 `web/routes/`（`sessions` / `chats` / `stickers` / `config` / `usage` / `system` …），配一张路由表：

```ts
type Route = { method: 'GET'|'POST'|'DELETE'; path: string | RegExp; handle(ctx: AppCtx, req: Req, m: RegExpMatchArray | null): Promise<Reply> };
```

参数路由（现在散着 ~10 个 `xxxMatch = pathname.match(...)` 变量）统一由表来做；handler 返回 `{ status, body }` 而不是自己 `res.writeHead/end`。**HTTP 路径、请求体、响应体一个字节都不改**（t-admin / t-smoke / t-panel 等套件在守）。

同步转 `.ts`，并给 `AppCtx` 一个接口——现在它是鸭子类型，测试里靠手搓假对象（t-orch 就是），有接口后这些假对象能被编译器检查。

### S7 UI 拆 ES 模块（独立轨道，可与其他阶段并行）

`ui/js/`：`main.js`（启动 + 标签页）、`state.js`、`api.js`（`api()` + EventSource）、`dom.js`（`$`/`$$`/`esc`/格式化）、`views/*.js`（sessions / chats / memory / stickers / usage / settings）、`parts/*.js`（下拉、滑条、模态框、主题、成本表）。**分组原则直接沿用文件里现成的 `// ── xxx ──` 分节横幅**（约 33 段），每文件 ≤400 行。

- `index.html`：`<script src="/app.js">` → `<script type="module" src="/js/main.js">`。`src/app.js` 的静态服务**不用改**（它已经服务 `UI_DIR` 下任意路径，mime 表里有 `.js`）。
- 已确认的两件事让这步很便宜：HTML 里**没有任何 `onclick="fn()"`**（全是事件委托/绑定），所以"函数不再挂全局"不会踩雷；模块是 defer 加载，反而免掉了现在的启动时序顾虑。
- **约束（为了测试）**：UI 模块不许 import 任何东西（无 bare specifier），顶层不许碰 DOM——全部走导出的 `init()`。这样 `t-ui-render` 可以从"整份塞进 `vm` + 手搓 DOM 壳 + `globalThis.__state` hack"升级成：先把假 DOM 装到 `globalThis`，再 `await import('ui/js/main.js')`，然后用**具名导出**驱动（比现在干净）。UI 套件必须在各自进程里跑（模块只求值一次）。
- 回滚：UI 是独立子树，`index.html` 那一行改回去即可。

### S8 收尾

- `scripts/sanitize-release.mjs`：`TEXT_EXT` 里补 **`.ts`**（否则密钥扫描会跳过源码）；`SKIP_DIR` 已有 `dist`；发布流程要在打包前 `npm run build`（发布包只需要 `dist` + 运行时依赖，`npm ci --omit=dev` 即可，`typescript` 不必随包走）。
- `scripts/export-prices-md.mjs` 是**把 `src/model-prices.js` 当文本读**、按 `// ══ 厂商 ══` 注释切段的——迁移后要指向 `src/llm/model-prices.ts`（tsc 默认保留注释，`removeComments: false` 也保住了 `dist` 里的注释，但这个脚本读的是**源码**）。`scripts/export-prices.mjs` / `apply-vision-docs.mjs` 的 import 改指 `dist`。
- README：安装（`npm ci`）→ 首次 `npm run build` → `npm start` / `npm run server`；改源码后 `npm run dev`（watch）。`启动QQ机器人.bat` **保持原样**（它是给最终用户/便携包用的，跑的就是已构建好的 `dist`；开发流走 npm 脚本）。
- 可选：`electron/main.js`（177 行）也转 `.ts`（要单独一个 `tsconfig.electron.json`，因为 `rootDir` 不同）。

---

## 三、类型化策略

- **只管 `.ts`**（`checkJs: false`）：迁移期间每提交都绿，未转换的 `.js` 不产生噪音。
- **接口就近放**：`core/`（`AppConfig`）、`chat/types.ts`（`ChatMessage` / `MediaEntry` / `SessionRecord`）、`llm/types.ts`（`ChatRequestMessage` / `ToolCall` / `Usage`）、`qq/types.ts`（OneBot v11 事件联合 + CQ 段）、`stickers/types.ts`（`StickerEntry`）、`agent/types.ts`（`ToolResult` / `ToolContext` / 事件表）。跨域只有 `AppConfig` 和事件表。
- **JSON 边界保持 `unknown` + 手写窄化**，不引入 zod/io-ts（与这个仓库"零额外运行时依赖"的风格一致；`safeParse` 之类的小 helper 已经存在）。
- **不加**品牌类型（branded types）、不加 `noUncheckedIndexedAccess`（13k 行的存量代码会被淹没），这两样留作 S8 之后的可选收紧。
- 有三处"注释里写着"的坑会被类型系统直接接管，这是本次重构最实在的收益：
  1. `normalizeStickerEntry` 的字段白名单（`cacheFile` 静默丢失那一类）→ `StickerEntry` 接口 + 白名单构造器，漏字段编译期就报；
  2. `detectMime` 的 `export { x } from` 陷阱 → `.ts` 里用未 import 的名字直接 "Cannot find name"；
  3. `ToolContext` 鸭子类型 → 工具与假测试对象都被编译器检查。

---

## 四、需要改的跨界引用（S2 一次改到位）

| 位置 | 现在 | 改成 |
|---|---|---|
| `package.json` scripts | `"server": "node src/server.js"` | `"server": "node dist/server.js"` + `build`/`typecheck`/`dev`/`check` + `prestart`/`preserver` |
| `electron/main.js` | `await import('../src/app.js')` | `await import('../dist/app.js')` |
| `scripts/export-prices.mjs` | `import '../src/model-prices.js'` | `import '../dist/llm/model-prices.js'` |
| `scripts/apply-vision-docs.mjs` | `import '../src/config.js'` | `import '../dist/core/config.js'` |
| `scripts/export-prices-md.mjs` | 把 `src/model-prices.js` 当文本读 | `src/llm/model-prices.ts` |
| `tests/lib/src.mjs` | —（S1 新建） | `dist/`（可 `QQ_AGENT_SRC` 覆盖） |
| `README.md` `启动QQ机器人.bat` | 直接起 electron | 文档补 build；`.bat` 不动 |
| `.gitignore` | 已有 `dist/` | 再补 `*.tsbuildinfo` |
| `scripts/sanitize-release.mjs` | `TEXT_EXT` 无 `.ts` | 补 `.ts` |

`src/server.js` 内部 `import './app.js'` **不用改**（两者都在 `dist` 里，相对关系不变）。

---

## 五、风险与对策

1. **路径锚点深度敏感**（最大的一颗雷）：必须排在搬迁**之前**（S3），并且用"向上找 package.json"而不是数 `..`，否则 `dist/core/config.js` 会把 `ROOT` 算成 `dist/`，`data/`、`ui/`、`python-tools/` 全部失联——而且症状是运行时才炸。
2. **`.js` 后缀必须保留在 `.ts` 的 import 里**（NodeNext 约定）：这是 `dist` 与 `src` 说明符 1:1 的前提，随手"清理"成无后缀会让编译产物在 Node 里解析失败。
3. **忘了 build 就跑**：改 `src/*.ts` 后不加 `prestart`/`preserver`，`node dist/server.js` 跑的是旧产物，排查成本极高。用 npm 生命周期钩子 + `tsc -w` 兜住。发出去的便携包本来就只带 `dist`，不受影响。
4. **`%TEMP%` 套件是全部分安全网，且不在版本库**：S1 必须先把它们搬进 `tests/` 并跑绿，否则 S4/S5 是在盲改。
5. **入口清单漏改**（第四节表格）：漏一处不会编译报错，只在运行时表现为"改的地方没生效"。建议 S2 提交时按表逐条打勾。
6. **`scripts/*.mjs` 读源码文本**：`export-prices-md.mjs` 解析的是注释横幅，路径/后缀变更会静默产出空文档——S8 改完要跑一次 `node scripts/export-prices-md.mjs` 并 diff `docs/model-prices.md`。
7. **循环依赖**：今天一个都没有（`tier-slider` 被特意做成零依赖就是为了这个）。搬迁可能诱使人写出 `core → agent` 这种反向依赖，用 `scripts/check-layers.mjs` 钉住分层。
8. **`tsc` 编到 `dist` 会让"就地改、就地跑"的手感消失**（替代方案是 `outDir: src` 与源码同目录，代价是 `src/` 里混入生成物、`git status` 噪音、容易改错文件——已确认不走这条）。开发期用 `tsc -w` 缓解。
9. **首次 `npm ci` 会拉 Electron（100MB+）**，这台机器现在 `node_modules` 是空的；只想要类型检查的话先装运行时会失败，得接受一次性成本。
10. **UI 拆模块后，`t-ui-render` 的 `vm` 假壳方案失效**：要改成"装假 DOM 到 `globalThis` 再动态 import"，并把每个 UI 套件放进独立进程（S7 已写明）。

---

## 六、明确的验证矩阵

每阶段收尾都跑：

```bash
npm run typecheck        # tsc --noEmit
npm run build            # tsc -p tsconfig.json
node tests/run.mjs       # 仓库内套件（断言组全绿；--all 带诊断组）
node dist/server.js      # 起服务，浏览器开 127.0.0.1:3210 逐个标签页点一遍
npx electron .           # 窗口 / 托盘 / 单实例锁正常
node scripts/sanitize-release.mjs --dry-run   # 发布清理流程没被破坏
```

外加一次**真机冒烟**（只有它能验的地方）：连 SnowLuma 收到一条真实群消息 → 机器人回复 → 会话记录面板里能看到这次运行。

---

## 七、不做的事（本次范围外）

- 不加 ESLint / Prettier / 测试框架 / 打包器（UI 明确不打包）；不引 zod 之类的运行时校验库。
- 不改任何运行时行为、HTTP 接口、`data/` 文件格式与字段、提示词内容。
- 不升级已有依赖，不动 Electron 版本，不碰 `snowluma/`（第三方）。
- 不搬 `electron/`、`assets/`、`python-tools/`、`scripts/`（`scripts/*.mjs` 保持 `.mjs`，只改 import 指向）。
- 不做 `noUncheckedIndexedAccess`、品牌类型、路径别名（`@core/*`）这类"好看但会挡住增量迁移"的收紧——留到结构稳定之后。
- S0 不动 `ui/` 与 `src/` 的**任何**代码。
