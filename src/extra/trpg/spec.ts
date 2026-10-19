// 跑团扩展的**声明**（纯数据）。
//
// ⚠️ 本文件是 `registry.ts` **静态 import** 的那一份，所以它里面**一个字的重东西都不许有** ——
// 没有 `impl.js` 的 import、没有状态、没有文件读写。`tests/t-extras.mjs` 有一条源级断言钉这条。
//
// 文案只许**引用** `../prompts.js`：模型可见的固定指令的唯一落点在那里，这里抄一份必然漂移，
// 而漂移的表现是"文档写着 A、模型看到的是 B"，没有任何报错。
import { EXTRA_PROMPT_TEXT } from '../prompts.js';
import type { ExtraSpec } from '../types.js';

const PROMPTS = EXTRA_PROMPT_TEXT;

/**
 * **助手模式**暴露的工具名 —— 只有掷骰与发言。
 *
 * 它住在 `spec.ts` 而不是 `impl.ts`，是为了紧挨着它**必须是其子集**的那个东西（下面的 `tools`）：
 * `toolsFor()` 会滤掉没声明的名字（只记日志，不抛），而 `tests/t-trpg.mjs` 有一条断言直接钉
 * "这里的每个名字都真的声明过"。把这份名单放在别处，拼错一个名字的表现是**静默少一个工具**。
 *
 * 不含 `campaign` / `character`：助手模式不管状态，连状态都不注入（见 `impl.ts` 的 `prompt()`）。
 */
export const TRPG_ASSISTANT_TOOLS: readonly string[] = ['say', 'roll'];

/** 工具参数里那个"名字 → 数值"的表（属性/技能）。建卡与改卡共用这一个形状。 */
const STATS_SCHEMA = {
  type: 'object',
  additionalProperties: { type: 'number' },
  description: PROMPTS.character.stats
};

/** 字段级可见度的取值域（与 `types.ts` 的 `HIDDEN_FIELDS` 一致，两处都是硬约束）。 */
const HIDDEN_SCHEMA = {
  type: 'array',
  items: { type: 'string', enum: ['stats', 'pools', 'notes'] },
  description: PROMPTS.character.hidden
};

/**
 * **四个工具，不是七个**。
 *
 * 合并的判据是"参数互不重叠、机械部分相同"，而收益是具体的：工具 schema 是**每次请求前缀**的
 * 一部分，每多一个工具就打散一次提示词缓存；合并后每个工具内部用 `action` 分支，
 * 而 `action` 的取值在 schema 里是 `enum`，模型看见的就是全部选项。
 *
 * 代价知情：`required` 不能按 `action` 分支（JSON Schema 里没有这个能力），所以"某个 action
 * 少传了必填字段"只能靠 `tools/character.ts` 里的中文错误文案补救 —— 那批文案因此必须点明"这个 action
 * 需要什么"。
 */
