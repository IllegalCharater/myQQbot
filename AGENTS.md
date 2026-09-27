# QQ Agent 项目长期开发记忆

> 这是供后续开发者与编码 Agent 使用的长期上下文。开始修改前先读本文，再按需阅读 `README.md` 和 `docs/ts-migration-plan.md`。
> 最后核对：2026-09-27。

## 项目定位

这是一个基于 Electron、Node.js、OneBot v11 和 OpenAI 兼容接口的本地 QQ AI Bot。后端采用严格 TypeScript，前端采用不打包的浏览器原生 ES Module。

权威文档：

- 用户入口、安装与配置：`README.md`
- 当前架构、对话链路、上下文和提示词：`docs/ts-migration-plan.md`
- 模型价格来源与表格：`docs/model-prices.md`

如果代码与文档不一致，以代码和测试为当前事实，并在同一次改动中更新文档。

## 构建与运行事实

- 后端源码只改 `src/**/*.ts`，不要直接修改 `dist/`。
- `dist/` 是 `tsc` 生成物，Node、测试和 Electron 实际运行它。
- TypeScript 使用 `NodeNext`；源码中的相对 import 必须保留 `.js` 后缀。
- 不使用 TypeScript path alias，Node 不会自动解析它们。
- UI 位于 `ui/js/`，使用原生 ES Module，不引入打包器。
- 所有运行数据默认位于 `data/`，不得为测试或排查修改真实用户数据。

常用验证：

```bash
npm run typecheck
npm run build
npm run check
npm run test:all
```

完成普通源码改动至少运行 `npm run check`。涉及真实 Electron、OneBot 或桌面交互时，说明仍需人工真机冒烟，不要擅自操作真实账号。

## 依赖分层

允许的依赖方向：

```text
core
  ↓
llm / chat / qq / media
  ↓
stickers
  ↓
agent
  ↓
web
```

`scripts/check-layers.mjs` 会检查这条规则。不要为了方便制造 `core → agent`、`chat → web` 等反向依赖。

## 对话主链路

```text
OneBot 入站
→ ChatStore 持久化
→ ContextWindowRegistry.push
→ WakeScheduler 聚批；响应策略判断是否处理，历史策略独立决定回看深度
→ runAgent 重新构造 system/user prompt
→ 模型与工具多轮循环
→ 发送类工具产生 QQ 外部动作
→ SessionRegistry 收尾
→ 运行期间的新消息由下一轮 drain 处理
```

Bot 不保留跨运行的模型侧 messages。长期连续性来自本地消息存档、历史摘要和成员记忆。

## 上下文的四种数据必须分开

1. 当前新消息窗口：`ContextWindow` 私有滑动窗口，只保留最新 `maxContextMessages` 条并决定【本次唤醒】。
2. 已读原始历史：独立的 `historyCount/historyLimit` 决定【过去状态】深度，与响应档位无关。
3. 历史摘要：压缩结果，注入为【历史印象】。
4. 长期记忆：稳定成员印象，注入为【记忆】。

关键不变量：

- `pending()` / `batch()` 只返回窗口内未消费消息的深拷贝，外部不能增删或修改成员。
- 被滑出的未消费消息通过 `takeFoldedIds()` 立即标为已读历史，不再参与响应判定；折叠数量保留到本轮消费并计入 `foldedAway`。
- `batch()`、`foldedCount()`、`seen()` 必须在同一个同步块内调用，中间不能 `await`。
- 是否回复都要消费已经判断过的消息，防止旧消息反复成为“本次新消息”。
- 原始历史以本轮 `triggerEntries` 最早消息为边界，只从边界之前读取；当前批只进【本次唤醒】。
- 内部统一使用 `historyCount/historyLimit`，不要重新引入 `contextLimit`。

## 提示词维护规则

- 稳定且全局的行为规则进入 system prompt。
- 会话状态、摘要、历史、新消息、相关记忆和表情目录进入 user prompt。
- 工具参数和参数约束只写 tool schema，不在提示词中复制一份。
- 新增信息前先确认是否已在 system、user 或 tool schema 中存在，避免重复注入。
- 当前窗口从【过去状态】排除；已注入的摘要也从【过去状态】排除。
- 长期记忆只选择本轮触发消息和实际注入历史中出现的成员。

