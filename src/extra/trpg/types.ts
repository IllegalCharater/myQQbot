// 跑团（TRPG）的领域类型。
//
// ⚠️ 本文件**不 import 本模块的任何文件**（同 `media/transcription/types.ts`、
// `media/jmcomic/types.ts` 的规矩）：它被 state / render / tools / commands / impl 同时依赖，
// 反向依赖就成环。

/**
 * 一张人物卡。
 *
 * ⚠️ **这里是"确定性状态"的家**：HP / SAN / 属性 / 技能都由**代码**持有并钳制，模型只能通过
 * 工具请求改动（`character_create` / `character_update`）。这正是跑团那条最要紧的分界 ——
 * AI 负责叙事，代码负责状态；模型在叙述里说"你掉了三点血"而不调工具，群里的状态就与它说的
 * 对不上，而且**没有任何人会立刻发现**。
 *
 * `ownerId` 是玩家的 QQ 号，空串表示 NPC（由 DM 扮演，没有真人对应）。
 * 不区分"玩家角色 / NPC"两种结构：它们的字段完全一样，分开只会让渲染与工具都要写两份。
 */
export interface TrpgCharacter {
  name: string;
  /** 玩家 QQ 号；`''` = NPC。 */
  ownerId: string;
  /**
   * 属性与技能**合一张表**（键是名字、值是数）。
   *
   * 刻意不拆成 `attributes` / `skills` 两栏：跑团规则书五花八门（COC 是一长串百分技能，
   * D&D 是六属性 + 熟练），而"哪些算属性、哪些算技能"只有具体规则书说得清。本模块选了
   * 通用骰子表达式那条路（见 `rules/check.ts` 的 `CheckJudge`），所以这里也**不替规则书分类**。
   */
  stats: Record<string, number>;
  hp: number;
  hpMax: number;
  san: number;
  sanMax: number;
  /** 自由文本备注（物品、状态、旧伤…）。有上限，因为它每轮都进提示词。 */
  notes: string[];
}

/** 一条跑团日志。 */
export interface TrpgLogEntry {
  /** 单调递增序号，**渲染时会印出来**（模型与群友都靠它指代"第 N 条"）。 */
  seq: number;
  ts: number;
  /**
   * `'narration'`（DM 说的话）| `'roll'`（掷骰）| `'check'`（检定）| `'state'`（状态变更）| `'scene'`。
   *
   * 是**给渲染层分类用的标签**，不是封闭枚举：加一种日志不必改这里，
   * 渲染层认不出来就当普通条目印。
   */
  kind: string;
  text: string;
}

/** 一场跑团的全部状态。一个会话最多一场。 */
export interface TrpgCampaign {
  chatKey: string;
  title: string;
  /** 规则系统名（自由文本，如「通用骰子」「COC 7 版」）。**本模块不解释它**。 */
  system: string;
  /** 当前场景的一句话描述。 */
  scene: string;
  /** 剧情旗标：键 → 值。值是字符串（`'是'` / `'3'` / `'已烧毁'` 都合法）。 */
  flags: Record<string, string>;
  characters: TrpgCharacter[];
  log: TrpgLogEntry[];
  /** 下一条日志的序号。单调递增、**只增不减**（截断旧日志不会让它回退，否则序号会重复）。 */
  seq: number;
  createdAt: number;
  updatedAt: number;
}
