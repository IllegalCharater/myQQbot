// `character` —— 建卡 / 改卡 / 撤卡（从 `tools.ts` 拆出，2026-10-16）。
//
// 数值一律**增量或回满**，不接受"直接设成某个数"：模型看不到自己算错的时候，而
// `hpDelta: -3` 这种说法既好核对、日志里也读得懂（"HP 10→7"）。
import { err, ok } from '../../../agent/tools/shared.js';
import {
  MAX_CHARACTERS, MAX_NOTES, MAX_POOL, MAX_STATS_PER_CHARACTER, clampInt, text
} from '../model/limits.js';
import { appendLog, findCharacter, mirrorLog } from '../model/campaign.js';
import { changeNote, readHidden, readStats } from './shared.js';
import type { Handler, ToolGates } from './shared.js';
import type { ToolArguments, ToolContext, ToolResult } from '../../../agent/shared/types.js';
import type { TrpgCampaign, TrpgCharacter } from '../types.js';
import type { JournalPort } from '../model/campaign.js';
import type { TrpgStore } from '../store/campaign-store.js';

export interface CharacterHandlerDeps {
  store: TrpgStore;
  gates: ToolGates;
  journal?: JournalPort | null;
}

export function createCharacterHandler({ store, gates, journal }: CharacterHandlerDeps): Handler {
  const { gate, settle, withCampaign } = gates;

  const createCharacter = (ctx: ToolContext, args: ToolArguments, name: string): ToolResult => {
    const campaign = store.read(ctx.chatKey);
    if (!campaign) return err('这个会话还没有开局 —— 先调 campaign（action=start）把这场跑团建起来');
    if (findCharacter(campaign, name)) {
      return err(`已经有「${name}」这张卡了 —— 改它请用 action=update（不要重复建卡）`);
    }
    if (campaign.characters.length >= MAX_CHARACTERS) {
      return err(`人物卡已经到上限（${MAX_CHARACTERS} 张）。先让已经退场的角色用 action=remove 撤掉`);
    }
    // **建卡不过闸门**：同名重复已经被上面那条拦下了，而"给一个新名字建卡"本来就不可能是
    // "重做上一轮的动作"。配额留给"改已有的人"（那里才有重做与一回合连改的问题）。
    const hpMax = clampInt(args?.hpMax, 0, MAX_POOL, 10);
    const sanMax = clampInt(args?.sanMax, 0, MAX_POOL, 0);
    const mpMax = clampInt(args?.mpMax, 0, MAX_POOL, 0);
    const card: TrpgCharacter = {
      name,
      ownerId: /^\d+$/.test(String(args?.ownerId ?? '')) ? String(args.ownerId) : '',
      stats: readStats(args?.stats),
      hp: hpMax,
      hpMax,
      san: sanMax,
      sanMax,
      // DM 可以显式给 MP 上限（COC7 的 MP = POW/5，但它也可以自己定）。
      // DB / Build / MOV 不在这里设：那三个是 `rules/chargen.ts` 按公式算的派生值。
      mp: mpMax,
      mpMax,
      notes: [],
      db: '',
      build: 0,
      mov: 0,
      // schema 里用正面措辞 `visible`（模型更容易填对），内部存的是它的反面。
      discovered: args?.visible !== false,
      hidden: readHidden(args?.hidden),
      // **建出来是"未确认"**：`.pc confirm` 是**玩家**的动作，模型替不了。
      // （DM 那条路的开局本来就是 `active`，所以这不挡它；它只挡"人从 `.trpg new` 起的局"。）
      confirmed: false
    };
    campaign.characters.push(card);
    const beforeSeq = campaign.seq;
    // 这一条的正文里写着"玩家尚未见过"与"隐藏：pools/notes" —— 那是**藏起来的事实**，
    // 所以它不能进战报（战报会被导出成文件发进群，见 `TrpgLogEntry.visible`）。
    appendLog(campaign, 'state', `新建人物卡：${name}（${card.ownerId ? `玩家 ${card.ownerId}` : 'NPC'}）`
      + `${hpMax ? ` HP ${hpMax}` : ''}${sanMax ? ` SAN ${sanMax}` : ''}`
      + `${card.discovered ? '' : '（玩家尚未见过）'}${card.hidden.length ? ` 隐藏：${card.hidden.join('/')}` : ''}`,
      card.discovered && !card.hidden.length);
    store.write(campaign);
    mirrorLog(campaign, beforeSeq, journal ?? null);
    return ok(`已建立「${name}」：HP ${card.hp}/${card.hpMax}、SAN ${card.san}/${card.sanMax}`
      + `${card.mpMax > 0 ? `、MP ${card.mp}/${card.mpMax}` : ''}`
      + `${card.discovered ? '' : '（玩家还没见过这个人）'}。`);
  };

  const updateCharacter = (
    campaign: TrpgCampaign, card: TrpgCharacter, args: ToolArguments
  ): ToolResult => {
    const changes: string[] = [];
    const before = { hp: card.hp, san: card.san, mp: card.mp };
    // 这一条要不要**挡在战报外面**（见 `TrpgLogEntry.visible`）：正文是 `名字：HP 3→0` 这样一串，
    // 判据因此是**逐项**的 —— 改了哪一个字段，就看那张卡把不把它藏着。
    // 卡本身"玩家还没见过"时整条都算藏着的：一个不存在的人身上发生了什么，本身就是秘密。
    let leaked = !card.discovered;
    const hidden = new Set(card.hidden);

    if (args?.hpDelta !== undefined) {
      const delta = clampInt(args.hpDelta, -MAX_POOL, MAX_POOL, 0);
      card.hp = clampInt(card.hp + delta, 0, card.hpMax, card.hp);
    }
    if (args?.sanDelta !== undefined) {
      const delta = clampInt(args.sanDelta, -MAX_POOL, MAX_POOL, 0);
      card.san = clampInt(card.san + delta, 0, card.sanMax, card.san);
    }
    if (args?.mpDelta !== undefined) {
      const delta = clampInt(args.mpDelta, -MAX_POOL, MAX_POOL, 0);
      card.mp = clampInt(card.mp + delta, 0, card.mpMax, card.mp);
    }
    if (args?.full === true) {
      card.hp = card.hpMax;
      card.san = card.sanMax;
      card.mp = card.mpMax;
    }
    if (card.hp !== before.hp) {
      // 刚被打趴时**顺手标一句**（P5）：战斗推进靠"这个人还站不站得住"决定跳过谁
      // （`model/combat.ts` 的 `isMobile`），而日志是 DM 下一轮唯一的凭据 —— 只印
      // `HP 3→0` 的话它得自己推出"所以这个人不占回合了"。
      // ⚠️ **判据必须带 `hpMax > 0`**：`hpMax` 为 0 是"这套规则没有 HP 概念"的合法写法
      // （见 `prompts.ts` 的 `character.hpMax`），那种卡上 `hp` 恒为 0，否则**每一张卡
      // 一建出来就是"倒下"**，而那套规则下的先攻序会当场全灭。
      const downed = card.hpMax > 0 && before.hp > 0 && card.hp === 0 ? '（倒下）' : '';
      changes.push(`HP ${before.hp}→${card.hp}${downed}`);
      if (hidden.has('pools')) leaked = true;
    }
    if (card.san !== before.san) {
      changes.push(`SAN ${before.san}→${card.san}`);
      if (hidden.has('pools')) leaked = true;
    }
    if (card.mp !== before.mp) {
      changes.push(`MP ${before.mp}→${card.mp}`);
      if (hidden.has('pools')) leaked = true;
    }

    if (args?.stats !== undefined) {
      const stats = readStats(args.stats);
      const keys = Object.keys(stats);
      if (!keys.length) return err('stats 是空的 —— 要么给几个「名字: 数值」，要么别传这个参数');
      if (Object.keys(card.stats).length + keys.length > MAX_STATS_PER_CHARACTER) {
        return err(`一张卡的属性/技能最多 ${MAX_STATS_PER_CHARACTER} 项，这一改会超（现在 ${Object.keys(card.stats).length} 项）`);
      }
      Object.assign(card.stats, stats);
      changes.push(`属性：${keys.map((key) => `${key} ${stats[key]}`).join('、')}`);
      if (hidden.has('stats')) leaked = true;
    }

    if (args?.note !== undefined) {
      const note = text(args.note, 160);
      if (note) {
        card.notes.push(note);
        if (card.notes.length > MAX_NOTES) card.notes.splice(0, card.notes.length - MAX_NOTES);
        changes.push(`备注+：${note}`);
        if (hidden.has('notes')) leaked = true;
      }
    }
    if (args?.forget !== undefined) {
      const gone = text(args.forget, 160);
      if (gone) {
        const kept = card.notes.filter((item) => item !== gone);
        if (kept.length !== card.notes.length) {
          card.notes = kept;
          changes.push(`备注-：${gone}`);
          if (hidden.has('notes')) leaked = true;
        }
      }
    }

    // 可见度：`visible: false` 把整张卡藏起来（"这个人玩家还没见过"）；`hidden` 覆盖字段级清单
    // （**给空数组 = 全部可见**，所以判据是"参数在不在"而不是"它真不真"）。
    if (args?.visible !== undefined && (args.visible !== false) !== card.discovered) {
      card.discovered = args.visible !== false;
      changes.push(card.discovered ? '对玩家可见' : '对玩家隐藏（尚未见过）');
      // 改可见度本身就是"藏/露"的记账 —— 两种方向都不进战报：说"对玩家可见"要先说
      // "他本来藏着"（那句话正是秘密），而"隐藏字段：（无）"这种话在玩家眼里就是
      // "这里本来有事"（同 `render/players.ts` 里那条"一条全是问号的旗标本身就是一次泄漏"）。
      leaked = true;
    }
    if (args?.hidden !== undefined) {
      const now = readHidden(args.hidden);
      if (now.join('/') !== card.hidden.join('/')) {
        card.hidden = now;
        changes.push(now.length ? `隐藏字段：${now.join('/')}` : '隐藏字段：（无）');
        leaked = true;
      }
    }

    if (!changes.length) {
      return err('这次调用没有改变任何东西 —— 至少给一个 hpDelta / sanDelta / full / stats / note / forget / visible / hidden');
    }
    appendLog(campaign, 'state', `${card.name}：${changeNote(changes)}`, !leaked);
    // MP 也印（**按"字段在不在"决定**，同 HP/SAN）：漏掉它的话模型刚花掉魔法值却看不见，
    // 下一轮只会看到笔记里没变的那个数，而它没有任何线索。
    return ok(`${card.name} → HP ${card.hp}/${card.hpMax}、SAN ${card.san}/${card.sanMax}`
      + `${card.mpMax > 0 ? `、MP ${card.mp}/${card.mpMax}` : ''}`
      + `${card.notes.length ? `；备注：${card.notes.join('；')}` : ''}`);
  };

  return async (ctx, args) => {
    const action = text(args?.action, 16).toLowerCase();
    const name = text(args?.name, 24);
    if (!name) return err('character 需要 name（人物卡的名字）—— 它是以后引用这张卡的键');
    if (action === 'create') return createCharacter(ctx, args, name);

    return withCampaign(ctx, (campaign) => {
      const card = findCharacter(campaign, name);
      if (!card) {
        const names = campaign.characters.map((c) => c.name).join('、');
        return err(`找不到「${name}」这张卡。`
          + (names ? `现在有：${names}（要新建就用 action=create）` : '现在一张卡都没有，先用 action=create 建卡'));
      }

      // 闸门排在前面：被拒的那一次不落盘、也不进日志。
      const blocked = gate(ctx, {
        tool: `character:${action}`, actor: card.name, args, source: args?.actionSource, quota: true
      });
      if (blocked) return ok(blocked);

      if (action === 'remove') {
        campaign.characters = campaign.characters.filter((c) => c !== card);
        // 名字本身也判：撤掉一张**玩家还没见过**的卡，说出来的正是那个名字（战报会发进群）。
        appendLog(campaign, 'state', `${card.name} 退场（人物卡已移除）`, card.discovered);
        return settle(ctx, `character:${action}`, card.name, args, ok(`已把「${card.name}」移出这场团。`));
      }
      if (action !== 'update') {
        return err(`character 的 action 只能是 create / update / remove，收到「${String(args?.action ?? '')}」`
          + '—— update 里可以一次改多项：hpDelta / sanDelta / full / stats / note / forget / visible / hidden');
      }
      return settle(ctx, `character:${action}`, card.name, args, updateCharacter(campaign, card, args));
    });
  };
}
