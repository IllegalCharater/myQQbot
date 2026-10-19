# 跑团（TRPG）：分层重构 + 功能实现计划

> **最后更新：2026-10-17**。依据：`docs/trpg-dialogue-expectations.md`（现状逐幕）与《跑团功能实现度检查报告》（31 项对照，结论 ✅6 / 🟡9 / 🔴16）。

## 实施进度

| 阶段 | 状态 | 落在哪 | 验收数字 |
| --- | --- | --- | --- |
| **P0** 分层重构（纯搬运） | ✅ | 17 → 30+ 个文件；`check-layers.mjs` 三条新闸门 | `t-trpg` 266 → **266**（逐字不变） |
| **P1** 命令面统一到 `.` | ✅ | `ExtraCommandSpec.subs`；dispatcher 改名 | `t-commands` 50、`t-extras` 174 |
| **P2** 会话与建卡 | ✅ | 状态机 + `.trpg new/join/start/end` + `.pc new/confirm/show/save` + 战报写侧 | `t-trpg` 268 → **308** |
| **P3** 检定与暗骰 | ✅ | `sendPrivate` / `atUserId` / `.ra` / `.rh` / `.st` | `t-trpg` 308 → **332**；`t-trpg-rules` 140 → **144** |
| **P4** 属性生成（COC7） | ✅ | `rules/chargen.ts` + `.pc roll` + 卡的 `mp/mpMax/db/build/mov` | `t-trpg` 332 → **351**；`t-trpg-rules` 144 → **166** |
| **P5** 战斗 | ✅ | `rules/combat.ts` + `model/combat.ts` + `.combat start/next/end` + `campaign action=combat` | `t-trpg` 351 → **392**；`t-trpg-rules` 166 → **185** |
| **P6** 战报（导出） | ✅ | `render/journal.ts` + `.log export` + 面板列出/删除 + `SendQueue.sendFile` | `t-trpg` 392 → **419** |
| **收尾** 审查发现的 A / B / C / E 四类 | ✅ | 见下面「待修复」那几张表 —— 每行末尾补了**实际怎么修的** | `t-trpg` 419 → **437** |
| **P7** 剧本抽取管线 + 规则扩展 | ✅ | `scenario/extract/` 四级流水线（L1 切片 → L2 逐片抽 → L3 归并 → L4 校验）、`model/rule-set.ts` + `rules/rule-set.ts`、`.trpg check`、规则表加 `initiative` 一栏 | `t-trpg` 437 → **553**；`t-trpg-rules` 185 → **289**；新增 `t-trpg-extract` **82** |
| **收尾（二）** 抽取与整理的用量记账 | ✅ | `createAskPort` / `formatScenarioText` 收 `recordUsage`；`.trpg scenario` 透给宿主 | `t-trpg` 553 → **557** |
| **第三轮** 落地审查发现的 9 条（详见 `AGENTS.md` 的「2026-10-19 第三轮」） | ✅ | `roll` 加 `skill`；暗线旗标遮挡（三条出圈路径）；`preparing` 对模型可见 + `activate` 落日志；拒绝话术按状态分岔；人格里收团改 `.trpg end`；`refund`（报错不占额度）；`.trpg scenario` 拆前后半 + 后台 + `sendText`；两本调用额度；`.pc roll` 覆盖提示 / 战报跨局分界 / `modes.json` mtime 缓存 | `t-trpg` 557 → **607** |
| **第三轮（续）** 审阅拍板后落地的 8 条（详见 `AGENTS.md` 的「2026-10-19 第三轮（续）」） | ✅ | `roll` 漏填 `skill` 的提醒；`actionSource` 留痕；`.combat` 与收团摘要的两条隐藏泄漏；收团回执说清「什么还在」；start / mode / 降级三处固定文案；限流单位澄清为「份」；`secretRoll` 的档位硬约束 | `t-trpg` 607 → **623** |

**全量**：`npm run check` **40 个套件**全绿、`npm run test:all` **50 个套件**全绿（每阶段收尾都做过一次 `rm -rf dist && npm run build` 干净重建再复跑）。

### 各阶段实际做了什么

- **P0**：按「一、新分层结构」把那棵树搬完，`state.ts` / `tools.ts` / `render.ts` / `scenario.ts` / `mode.ts` 各自拆开，`impl.ts` 瘦成纯接线，多一个 `index.ts` 桶文件（`web/routes/trpg.ts` 改走它）。三条闸门：**根目录白名单 + 七个子目录缺一报错**、`rules/**` 纯度（既有，新文件自动纳入）、**`model/**` 不许出现 `node:fs` / `node:path`**。
- **P1**：`subs` 的展开只在 `runtime.ts` 做一次，此后没有任何地方知道"子命令"这个概念。**匹配顺序由 `spec.ts` 决定**，每条裸命令都排在自己的子命令之后。
- **P2**：`preparing` / `active` 两档状态；`beginCampaign` 收一个 `status` 参数就把"人工入口"与"模型入口"分开（判据仍是一份）。战报的**写侧**先落地，理由是"记录要早于导出"——否则 P6 上线那天开始的团才有完整战报。
- **P3**：`sendPrivate` 是宿主的口子（与 `deliverNote` 同源）；`say` 的 `atUserId` 修掉"DM 物理上无法 @ 人"；暗骰**不留痕**（不写 `campaign.log`、不进战报），那段私密叙事是独立模型调用而且**拿不到点数**。
- **P4**：**掷法是数据、公式是代码**（`.pc roll` 只在规则表声明了 `chargen` 时才有）；派生值认死那几个属性名，改名会让那几项**派生不出来**并明说缺谁。
- **P5**：**顺序是代码、数值是规则**（`rules/combat.ts` 只管排序与指针，命中/伤害仍走 `resolveCheck` 与 `character` 的 `hpDelta`）。战斗状态挂在 `TrpgCampaign.combat` 上，与人物卡同一份归一化（`normalizeCombat`）。**"行动即推进"**：`campaign action=combat` 的 `sub=next` 与玩家自己敲的 `.combat next` 是**同一个函数**（`advanceTurn`），区别只在谁有权敲 —— 而"谁有权"这件事**代码不拦**（决策 9，见偏差表 9）。
- **P6**：战报**只在写入那一刻筛一次**（`TrpgLogEntry.visible`），`mirrorLog` 据此挡下；导出再按**同一条判据**挡一次（那是这条链上唯一的发布动作）。`.log export` 走宿主递进来的 `sendFile` 口子（扩展只说"给谁、叫什么名字、正文是什么"），宿主那侧是 `SendQueue.sendFile` → `upload_group_file`（**120 秒**，与转写的全文文件、漫画的 PDF 同一档超时）。
- **P7**：一份"格式不对"的模组不再只做**一次**格式整理，而是走四级流水线 —— **L1 `outline.ts` 纯函数切片 → L2 逐片抽取 → L3 归并 → L4 校验回填**，编排在 `pipeline.ts`。产物是**三份伴生文件**（`.struct.json` 剧情结构 / `.rule.json` 规则扩展 / `.raw/` 原文切片），由 `store/scenario-store.ts` 的 `writeExtras` 落盘 —— **管线自己不做 I/O**，这正是 `scenario/extract/**` 那条新闸门（与 `model/**` 逐字同形）的全部理由。`<id>.md` 仍是**唯一进 system prompt 的正文**，`MAX_SCENARIO_CHARS` **不动**：30 页模组的细节进 struct（有独立预算）、原文进 `raw/`。**"只抽不扩"是这条管线的判据**（正文那个数每轮都进提示词，是成本不是洁癖）。另有两块：**规则扩展**（`RuleExtension`：把"某个场景里侦察要减 20"这类散文变成可编译的机制，`compileRuleSet` 编译、`applyCheckModifiers` 在检定/战斗上套用）与 **`.trpg check`**（零模型调用、零写入，把抽出来的东西摊开给管理员核对 —— 抽取质量本身只能人工冒烟）。
- **收尾（二）**：抽取管线（最多 **6 次**调用）与后备那次整理（1 次）的用量，2026-10-19 起进 token 账 —— `createAskPort(recordUsage)` 与 `formatScenarioText(..., recordUsage)` 各报各的，由 `.trpg scenario` 透给宿主的 `ExtraRuntimeDeps.recordUsage`（同 `suggest` / `.rh` 那条链）。⚠️ **`recordUsage` 是端口的参数、不是 `AskPort` 的第三个参数**：管线只认 `(request, signal)`，把记账塞进端口就等于让管线认识记账。

