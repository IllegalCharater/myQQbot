// 跑团工具的**实现**（声明在 `spec.ts`，文案在 `extra/prompts.ts`）。
//
// ── 这一层的职责边界 ──
//
// 工具只做三件事：**校验参数 → 改状态 → 把"发生了什么"回给模型**。它**不发言**（`say` 除外 ——
// 它就是发言本身，因为接管模式下内置的 `send_message` 不在表里）。这条与仓库的
// 「工具不得代模型发言」是同一条：掷骰不会自动喊出点数，交不交代是模型自己的判断。
//
// ── "AI 不得直接改状态"这条契约落在哪 ──
//
// 落在**这里**：HP / SAN / 旗标全部由代码钳制（`state.ts` 的上限），模型只能**请求**改动，
// 请求带着"从多少变到多少"进日志。所以它没法在自己的叙述里偷偷把局势改掉 ——
// 叙述与状态之间那条线，是这批工具画的。
import { normalizeMessageList } from '../../core/util.js';
import { err, errorMessage, ok, recordSent, sentTextEntries } from '../../agent/tools/shared.js';
import { DiceError, rollDice } from './rules/dice.js';
import { resolveCheck } from './rules/check.js';
import { formatCheck, formatRoll } from './render.js';
import {
  MAX_CHARACTERS, MAX_FLAGS, MAX_NOTES, MAX_POOL, MAX_STAT, MAX_STATS_PER_CHARACTER,
  MIN_STAT, appendLog, clampInt, emptyCampaign, findCharacter, text
} from './state.js';
import type { ToolArguments, ToolContext, ToolResult } from '../../agent/shared/types.js';
import type { TrpgStore } from './state.js';
import type { TrpgCampaign, TrpgCharacter } from './types.js';

/** 认得出 `DiceError` 就把它的中文文案原样回给模型；别的异常才走通用文案。 */
function diceError(error: unknown): ToolResult {
  if (error instanceof DiceError) return err(error.message);
  return err(errorMessage(error));
}

/**
 * 一张卡的"一行摘要"，用在变更日志里（`阿飞 HP 10→7；备注+：受了刀伤`）。
 * 只写**变了什么**，不把整张卡重印一遍 —— 日志每一行都会进提示词。
 */
function changeNote(parts: string[]): string {
  return parts.filter(Boolean).join('；');
}

