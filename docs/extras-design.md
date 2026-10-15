# 扩展能力（extra）设计

> 2026-10-15 落地并同日扩了一轮（命令装载 / 提示词注入 / 接管模式）。本文记录**已经实现**的形态与它的取舍，不是提案。
> 相关：`AGENTS.md`「扩展能力（extra）」、`docs/ts-migration-plan.md` §2。

## 1. 要解决的问题

`src/extra/` 用来收"额外且相对独立的功能"。在这之前，加一个能力要在四处装配点各改一次（工具表、装配清单、描述表、组装根），而它本来只该是"多一个工具、或者多一个后台任务"。扩展层要做的就是把这件事压成**建一个目录 + 加一行**。

同时它要满足两个要求：**不用的时候不付代价**（不起子进程、不占内存），以及**装载的时机由人决定**（见下一节）。

## 2. 谁能装载 —— 这一节是全部设计的地基

**模型一个装载入口都没有。**

- 装载与卸载的唯一入口是主流程那条 `/能力` 命令：`/能力`（看列表）、`/能力 加载 <id>`、`/能力 卸载 <id>`。
- 敲扩展**自己**的命令也会把它拉起来（入口同样是人）。
- **未装载的扩展，它的工具不在工具表里**。模型连"有这个能力"都看不到，更没有"调用即加载"这条隐式路径。

这条取舍带来一串必须一起成立的性质：

| 性质 | 为什么必须这样 |
|---|---|
| **工具表按"已装载"、命令表按"已启用"** | 两个入口的人不同：命令的入口是**人**（判据按 spec 静态，敲得到），工具的入口是**模型**（只该看到此刻真正可用的能力）。这条**不对称是刻意的**，别统一掉 |
| **命令的判据留在 `spec.ts`** | `isSlashCommand()` 是同步的、且在入站热路径上被调（决定 `wakeEligible`、要不要并入引用附件）。它不可能去问一个异步的装载表 —— 判据静态 + 执行时装载，矛盾就没了 |
| **别名由分发层统一处理** | 见 §3.3 |
| **`/能力` 在任何模式下都存在** | 它是卸载接管者的唯一入口。把它一起换掉就是死锁（装得上、卸不掉） |
| **工具表变成运行期可变** | `agent-runner` 每次运行开头读一次 `host.toolDefs`（`WakeScheduler` 上是 getter），语义因此是"**装载后，下一次运行生效**" |

**代价（知情）**：tools 是请求前缀的一部分，装载/卸载各打散一次提示词缓存。但频次由人控制（TTL 默认 10 分钟），这正是这条设计换来的东西。

**开放问题**：`/能力` 的权限与内置命令一致（白名单会话里可敲），所以白名单群里**任何群友**都能起一个重扩展。缓解是 `extras.maxLoadsPerHour` 那道闸门；要收紧只需在 `slash-commands.ts` 那一处加判据（仓库目前没有"管理员 QQ"的概念，管理动作的既有落点是 HTTP 控制台）。

## 3. 形态

```text
src/extra/
├─ types.ts          契约（ExtraSpec / ExtraRuntime / ExtraCommandSpec / ExtraPromptContribution）—— 不 import 本模块任何文件
├─ prompts.ts        扩展的固定指令 EXTRA_PROMPT_TEXT / EXTRA_PROMPT_SECTIONS —— **必须无 import**（§7）
├─ registry.ts       静态清单 EXTRA_REGISTRY，每行 { ...xSpec, load }
├─ runtime.ts        ExtrasRuntime：装载表 + 由它派生的三张表 + 校验
└─ <x>/
   ├─ spec.ts        纯数据（id / title / displayDesc / mode / defaultEnabled / 工具与命令声明）
   └─ impl.ts        export function createRuntime(): ExtraRuntime（重东西全在这里）
```

```ts
// registry.ts —— 与 web/runtime/lifecycle.ts 的装配清单同一形态：存函数引用、只 for...of、无按键分发
export const EXTRA_REGISTRY: readonly ExtraEntry[] = [
  { ...clockSpec, load: () => import('./clock/impl.js').then((m) => m.createRuntime()) }
];
```

**加一个扩展 = 建一个目录 + 在本文件加一行。**

### 3.1 声明与实现分开

`spec.ts` 被注册表**静态** import，`impl.ts` 永远走 `import()`。

`ExtraRuntime` 提供 `handlers`（工具名 → 执行函数）、可选的 `commandHandlers`、可选的 `prompt()` 与 `dispose()`。