### 与本文原始设计的偏差（合并记录，免得下一个人照旧文改已经改过的地方）

| # | 本文原写法 | 实际落地 | 为什么 |
| --- | --- | --- | --- |
| 1 | P1 把 2.2 那张命令表**一次全声明** | **只声明已经有 handler 的 sub**，后面每个阶段各加自己的 | 本文自己那条硬约束（每阶段结束全绿）：`checkRuntimeShape` 要求每个声明出来的 sub 都有实现 |
| 2 | 新分层树里没有 `commands/shared.ts` | 多了一个（`argsOf` / `restOf` / `usableScenarios` / `scenarioIds`） | 子命令的参数要"切掉命中那个词"，而 `usableScenarios` 命令层与 `prompt()` 都要用 |
| 3 | dispatcher 只改三个名字 | **整族改**（`SlashCommand*` → `Command*`） | 只改三个会把 `SlashCommandInput` 这些误称留下来 |
| 4 | `.trpg start` 既建会话又开跑 | `new` 建局（`preparing`）、`start` 只推状态 | 第 2 节那张表本身没拆干净；模型那条 `campaign action=start` 仍是"建局即开跑"（`active`），两个入口共用 `beginCampaign`、差别只有 `status` 一个参数 |
| 5 | 战报"在 `appendLog` 调用点旁路写" | `mirrorLog(campaign, fromSeq, journal)` 在 `store.write()` **之后**调 | 语义是"只记真的落盘了的"；写在 appendLog 那一刻，一次被 `return err(...)` 撤销的动作会**在战报里留下一条** |
| 6 | P2 落地清单 25 | 只做了**收团摘要**，导出留给 P6 | 导出要 `upload_group_file` 那条链，与战报的读取/渲染一起做更整 |
| 7 | 规则文件只有 `levels` / `requires` | 多了 **`dice`**（P3）与 **`chargen`**（P4） | `.ra` 要掷 d100 还是 d20、`.pc roll` 掷什么，都是**规则书的知识** —— 写死在代码里等于让别的规则书永远用不了这两条命令。两者都在 `compileRule` 里**编译期校验** |
| 8 | P4 只说"`TrpgCharacter` 加 `mp`/`db`/`build`/`mov`" | 还把 **MP 接进了工具**（`mpDelta` / `mpMax` / `full` 一起回满） | 字段没有写入路径就等于没接 |
| 9 | P5 说"伤害也放 `rules/combat.ts`（纯）" | **只放排序与指针**，伤害仍走 `character` 的 `hpDelta` | 伤害要读人物卡的钳制（`clampInt` / `hpMax`）与倒地判定，那是**领域模型**的事；在 `rules/` 里再写一份等于让"扣血"有两条实现 —— 而两条必然漂移（表现是"工具扣的和战斗扣的不是同一个数"） |
| 10 | 规则文件只有 `dice` / `chargen` 那两栏 | 又多了 **`initiative`**（P5） | 先攻掷什么骰是规则书的知识（COC 是 `1d100`，D&D 是 `1d20+DEX`）。缺省 `1d100`，与 `dice` 同一条约定、同一处编译期校验 |
| 11 | P5 的 `.combat start` 回执"点名该谁动了" | 回执**只印名字**，@ 不到人 | `web/onebot/commands.ts` 的 `runCommand` 只递 `{ replyToMessageId }`，命令回执没有 @ 的口子（`say` 的 `atUserId` 是**工具**那条路的口子）。要补得先给命令回执开一个 `atUserId` —— 那是另一处改动，不在 P5 的范围里 |
| 12 | P6 说"导出成 `.txt`/`.md`" | 只有 `.md` | 两种后缀指的是同一份 Markdown（`# 标题` + 一行一条），给两个选择等于让人猜哪个是"对的那个" |

### 探针实测（每一条都是"改一处、跑一次、必须变红"，然后 `rm -rf dist && npm run build` 复原）

- **P2 四条**：迁移默认值反过来（缺 `status` 读成 `preparing`）→ 红 1；`canActivate` 拆掉「逐人查确认」→ 红 2；`withCampaign` 去掉 `mirrorLog` → 红 1（**只有工具路那条红，命令路照绿** —— 两条路各写各的落盘，所以两条都要钉）；`.pc new` 不再顺手报名 → 红 1（满员那条抓住的）。
- **P3 三条**：`.rh` 的回执换写法 → 红 1（那条断言是**整串相等**）；让 `.rh` 顺手 `appendLog` → 红 1；`compileRule` 去掉 `dice` 校验 → `t-trpg-rules` 红 1。
- **P4 三条**：DB 表边界写成 `<` → `t-trpg-rules` 红 1（判据是**每一档的两个端点**）；**`.pc roll` 里写 `hpMax` 那一行拆掉 → 第一版断言照样全绿**，补上「派生值是按公式从刚掷出的属性算的」才红；`pools` 隐藏不再覆盖 MP → 红 1。
- **P5 三条**：`rollInitiative` 的排序键去掉先攻值（只剩名单顺序）→ 红 **6**（顺序、给模型的那一份、工具回执、`sub=next`、以及"行动即推进"与"不是当前行动者不推"两条）；`advance` 去掉 `skip` 判断（倒下的人也占回合）→ 红 1（绕回起点那条）；`renderForPlayers` 的 `combatLines` 去掉 `seen` 过滤 → 红 1（"轮到「X」"那句把还没被玩家见过的人漏出去）。
- **P6 五条**：`mirrorLog` 不看 `visible` → 红 **6**（含 `read()` 那条独立的"战报里没有 `visible: false`"）；`character` 建卡那条恒 `visible` → 红 2；`.log export` 去掉过滤 → 红 2；`JournalStore.read()` 丢掉 `visible` → 红 2（"原样带回来" + "手改过的文件也挡得住"）；`campaign` 删暗线那条不标 → 红 1。

⚠️ **P4 第二条是这份计划里最值得记的一课**：`> 0` 这类判据在"上游已经给过默认值"的前提下**证明不了任何事**。写断言时先问一句"**如果这一行删掉，这个数还会碰巧对吗**"。

⚠️ **P6 开工时抓到的第一条**：`mirrorLog` 原本把 `campaign.log` **不过滤**地镜像进战报，而 P6 的导出会把那份文件**发进群** —— 于是暗线旗标的名字、"玩家尚未见过"、`隐藏：stats` 会一起进群。`renderForPlayers` 靠 `PLAYER_LOG_KINDS`（只印 `roll`/`check`）挡得住，但战报要的是**完整**（那是这一局唯一的完整记录），所以判据只能是**逐条**的、且必须由**写那条日志的人**在写入那一刻标 —— 见偏差表第 5 条与 `TrpgLogEntry.visible`。

⚠️ **P6 写测试时的第二个坑（当场踩到）**：`campaign action=start` 的 `title` 是**必填**，夹具漏了它之后 `start` 回一句 err，于是战报里**什么都没有** —— 那一段里六条负向断言（"暗线不进战报"之类）**全部变绿**。这正是本文第 46 行那条纪律的另一种形态：**负向断言必须配一条正向对照**（"这一条确实进了 `campaign.log`"），否则夹具一坏整段就变成假绿。同一段里另一个坑是裸下标 `sent[0].content` —— 夹具坏掉时它抛 `TypeError`，**中止整个套件**（后面的断言一次都不跑，终端上只显示"这个套件失败了"），所以取"最近一次发出去的东西"一律走 `sent.at(-1)?.content ?? ''`。

