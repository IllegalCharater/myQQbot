// ── 扩展（extra）的固定指令 ────────────────────────────────────────────────────
//
// 模型可见的固定指令仍然集中在**提示词目录**里，只是扩展那一块**单独一个文件**：
//   • `src/core/prompt-catalog.ts` 的 `TOOL_PROMPT_TEXT` —— 每一项对应 `agent/tools/index.ts` 里
//     **内置拼装**的一个工具，那张名单（名字与顺序）是硬约束、有断言逐字钉着；
//   • 本表 —— 每一项对应 `src/extra/<x>/spec.ts` 里声明的一个工具，加一个扩展就在这里加一块。
// 分开的理由是**权威来源不同**，而权威来源决定"加东西时要动哪里"：混在一起会让"哪些工具是内置的"
// 看不出来，加扩展的人也会在一张写着 "canonical schema traversal order" 的表里找自己该插哪儿。
//
// ⚠️ **本文件是分层闸门里唯一的具名例外**：`scripts/check-layers.mjs` 的 `LAYER_ALLOW` 里写着
// `core/prompt-catalog.ts -> extra/prompts.ts` —— 也就是说 `core`（层级 0）要 import 这个
// `extra`（层级 4）的文件。之所以敢这么开，**全靠本文件是个叶子模块**：
//
//   ★ 本文件**不许 import 任何东西**（连 `import type` 都不要）。
//
// 一旦这里出现 import，环就可能成立（core → extra → core），而 `tsc` 不一定报错、运行期也只在
// 特定加载顺序下才炸。闸门里有专门的断言扫这一点（`LAYER_ALLOW` 的目标必须是叶子模块），
// 不需要靠人记 —— 但也别去试探它。
//
// ⚠️ 扩展的 `spec.ts` 只允许**引用**这里，**不许把文案抄一份到自己那边**：抄本必然漂移，
// 而漂移的表现是"文档写着 A、模型看到的是 B"，没有任何报错。`tests/t-extras.mjs` 有一条断言
// 逐个比对注册表里每个工具的 description 与本表。
export const EXTRA_PROMPT_TEXT = {
  get_current_time: {
    displayDesc: '给模型一个查当前日期与时间的工具（支持按 IANA 时区指定地区）。',
    description: '查询此刻的日期与时间（含星期与所在时区）。群友问“现在几点”“今天几号”“今天星期几”“你那边现在是什么时候”这类需要真实时间的问题时调用 —— 你没有内建时钟，不调这个工具就只能瞎猜或回避。timeZone 不填按 Asia/Shanghai 算；要别的地区就填 IANA 时区名（UTC、America/New_York、Europe/London 等），填错会返回一句可读的错误而不是乱算。工具自己不会发送任何消息：拿到结果后要不要说、怎么说由你决定。',
    timeZone: '（可选）IANA 时区名，例如 Asia/Shanghai、UTC、America/New_York。不填就用默认时区。'
  }
} as const;

/**
 * 扩展往 **system prompt** 里追加/覆盖的段落。
 *
 * **为什么与上面那张表分成两个导出**：索引方式不同 ——
 *   • `EXTRA_PROMPT_TEXT` 按**工具名**索引（与注册表的工具名逐个对账）；
 *   • 本表按**扩展 id** 索引（与注册表的扩展 id 逐个对账）。
 * 混在一张表里会让"这是工具文案还是提示词段落"看不出来，而两者的对账规则完全不同。
 *
 * **群友可见的文案不在这里**（命令的用法提示、回执话术都属于 UI/群聊文案，不属于提示词目录）——
 * 那些跟命令的实现放在一起（`<x>/impl.ts`），同 `media/image-gen/commands.ts` 的用法提示。
 *
 * 段落文案由扩展的 `impl.prompt()` 返回；**它只在扩展被装载后才生效**（"随装载状态变化"那条取舍）。
 */
export const EXTRA_PROMPT_SECTIONS = {
  clock: {
    append: [
      '【时间】要报时间必须调 get_current_time（你没有内建时钟），不要凭印象说"大概几点"。'
    ]
  }
} as const;