**为什么是"名字 → 函数"的映射而不是单个 `execute(name, …)`**：只有这样名字集合才**可枚举**。写成单个 `execute` 的话，运行时无法在不真的执行一次的前提下知道实现认哪些名字，那句"装载时校验声明与实现对得上"就只能退化成"凭声明相信它" —— 而声明与实现分居两处，正是这套设计唯一的漂移点。查表本身**不是**被禁的"字符串式业务注册表"：它是扩展自己实现的内部细节，键来自 `spec`（注册表静态数据），不参与任何跨模块分发。

### 3.1.1 命令这一侧的两个形状 —— 一个必须分开，一个必须合并

| 形状 | 住哪儿 | 是什么 |
|---|---|---|
| `SlashCommand`（内部） | `web/onebot/slash-commands.ts` | **命令骨架**：`run(input, deps): Promise<void>`，回执发送 / `error.message` 原样进群 / 发送失败不抛三条都在它的 `runCommand` 外壳里 |
| `ExtraCommand` | `extra/types.ts`（**唯一定义处**） | **业务实现**：`run(input): Promise<string\|null>`，只返回一句回执文本，**不碰 sender** |

**必须分开**：两者职责不同 —— 骨架管"怎么发出去"，实现管"发什么"。`adaptExtraCommand()` 就是把后者套进前者的那一层。

**必须合并的是它自己的定义处**：`ExtraCommand` 只写在 `extra/types.ts`，web 侧 **import 它**（`web → extra` 是允许的方向），不再抄一遍形状 —— 抄一遍的话"两边漂移了"只能靠人核对，import 之后**编译器就会报**（`adaptExtraCommand` 里那句 `command.run(input)` 就是那条编译期对账）。

### 3.2 三张表各自的筛选条件

```ts
toolDefs()     // 附加模式：**已装载**的扩展；接管模式：只有接管者的
commandDefs()  // 附加模式：**已启用**的扩展；接管模式：只有接管者的
promptPlan()   // 只算**已装载**扩展的贡献
```

### 3.3 命令别名（可选）

内置与扩展的命令都可以声明 `aliases`（如 `/能力` 的 `/扩展`、`/时间` 的 `/time`）。**判定与规范化都在分发层的一处**：

```ts
matchesCommand(cmd, text) = cmd.match(text) || cmd.aliases.some((a) => startsWithWord(text, a))
canonicalize(cmd, text)   = 命中别名时把开头那个词换成 cmd.name
```

**为什么必须规范化**：每个命令的解析器只认识自己那一个词。不换的话，加一个别名要同时改解析器 —— 内置的解析散在 `media/` 下各能力里、扩展的在 `impl.ts` 里，三处各改一次，而漏改的表现是"命令被认出来了、但参数解析不出来"（`/time` 交给只认 `^/时间` 的解析器 → 返回一句用法提示）。

**推论：`SlashCommand.name` 必须是真能敲的那个词。** 曾经内置命令写的是 `'transcribe'` 这类内部标签，别名一接上就把它规范成了 `transcribe …`，解析器当场认不出来 —— 这是实测踩到的一次。现在 `name` 一律是命令词本身（`/转写`、`/画`、`/漫画`、`/能力`）。

`startsWithWord` 的规矩与主判据一致：**词后面跟空白或直接结束**（`/画像` 不是 `/画`，`/weatherx` 不是 `/weather`）。中文没有分词，这是"前缀 + 边界"能做到的极限 —— 放宽成 `includes` 会把 `/画廊今天开了吗` 认成 `/画` 命令。

别名与主命令词**共用一个命名空间**，注册表自检拒绝重复（跨扩展也查）：重了的话"先匹配到的先处理"会静默地决定谁赢，而两个命令的作者都以为自己的那个会被执行。

## 4. 装载与卸载

```text
/能力 加载 <id>   ── 闸门 → import() → 校验名字集合 → 记入装载表 → 起空闲计时器
敲扩展自己的命令   ── 同一条机械（没装载就先装载）
每次执行          ── inFlight++ / 清空闲计时器 → 执行 → inFlight-- / 按 idleUnloadMs 重新起表
空闲到点          ── inFlight>0 就推迟；否则 dispose() → 从装载表删掉
/能力 卸载 <id>   ── 在途时拒绝；否则清计时器 → dispose() → 从装载表删掉
app.stop()        ── 清全部计时器 + dispose 全部已装载项（每个带等待上限）
```

- **TTL 是滑动的空闲窗口**，每次执行都把它推后。
- **在途调用期间绝不 dispose** —— 那是"任务跑一半被抽掉子进程"的成因，且症状偶发、看起来像扩展自己有 bug。
- **`dispose()` 有等待上限**（3s，且只在返回 thenable 时才建计时器）：一个卡住的扩展不该挂死 `stopLifecycle`。
- **装载闸门**复用 `media/call-budget.ts` 的 `SlidingWindowBudget`，键是**扩展 id**（防的是"反复起停同一个子进程"，那是速率问题，与哪个群在问无关）；被拒的那一次不占额度、也不加载。