### P5 / P6 的落地清单（原文那两条，逐项对照）

原文（2026-10-16 版）：

- **P5 战斗**：`rules/combat.ts`（先攻排序、指针推进、**伤害**，纯）、`model/combat.ts`（战斗状态归一化）、`commands/combat.ts`（`.combat start|next|end`）、`tools/campaign.ts` 加 `action=combat`、`ActionLedger` 的 `actor` 直接复用。**代码不拦越权行动**（决策 9）。
- **P6 战报导出**：`JournalStore` 的读取已经有了（`read(chatKey)`），差渲染成 `.txt`/`.md` + `upload_group_file`（120 秒超时）+ 面板的列出/删除（与剧本、规则表同形）。

实际落地（**加粗的是与原文不一致的地方**）：

| 原文那一项 | 落地 | 差异 |
| --- | --- | --- |
| `rules/combat.ts` 含伤害 | 只有 `rollInitiative` / `clampTurn` / `advance` / `immobileNames` | **伤害不在这里**（偏差表 9） |
| `model/combat.ts` | `normalizeCombat` / `currentActor` / `immobileNames` / `beginCombat` / `endCombat` | 归一化与 `normalizeCampaign` 同一手法（坏值夹回合法区间、旧存档缺字段取"更宽"的那一档） |
| `commands/combat.ts` | `.combat start` / `.combat next` / `.combat end` + 裸 `.combat` 的用法 | `next` 与工具那条 `sub=next` 共用 `advanceTurn`（**同一份实现**，不是"两边各写一遍"） |
| `campaign` 加 `action=combat` | `action=combat` + `sub=start\|next\|end` | `sub` **不是必填**（`required` 不能按 action 分支 —— 工具表那条断言钉着） |
| `ActionLedger` 的 `actor` 复用 | ✅ 原样复用 | `combat` 的写动作按 `actor` 计额度（与 `character` / `campaign` 同一本账） |
| 代码不拦越权行动 | ✅ 不拦 | 偏差表 9 的延伸：DM 能替任何人推指针，玩家敲 `.combat next` 也认 |
| 渲染成 `.txt` / `.md` | 只有 `.md` | 偏差表 12 |
| `upload_group_file`（120 秒） | ✅ | 但**不在扩展里**：扩展调宿主递进来的 `sendFile`，`SendQueue.sendFile` 才碰 `onebot.call` |
| 面板列出 / 删除 | ✅ 第三类（`data-trpg-row="journal"`） | 与剧本、规则表同形，但 confirm 文案说的是**相反**的话（删掉就没了） |

### 待修复（P0–P4 重构后的审查发现，**逐条对照过当前代码**）

> 记录于 2026-10-16，P5/P6 动工之前。按"会不会真的把人带错"排序。每条都给了判据 —— 修完能拿它验。
> **2026-10-17 重锚**：P5/P6 新增了 `rules/combat.ts` / `model/combat.ts` / `commands/combat.ts` /
> `commands/log.ts` / `render/journal.ts`，下面那些**行号已按当时的代码重取过一遍**（只改行号与计数，
> 没有一条发现被修掉）。修的时候按"位置"那一列的描述去定位，行号本身随时会再漂。
> **2026-10-17 同批**：D2–D5 那四条是**文档漂移**，随 P5/P6 的文档更新一起修掉了（见 D 类表里的 ✅ 行）。

✅ **2026-10-17 收尾：A / B / C / D / E(a) 已全部修完**（P5/P6 之后的一次专项）。下面几张表**保留原样**
—— 那是"当时看到了什么"的记录；每行末尾补了一句**实际怎么修的**。判据那一列仍然有效，改回去就该变红。
`t-trpg.mjs` 419 → **424**（A5 的 5q 段）→ **437**（E(a)：5i/6 两段 5 条 + 7b 段 8 条）。
**收尾那一轮没有再加断言条数**（D1 是文档、A5 的补漏只是把 5q 的扫描范围扩到 `web/onebot/commands.ts`）。

**2026-10-19**：P7（抽取管线 / 规则扩展 / `.trpg check`）把 `t-trpg.mjs` 推到 **553**、`t-trpg-rules.mjs` 到 **289**，
并新增 `t-trpg-extract.mjs`（**82**）；同日的「收尾（二）」补上抽取与整理的用量记账 → `t-trpg.mjs` **557**。

#### A 类：用户可见的错误输出（照做会失败 / 群里看到的字是错的）

| # | 位置 | 是什么 | 判据 | 修法 |
| --- | --- | --- | --- | --- |
| A1 | `src/extra/trpg/commands/scenario.ts:117` | 存剧本的**回执末尾**写 `开局：.trpg start ${saved.scenario.id}` —— 而 `createStartCommand`（`commands/session.ts:124`）**带参数就拒**，剧本名是 `.trpg new` 的参数。这是**代码逐字产出**的一句错话，且紧跟在"我刚存好剧本"那一刻 | 存一份剧本，回执里那句照敲，必须真的开得了局（现在会被拒） | ✅ 改成 `.trpg new <剧本名>`，并在那行上写明"必须是真能开局的词形" |
| A2 | `ui/js/views/settings/sections.js:917` | 设置页写着 `.trpg start <剧本名> [规则表 id]` | 面板文案与 `commands/session.ts` 的 `USAGE` 逐字一致 | ✅ 改成 `.trpg new <剧本名> [规则表 id]` |
| A3 | `AGENTS.md:613` | `.trpg start <剧本> [规则]` | 同上 | ✅ 改成 `.trpg new <名字> [规则表]` |
| A4 | `docs/trpg-dialogue-expectations.md:74` | 逐幕记录里 `[代码]` 那一栏写着 `开局：.trpg start 灯塔` —— 那份文档的**全部价值**就是"代码此刻逐字产出什么"，这里正好抄错了 | 重跑文末那段复核脚本，`[代码]` 字面量与实现逐字相同 | ✅ 改成 `开局：.trpg new 灯塔`；复核脚本覆盖了那条回执 |
| A5 | `commands/mode.ts:31`、`commands/combat.ts:24`、`commands/character.ts:222`、`render/players.ts:165`、`render/status.ts:61,93,94` | **七处群友可见的回执把 Markdown 的 `**` 原样发进群**（QQ 不认 Markdown）。**不是"照做会失败"，是同属"群里看到的字是错的"** | 跑一遍那些命令，输出里不出现 `**`；`t-trpg.mjs` 加一条扫"回执字面量里没有 `**`"的断言 | ✅ 七处全去掉加粗。**当初给 `renderScenarioList` 写的理由（"它同时进 system prompt"）是个误判** —— 进 system prompt 的是 `renderBriefing`，那是另一个函数、不调用 `renderScenarioList`；它只被三处调用（`.trpg scenario`、`.trpg new` 不带名字那一次、向导），**三处都是群友可见**，所以"去掉加粗"本来就够，不需要拆两份。守护是 `t-trpg.mjs` 第 **5q** 段（5 条：行为层逐条跑两遍 + 源码层剥注释扫 + 一条正对照）。⚠️ **源码层当初只扫 `extra/trpg/`，因此漏掉了一处真缺陷**：`web/onebot/commands.ts` 的 `/能力` 回执里那句 `只接管**本群**` 原样发进了群，而没有任何断言看得见。现已把扫描扩到主流程那个落点，并用**证伪探针实测**过（把 `**` 加回去 → 5q 红 1 条，报出 `web/onebot/commands.ts:376`） |

正确词形只有一条：**`.trpg new <名字> [规则表 id]`**（名字对上剧本库就用那份剧本，对不上就当标题）。

#### B 类：同一条规则写了两遍（静默漂移）