export const trpgSpec: ExtraSpec = {
  id: 'trpg',
  title: '跑团（TRPG）',
  // ⚠️ `displayDesc` 必须取自 `tools[0]`（这里是 `say`）那一格 —— `tests/t-extras.mjs`
  // 逐个比对两者，写别处就红。理由见 `extra/types.ts`：设置页那一行与工具文案同源。
  displayDesc: PROMPTS.say.displayDesc,
  /**
   * **接管模式**：装载即让**那个会话**的模型侧整体换掉 —— 工具表只剩下面这 4 个、
   * 命令表只剩跑团那 25 条词形（12 条声明，其中 4 条带 `subs`、4 条是裸命令；外加永远在的
   * `/能力`）、system prompt 换成"框架契约 + 跑团人格"。存档、上下文窗口、记忆、后台任务照常。
   */
  mode: 'override',
  /**
   * **默认关**。判据是仓库里所有"重的、会改变行为的能力"都默认关：`imageSource` / `transcription` /
   * `imageGen` 全是 `enabled: false`。跑团比它们更重 —— 它换掉的是 bot 的整个人格，
   * 该由管理员在设置页明确打开（保存即生效、不用重启，那句提示在设置页上）。
   */
  defaultEnabled: false,
  /**
   * 框架契约段（任何模式下都强制保留）里那两个工具名，见 `extra/types.ts` 的说明。
   *
   * `say` 是**唯一的发言通道**（接管会话里内置 `send_message` 不在表里），所以它必须与
   * `tools` 里的名字逐字相同 —— `validateRegistry` 在装配期校验，对不上直接拒绝装载。
   * `finishTool: null`：跑团没有收尾工具（模型不调工具就是结束），于是框架段第 5 条不提它。
   */
  overrideTools: { sendTool: 'say', finishTool: null },
  tools: [
    // `say` **必须是第一个**：`displayDesc` 取自它那一格（见上）。
    {
      name: 'say',
      description: PROMPTS.say.description,
      parameters: {
        type: 'object',
        properties: {
          text: { description: PROMPTS.say.text, oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          replyToMessageId: { type: ['integer', 'string'], description: PROMPTS.say.replyToMessageId },
          // 纯数字 QQ 号。**必须用它才能真的 @ 到人**（写进 text 只是一串文字），见 prompts.ts。
          atUserId: { type: ['integer', 'string'], description: PROMPTS.say.atUserId }
        },
        required: ['text']
      }
    },
    {
      name: 'campaign',
      description: PROMPTS.campaign.description,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'scene', 'flag', 'reveal', 'combat', 'advance', 'end'],
            description: PROMPTS.campaign.action
          },
          // 只有 `action=combat` 用它。`required` 不能按 action 分支，所以"这个 action 需要 sub"
          // 只能靠 `PROMPTS.campaign.sub` 与 `tools/campaign.ts` 的错误文案补救（同文件头那条）。
          sub: { type: 'string', enum: ['start', 'next', 'end'], description: PROMPTS.campaign.sub },
          title: { type: 'string', description: PROMPTS.campaign.title },
          system: { type: 'string', description: PROMPTS.campaign.system },
          // ⚠️ **不写 `enum`**：规则表是 `data/trpg/rules/` 里的数据文件，管理员随时可以加，而本
          // 文件是**静态纯数据**（注册表静态 import 它，不许 I/O）—— 拼不出"磁盘上此刻有哪些"。
          // 代价是少了 schema 这一层保护，靠两件事补偿：可用清单注入 system prompt（`renderBriefing`），
          // 以及填错时回执里明说用了哪一个（`beginCampaign`）。
          rule: { type: 'string', description: PROMPTS.campaign.rule },
          scenario: { type: 'string', description: PROMPTS.campaign.scenario },
          scene: { type: 'string', description: PROMPTS.campaign.scene },
          restart: { type: 'boolean', description: PROMPTS.campaign.restart },
          flags: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: PROMPTS.campaign.flags
          },
          visible: { type: 'boolean', description: PROMPTS.campaign.visible },
          name: { type: 'string', description: PROMPTS.campaign.name },
          fields: {
            type: 'array',
            items: { type: 'string', enum: ['stats', 'pools', 'notes'] },
            description: PROMPTS.campaign.fields
          },
          actionSource: { type: 'string', description: PROMPTS.campaign.actionSource }
        },
        required: ['action']
      }
    },
    {
      name: 'character',
      description: PROMPTS.character.description,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'update', 'remove'],
            description: PROMPTS.character.action
          },
          name: { type: 'string', description: PROMPTS.character.name },
          ownerId: { type: ['integer', 'string'], description: PROMPTS.character.ownerId },
          hpMax: { type: 'integer', description: PROMPTS.character.hpMax },
          sanMax: { type: 'integer', description: PROMPTS.character.sanMax },
          mpMax: { type: 'integer', description: PROMPTS.character.mpMax },
          hpDelta: { type: 'integer', description: PROMPTS.character.hpDelta },
          sanDelta: { type: 'integer', description: PROMPTS.character.sanDelta },
          mpDelta: { type: 'integer', description: PROMPTS.character.mpDelta },
          full: { type: 'boolean', description: PROMPTS.character.full },
          stats: STATS_SCHEMA,
          note: { type: 'string', description: PROMPTS.character.note },
          forget: { type: 'string', description: PROMPTS.character.forget },
          visible: { type: 'boolean', description: PROMPTS.character.visible },
          hidden: HIDDEN_SCHEMA,
          actionSource: { type: 'string', description: PROMPTS.character.actionSource }
        },
        required: ['action', 'name']
      }
    },
    {
      name: 'roll',
      description: PROMPTS.roll.description,
      parameters: {
        type: 'object',
        properties: {
          expr: { type: 'string', description: PROMPTS.roll.expr },
          target: { type: 'number', description: PROMPTS.roll.target },
          reason: { type: 'string', description: PROMPTS.roll.reason },
          actor: { type: 'string', description: PROMPTS.roll.actor },
          // ⚠️ **必须有它**：这一局的规则扩展按技能名匹配 `{op:'skill'}` 机制。没有这一栏时
          // 工具那条路恒传空串，于是同一个检定「DM 用 roll 掷」与「玩家敲 .ra」目标值不同 ——
          // 而两条路本该是同一件事（见 `tools/roll.ts` 那段说明与 `.ra` 的 `judge()`）。
          skill: { type: 'string', description: PROMPTS.roll.skill },
          actionSource: { type: 'string', description: PROMPTS.roll.actionSource }
        },
        required: ['expr']
      }
    }
  ],
  /**
   * 斜杠命令。**判据是纯数据**（`names` 的第一个是主命令词，也是 `commandHandlers` 的键），
   * 所以列表在**没装载**时就能算出来 —— 这几条命令被敲到时才把本扩展拉起来（入口是人）。
   *
   * ⚠️ 它们**只出现在被接管的会话里**：`commandDefs()` 对非接管的会话直接跳过 override 模式的
   * 扩展。所以别的群敲不到 `.trpg`，也看不到跑团这件事存在。
   *
   * ── 前缀是 `.` 而不是 `/`（2026-10-16 起）──
   *
   * OneDice 的手感（`.r 3d6`），也是这一族命令与主流程 `/转写` `/画` `/漫画` `/能力`
   * 分开的标记。前缀的合法性由 `validateRegistry` 查（`/` 与 `.` 都收）。
   *
   * ── 子命令是**声明期的糖**（`subs`）──
   *
   * `runtime.ts` 把它们展开成 `.trpg start` 这样的**普通命令词**，此后没有任何地方知道
   * "子命令"这个概念（见 `ExtraCommandSpec.subs`）。所以：
   *   • `commandHandlers` 的键是 `.trpg start`（带空格）这样一串；
   *   • 判定沿用既有的边界规则 —— `.trpg start 灯塔` 落到 `.trpg start` 上，`rest` 是 `' 灯塔'`；
   *   • **裸命令要单独声明一条，且排在带 `subs` 的那条之后**（见下面那条 `.trpg`）。
   *     顺序即行为：反过来的话裸命令会先命中，所有子命令全被它吃掉。
   *
   * ⚠️ 词形共用一个命名空间（同一命令内、跨命令、跨扩展都查），注册表自检拒绝重复 ——
   * 而且查的是**展开后**的串（两个扩展各写一个 `.trpg start` 正是最该被拦住的那种撞名）。
   */
  commands: [
    // 会话这一族：起局 → 报名 → 确认 → 开跑 → 收团，加上形态、剧本与核对。
    // ⚠️ `check` **追加在末尾**，与 `commands/index.ts` 那张表的行序对应（那份表也把
    // `.trpg check` 排在 `.trpg scenario` 之后、裸 `.trpg` 之前）。顺序只对同前缀的词有意义，
    // 这里两个都是两词命令、互不遮蔽，但**读起来一致**省得下一个人以为漏了一条。
    { names: ['.trpg'], subs: ['new', 'join', 'status', 'start', 'end', 'mode', 'scenario', 'check'] },
    // **裸命令兜底**：排在所有子命令之后 —— 只在"一个子命令都没匹配上"时命中，回用法清单。
    { names: ['.trpg'] },
    // 人物卡那一族。同样先子命令、后裸命令（顺序即行为）。
    { names: ['.pc'], subs: ['new', 'roll', 'confirm', 'show', 'save'] },
    { names: ['.pc'] },
    // 战斗那一族（P5）。三条子命令做的是 `campaign action=combat` 那三件事，
    // 共用 `model/combat.ts` —— 两条路（人敲的 / 模型调的）判据只有一份。
    // 同样先子命令、后裸命令。
    { names: ['.combat'], subs: ['start', 'next', 'end'] },
    { names: ['.combat'] },
    // 战报那一族（P6）。同样先子命令、后裸命令。
    // ⚠️ 这一族**不看战役存档**：`.trpg end` 收团时删的是 `data/trpg/<会话>.json`，战报
    // （`data/trpg/journal/<会话>.jsonl`）留着 —— "刚打完那一局想留个纪念"正是它的主要用法。
    { names: ['.log'], subs: ['export'] },
    { names: ['.log'] },
    // 检定与属性：参数是**技能名**，所以是普通命令（没有子命令那一族）。它们都要读卡，
    // 所以都在 `commands/check.ts` 里（`.ra` 公开、`.rh` 暗骰、`.st` 改属性）。
    { names: ['.ra'] },
    { names: ['.rh'] },
    { names: ['.st'] },
    // 掷骰：参数是**一整条表达式**，所以它自己剥前缀、不按词切（见 `commands/shared.ts`）。
    { names: ['.r'] }
  ]
};