## 5. 系统提示词：具名段落 + 框架契约

`buildSystemPrompt` 按 `core/prompt-catalog.ts` 的 `SYSTEM_SECTION_IDS` 拼段落 —— **段序即数组顺序**。有了段名，扩展才能"按名字覆盖"。

```ts
export const SYSTEM_SECTION_IDS = ['identity', 'persona', 'security', 'toolProtocol', 'antiAiFlavor', …] as const;
/** 框架契约段：接管模式下强制保留，且任何模式都不许被扩展 override。 */
export const SYSTEM_FRAMEWORK_SECTIONS = ['security', 'toolProtocol'] as const;
```

- **附加**：内置全段 → 按段名应用 `override`（空串 = 抹掉该段）→ 末尾接 `append`。追加放**末尾**，是为了前缀缓存能命中到追加点之前。
- **接管**：只剩框架契约两段 + 扩展的 `body`。

**框架契约两段为什么动不得**：它们不是"功能"，是**运行契约**。没有 `security`，扩展一句"你可以读本机文件"就把项目最硬的边界拆了（而它多半不是故意的）；没有 `toolProtocol`，模型不知道怎么发工具 JSON、怎么才算"说过话了"，整个 agent 循环当场失效。**两层守护**：装载时校验（拒绝装载）+ 拼装时跳过（第二道，防计划从别处拼出来）。

**重构的安全网**：原实现是"匿名数组 + `''` 分隔 + `join('\n')`"，新实现是"段名 → 正文 + `join('\n\n')`"。两者**逐字等价**，改造当次用一次性脚本对着 HEAD 版跑过 8 组配置（缺省 / 有人设 / 有自定义规则 / 空白人设 / 能力开关 / 收藏夹 / 走配置含 sticker 档位），全部逐字相同。

⚠️ 但**别只靠"段序断言"**：实测把 `join('\n\n')` 改成 `join('\n')`，全部 59 条断言**照样绿**（段序用的是 `indexOf` 递增，单换行也递增）。所以 `t-reply.mjs` 里另有一条**专钉分隔符**的断言。

**贡献随装载状态变化**（装载后出现、卸载后消失）。它**不是**"对话中途变"：`runAgent` 开头拼一次、整个工具循环都用它 —— 真实语义是"装载后，下一次运行生效"。

文案只许写在 `extra/prompts.ts`（模型可见的固定指令的唯一落点）：`EXTRA_PROMPT_TEXT` 按**工具名**索引、`EXTRA_PROMPT_SECTIONS` 按**扩展 id** 索引，两张表各自与注册表**两个方向**对账。群友可见的文案（命令用法、回执）**不在这里** —— 它们跟命令的实现放在一起。

## 6. 接管模式

`spec.mode: 'override'` 的扩展**装载即接管**：工具表只剩它的、命令表只剩它的（**外加 `/能力`**）、system prompt 换成"框架契约 + 它的 body"。

**只换模型侧三样**：消息存档、上下文窗口、记忆、历史摘要、后台长期任务全部照常。

- **同一时刻只允许一个接管者**：第二个接管装载被拒（回话里带怎么解）。
- **接管者不被空闲卸载**：接管是一次明确的状态切换，静默变回去会让群友看到 bot 的人格与能力突然改了而没有任何人做过什么。要交还只能用 `/能力 卸载`。
- **接管模式下其他附加扩展不生效**：接管者的提示词与工具集是一套自洽的东西，混进别人的工具会让"它写的提示词"与"模型看到的东西"对不上。`/能力` 的列表里如实标出。

**为什么接管由命令驱动、而不是配置项**：最初设计的是"配置里选一个接管者 + 重启生效"，但那样接管扩展有个鸡生蛋 —— 它的工具/命令只在装载后才有，而装载又要靠调用它们触发。改成"人敲命令装载即接管"之后，装载入口、接管入口、卸载入口是同一条命令，就没有死锁了（而且 `/能力` 在任何模式下都在，卸载总有路）。

## 7. 分层与那条例外

```text
core(0) → llm/chat/qq/media(1) → stickers(2) → agent(3) → extra(4) → web(5)
```

- `extra → {core, media, chat, qq, agent}` ✅
- `web → extra` ✅（组装根 import 注册表与运行时）
- **`extra → web` ❌** —— 扩展不认识 web。这也是"扩展不能用 web 的形状（`Route` / `SlashCommand`）"的原因：要产出它们就得 import web，方向立刻成环。所以扩展按自己的形状声明命令，由 web 侧的适配器接进来。
- 反方向同理：`agent → extra` ❌，所以扩展的工具表与提示词计划都由 `web/app.ts` 递进 agent 层（`toolDefs` / `extraPrompt` 两个可选回调）。