| # | 位置 | 是什么 | 判据 | 修法 |
| --- | --- | --- | --- | --- |
| B1 | `model/character.ts:87` 的 `normalizeHidden` vs `tools/shared.ts:161` 的 `readHidden` | **同一件事的两份实现**，且行为不同：`normalizeHidden` 收到标量（`"stats"`）直接返回 `[]`，`readHidden` 把它包成 `['stats']`。于是"工具写进存档的 hidden"与"存档读回来的 hidden"能不一致 —— 表现是**藏了、没藏住**，没有任何报错。另外 `readHidden` 用的是裸 `24` 而不是 `MAX_NAME_CHARS` | 两个函数对同一组输入（含标量、含大小写、含不认识的名字）给出相同结果；`readHidden` 里不出现裸数字 | ✅ `readHidden` 整个删掉，工具层改调 `normalizeHidden`（**唯一一份**，含标量归一与大小写归一） |
| B2 | `scenario/parse.ts:166-168` | 裸 `60` / `64` / `400`，而 `model/limits.ts` 里有 `MAX_TITLE_CHARS` / `MAX_RULE_CHARS` / `MAX_SCENE_CHARS` 三个同名常量 | 源码里不出现这三个裸数；改上限时只有一处要改 | ✅ 三处都换成具名常量（`import` 那一行加三个名字） |
| B3 | `model/campaign.ts:149`、`model/session.ts:200`、`model/paths.ts:36`（默认参数）、`store/scenario-store.ts:55,67,85` | 剧本 id 的长度上限 `40` 在**六处**各写一遍 | 只留一个具名常量；`safeFileName(id)` 不传第二参 | ✅ 新增 `MAX_SCENARIO_ID_CHARS`（`model/limits.ts`），六处全部改用它；`safeFileName` 的**缺省值**就是它，调用方不再显式传第二参 |
| B4 | `suggest.ts:50-63` 的 `suggestionContext` | 拼"在场的人"时印了 HP 与 SAN，**漏了 MP** —— 而 `render/model.ts:51` 与 `render/players.ts:35` 都印 | 三处对同一个角色给出的资源条一致 | ✅ 补上 `mpMax > 0` 那一档（与另两处**同一条判据**），并在注释里点明它是被这条审查抓出来的 |

#### C 类：死代码、未用参数、过时注释（不影响行为，但会误导下一个人）

| # | 位置 | 是什么 | 修法 |
| --- | --- | --- | --- |
| C1 | `impl.ts:18` | `import { scenarioIds, usableScenarios }` —— `scenarioIds` **从未被使用** | ✅ 去掉那个名字（函数本身仍被 `commands/` 用着，不是死代码） |
| C2 | `commands/index.ts:90` | `.ra` 传了 `sendPrivate`，而 `createCheckCommand` 根本不读它 | ✅ 不再传（只有 `.rh` 传） |
| C3 | `commands/index.ts:92` | `.st` 传了 `sendPrivate` **与** `base` 里的 `rules` / `rng`，而 `createStatCommand` 只解构 `{ store, command }` | ✅ 只递 `{ store, journal, command }`，并把 `StatCommandDeps` 收窄成那三样（**故意窄**：按 `CheckCommandDeps` 收的话，下一个读代码的人会以为 `.st` 也掷骰、也发私聊） |
| C4 | `spec.ts:57` | 注释"命令表只剩跑团**那两条**" —— 现在展开后有 24 条 | ✅ 改成"24 条词形（12 条声明，其中 4 条带 `subs`、2 条是裸命令；外加永远在的 `/能力`）"；**P7 加 `.trpg check` 之后是 25 条词形 / 4 条裸命令**，注释已跟着改 |
| C5 | `model/session.ts:48` 的 `isQq` 注释 | 声称"只有这一处"，实际另有 5 处内联的 `/^\d+$/` | ✅ 注释改成"**不是唯一的落点**"并逐个列出那 4 处（`say` / `character`×2 / `campaign`），说明它们各自在读一个不可信字段、就地判一次更直白，改判据要五处一起改 |
| C6 | `render/format.ts:38` 的 `GRADE_LABEL` | 当前**不可达** | ✅ 整张表删掉（与 C7/C8 同一个动作） |
| C7 | `render/format.ts:40` | `formatCheck` 对**最常见的那一档**印出 `成功（成功，差 20）` | ✅ `formatCheck` 加一条判据：档位名与"成功/失败"是同一个词时**只印一次**（`grade === outcome` → 只印间距）。文案变成 `成功（差 20）` / `成功（极难成功，超出 3）` |
| C8 | `render/format.ts` 的 `GRADE_LABEL` 与 `coc7`/`generic` 的 label 表 | 三处都在描述"档位叫什么"，而权威只有一处（规则表） | ✅ 只留规则表那一条路：`result.label ?? result.grade`，兜底表删掉。注释里写明"**这里刻意没有兜底表**"以及当初为什么删 |

#### D 类：文档漂移（`docs/ts-migration-plan.md` 的跑团那一节最严重）

| # | 位置 | 是什么 |
| --- | --- | --- |
| D1 | `docs/ts-migration-plan.md` §跑团 | 整段还停在 P0 之前：目录写成**根下平铺**（`state.ts` / `render.ts` / `tools.ts` / `rule-store.ts` / `scenario.ts` / `mode.ts`），命令写成 `/跑团` `/开局` `/模式` `/剧本` `/掷骰`（P1 起是 `.` 前缀且已拆成独立命令），`t-trpg-rules.mjs` 写成"109 条"（现 185）。**这一节现在教人敲不存在的命令、去不存在的文件**。✅ **2026-10-17 已修**：整节按**当前**代码重写（七个子目录与根白名单、`.` 词形与 `subs`、`initiative`/`dice`/`chargen` 三个规则字段、两份视野、战斗与战报、两种模式与 `intercept`、`configPatch` 的上下文下限、`ExtraRuntimeDeps` 四个口子），并指向 AGENTS.md 与逐幕文档作为权威 |
| ~~D2~~ | `README.md` | ✅ **已修**（P6 同批）：`.trpg status` 那一行改成"按上面那**八**步"，并补了 `.combat start/next/end`、`.log export` 四行命令与「跑团」面板那一栏 |
| ~~D3~~ | `AGENTS.md` §跑团 | ✅ **已修**（P6 同批）：handler 键 **14 → 24** 条（12 条声明 / 4 条带 `subs` / 2 条裸命令）、`t-trpg.mjs` **351 → 419**、`t-trpg-rules.mjs` **166 → 185**，命令表补上 `.combat` / `.log` 六行 |
| ~~D4~~ | `docs/trpg-dialogue-expectations.md` | ✅ **已修**（P6 同批）：新增第十一幕（战斗）与第十二幕（战报），文末复核脚本补上 `sendFile` 接线与 `.combat` / `.log` 两族 |
| ~~D5~~ | `AGENTS.md` §跑团 | ✅ **已修**（P6 同批）：新增「战斗与先攻（P5）」一节（`initiative` 规则字段、排序/指针、倒下判定、行动即推进、伤害刻意不在 `rules/`），战报一节补上 `visible` 判据（镜像按条滤 + 导出边界再查一遍 + 面板第三列）与 `sendFile` 那条口子 |

#### E 类：已知缺口

- ✅ **（已修，2026-10-17）** `suggest.ts` 与 `.rh` 私密叙事那两次独立 `chatCompletion` 调用**不进 token 账**。
  修法就是当初记下的那条：给 `SessionRegistry` 加一个**只叠增量**的入口 —— `addExtraUsage(usage, at)`，
  它不碰 `runs`（那两次调用不是一次 agent 运行，算进去会让面板上"每次花多少"失真），四个数全 0 时直接返回。
  与 `#bumpTodayUsage` **共用**唯一那个读改写函数 `#addTodayUsage`（"新的一天"与原子落盘只有一份实现）。
  接线：`ExtraRuntimeDeps.recordUsage`（宿主口子）→ `web/app.ts` 的 `sessions.addExtraUsage`；
  扩展那侧只在拿到口子时才上报（缺省 = 不记账，调用照常 —— 记不上是账面的小缺口，不该让一次暗骰失败）。
  守护在 `t-trpg.mjs`：5i 段 3 条 + 6 段 2 条（**扩展那一半**：`recordUsage` 收到确切的那三个数）、
  7b 段 8 条（**宿主那一半**：叠增量 / 不动 `runs` / 读模型同源 / 零增量不写盘 / 会话结束照旧加 `runs` /
  组装根真的接上了）。**三条探针实测**：把 `runs: 0` 改成 `1` → 红 2 条；去掉零值早退 → 红 1 条；
  把 `app.ts` 的接线换成 `() => {}` → 红 1 条。