export function createHandlers(store: TrpgStore): Record<string, (ctx: ToolContext, args: ToolArguments) => Promise<ToolResult>> {
  /**
   * "需要已经开局"的工具共用外壳：读战役 → 跑动作 → **没出错才落盘**。
   *
   * 出错不落盘是有意的：校验失败的请求不该留下任何痕迹（否则一次误调用会在日志里留下
   * 一条"什么也没发生"的记录，而日志是给模型看的上下文）。
   */
  const withCampaign = async (
    ctx: ToolContext,
    run: (campaign: TrpgCampaign) => ToolResult | Promise<ToolResult>
  ): Promise<ToolResult> => {
    const campaign = store.read(ctx.chatKey);
    if (!campaign) return err('这个会话还没有开局 —— 先调 campaign_start 把这场跑团建起来');
    const result = await run(campaign);
    if (!result.isError) store.write(campaign);
    return result;
  };

  return {
    /**
     * 发言。**接管模式下这是唯一的发言通道**（内置 `send_message` 不在表里），
     * 所以它必须走和内置那条完全一样的路：`sendTextBatch` 发出去 → `recordSent` 记账。
     *
     * ⚠️ **`recordSent` 那一步不能省**：会话的收尾状态（`done` / `noreply`）、协议纠正的
     * `sentExternalAction`、面板的 `sentCount` 三处都读那本账。漏了它的表现是"明明说了话
     * 却被记成没说过，而且模型被追着再发一次"，两样都不报错。
     *
     * 叙事的**记档由代码做**（说了什么就记什么），不另开一个"记日志"的工具 ——
     * 那会给模型一个"我可以说但不记"的口子，而日志正是它下一轮的上下文。
     */
    async say(ctx, args) {
      try {
        const messages = normalizeMessageList(args?.text);
        if (!messages.length) return err('要说的正文是空的（text）');
        const result = await ctx.sender.sendTextBatch(ctx.chatKey, messages, {
          replyToMessageId: args?.replyToMessageId ?? null
        });
        recordSent(ctx, sentTextEntries(result));

        const campaign = store.read(ctx.chatKey);
        if (campaign) {
          for (const line of messages) appendLog(campaign, 'narration', line);
          store.write(campaign);
        }

        const failed = result.failed.length
          ? `（另有 ${result.failed.length} 条没发出去：${result.failed.map((f) => f.error).join('；')}——成功的不必重发）`
          : '';
        return ok(`已发送 ${result.sent.length} 条。${failed}不要输出"已发送"类汇报，接着推进剧情或直接结束。`);
      } catch (error) {
        return err(errorMessage(error));
      }
    },

    /** 开局。`restart: true` 才允许覆盖已有的那一场（**会清掉全部人物卡与记录**）。 */
    async campaign_start(ctx, args) {
      try {
        const existing = store.read(ctx.chatKey);
        if (existing && args?.restart !== true) {
          return err(`这个会话已经有《${existing.title}》在跑了（${existing.characters.length} 张人物卡）。`
            + `改设定用 story_update、改人用 character_update；真要推倒重来，把 restart 设成 true`
            + `——那会清掉现有的卡与全部记录，先跟群友说一声`);
        }
        const title = text(args?.title, 60);
        if (!title) return err('要给这场团起个名字（title）');
        const campaign = emptyCampaign(ctx.chatKey, { title, system: text(args?.system, 60) });
        campaign.scene = text(args?.scene, 400);
        appendLog(campaign, 'scene', `开团：《${campaign.title}》${campaign.system ? `（${campaign.system}）` : ''}`);
        store.write(campaign);
        return ok(`《${campaign.title}》已经开局。`
          + `接下来用 character_create 给玩家和主要 NPC 建卡，然后开始叙事（发言记得用 say）。`);
      } catch (error) {
        return err(errorMessage(error));
      }
    },

    /** 建一张新卡。同名已存在时要它改而不是重建 —— 否则"改谁的血"会变成运气。 */
    async character_create(ctx, args) {
      return withCampaign(ctx, (campaign) => {
        const name = text(args?.name, 24);
        if (!name) return err('人物卡要有名字（name）');
        if (findCharacter(campaign, name)) {
          return err(`已经有「${name}」这张卡了 —— 改它请用 character_update（不要重复建卡）`);
        }
        if (campaign.characters.length >= MAX_CHARACTERS) {
          return err(`人物卡已经到上限（${MAX_CHARACTERS} 张）。先让已经退场的角色用 character_update 的 remove 撤掉`);
        }
        const hpMax = clampInt(args?.hpMax, 0, MAX_POOL, 10);
        const sanMax = clampInt(args?.sanMax, 0, MAX_POOL, 0);
        const card: TrpgCharacter = {
          name,
          ownerId: /^\d+$/.test(String(args?.ownerId ?? '')) ? String(args.ownerId) : '',
          stats: readStats(args?.stats),
          hp: hpMax,
          hpMax,
          san: sanMax,
          sanMax,
          notes: []
        };
        campaign.characters.push(card);
        appendLog(campaign, 'state', `新建人物卡：${name}（${card.ownerId ? `玩家 ${card.ownerId}` : 'NPC'}）`
          + `${hpMax ? ` HP ${hpMax}` : ''}${sanMax ? ` SAN ${sanMax}` : ''}`);
        return ok(`已建立「${name}」：HP ${card.hp}/${card.hpMax}、SAN ${card.san}/${card.sanMax}。`);
      });
    },

    /**
     * 改一张卡：HP / SAN / 属性技能 / 备注，以及"退场"。
     *
     * 数值一律**增量或回满**，不接受"直接设成某个数"：模型看不到自己算错的时候，而
     * `hpDelta: -3` 这种说法既好核对、日志里也读得懂（"HP 10→7"）。
     */
    async character_update(ctx, args) {
      return withCampaign(ctx, (campaign) => {
        const card = findCharacter(campaign, args?.name);
        if (!card) {
          const names = campaign.characters.map((c) => c.name).join('、');
          return err(`找不到「${String(args?.name ?? '')}」这张卡。`
            + (names ? `现在有：${names}（要新建就用 character_create）` : '现在一张卡都没有，先用 character_create 建卡'));
        }

        if (args?.remove === true) {
          campaign.characters = campaign.characters.filter((c) => c !== card);
          appendLog(campaign, 'state', `${card.name} 退场（人物卡已移除）`);
          return ok(`已把「${card.name}」移出这场团。`);
        }

        const changes: string[] = [];
        const before = { hp: card.hp, san: card.san };

        if (args?.hpDelta !== undefined) {
          const delta = clampInt(args.hpDelta, -MAX_POOL, MAX_POOL, 0);
          card.hp = clampInt(card.hp + delta, 0, card.hpMax, card.hp);
        }
        if (args?.sanDelta !== undefined) {
          const delta = clampInt(args.sanDelta, -MAX_POOL, MAX_POOL, 0);
          card.san = clampInt(card.san + delta, 0, card.sanMax, card.san);
        }
        if (args?.full === true) {
          card.hp = card.hpMax;
          card.san = card.sanMax;
        }
        if (card.hp !== before.hp) changes.push(`HP ${before.hp}→${card.hp}`);
        if (card.san !== before.san) changes.push(`SAN ${before.san}→${card.san}`);

        if (args?.stats !== undefined) {
          const stats = readStats(args.stats);
          const keys = Object.keys(stats);
          if (!keys.length) return err('stats 是空的 —— 要么给几个「名字: 数值」，要么别传这个参数');
          if (Object.keys(card.stats).length + keys.length > MAX_STATS_PER_CHARACTER) {
            return err(`一张卡的属性/技能最多 ${MAX_STATS_PER_CHARACTER} 项，这一改会超（现在 ${Object.keys(card.stats).length} 项）`);
          }
          Object.assign(card.stats, stats);
          changes.push(`属性：${keys.map((key) => `${key} ${stats[key]}`).join('、')}`);
        }

        if (args?.note !== undefined) {
          const note = text(args.note, 160);
          if (note) {
            card.notes.push(note);
            if (card.notes.length > MAX_NOTES) card.notes.splice(0, card.notes.length - MAX_NOTES);
            changes.push(`备注+：${note}`);
          }
        }
        if (args?.forget !== undefined) {
          const gone = text(args.forget, 160);
          if (gone) {
            const kept = card.notes.filter((item) => item !== gone);
            if (kept.length !== card.notes.length) {
              card.notes = kept;
              changes.push(`备注-：${gone}`);
            }
          }
        }

        if (!changes.length) {
          return err('这次调用没有改变任何东西 —— 至少给一个 hpDelta / sanDelta / full / stats / note / forget / remove');
        }
        appendLog(campaign, 'state', `${card.name}：${changeNote(changes)}`);
        return ok(`${card.name} → HP ${card.hp}/${card.hpMax}、SAN ${card.san}/${card.sanMax}`
          + `${card.notes.length ? `；备注：${card.notes.join('；')}` : ''}`);
      });
    },

    /** 场景与剧情旗标。旗标值是空串 = **删掉这个旗标**。 */
    async story_update(ctx, args) {
      return withCampaign(ctx, (campaign) => {
        const changes: string[] = [];
        if (args?.scene !== undefined) {
          const scene = text(args.scene, 400);
          if (scene !== campaign.scene) {
            campaign.scene = scene;
            changes.push(`场景：${scene || '（清空）'}`);
          }
        }
        const rawFlags = args?.flags;
        if (rawFlags && typeof rawFlags === 'object' && !Array.isArray(rawFlags)) {
          for (const [key, value] of Object.entries(rawFlags as Record<string, unknown>)) {
            const label = text(key, 24);
            if (!label) continue;
            const body = text(value, 160);
            if (!body) {
              if (label in campaign.flags) {
                delete campaign.flags[label];
                changes.push(`旗标-：${label}`);
              }
              continue;
            }
            if (!(label in campaign.flags) && Object.keys(campaign.flags).length >= MAX_FLAGS) {
              return err(`剧情旗标已经到上限（${MAX_FLAGS} 条），先删掉用不上的`);
            }
            campaign.flags[label] = body;
            changes.push(`旗标：${label} = ${body}`);
          }
        }
        if (!changes.length) {
          return err('这次调用没有改变任何东西 —— 至少给一个 scene 或 flags');
        }
        appendLog(campaign, 'scene', changeNote(changes));
        return ok(`已更新：${changeNote(changes)}`);
      });
    },

    /** 掷骰。**不自动发言** —— 要不要把点数讲给群友由模型决定。 */
    async roll_dice(ctx, args) {
      const reason = text(args?.reason, 80);
      // 掷骰放在 `withCampaign` **里面**：顺序反了的话，没开局的会话会先白掷一次（消耗随机数），
      // 再把"还没开局"回给模型 —— 而它问的是骰子。先答"这个会话能不能掷"，再掷。
      return withCampaign(ctx, (campaign) => {
        let roll;
        try {
          roll = rollDice(args?.expr);
        } catch (error) {
          return diceError(error);
        }
        appendLog(campaign, 'roll', `${formatRoll(roll)}${reason ? `（${reason}）` : ''}`);
        return ok(`${formatRoll(roll)}${reason ? `（${reason}）` : ''}\n掷骰不会自动发言：要报给群里就用 say。`);
      });
    },

    /** 检定（掷一次并对目标值判定）。判定规则来自 `rules/check.ts` 的通用判定。 */
    async skill_check(ctx, args) {
      const reason = text(args?.reason, 80);
      return withCampaign(ctx, (campaign) => {
        let result;
        try {
          result = resolveCheck(args?.expr, args?.target);
        } catch (error) {
          return diceError(error);
        }
        const line = `${formatCheck(result)}${reason ? `（${reason}）` : ''}`;
        appendLog(campaign, 'check', line);
        return ok(`${line}\n检定不会自动发言：要报给群里就用 say。`);
      });
    }
  };
}

/**
 * 读一组"名字 → 数值"。键去空白、值夹进区间；非对象的输入给空表（调用方会当"没给"处理）。
 *
 * 上限在这里**不查**（那是各调用点的事）：`character_create` 是"从头建"，
 * `character_update` 要看"现有的 + 这次的"总数，两者的判据不一样。
 */
function readStats(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const label = text(key, 24);
    if (!label) continue;
    if (Object.keys(out).length >= MAX_STATS_PER_CHARACTER) break;
    out[label] = clampInt(raw, MIN_STAT, MAX_STAT, 0);
  }
  return out;
}