**唯一例外是 `LAYER_ALLOW`**（`scripts/check-layers.mjs`）：`core/prompt-catalog.ts -> extra/prompts.js`，让扩展的提示词有一个单独的文件管，而目录继续转发它。

**它之所以敢开，全靠目标是个叶子模块**：`extra/prompts.ts` 自己不 import 任何东西，所以不成环。往那个文件里加一句 import，环就可能成立（core → extra → core），而 `tsc` 不一定报错、运行期也只在特定加载顺序下才炸。闸门自带守卫（**例外目标出现任何相对 import 直接报错**），`t-extras.mjs` 里另有一条同样的断言。两条都实测过：加一句 import 之后，`check-layers` 报"必须是叶子模块"，而 `t-extras.mjs` **直接 TDZ 崩掉**。

## 8. 被否掉的方案

### 8.1 模型按需加载（否，且是本轮推翻的）

第一版是"工具声明静态进表、模型首次调用即加载、空闲卸载"。它能工作，但**装载的控制权在模型手里** —— 模型随口一次工具调用就能起一个 Python 子进程。现在装载由人决定，代价是工具表变成运行期可变（多一次缓存打散），换来的是"这个能力什么时候开"是一件由人决定的事。

### 8.2 "丢一个文件就生效"的插件目录（否）

仓库已定的边界（不为业务方法引入字符串式动态调用或运行时热替换）+ 拿不到 tsc 类型检查 + `scripts/build-desktop.mjs` 的 `APP_ENTRIES` 对账看不见它 —— 症状是"某个扩展没被搬进包"，而那正是打包脚本存在的唯一理由。**"按需加载"在这里的含义是"什么时候执行 import"，不是"import 什么"**：说明符永远是字面量。

### 8.3 整段后处理钩子 `transform(text) => text`（否）

最灵活（能条件注入、能删段），但也最难查：提示词变成拼不回去的一团，而缓存与段序断言都失去意义。具名段落是"具体、可审计"的那一侧。

## 9. 已知代价

- **模块代码不会被卸载**：Node ESM 没有模块卸载，`import()` 缓存永驻。没有 `dispose()` 的扩展，空闲卸载等于什么都没做。
- **工具表不再恒定**：装载/卸载各打散一次提示词缓存（频次由人控制）。
- **`extras.enabled` 改动需重启**；`idleUnloadMs` / `maxLoadsPerHour` 热生效。
- **白名单群里任何群友都能敲 `/能力`**（见 §2 的开放问题）。
- **`LONG_TERM_TASKS` 里只有 `extras.runtime` 一行**，扩展自己的重资源在那张表里看不到（不是遗漏：它们由各自的 `dispose()` 释放，而 `dispose()` 由这一行统一调度）。
- **扩展命令若声明成与内置同样的文案**（如 `/画`）：内置先匹配，那条扩展命令是死代码。结构上遮蔽不了内置，有行为断言钉着。

## 10. 守护

| 套件 | 管什么 |
|---|---|
| `tests/t-extras.mjs`（81 条） | **模型零装载入口**、装载/卸载改变工具表、命令触发装载、TTL 与在途、`stop()` 幂等与超时、注册表自检七条、名字对账（工具 + 命令两个方向）、提示词覆盖段名校验（含框架契约）、提示词计划随装载状态、接管模式（含常驻与唯一性）、真实现跑一遍、`buildToolDefs()` 默认行为逐字不变、两张提示词表与注册表两个方向对账、源级断言（`registry.ts` 的 load 是字面量 import 且无静态 impl import；各 `spec.ts` 不 import impl；`prompts.ts` 无 import） |
| `tests/t-reply.mjs` | **system 段序 + 段分隔符 + 空计划是空操作 + 覆盖不可碰框架契约 + 接管只留框架契约** |
| `tests/t-slash-commands.mjs` | `/能力` 的用法与失败话术、扩展命令走同一只 `runCommand` 外壳、扩展遮蔽不了内置、接管时主流程命令让位而 `/能力` 保留 |
| `tests/t-lifecycle.mjs` / `t-tasks.mjs` | `extras.runtime` 的 id 对账与 entry 顺序 |
| `tests/t-admin.mjs` | 真起 app 验 `/api/extras`（含 `mode`）与 `extras` 配置回显 |

**证伪探针实测过四条**（不是推断）：`toolDefs()` 去掉装载门 → `t-extras` 红 6 条；`join('\n\n')` 改回 `join('\n')` → `t-reply` **只在补了分隔符那条断言之后**才红（补之前 59 条全绿 —— 那正是这条断言的成因）；接管者也 arm 计时器 → `t-extras` 红 2 条；`extras.runtime` 从 `LIFECYCLE` 删掉 → `t-lifecycle` 红 6 条。