- ✅ **（已修，2026-10-19）** 抽取管线的模型调用
  （`scenario/extract/prompt.ts` 的 `createAskPort`）与单次格式整理（`scenario/format.ts` 的
  `formatScenarioText`）**同样不进 token 账**。修法与上面那条同源（`ExtraRuntimeDeps.recordUsage`
  → `sessions.addExtraUsage`），但**量级不同**：P7 把"传一份剧本"从**一次**调用放大成**最多 6 次**
  （`MAX_CHUNKS`），所以这个缺口比 `.rh` 那一次大得多。
  落地：`createAskPort(recordUsage?)` 是一个**工厂**（`AskPort` 仍然是两参数 —— 见下），
  `formatScenarioText(text, opts, recordUsage?)` 收第三个参数；`.trpg scenario` 把宿主的
  `recordUsage` 透给 `saveScenario`，两条路各报各的（一次调用报一次，不是只报总数）。
  **缺省不记账、调用照常**（记不上是账面的小缺口，不该让一次传剧本失败）。
  **日志仍然留着**（`[trpg] 剧本抽取用量（chunk）` / `[trpg] 剧本整理用量`）：账本只给总数，
  而"这一片花了多少"只有它答得上来 —— 补账时**别顺手删掉**。
  ⚠️ **`recordUsage` 是 `createAskPort` 的参数，不是 `AskPort` 的第三个参数** —— 管线只认
  `(request, signal)` 两参数，而"谁记账"是宿主的事；塞进端口会让测试注入的假端点也得模拟它。
  守护在 `t-trpg.mjs`（三条：端口交用量、整理交用量、不给 `recordUsage` 时调用照常）
  + 一条源级断言（`.trpg scenario` 那一行真的把它透给了 `saveScenario` —— 那一段要真网络 + 真
  Python，套件里跑不了）。**两条探针实测**：把 `createAskPort` 里那行 `recordUsage?.(…)` 拆掉 → 红 1 条；
  把 `formatScenarioText` 里那行拆掉 → 红 1 条。
- `.trpg scenario` 命令路径上"用文件名当名字"那一段**没有端到端断言**（要真下载 + 起 Python），只有
  `scenarioNameFromFile` 的单元断言。**结构性缺口，不修** —— 仓库的测试约定不许启动真解释器。
- 换熵源（把 `secureRng` 换成 `Math.random`）**没有任何行为断言看得见**，只有源码文本断言。
  **结构性缺口，不修** —— 掷骰本来就随机，行为断言无从判别。

## Context

跑团是 `src/extra/` 的第一个完整接管扩展（`src/extra/trpg/`，12 个根文件 + `rules/` 5 个文件，约 1900 行）。
对照 31 项功能清单检查后，缺口集中在三处结构性原因上：

1. **命令面不匹配**：清单用 `.` 前缀（`.trpg` `.pc` `.ra` `.rh` `.combat` `.log`），现有命令是 `/跑团` `/开局` `/模式` `/剧本` `/掷骰`。
2. **没有会话模型**：`TrpgCampaign`（`src/extra/trpg/types.ts:102`）没有 `status` / `players` / 战斗字段 —— 建团、加入、确认、开局、收团这一整条链路无处落脚。
3. **扩展够不到私聊与 @**：`ExtraCommandHandler` 只能返回一句话，由宿主发回**同一个** chatKey（`src/extra/types.ts:132`），于是暗骰、点名、多玩家私聊三项全部卡住。

同时，文件数会从现在 17 个涨到 30+，`tools.ts`（634 行）与 `impl.ts`（503 行）已经是"什么都往里塞"的形状。
所以本次分两步走：**先按新分层把现有代码原样搬一遍（零行为变化）**，再在新骨架上逐个补齐功能。

目标产物：一份新分层结构 + 一条能跑完整一场团的命令链路（建团 → 建卡 → 检定 → 战斗 → 收团 → 战报）。

---

## 已确认的决策

| # | 决策 | 影响 |
|---|---|---|
| 1 | **命令统一 `.` 前缀**，`/能力` 是唯一保留的主流程命令 | 全部现有命令改词形；dispatcher 改名；面板/文档/套件跟着改 |
| 2 | **"玩家" = QQ 号** | `TrpgCampaign.players: string[]`；人物卡 `ownerId` 即身份，不引入账号体系 |
| 3 | **先做 COC 7 版** | chargen 只实现一套；`RuleFile` 的 chargen 段按 COC7 的形状设计 |
| 4 | **AI DM 维持单 Agent** | 战斗的机械部分（先攻、伤害、回合）做成代码工具，**不引入第二个模型** |
| 5 | **私聊投递走 `ExtraRuntimeDeps.sendPrivate`** | 扩展仍然只说"给谁、说什么"，不碰 `SendQueue` |
| 6 | **战报另开 append-only 落盘** | 不占用每轮的提示词预算；`campaign.log` 的 60 条环形缓冲不动 |
| 7 | **私密叙事不进上下文** | 暗骰结果与私密叙事**不写进 `campaign.log`**，只经 `sendPrivate` 送达 |
| 8 | **子命令声明为数据**（`subs`） | 词形仍然只有一个落点；`spec.ts` 是唯一事实源 |
| 9 | **战斗：代码持先攻序与回合指针，行动即推进** | 代码不拦越权行动（DM 叙事不受限） |

---

## 一、新分层结构

