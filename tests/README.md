# tests/ —— 仓库内的测试套件

没有测试框架：套件就是普通的 `.mjs` 脚本，用 `node` 直接跑，每个起一个子进程
（各套件都会改全局配置、起假服务器、写自己的临时数据目录，同进程会互相污染）。
但**需要 `npm install`**——套件验的是 `tsc` 产物 `dist/`，所以也依赖 `node_modules`。

```bash
npm test              # 先 build，再跑 13 个断言套件，全绿才退 0
npm run test:all      # 连 10 个打印式诊断脚本一起跑
node tests/run.mjs --list            # 只列清单
node tests/run.mjs --no-build        # 跳过开跑前的 tsc（刚 build 过就别再编了）
node tests/run.mjs t-sticker t-admin # 只跑名字匹配的
```

单个套件也能直接跑（调试时最常用）：

```bash
node tests/t-sticker.mjs
```

## 目录

```
tests/
├─ run.mjs           跑全套的入口：先 build、再逐个起子进程、汇总、失败退非零
├─ lib/
│  ├─ src.mjs        被测代码在哪 —— 全仓库只有这一处写死
│  └─ harness.mjs    公用零件：checker / dataDir / 假图床 / 假模型端点 / 假 DOM
└─ t-*.mjs           23 个套件（13 断言 + 10 诊断）
```

## 两条必须知道的规矩

**1. 加载被测模块一律走 `lib/src.mjs` 的 `load()`，不要自己拼路径。**

```js
import { load } from './lib/src.mjs';
const { ChatStore } = await load('store.js');       // tsc 产物 dist/ 下的模块
```

`load()` 是**动态** import，这一点是硬要求：`src/config.js` 在模块加载那一刻就把
`DATA_DIR` 定死了，所以套件得先建临时数据目录再设 `QQ_AGENT_DATA_DIR`，然后才能
加载第一个被测模块。顺序反过来，测试就会往真数据目录（真聊天记录、真表情包、
真 API key）里写东西。用 `harness.dataDir()` 一次做完这两件事：

```js
import { dataDir, checker } from './lib/harness.mjs';
dataDir();                                   // mkdtemp + 设好 QQ_AGENT_DATA_DIR，退出时自动删
const { load } = await import('./lib/src.mjs');
```

**2. 新套件必须在 `run.mjs` 里归类（`ASSERT` 或 `DIAG`）。**

清单没覆盖到磁盘上的 `t-*.mjs` 时，`run.mjs` 会直接报错退出——这是故意的：
套件不能"悄悄躺着不跑"。有断言、失败会退非零的进 `ASSERT`；只打印行为的进 `DIAG`。
**新写的套件请用 `harness.checker()`**，不要再手写第 N 份 `ok()`。

## 断言套件（13）

| 套件 | 守着什么 |
|---|---|
| `t-paths` | 路径锚点 `ROOT`/`DATA_DIR`/`UI_DIR`/`CONFIG_FILE`（含"文件下沉一层后仍算得对"） |
| `t-window` / `t-window-http` | 上下文窗口、滑动、相关接口 |
| `t-reply` | 提示词拼装 |
| `t-notice` | 通知、卡片消息解析 |
| `t-digest` | 历史摘要注入（含"没有摘要时提示词与旧版逐字相同"） |
| `t-sticker` | 表情包管理与缓存 |
| `t-smoke` | 端到端冒烟：真起 app 再 fetch |
| `t-panel` / `t-panel-wiring` | 面板接口 + `ui/*` 文本层接线 |
| `t-admin` | 管理接口 |
| `t-ui-render` | 把 `ui/app.js` 整份丢进 vm 跑一遍，看拼出来的 HTML |
| `t-vision-log` | 读图 → 会话记录回填（自起假模型端点跑整轮 orchestrator） |

## 诊断脚本（10）

`t-cfg` / `t-compact` / `t-diag` / `t-orch` / `t-orch2` / `t-fire` / `t-final` /
`t-final2` / `t-reentry` / `t-stall` —— 这些是当时排查问题用的打印脚本：跑一段
真实场景，把中间状态打出来给人看，没有断言也没有退出码。默认不跑（合计约 40 秒）。

## 为什么验 `dist/` 而不是 `src/`

S2 起运行时跑的是 `tsc` 产物，**S3 起 `src/` 里有 `.ts` 了，它不再是能跑的东西**
（Node 20 跑不了 `.ts`，`src/config.js` 会 import 不到 `./paths.js`）。
所以 `dist/` 是唯一的运行形态，套件也验它——这反而是好事，验的是**真正会被执行的那份代码**，
顺带把"编译坏了"和"代码坏了"分成了两件事（`run.mjs` 一上来就 build，build 挂了
直接报，不会拿旧产物给你一个假绿灯）。

代价是要 `npm install`（`typescript` + 运行时依赖），不再是"空 node_modules 也能跑"。

早期（`node_modules` 为空时）确实用过一套 loader hook 把 `ws` / `js-yaml` 顶成空壳，
S2 装完依赖后**已经把 hook 删掉了**：它让"用 yaml 读配置""真的构造 WebSocket"
这两条路在套件里是假的，而假的那条路今天已经没有必要。
同样地，`QQ_AGENT_SRC=src` 这个逃生口也在 S3 删掉了——它从 src/ 出现第一个 `.ts` 起
就一定跑不通，留着只会让人以为还有退路。要回到"跑源码"只能等 `.ts` 全部转换完之后
另想办法（Node 22 的 `--experimental-strip-types`，或者继续用 `tsc -w` 看编译错误）。

改了源码之后，套件里的相对路径要跟着变（`load('chat/store.js')`），这类变化只影响
`lib/src.mjs` 一处——这也是它存在的原因。

## 来历

2026-09-24 之前，这 22 个套件散在 `%TEMP%` 下，路径写死成绝对路径，
清一次临时目录就全没了。搬进仓库是 TypeScript 重构的 S1（见
`docs/ts-migration-plan.md`）：后面要动目录结构、要换成跑 `dist/` 产物，
先得有一张不会丢、且只有一处知道"源码在哪"的安全网。

S2 把工具链接上，`lib/src.mjs` 的默认值从 `src/` 切到 `dist/`——这一步的前提就是
S1 那 22 个套件已经在仓库里、已经全绿：**切换运行形态时，闸门必须是现成的。**

S3 加进第 23 个（`t-paths`），守的是"路径常量不许再跟着文件位置走"。
它是唯一一个会在 `%TEMP%` 里造夹具、把编译产物拷进更深目录再 import 的套件，
理由见文件头的注释。