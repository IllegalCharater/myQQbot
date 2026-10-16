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
 * 少传了必填字段"只能靠 `tools.ts` 里的中文错误文案补救 —— 那批文案因此必须点明"这个 action
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
   * 命令表只剩跑团那两条（外加永远在的 `/能力`）、system prompt 换成"框架契约 + 跑团人格"。
   * 存档、上下文窗口、记忆、后台任务照常。
   */
  mode: 'override',
  /**
   * **默认关**。判据是仓库里所有"重的、会改变行为的能力"都默认关：`imageSource` / `transcription` /
   * `imageGen` 全是 `enabled: false`。跑团比它们更重 —— 它换掉的是 bot 的整个人格，
   * 该由管理员在设置页明确打开（改完要重启，那句提示在设置页上）。
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
          replyToMessageId: { type: ['integer', 'string'], description: PROMPTS.say.replyToMessageId }
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
            enum: ['start', 'scene', 'flag', 'reveal'],
            description: PROMPTS.campaign.action
          },
          title: { type: 'string', description: PROMPTS.campaign.title },
          system: { type: 'string', description: PROMPTS.campaign.system },
          rule: { type: 'string', enum: ['generic', 'coc7'], description: PROMPTS.campaign.rule },
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
          hpDelta: { type: 'integer', description: PROMPTS.character.hpDelta },
          sanDelta: { type: 'integer', description: PROMPTS.character.sanDelta },
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
          actionSource: { type: 'string', description: PROMPTS.roll.actionSource }
        },
        required: ['expr']
      }
    }
  ],
  /**
   * 斜杠命令。**判据是纯数据**（`names` 的第一个是主命令词，也是 `commandHandlers` 的键），
   * 所以列表在**没装载**时就能算出来 —— 这两条命令被敲到时才把本扩展拉起来（入口是人）。
   *
   * ⚠️ 它们**只出现在被接管的会话里**：`commandDefs()` 对非接管的会话直接跳过 override 模式的
   * 扩展。所以别的群敲不到 `/跑团`，也看不到跑团这件事存在。
   */
  commands: [
    { names: ['/跑团', '/trpg'] },
    { names: ['/掷骰', '/roll'] }
  ]
};
