// 跑团扩展的**声明**（纯数据）。
//
// ⚠️ 本文件是 `registry.ts` **静态 import** 的那一份，所以它里面**一个字的重东西都不许有** ——
// 没有 `impl.js` 的 import、没有状态、没有文件读写。`tests/t-extras.mjs` 有一条源级断言钉这条。
//
// 文案只许**引用** `../prompts.js`：模型可见的固定指令的唯一落点在那里，这里抄一份必然漂移，
// 而漂移的表现是"文档写着 A、模型看到的是 B"，没有任何报错。
import { EXTRA_PROMPT_TEXT } from '../prompts.js';
import type { ExtraSpec } from '../types.js';

const T = EXTRA_PROMPT_TEXT;

/** 工具参数里那个"名字 → 数值"的表（属性/技能）。两个工具共用这一个形状。 */
const STATS_SCHEMA = {
  type: 'object',
  additionalProperties: { type: 'number' },
  description: T.character_create.stats
};

export const trpgSpec: ExtraSpec = {
  id: 'trpg',
  title: '跑团（TRPG）',
  // ⚠️ `displayDesc` 必须取自 `tools[0]`（这里是 `say`）那一格 —— `tests/t-extras.mjs`
  // 逐个比对两者，写别处就红。理由见 `extra/types.ts`：设置页那一行与工具文案同源。
  displayDesc: T.say.displayDesc,
  /**
   * **接管模式**：装载即让**那个会话**的模型侧整体换掉 —— 工具表只剩下面这 7 个、
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
      description: T.say.description,
      parameters: {
        type: 'object',
        properties: {
          text: { description: T.say.text, oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          replyToMessageId: { type: ['integer', 'string'], description: T.say.replyToMessageId }
        },
        required: ['text']
      }
    },
    {
      name: 'campaign_start',
      description: T.campaign_start.description,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: T.campaign_start.title },
          system: { type: 'string', description: T.campaign_start.system },
          scene: { type: 'string', description: T.campaign_start.scene },
          restart: { type: 'boolean', description: T.campaign_start.restart }
        },
        required: ['title']
      }
    },
    {
      name: 'character_create',
      description: T.character_create.description,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: T.character_create.name },
          ownerId: { type: ['integer', 'string'], description: T.character_create.ownerId },
          hpMax: { type: 'integer', description: T.character_create.hpMax },
          sanMax: { type: 'integer', description: T.character_create.sanMax },
          stats: STATS_SCHEMA
        },
        required: ['name']
      }
    },
    {
      name: 'character_update',
      description: T.character_update.description,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: T.character_update.name },
          hpDelta: { type: 'integer', description: T.character_update.hpDelta },
          sanDelta: { type: 'integer', description: T.character_update.sanDelta },
          full: { type: 'boolean', description: T.character_update.full },
          stats: STATS_SCHEMA,
          note: { type: 'string', description: T.character_update.note },
          forget: { type: 'string', description: T.character_update.forget },
          remove: { type: 'boolean', description: T.character_update.remove }
        },
        required: ['name']
      }
    },
    {
      name: 'story_update',
      description: T.story_update.description,
      parameters: {
        type: 'object',
        properties: {
          scene: { type: 'string', description: T.story_update.scene },
          flags: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: T.story_update.flags
          }
        },
        required: []
      }
    },
    {
      name: 'roll_dice',
      description: T.roll_dice.description,
      parameters: {
        type: 'object',
        properties: {
          expr: { type: 'string', description: T.roll_dice.expr },
          reason: { type: 'string', description: T.roll_dice.reason }
        },
        required: ['expr']
      }
    },
    {
      name: 'skill_check',
      description: T.skill_check.description,
      parameters: {
        type: 'object',
        properties: {
          expr: { type: 'string', description: T.skill_check.expr },
          target: { type: 'number', description: T.skill_check.target },
          reason: { type: 'string', description: T.skill_check.reason }
        },
        required: ['expr', 'target']
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