```
src/extra/trpg/
├─ index.ts              桶文件（只给 web 路由与套件用）
├─ types.ts              领域类型（**零 import 本模块**，避免成环）
├─ spec.ts               声明（纯数据：tools + commands + subs）
├─ impl.ts               接线：ExtraRuntime 的实现（**薄** —— 只把口子接到下面各层）
├─ entropy.ts            真熵源（secureRng）—— 必须在 rules/ 之外，由调用方注入
├─ suggest.ts            兜底建议（一次独立模型调用）
│
├─ rules/                【纯函数层】机检：不得 import 到本目录之外（连 node: 都不许）
│  ├─ dice.ts            骰子表达式（既有）
│  ├─ percentile.ts      奖惩骰（既有）
│  ├─ condition.ts       条件表达式（既有）
│  ├─ check.ts           检定档位表（既有）
│  ├─ economy.ts         行动经济账本（既有）
│  ├─ chargen.ts         ← 新增：COC7 属性生成 + 派生（HP/MP/SAN/DB/Build/MOV）
│  └─ combat.ts          ← 新增：先攻排序、回合指针推进、伤害（纯）
│
├─ model/                【领域模型层】纯逻辑：归一化、上限钳制、状态机
│  │                     **不做 I/O** —— 需要读写时一律经参数传进来的 store 端口
│  ├─ limits.ts          ← 从 state.ts 拆出：全部 MAX_*/MIN_STAT/MAX_POOL
│  ├─ paths.ts           ← 从 state.ts 拆出：safeName / safeFileName
│  ├─ campaign.ts        ← 从 state.ts 拆出：normalizeCampaign / emptyCampaign / appendLog / findCharacter
│  ├─ character.ts       ← 从 state.ts 拆出：normalizeCharacter / normalizeHidden / 派生字段
│  ├─ session.ts         ← 新增：preparing↔active 状态机、玩家名单、beginCampaign
│  ├─ combat.ts          ← 新增：战斗状态归一化 + 回合指针
│  └─ mode.ts            ← 从 mode.ts 拆出：TrpgMode / parseMode / MODE_LABEL
│
├─ store/                【存储层】真正做 I/O 的那一层
│  ├─ campaign-store.ts  ← state.ts 的 TrpgStore（原子替换写）
│  ├─ rule-store.ts      ← 既有（从根搬入）
│  ├─ scenario-store.ts  ← 从 scenario.ts 拆出 I/O 部分
│  ├─ mode-store.ts      ← 从 mode.ts 拆出 TrpgModeStore
│  └─ journal-store.ts   ← 新增：append-only 战报 jsonl（决策 6）
│
├─ scenario/             【剧本格式层】纯函数
│  ├─ parse.ts           ← 从 scenario.ts 拆出：parseScenario / isFormattedScenario
│  ├─ save.ts            ← 从 scenario.ts 拆出：saveScenarioText
│  └─ format.ts          ← scenario-format.ts 搬入
│
├─ commands/             【玩家命令层】每个领域一个文件，**只返回回执文本、不碰 sender**
│  ├─ session.ts         .trpg new|join|start|status|end
│  ├─ character.ts       .pc new|roll|confirm|show|save
│  ├─ check.ts           .ra / .rh / .st
│  ├─ combat.ts          .combat start|next|end
│  ├─ log.ts             .log export
│  ├─ dice.ts            .r <表达式>
│  ├─ scenario.ts        .trpg scenario（原 /剧本）
│  ├─ mode.ts            .trpg mode（原 /模式）
│  └─ index.ts           装配清单：把 subs 展开成 `<命令> <子命令>` → handler
│
├─ tools/                【模型工具层】四个工具 + 共用的闸门外壳
│  ├─ shared.ts          ← 从 tools.ts 拆出：gate / settle / withCampaign / readStats / readHidden
│  ├─ say.ts  campaign.ts  character.ts  roll.ts
│  └─ index.ts           createHandlers 装配
│
└─ render/               【展示层】几份视野**分开写**，不做"一份 + 开关参数"
   ├─ model.ts           renderForModel（全量 + [暗线] / [对玩家隐藏] 标注）
   ├─ players.ts         renderForPlayers（全群）+ renderForPlayer(campaign, qq)（按人，决策 2）
   ├─ status.ts          renderStatusCard / renderWizard / renderScenarioList / renderBriefing
   └─ format.ts          formatRoll / formatCheck / GRADE_LABEL
```

### 三条分层约束（都要写进 `check-layers.mjs`）

1. **`rules/**` 保持既有的纯函数闸门**（已有，`scripts/check-layers.mjs:113`）—— 新增的 `chargen.ts` / `combat.ts` 自动纳入。
2. **`extra/trpg/` 根目录白名单**（新增闸门）：只许 `index.ts` / `types.ts` / `spec.ts` / `impl.ts` / `entropy.ts` / `suggest.ts`，其余 `.ts` 落在根目录直接报错；`rules` / `model` / `store` / `scenario` / `commands` / `tools` / `render` 七个子目录缺一个也报错。
   判据与 `web/` 那条逐字相同：**没有闸门，搬进子目录的东西会一个一个搬回来**。
3. **`model/` 不做 I/O**：它需要读写时收 store 端口作参数（`beginCampaign(chatKey, args, { store, rules, scenarios })` 已经是这个形状）。这条靠**源码扫描**守（`model/**` 里不许出现 `node:fs` / `node:path`）。

### 分层的判据（为什么这么切）

| 层 | 判据 | 例子 |
|---|---|---|
| `rules/` | **能脱离平台独立测试**：给定 `rng` 必得同一结果 | 掷骰、检定档位、属性生成、先攻排序 |
| `model/` | **纯数据变换**：给一份状态，返回新状态；不碰磁盘 | 归一化、钳制、状态机 |
| `store/` | **碰外部世界**：文件、目录、mtime | `TrpgStore`、`RuleStore`、`JournalStore` |
| `scenario/` | 字节/文本 ↔ 领域对象，纯函数 | frontmatter 解析、模型整理后的落库 |
| `commands/` | **入口是人**：零 LLM 成本、落已读历史 | `.ra` `.pc` `.trpg` |
| `tools/` | **入口是模型**：改状态、写日志、要求模型自己开口 | `say` `campaign` `character` `roll` |
| `render/` | **受众不同就必须是两份实现** | DM 视角 / 玩家视角 / 单玩家视角 |

---

## 二、命令面（决策 1 + 8）

### 2.1 命令表

| 命令 | 子命令 | 清单项 | 说明 |
|---|---|---|---|
| `.trpg` | `new <模组名> [规则表]` | 1 | 建会话，`status: preparing` |
| `.trpg` | `join` | 2 | 加入（QQ 号入 `players`），重复/满员/无会话各有话术 |
| `.trpg` | `start` | 7 | 全员确认后 `preparing → active` |
| `.trpg` | `status` | 6 | 玩家视角局势卡（原 `/跑团`） |
| `.trpg` | `end` | 25 | 收团摘要：时长 / 玩家 / 关键节点 / 未解决线索 |
| `.trpg` | `mode [助手\|DM]` | — | 原 `/模式` |
| `.trpg` | `scenario [名字]` | — | 原 `/剧本` |
| `.pc` | `new <角色名>` | 3 | 建卡，`ownerId = senderId` |
| `.pc` | `roll` | 4 | COC7 属性生成 + 派生（决策 3） |
| `.pc` | `confirm` | 5 | 确认，之后 `.st` 只读 |
| `.pc` | `show [名字]` | 6 | 看卡（默认看自己的） |
| `.pc` | `save` | 27 | 显式落盘 + 回执（本来每次写都落盘，这条是给人一个凭据） |
| `.ra` | `<技能>` | 12 | 公开检定，自动读卡 |
| `.rh` | `<技能>` | 15 | 暗骰：群里只回「已私聊发送」，结果走私聊 |
| `.st` | `<技能\|属性> <值>` | 5, 30 | 确认前手动调整 |
| `.combat` | `start` / `next` / `end` | 17–21 | 先攻序由代码算（决策 9） |
| `.log` | `export` | 26 | 战报经群文件发送 |
| `.r` | `<表达式>` | — | 原 `/掷骰` |
| `/能力` | — | — | **保留**：卸载接管者的唯一入口 |

### 2.2 子命令的落地方式（决策 8）

`ExtraCommandSpec` 加一个可选字段：

```ts
// src/extra/types.ts
export interface ExtraCommandSpec {
  names: readonly string[];
  /** 子命令。**声明期的糖**：由 runtime 展开成 `<names[0]> <sub>` 这些普通命令词。 */
  subs?: readonly string[];
}
```

**展开只在 `src/extra/runtime.ts` 里做一次**，产出仍然是普通的 `ExtraCommand`（`names: ['.trpg new']`）：

- `checkRuntimeShape()`（`runtime.ts:233`）对账时，把 `subs` 展开后再比名字集合（两个方向都查）；
- `commandDefs()`（`runtime.ts:384`）把每个 sub 展开成一条 `{ names: ['<cmd> <sub>'], run }`，`run` 从 `commandHandlers['<cmd> <sub>']` 取（执行入口是 `#runCommand`，`runtime.ts:868`）。

**这样 `src/web/onebot/slash-commands.ts` 一行都不用改** —— `startsWithWord('.trpg new', '.trpg new 灯塔')` 的 `rest` 是 `' 灯塔'`，以空白开头，判定通过；`canonicalize` 也自然成立。清单的写法保住了，"词形只有一个落点"这条性质也保住了。

**兜底用法必须显式声明，且排在所有 sub 之后**：

```ts
// spec.ts —— 顺序即行为（同 LIFECYCLE 那条）
commands: [
  { names: ['.trpg'], subs: ['new', 'join', 'start', 'status', 'end', 'mode', 'scenario'] },
  { names: ['.pc'],   subs: ['new', 'roll', 'confirm', 'show', 'save'] },
  { names: ['.combat'], subs: ['start', 'next', 'end'] },
  { names: ['.log'],  subs: ['export'] },
  { names: ['.ra'] }, { names: ['.rh'] }, { names: ['.st'] }, { names: ['.r'] },
  // 裸命令兜底：排在 subs 之后，只在下属一个都没匹配上时命中 → 回用法提示
  { names: ['.trpg'] }, { names: ['.pc'] }, { names: ['.combat'] }, { names: ['.log'] }
]
```