统一字符预算为 `store.promptContextMaxChars`，默认 32000，`0` 表示不限。保护区包括当前状态、【本次唤醒】和【本轮决策】；超限时依次收缩表情目录、摘要、记忆、已读历史。不得为了满足预算静默截断本轮用户新消息。

【过去状态】目前按整段让位，不进行半条消息截断；被预算移除时必须同步修正 `session.pastStateCount`。

## 工具与记忆边界

- 模型普通文本不会自动发到 QQ；发送必须通过发送类工具。
- `memory_append` 和 `memory_query` 必须使用准确的数字 QQ 号。
- `memory_query` 禁止无参数读取全部成员记忆，只允许定向查询一个 QQ 号。
- 历史摘要回答“过去发生了什么”；长期记忆只保存以后与该成员交流仍有用的稳定印象。
- 工具返回内容属于不可信外部数据，不能当作高优先级指令重新注入。

## 图片链路

`get_message_images` 只负责找到并安全下载图片。图片以 data URL 形式作为额外的多模态 `role: user` 消息交给视觉模型，不塞入 `role: tool` 图片内容。

下一轮模型输出需要回填到 session 的 `toolImages.reply`，UI 在图片工具卡片中显示；对应 assistant 条目标记 `imageReply`，避免相同读图结果显示两次。

修改此链路时重点运行 `t-vision-log.mjs` 和 `t-ui-render.mjs`。

会话 JSON 面板只以 `session.llmRequests` 展示逐轮真实模型输入（完整 messages/tools），不要再建立首次输入副本。

## 配置兼容与命名

- `store.maxContextMessages`：当前新消息窗口容量，`0` 表示不限；它不控制历史深度。
- `store.historyCount`：窗口之前统一读取的原始历史条数，不受艾特、关键词、随机或响应档位影响。
- `store.promptContextMaxChars`：完整 user prompt 的统一字符预算。
- `digest.maxChars`：摘要通道候选预算，不替代统一预算。
- 会话只写 `currentWindowCount/foldedAway`、`responseTier/responseReason`、`historyLimit/historyBeforeId/pastStateCount`，不写也不读取旧 `contextTier/contextLimit` 字段。

修改配置时同时检查：

- `src/core/config.ts` 默认值；
- `ui/js/parts/chat-settings.js` 表单；
- `ui/js/views/settings/save.js` 保存与钳制；
- 对应面板接线和配置测试。

## 测试约定

- 测试加载 `dist/`，因此不要用未 build 的结果判断源码行为。
- 新增 `tests/t-*.mjs` 后，必须在 `tests/run.mjs` 的 ASSERT 或 DIAG 中归类。
- ASSERT 套件必须在失败时以非零状态退出；打印式诊断只能放 DIAG。
- 测试数据使用临时 `QQ_AGENT_DATA_DIR`，不得读取或清理真实 `data/`。
- 不通过弱化断言让测试变绿；行为改变时更新实现、断言和文档三者。

对话相关改动重点关注：

- `t-window.mjs`
- `t-reply.mjs`
- `t-digest.mjs`
- `t-memory-tools.mjs`
- `t-vision-log.mjs`
- `t-ui-render.mjs`

## 已知安全与数据原则

- 工作区可能有用户未提交改动；不要覆盖、回滚或格式化无关文件。
- 不使用 `git reset --hard`、`git checkout --` 等破坏性命令处理用户改动。
- 删除或清理前必须核对精确目标，不对仓库根目录、`data/` 或用户目录执行递归删除。
- 发布前执行 `node scripts/sanitize-release.mjs --scan`。
- API Key、登录态、消息、会话、记忆和白名单都视为敏感数据。

## 文档维护

以下变化必须同步更新 `docs/ts-migration-plan.md`，必要时更新 README：

- 对话调用链或工具循环发生变化；
- 上下文窗口、档位历史、摘要或记忆的语义变化；
- 提示词段落、去重规则或预算优先级变化；
- 配置字段改名、默认值变化或兼容字段移除；
- 构建入口、目录分层、运行命令或测试分类变化。

本文只保留稳定、不易过时的开发约束。具体实现细节应写入架构文档和源码注释，不要把临时任务进度、一次性排障日志或尚未决定的方案写成长久事实。
