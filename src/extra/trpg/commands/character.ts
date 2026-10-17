// `.pc <子命令>` —— 玩家自己的角色卡（P2 加）。
//
//   建卡 → 确认 → 看卡 → 落盘。**身份是 QQ 号**（决策 2）：`ownerId = senderId`，
//   所以"你的卡"永远是"这张卡的 ownerId 等于敲命令的人" —— 不需要账号、不需要昵称匹配。
//
// ⚠️ **确认（`.pc confirm`）是玩家的动作，代码不替它做**（`.trpg start` 要求全员确认）——
// 模型用 `character` 建的卡也是"未确认"（见 `tools/character.ts`）。那正是这条闸门的意义：
// "卡还没定下来"这件事只有本人说了算。
import { appendLog, findCharacter, mirrorLog } from '../model/campaign.js';
import { MAX_CHARACTERS, MAX_NAME_CHARS } from '../model/limits.js';
import { canJoin, isQq, join, playerOf } from '../model/session.js';
import { rollChargen } from '../rules/chargen.js';
import { renderCharacterForPlayers, renderForPlayer } from '../render/players.js';
import { argsOf } from './shared.js';
import type { CommandHandler } from './shared.js';
import type { JournalPort } from '../model/campaign.js';
import type { TrpgCharacter } from '../types.js';
import type { DiceRng } from '../rules/dice.js';
import type { RuleStore } from '../store/rule-store.js';
import type { TrpgStore } from '../store/campaign-store.js';

/** 新卡的 HP / SAN 起点。`.pc roll`（P4 的 COC7 属性生成）会把它们按公式填上。 */
const NEW_HP = 10;

export interface CharacterCommandDeps {
  store: TrpgStore;
  rules: RuleStore;
  /** 规则层没有默认随机源，`.pc roll` 与工具共用同一个注入点。 */
  rng: DiceRng;
  journal?: JournalPort | null;
  /** 这条命令的词（`'.pc new'` 这样）—— 由 `commands/index.ts` 递进来，见 `argsOf`。 */
  command: string;
}

const USAGE = '这一族管你自己的人物卡：\n'
  + '· `.pc new <角色名>` —— 建一张卡（之后用 DM 给的属性表填值）\n'
  + '· `.pc confirm` —— 确认（全员确认之后 `.trpg start` 才开得了团）\n'
  + '· `.pc show [名字]` —— 看卡（不带名字就是看你自己的）\n'
  + '· `.pc roll` —— 按规则书掷一整套属性（只在这套规则支持时才有）\n'
  + '· `.pc save` —— 显式落盘一次（本来每次写都会落，这条是给人一个凭据）';

export function createCharacterUsageCommand(): CommandHandler {
  return async () => USAGE;
}

/** `.pc new <角色名>` */
export function createCharacterNewCommand({ store, journal, command }: CharacterCommandDeps): CommandHandler {
  return async (input) => {
    const campaign = store.read(input.chatKey);
    if (!campaign) return '这个会话还没有开局 —— 先让谁来敲 `.trpg new <名字>` 起一局。';
    const name = argsOf(input, command).join(' ').slice(0, MAX_NAME_CHARS);
    if (!name) return '用法：`.pc new <角色名>`';
    if (!isQq(input.senderId)) return '拿不到你的 QQ 号 —— 在群里直接敲这条命令。';

    const existing = playerOf(campaign, input.senderId);
    if (existing) {
      return `你已经有一张卡了（${existing.name}）—— `
        + '改它请让主持人用 `character` 改，或者等 `.trpg end` 重开一局。';
    }
    if (findCharacter(campaign, name)) return `已经有叫「${name}」的卡了 —— 换一个名字。`;
    if (campaign.characters.length >= MAX_CHARACTERS) {
      return `这一局的人物卡已经到上限（${MAX_CHARACTERS} 张）—— 让主持人撤掉几个退场的。`;
    }
    // **建卡顺手报名**：不把"报名"与"建卡"分成两步（群友会漏掉前一步，然后卡建好了却不在名单里，
    // 而 `canActivate` 是按名单逐人查的）。名单满了就当场拒 —— 否则这张卡会落进"查不到这个人"
    // 的缝里。
    if (!campaign.players.includes(String(input.senderId))) {
      const verdict = canJoin(campaign, input.senderId);
      if (!verdict.ok) return verdict.reason;
      join(campaign, input.senderId);
    }

    const card: TrpgCharacter = {
      name,
      ownerId: String(input.senderId),
      stats: {},
      hp: NEW_HP,
      hpMax: NEW_HP,
      san: 0,
      sanMax: 0,
      // MP / DB / Build / MOV 是**派生值**（P4）：`.pc roll` 会按规则书的公式填上。
      // 手工建的卡先留 0 —— 渲染按"字段在不在"决定印不印，所以 0 只是"还没有"。
      mp: 0,
      mpMax: 0,
      db: '',
      build: 0,
      mov: 0,
      notes: [],
      discovered: true,
      hidden: [],
      confirmed: false
    };
    campaign.characters.push(card);
    const beforeSeq = campaign.seq;
    appendLog(campaign, 'state', `新建人物卡：${name}（玩家 ${card.ownerId}）`);
    store.write(campaign);
    mirrorLog(campaign, beforeSeq, journal ?? null);

    return `已建卡：「${name}」（HP ${NEW_HP}/${NEW_HP}）。\n`
      + '属性怎么定听主持人的（有的团自己掷、有的团直接给）。定下来之后敲 `.pc confirm` 确认。';
  };
}