`.r` 与 `.ra` / `.rh` 不冲突：`startsWithWord('.ra 侦查', '.r')` 的 `rest` 是 `'a 侦查'`，不是空白/`[`/空 → 不匹配。

### 2.3 dispatcher 改名

命令不再以 `/` 开头，`slash-commands.ts` / `isSlashCommand` / `handleSlashCommand` 三个名字变成误称。本次一并改名（仓库对误称的容忍度很低，且这一步反正要动测试）：

- `src/web/onebot/slash-commands.ts` → `src/web/onebot/commands.ts`
- `isSlashCommand` → `isCommand`，`handleSlashCommand` → `handleCommand`（**实际落地的是 `isCommandEntry` / `handleCommandEntry`** —— 那两个名字在 `CommandDispatcher` 上，与扩展命令共用一个入口，加 `Entry` 是为了点明"认的是入站那一条"，见 `src/web/onebot/commands.ts`）
- 连带：`src/web/onebot/ingest.ts`、`src/web/app.ts`、`tests/t-slash-commands.mjs`（可一并改名 `t-commands.mjs`）

---

## 三、分阶段实现计划

> 每阶段结束都必须 `rm -rf dist && npm run build`（`tsconfig` 是 `incremental`，搬文件后不清 dist 会跑旧产物 —— AGENTS.md 有实测记录）。

### P0 — 分层重构（**纯搬运，零行为变化**）

**目标**：把现有 17 个文件按上面那棵树搬到位，不新增任何功能。

**改动**：见「一、新分层结构」的 `←` 标注。要点：
- `state.ts` 一分为五（`model/limits` + `model/paths` + `model/campaign` + `model/character` + `store/campaign-store`）；
- `tools.ts` 一分为六（`tools/shared` + 四个工具 + `tools/index`），`beginCampaign` 进 `model/session.ts`；
- `render.ts` 一分为四；`scenario.ts` 一分为三；`mode.ts` 一分为二；
- `impl.ts` 瘦身成纯接线 + `commands/index.ts` 装配。
- `scripts/check-layers.mjs` 加根目录白名单 + 七个子目录完整性 + `model/` 无 I/O 三条闸门。

**套件路径同步**：`tests/t-trpg.mjs`（`load('extra/trpg/state.js')` 等 12 处）、`tests/t-trpg-rules.mjs`（5 处）、`tests/t-trpg.mjs:1308-1320` 的源级断言路径。

**验收**：`npm run check` + `npm run test:all` 全绿，且 **`t-trpg.mjs` 的断言总数仍是 266**（AGENTS.md：抛异常的断言会吃掉后面的，报"全绿"前必须核对总数）。**这一阶段不许有任何行为变化** —— 它是后面所有阶段的地基，混进行为改动就失去了"搬运可审"这条性质。

### P1 — 命令面统一到 `.`

**目标**：清单里的命令写法全部可用；现有命令改词形。

**改动**：
- `src/extra/types.ts` 加 `ExtraCommandSpec.subs`；`src/extra/runtime.ts` 的 `checkRuntimeShape` / `commandDefs` 做展开（**唯一改共享层的地方**）。
- `src/extra/trpg/spec.ts` 换成 2.2 的那张表；`commands/index.ts` 按 `<命令> <子命令>` 键装配。
- dispatcher 改名（见 2.3）。
- **所有用户可见文案跟着改**（漏一处就是"教用户敲一条不存在的命令"）：
  `commands/session.ts` 的 `COMMAND_USAGE`、`render/status.ts` 的 `renderWizard` / `renderScenarioList` / `SCENARIO_USAGE`、`commands/dice.ts` 的 `ROLL_USAGE`、`render/players.ts` 里那句 `/能力 加载 trpg`、
  `ui/js/views/settings/sections.js`（841–899 行的面板说明）、`README.md`（342–380 行的命令表）、
  `src/extra/prompts.ts`（`EXTRA_PROMPT_SECTIONS.trpg.body` 里提到 `/能力 卸载 trpg`）。

**验收**：`tests/t-slash-commands.mjs`（改名后）与 `t-trpg.mjs` 的 5g 段改完仍绿；面板文案与 `README` 与代码逐字一致。

### P2 — 会话与建卡（决策 2）

**目标**：清单 1 / 2 / 3 / 5 / 6 / 7 / 27 落地。

**改动**：
- `types.ts`：`TrpgCampaign` 加 `status: 'preparing' | 'active'`、`players: string[]`、`sessionId: string`；`TrpgCharacter` 加 `confirmed: boolean`。
- `model/session.ts`：状态机（`canJoin` / `join` / `canActivate` / `activate` / `end`）+ 收团摘要数据。
- `model/campaign.ts`：`normalizeCampaign` 补迁移 —— **旧存档缺 `status` 一律读成 `active`**（理由同 `normalizeFlag`：升级不该改变既有局面）。
- `commands/session.ts`、`commands/character.ts` 实现 7 + 5 条子命令。`senderId` 即身份，`ownerId = senderId`。
- `store/journal-store.ts` 同时落地**写入侧**（决策 6）：`appendLog` 的调用点旁路写一份 jsonl。**记录要早于导出**，否则 P6 上线那天开始的团才有完整战报。
- `render/players.ts` 加 `renderForPlayer(campaign, qq)`。

**验收**：新套件段（建团 → join → 重复 join → 满员 → 建卡 → 确认 → start → status → end 全链路）；旧存档迁移断言。

### P3 — 检定与暗骰（决策 5 + 7）

**目标**：清单 11 / 12 / 13 / 15 / 29 / 30 落地。

**改动**：
- `src/extra/types.ts` 的 `ExtraRuntimeDeps` 加 `sendPrivate?(targetUserId: string, text: string): Promise<void>`；
  `src/web/app.ts` 用现成的 `sender.sendTextBatch('private:<QQ>', text)` 实现（`SendQueue` 已支持 private key，`src/qq/sender.ts:132`）。**扩展仍然只说"给谁、说什么"**。
- `tools/say.ts` 的 schema 加 `atUserId` 并透传（`SendQueue.sendTextBatch` 已支持 `atUserId`，`src/qq/sender.ts:158`）—— 修掉"DM 物理上无法 @ 人"。
- `commands/check.ts`：
  - `.ra <技能>`：按 `senderId` 找 `ownerId` 匹配的卡 → 取 `stats[技能名]` → `resolveCheck(expr, target, { rng, rule })` → 回执用现成的 `formatCheck`；
  - 技能不存在时列出 `Object.keys(card.stats)` 并给替代方案（清单 30）；没有卡/没加入时提示 `.pc new` / `.trpg join`（清单 29）；
  - `.st <技能> <值>`：确认前可改，走 `character` 的同一套钳制；
  - `.rh <技能>`：代码掷骰 → **群里只回「暗骰结果已私聊发送」** → 结果经 `sendPrivate` 送达。
- **私密叙事（决策 7）**：`EXTRA_PROMPT_JOBS.trpg` 加一条 `secretRoll`，用 `chatCompletion` 发一次**独立调用**（照 `suggest.ts:69` 的先例）生成一段私密叙事，随结果一起私聊。
  **这段内容既不写 `campaign.log`、也不进 journal** —— 它唯一的持久痕迹是玩家私聊存档里那条 `我：…`（`SendQueue.appendSelf`）。

**验收**：`.ra` 的正反路径（有卡/无卡/无此技能）；`.rh` 的"群里那句话逐字不含点数"断言；`sendPrivate` 的接线断言。

### P4 — 属性生成（决策 3：COC7 先行）

**目标**：清单 4 落地。