/** `.pc confirm` */
export function createCharacterConfirmCommand({ store, journal, command }: CharacterCommandDeps): CommandHandler {
  return async (input) => {
    const campaign = store.read(input.chatKey);
    if (!campaign) return '这个会话还没有开局。';
    if (argsOf(input, command).length) return '用法：`.pc confirm`（不带参数，确认的是你自己的卡）';
    const card = playerOf(campaign, input.senderId);
    if (!card) return '你还没有人物卡 —— 先敲 `.pc new <角色名>`。';
    if (card.confirmed) return `「${card.name}」已经确认过了。`;
    card.confirmed = true;
    const beforeSeq = campaign.seq;
    appendLog(campaign, 'state', `${card.name} 已确认人物卡`);
    store.write(campaign);
    mirrorLog(campaign, beforeSeq, journal ?? null);

    // 顺手报一句"还差谁" —— 那是这条命令之后最该知道的下一步，而群友自己算不出来。
    const pending = campaign.players.filter((qq) => {
      const other = playerOf(campaign, qq);
      return !other || !other.confirmed;
    });
    return `「${card.name}」已确认。`
      + (pending.length
        ? `\n还差：${pending.map((qq) => playerOf(campaign, qq)?.name ?? qq).join('、')}`
        : '\n全员都好了 —— 敲 `.trpg start` 开跑吧。');
  };
}

/**
 * `.pc roll` —— 按规则书掷一整套属性（P4，决策 3）。
 *
 * **只在规则表声明了 `chargen` 时才有** —— 没有那一栏就如实说"这套规则没有属性生成"，
 * 而不是编一套出来（那会让"谁定的属性"变成一笔糊涂账）。
 *
 * **确认之前可以无限重掷**：掷属性本来就是"掷到满意为止"的游戏的一部分，而 `confirmed`
 * 那道闸门保证它只发生在"这张卡还没定下来"的时候。
 */
export function createCharacterRollCommand(deps: CharacterCommandDeps): CommandHandler {
  const { store, rules, rng, journal, command } = deps;
  return async (input) => {
    const campaign = store.read(input.chatKey);
    if (!campaign) return '这个会话还没有开局 —— 先让谁来敲 `.trpg new <名字>` 起一局。';
    if (argsOf(input, command).length) return '用法：`.pc roll`（不带参数）';
    const card = playerOf(campaign, input.senderId);
    if (!card) return '你还没有人物卡 —— 先敲 `.pc new <角色名>`。';
    if (card.confirmed) {
      return `「${card.name}」已经确认过了 —— 想重掷得先让主持人用 \`character\` 改（或者重开一局）。`;
    }

    const lookup = rules.read(campaign.rule);
    if (!lookup.ok) return lookup.message;
    if (!lookup.rule.chargen) {
      return `这一局的规则表（${lookup.rule.id}）没有属性生成 —— 属性由主持人定，`
        + '你可以用 `.st <技能> <值>` 自己填。';
    }

    const rolled = rollChargen(lookup.rule.chargen, rng);
    card.stats = rolled.stats;
    // 派生值：**算出来的才覆盖**（缺属性的那几项留着原样，并由下面那句说明原因）。
    const d = rolled.derived;
    if (d.hpMax !== undefined) { card.hpMax = d.hpMax; card.hp = d.hpMax; }
    if (d.sanMax !== undefined) { card.sanMax = d.sanMax; card.san = d.sanMax; }
    if (d.mpMax !== undefined) { card.mpMax = d.mpMax; card.mp = d.mpMax; }
    if (d.db !== undefined) card.db = d.db;
    if (d.build !== undefined) card.build = d.build;
    if (d.mov !== undefined) card.mov = d.mov;

    const beforeSeq = campaign.seq;
    appendLog(campaign, 'state', `掷属性：${card.name}（${describe(rolled.stats)}）`);
    store.write(campaign);
    mirrorLog(campaign, beforeSeq, journal ?? null);

    const pools = [
      d.hpMax === undefined ? '' : `HP ${card.hpMax}`,
      d.mpMax === undefined ? '' : `MP ${card.mpMax}`,
      d.sanMax === undefined ? '' : `SAN ${card.sanMax}`,
      d.db === undefined ? '' : `DB ${card.db}`,
      d.build === undefined ? '' : `Build ${card.build}`,
      d.mov === undefined ? '' : `MOV ${card.mov}`
    ].filter(Boolean).join('、');
    return [
      `已掷出一套属性（${lookup.rule.name}）：`,
      describe(rolled.stats),
      pools ? `派生：${pools}` : '',
      // **缺属性时明说缺谁**：那意味着规则表里的属性名与派生公式认的名字不一致（改了名），
      // 而不是"算出来是 0"。不说的话没人知道为什么少了那几项。
      rolled.missing.length
        ? `（有几项没算出来：规则表里没有 ${rolled.missing.join('、')} —— 那几项派生值要这几个名字）`
        : '',
      '不满意就再敲一次（确认之前随便重掷）；定下来敲 `.pc confirm`。'
    ].filter(Boolean).join('\n');
  };
}

/** 属性表的一行（`STR 55、CON 60、…`）。顺序即 `stats` 的插入顺序 = 规则文件里的声明顺序。 */
function describe(stats: Record<string, number>): string {
  const parts = Object.entries(stats).map(([key, value]) => `${key} ${value}`);
  return parts.length ? parts.join('、') : '（规则表里没有声明任何属性）';
}

/** `.pc show [名字]` */
export function createCharacterShowCommand({ store, command }: CharacterCommandDeps): CommandHandler {
  return async (input) => {
    const campaign = store.read(input.chatKey);
    if (!campaign) return '这个会话还没有开局。';
    const wanted = argsOf(input, command).join(' ').trim();
    if (!wanted) return renderForPlayer(campaign, input.senderId);

    const card = findCharacter(campaign, wanted);
    if (!card) {
      const names = campaign.characters.filter((item) => item.discovered).map((item) => item.name);
      return `没有叫「${wanted}」的人物卡。`
        + (names.length ? `你见过的是：${names.join('、')}` : '你还没见过任何人。');
    }
    // **没见过的整张不给看**（连名字都只在你敲对了的情况下才确认存在）—— 这是实体级可见度的
    // 判据，与渲染层那份两套投影同源。
    if (!card.discovered && card.ownerId !== String(input.senderId)) {
      return `你还没见过「${wanted}」这个人。`;
    }
    return `${renderCharacterForPlayers(card)}\n（这是玩家视角：被藏起来的字段不显示。）`;
  };
}

/** `.pc save` —— 显式落盘 + 凭据。 */
export function createCharacterSaveCommand({ store, command }: CharacterCommandDeps): CommandHandler {
  return async (input) => {
    if (argsOf(input, command).length) return '用法：`.pc save`（不带参数）';
    const campaign = store.read(input.chatKey);
    if (!campaign) return '这个会话还没有开局 —— 没有东西可存。';
    // 本来每次写就落盘；这一条是给人一个**凭据**（"我刚做的事确实记下来了"）。
    store.write(campaign);
    return `已保存这一局《${campaign.title}》：${campaign.players.length} 位玩家、`
      + `${campaign.characters.length} 张人物卡、${Object.keys(campaign.flags).length} 条旗标、`
      + `${campaign.log.length} 条记录。`;
  };
}