**改动**：
- `rules/chargen.ts`（纯函数）：STR/CON/SIZ/DEX/APP/INT/POW/EDU 的 `3d6×5` / `(2d6+6)×5` 掷法；派生 HP=`(CON+SIZ)/10`、MP=`POW/5`、SAN=`POW`、DB/Build 查 STR+SIZ 表、MOV 查 STR/DEX+SIZ 表。
- `rules/check.ts` 的 `RuleFile` 加可选 `chargen` 段；`BUILTIN_RULE_FILES.coc7` 补上它。
- `types.ts` 的 `TrpgCharacter` 加 `mp` / `mpMax` / `db` / `build` / `mov`（`normalizeCharacter` 补默认值）。
- `commands/character.ts` 的 `.pc roll`：一次性掷全属性 + 算派生 + 写卡（未确认前可重掷）。
- `render/*` 三份视野都要带上新字段（`pools` 的隐藏判据要覆盖 MP）。

**验收**：`tests/t-trpg-rules.mjs` 加 chargen 的定值断言（注入固定 `rng`，逐面核对）；派生公式的边界（DB/Build 表的每一档）。

### P5 — 战斗（决策 9）

**目标**：清单 17–22 落地。

**改动**：
- `rules/combat.ts`（纯）：按 DEX（平手随机，用注入的 `rng`）生成先攻序、指针推进、伤害计算。
- `model/combat.ts`：战斗状态归一化（`{ order: string[], turn: number, round: number }`）+ 指针推进；**代码不拦越权行动**。
- `commands/combat.ts`：`.combat start`（排序并公布，@ 当前行动者 —— 依赖 P3 的 `atUserId`）、`.combat next`、`.combat end`。
- `tools/campaign.ts` 加 `action=combat`（DM 侧也能推进）；当前行动者的行动被消费后**自动轮到下一个**。
- 复用 `rules/economy.ts` 的 `ActionLedger`：`actor` 已经是"这次判定算谁的行动"，战斗回合直接用它。
- `render/` 加战斗段的渲染（先攻序、当前回合）。

**验收**：先攻排序的定值断言（含平手）；"行动被消费 → 指针前进"的单元断言；`.combat start` 在真 app 端到端里的工具表与提示词。

### P6 — 战报（决策 6）

**目标**：清单 26 落地。

**改动**：
- `store/journal-store.ts` 补齐读取与渲染：`data/trpg/journal/<会话>.jsonl`，`{ seq, ts, kind, text }`，**只记公开事件**（暗骰不进去，见决策 7）。
- `commands/log.ts` 的 `.log export`：渲染成 `.txt`/`.md` → `upload_group_file`（照 `src/media/jmcomic/stages.ts:139` 与 `src/media/transcription/queue.ts:414`，**120 秒超时**）。
- 面板：`src/web/routes/trpg.ts` 与 `ui/js/views/settings/sections.js` 加"战报文件"的列出/删除（与剧本、规则表同形）。

**验收**：journal 的 append-only 断言（两次运行后旧行逐字不变）；导出的文件内容与 journal 一致；`upload_group_file` 的接线断言。

---

## 四、要改的关键文件

| 文件 | 改动 |
|---|---|
| `src/extra/types.ts` | `ExtraCommandSpec.subs`；`ExtraRuntimeDeps.sendPrivate` |
| `src/extra/runtime.ts` | `subs` 展开（`checkRuntimeShape` + `commandDefs`）—— **唯一改共享层的地方** |
| `src/extra/trpg/**` | 全部按新分层落位（P0），此后各阶段只加文件 |
| `src/extra/prompts.ts` | 新工具的文案 + `EXTRA_PROMPT_JOBS.trpg.secretRoll` + body 里的命令引用 |
| `src/web/app.ts` | `sendPrivate` 的接线（用现成的 `sender`） |
| `src/web/onebot/slash-commands.ts` → `commands.ts` | 改名（P1） |
| `src/web/onebot/ingest.ts` | 跟着改名 |
| `src/web/routes/trpg.ts` | 加战报文件路由（P6） |
| `scripts/check-layers.mjs` | 三条新闸门（P0） |
| `tests/t-trpg.mjs` / `t-trpg-rules.mjs` / `t-slash-commands.mjs` | 路径与断言同步 |
| `ui/js/views/settings/sections.js` | 面板文案（P1）+ 战报区（P6） |
| `README.md` / `AGENTS.md` / `docs/trpg-dialogue-expectations.md` | 命令表、分层、逐幕文案 |

**可复用的现成件**（不要重写）：
`resolveCheck` / `formatCheck`（`rules/check.ts`、`render/format.ts`）、`rollDice` / `parseDiceExpr` / `looksLikeDiceRequest`（`rules/dice.ts`）、`ActionLedger`（`rules/economy.ts`）、`appendLog`（`model/campaign.ts`）、`clampInt` / `text` / `safeFileName`、`deliverNote` → `appendAsyncResult`（`web/app.ts` / `chat/store.ts`）、`chatCompletion`（`llm/llm.ts`，照 `suggest.ts` 的用法）、`upload_group_file`（jmcomic / 转写两处）、`TrpgModeStore` 的小文件读写形状。

---

## 五、验证

**每阶段固定动作**：

```bash
rm -rf dist && npm run build     # 搬过文件就必须清 dist（incremental 会留旧产物）
npm run typecheck
npm run check                    # 分层闸门 + 类型 + 构建
npm run test:all
```

**重点套件**：`t-trpg.mjs`（266 条，**报绿前核对断言总数**）、`t-trpg-rules.mjs`、`t-slash-commands.mjs`、`t-extras.mjs`（`subs` 展开后名字对账两个方向）、`t-panel-wiring.mjs`（面板文案）、`t-lifecycle.mjs` / `t-tasks.mjs`（分层目录对账）。

**新增断言**：每阶段的功能断言并入 `t-trpg.mjs`；超过 ~400 条时拆出 `t-trpg-commands.mjs`（新套件必须在 `tests/run.mjs` 归类为 ASSERT，且结尾照抄 `process.exit(done() ? 0 : 1)`）。

**真机冒烟（套件证明不了）**：真 OneBot + 真模型下 —— DM 会不会真的调工具改状态、叙事质量、**私聊是否真的送达**、战报文件能否上传成功。

**文档复核**：`docs/trpg-dialogue-expectations.md` 文末那段脚本重跑一遍，`[代码]` 字面量逐条对账。

---

## 六、已知取舍与风险

1. **P0 是"纯搬运"，必须零行为变化**。它单独成阶段就是为了让 diff 可审 —— 混进功能改动会让"搬对了没有"无法验证。
2. **`.r` 与助手模式的 OneDice 前缀重叠**：`intercept` 会剥 `.r` / `。r` / `r`（`rules/dice.ts:632`）。命令优先于 `intercept`（`ingest.ts:309` 的 `slashCommand ? null : …`），所以 `.r 3d6` 走命令、`3d6` 走拦截，两者都零 LLM 成本，不冲突。
3. **私聊会在那个人的私聊存档里留下 `我：…`**（`SendQueue.appendSelf`）。这是有意的：那是暗骰唯一的持久痕迹，玩家能往回翻。代价是"从没聊过天的私聊"会出现在存档列表里。
4. **暗骰的私密叙事要花一次模型调用**（独立 `chatCompletion`；**2026-10-17 起进 token 账** ——
   `ExtraRuntimeDeps.recordUsage`，见 E 类第 1 条）。若不想花，`.rh` 可以先只发点数。
5. **战斗的指针不拦越权**（决策 9）：顺序错了不会有任何机制发现，只能靠 DM 照提示词走。
6. **`campaign.log` 的 60 条上限不动**：战报靠 jsonl，提示词预算不受影响。代价是"开局到 P6 之间"的团没有完整战报。
7. **`subs` 展开只改 `runtime.ts`**：这是本次唯一动到共享层的地方，`t-extras.mjs` 的名字对账断言要同步（两个方向都要覆盖展开后的集合）。
