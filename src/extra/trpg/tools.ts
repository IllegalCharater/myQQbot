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
//
// ── 行动经济挂在哪 ──
//
// `ledgers`（`WeakMap<ToolContext, ActionLedger>`）：`ctx` 是 `agent-runner` **每次运行新建一个**、
// 整个工具循环共用的对象（`executeTool(toolDefs, ctx, …)`），所以"一个回合 = 一次运行"这条定义
// 由对象生命周期免费给出 —— 运行结束自动清零，不需要清理代码，也不必往 `ToolContext` 里加字段。
//
// ── 为什么全部处理函数都嵌在 `createHandlers` 里 ──
//
// 它们都要 `store` 与那两道闸门（而闸门要 `ctx`、账本按 `ctx` 分组）。提到模块级就得用一个
// 共享的可变对象把当前那一份挂出去 —— 而 `createHandlers` 在测试里会被调用好几次（每次一个
// 临时目录），共享对象会让第 N 次创建的 store 覆盖前面那个。闭包是唯一不会出这个错的写法。
import { normalizeMessageList } from '../../core/util.js';
import { err, errorMessage, ok, recordSent, sentTextEntries } from '../../agent/tools/shared.js';
import { DiceError, rollDice } from './rules/dice.js';
import { resolveCheck } from './rules/check.js';
import { createLedger, consume, recall, remember } from './rules/economy.js';
import { formatCheck, formatRoll } from './render.js';
import {
  MAX_CHARACTERS, MAX_FLAGS, MAX_NOTES, MAX_POOL, MAX_RULE_CHARS, MAX_STAT, MAX_STATS_PER_CHARACTER,
  MIN_STAT, appendLog, clampInt, emptyCampaign, findCharacter, text
} from './state.js';
import { HIDDEN_FIELDS } from './types.js';
import type { ActionLedger } from './rules/economy.js';
import type { DiceRng } from './rules/dice.js';
import type { RuleStore } from './rule-store.js';
import type { ScenarioStore, TrpgScenario } from './scenario.js';
import type { TrpgStore } from './state.js';
import type { HiddenField, TrpgCampaign, TrpgCharacter } from './types.js';
import type { ToolArguments, ToolContext, ToolResult } from '../../agent/shared/types.js';

type Handler = (ctx: ToolContext, args: ToolArguments) => Promise<ToolResult>;

/** 回流条目的形状。**故意很窄**：扩展只说"这是一条什么、正文是什么"，怎么落库是宿主的事。 */
export interface TrpgNote {
  /** `journal` = 玩家视角变了（【跑团笔记】）；`suggest` = 兜底生成的行动建议（【行动建议】）。 */
  kind: 'journal' | 'suggest';
  text: string;
}

/** 组装根递给跑团的口子。 */
export interface TrpgToolDeps {
  store: TrpgStore;
  /** 规则表（从 `data/trpg/rules/` 读，坏表会拒绝而不是静默用别的）。 */
  rules: RuleStore;
  /** 剧本库（从 `data/trpg/scenarios/` 读）。 */
  scenarios: ScenarioStore;
  /** **必填**：规则层没有默认随机源（见 `rules/dice.ts` 的文件头）。生产用 `entropy.ts` 的 `secureRng`。 */
  rng: DiceRng;
  /** 把一条机器条目送进会话（落存档 + 入窗 + 通知面板）。缺省时不做任何事（测试与未接线时）。 */
  deliverNote?: (chatKey: string, note: TrpgNote) => void;
}

export function createHandlers(deps: TrpgToolDeps): Record<string, Handler> {
  const { store, rules, scenarios, rng } = deps;
  const deliverNote = deps.deliverNote;

  /** 每个回合（= 每次 agent 运行）一本账。见文件头那段说明。 */
  const ledgers = new WeakMap<ToolContext, ActionLedger>();
  const ledgerFor = (ctx: ToolContext): ActionLedger => {
    let ledger = ledgers.get(ctx);
    if (!ledger) { ledger = createLedger(); ledgers.set(ctx, ledger); }
    return ledger;
  };

  /**
   * 两道闸门的入口：**同参数去重** + **主行动配额**（`quota` 为真时）。
   *
   * Returns: 拒绝时给回给模型的那句话（空串 = 放行）。
   */
  const gate = (
    ctx: ToolContext,
    { tool, actor, args, source, quota }: {
      tool: string; actor: string; args: ToolArguments; source: unknown; quota: boolean;
    }
  ): string => {
    const declared = text(source, 24);
    const ledger = ledgerFor(ctx);
    // 声明了额外行动来源 = 这是规则允许的另一次行动，同样的参数可以合法地再来一次。
    if (!declared) {
      const reused = recall(ledger, actor, tool, args);
      if (reused) return `这一轮已经做过这件事了，下面是上次的结果：\n${reused}`;
    }
    if (quota) {
      const verdict = consume(ledger, actor, declared);
      if (!verdict.ok) return `⚠ ${verdict.reason}`;
    }
    return '';
  };

  /** 没出错才记进去重表 —— 失败的调用不该让"再来一次"也变成重复。 */
  const settle = (
    ctx: ToolContext, tool: string, actor: string, args: ToolArguments, result: ToolResult
  ): ToolResult => {
    if (!result.isError && typeof result.content === 'string') {
      remember(ledgerFor(ctx), actor, tool, args, result.content);
    }
    return result;
  };

  /**
   * "需要已经开局"的工具共用外壳：读战役 → 跑动作 → **没出错才落盘**。
   *
   * 出错不落盘是有意的：校验失败的请求不该留下任何痕迹（否则一次误调用会在日志里留下
   * 一条"什么也没发生"的记录，而日志是给模型看的上下文）。
   */
  const withCampaign = async (
    ctx: ToolContext,
    run: (campaign: TrpgCampaign) => ToolResult
  ): Promise<ToolResult> => {
    const campaign = store.read(ctx.chatKey);
    if (!campaign) {
      return err('这个会话还没有开局 —— 先调 campaign（action=start）把这场跑团建起来');
    }
    const result = run(campaign);
    if (!result.isError) store.write(campaign);
    return result;
  };

  // ── campaign 的四个 action ──────────────────────────────────────────────────

  const startCampaign = (ctx: ToolContext, args: ToolArguments): ToolResult =>
    beginCampaign(ctx.chatKey, args, { store, rules, scenarios });

  const setScene = (ctx: ToolContext, args: ToolArguments): Promise<ToolResult> => {
    const scene = text(args?.scene, 400);
    if (!scene) return Promise.resolve(err('要换场景就给一个 scene（一句话，比如「废弃灯塔的控制室」）'));
    return withCampaign(ctx, (campaign) => {
      const blocked = gate(ctx, { tool: 'campaign:scene', actor: '场景', args, source: args?.actionSource, quota: true });
      if (blocked) return ok(blocked);
      campaign.scene = scene;
      appendLog(campaign, 'scene', `场景：${scene}`);
      return ok(`场景已更新：${scene}`);
    });
  };

  /**
   * 写旗标。`visible=false` 表示**暗线**：DM 必须推进它，但玩家笔记里不会出现它。
   * 值是空串 = 删掉这个旗标（沿用合并前 `story_update` 的既有语义）。
   */
  const setFlags = (ctx: ToolContext, args: ToolArguments): Promise<ToolResult> => {
    const rawFlags = args?.flags;
    if (!rawFlags || typeof rawFlags !== 'object' || Array.isArray(rawFlags)) {
      return Promise.resolve(
        err('要写旗标就给一个 flags（键值都是字符串，例如 {"已拿到钥匙":"是"}）—— 值给空串表示删掉这个旗标'));
    }
    const visible = args?.visible !== false;
    return withCampaign(ctx, (campaign) => {
      const blocked = gate(ctx, { tool: 'campaign:flag', actor: '旗标', args, source: args?.actionSource, quota: true });
      if (blocked) return ok(blocked);

      const changes: string[] = [];
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
        campaign.flags[label] = { value: body, visible };
        changes.push(`旗标：${label} = ${body}${visible ? '' : '（暗线）'}`);
      }
      if (!changes.length) return err('这次调用没有改变任何东西 —— flags 里的值都是空的');
      appendLog(campaign, 'scene', changeNote(changes));
      return ok(`已更新：${changeNote(changes)}`);
    });
  };

  /**
   * 把藏起来的东西揭示给玩家：人物的**存在**（`discovered`）与它的**字段**（`hidden`），
   * 或者一条**暗线旗标**（`visible`）。
   *
   * 揭示之后**顺手落一条【跑团笔记】回流条目**，正文是"玩家刚刚多知道了什么"。那是这条回流
   * 存在的理由：不落条目的话，模型下一轮看不到"玩家的认知变了"，而它刚刚亲手改过那份认知。
   * 触发点选在 `reveal` 上（而不是"每轮都推一份玩家视角"）是有意的 —— 它确定、稀少、
   * 语义明确，不会变成噪音。
   */
  const reveal = (ctx: ToolContext, args: ToolArguments): Promise<ToolResult> => {
    const name = text(args?.name, 24);
    if (!name) return Promise.resolve(err('要揭示什么就给一个 name：人物卡的名字，或一条旗标的名字'));

    let learned = '';
    const result = withCampaign(ctx, (campaign) => {
      const card = findCharacter(campaign, name);
      if (card) {
        const fields = Array.isArray(args?.fields) ? args.fields : null;
        const revealed: string[] = [];
        if (!card.discovered) { card.discovered = true; revealed.push('这个人以前没人见过'); }
        if (fields) {
          const wanted = new Set(fields.map((item) => text(item, 24).toLowerCase()));
          const dropped = card.hidden.filter((field) => wanted.has(field));
          if (dropped.length) {
            card.hidden = card.hidden.filter((field) => !wanted.has(field));
            revealed.push(`字段 ${dropped.join('/')}`);
          }
        } else if (card.hidden.length) {
          revealed.push(`字段 ${card.hidden.join('/')}`);
          card.hidden = [];
        }
        if (!revealed.length) return ok(`「${card.name}」本来就没有对玩家藏起来的东西。`);
        appendLog(campaign, 'state', `揭示：${card.name}（${revealed.join('；')}）`);
        learned = `「${card.name}」（${revealed.join('；')}）`;
        return ok(`已把「${card.name}」的${revealed.join('；')}揭示给玩家。`
          + '接下来在叙事里自然地承接它 —— 别直接念这份清单。');
      }

      const flag = campaign.flags[name];
      if (flag) {
        if (flag.visible) return ok(`旗标「${name}」本来就是玩家可见的。`);
        flag.visible = true;
        appendLog(campaign, 'state', `揭示暗线：${name} = ${flag.value}`);
        learned = `暗线「${name} = ${flag.value}」`;
        return ok(`暗线「${name}」现在对玩家可见了。接下来在叙事里自然地承接它 —— 别直接念出来。`);
      }

      const names = [...campaign.characters.map((c) => c.name), ...Object.keys(campaign.flags)];
      return err(`没有叫「${name}」的人物卡或旗标。现在有：${names.join('、') || '（什么都没有）'}`);
    });

    // 只在**真的揭示了什么**时才回流（`learned` 非空即"这次调用改变了玩家的认知"）。
    if (learned && deliverNote) {
      deliverNote(ctx.chatKey, {
        kind: 'journal',
        text: `群友现在知道了：${learned}。敲「/跑团」能看到他们此刻的笔记 —— `
          + '在接下来的叙事里自然承接，不要照抄这句话，也不要宣布"笔记已更新"。'
      });
    }
    return result;
  };

  // ── character 的 create / update / remove ───────────────────────────────────

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
    const card: TrpgCharacter = {
      name,
      ownerId: /^\d+$/.test(String(args?.ownerId ?? '')) ? String(args.ownerId) : '',
      stats: readStats(args?.stats),
      hp: hpMax,
      hpMax,
      san: sanMax,
      sanMax,
      notes: [],
      // schema 里用正面措辞 `visible`（模型更容易填对），内部存的是它的反面。
      discovered: args?.visible !== false,
      hidden: readHidden(args?.hidden)
    };
    campaign.characters.push(card);
    appendLog(campaign, 'state', `新建人物卡：${name}（${card.ownerId ? `玩家 ${card.ownerId}` : 'NPC'}）`
      + `${hpMax ? ` HP ${hpMax}` : ''}${sanMax ? ` SAN ${sanMax}` : ''}`
      + `${card.discovered ? '' : '（玩家尚未见过）'}${card.hidden.length ? ` 隐藏：${card.hidden.join('/')}` : ''}`);
    store.write(campaign);
    return ok(`已建立「${name}」：HP ${card.hp}/${card.hpMax}、SAN ${card.san}/${card.sanMax}`
      + `${card.discovered ? '' : '（玩家还没见过这个人）'}。`);
  };

  const updateCharacter = (
    campaign: TrpgCampaign, card: TrpgCharacter, args: ToolArguments
  ): ToolResult => {
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

    // 可见度：`visible: false` 把整张卡藏起来（"这个人玩家还没见过"）；`hidden` 覆盖字段级清单
    // （**给空数组 = 全部可见**，所以判据是"参数在不在"而不是"它真不真"）。
    if (args?.visible !== undefined && (args.visible !== false) !== card.discovered) {
      card.discovered = args.visible !== false;
      changes.push(card.discovered ? '对玩家可见' : '对玩家隐藏（尚未见过）');
    }
    if (args?.hidden !== undefined) {
      const hidden = readHidden(args.hidden);
      if (hidden.join('/') !== card.hidden.join('/')) {
        card.hidden = hidden;
        changes.push(hidden.length ? `隐藏字段：${hidden.join('/')}` : '隐藏字段：（无）');
      }
    }

    if (!changes.length) {
      return err('这次调用没有改变任何东西 —— 至少给一个 hpDelta / sanDelta / full / stats / note / forget / visible / hidden');
    }
    appendLog(campaign, 'state', `${card.name}：${changeNote(changes)}`);
    return ok(`${card.name} → HP ${card.hp}/${card.hpMax}、SAN ${card.san}/${card.sanMax}`
      + `${card.notes.length ? `；备注：${card.notes.join('；')}` : ''}`);
  };

  // ── 对外的那四个工具 ────────────────────────────────────────────────────────

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

    /**
     * 战役本身：开局 / 改场景 / 写旗标 / 揭示玩家本该知道的东西。
     *
     * 四件事合成一个工具是有意的（见 `spec.ts` 的说明）：它们的参数互不重叠，而工具 schema 是
     * 请求前缀的一部分 —— 每多一个工具就打散一次提示词缓存。
     */
    async campaign(ctx, args) {
      try {
        switch (text(args?.action, 16).toLowerCase()) {
          case 'start': return startCampaign(ctx, args);
          case 'scene': return await setScene(ctx, args);
          case 'flag': return await setFlags(ctx, args);
          case 'reveal': return await reveal(ctx, args);
          default:
            return err(`campaign 的 action 只能是 start / scene / flag / reveal，收到「${String(args?.action ?? '')}」`
              + '—— start 开局、scene 换场景、flag 写剧情旗标（含暗线）、reveal 把藏起来的东西揭示给玩家');
        }
      } catch (error) {
        return err(errorMessage(error));
      }
    },

    /**
     * 人物卡：建 / 改 / 撤。
     *
     * 数值一律**增量或回满**，不接受"直接设成某个数"：模型看不到自己算错的时候，而
     * `hpDelta: -3` 这种说法既好核对、日志里也读得懂（"HP 10→7"）。
     */
    async character(ctx, args) {
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
          appendLog(campaign, 'state', `${card.name} 退场（人物卡已移除）`);
          return settle(ctx, `character:${action}`, card.name, args, ok(`已把「${card.name}」移出这场团。`));
        }
        if (action !== 'update') {
          return err(`character 的 action 只能是 create / update / remove，收到「${String(args?.action ?? '')}」`
            + '—— update 里可以一次改多项：hpDelta / sanDelta / full / stats / note / forget / visible / hidden');
        }
        return settle(ctx, `character:${action}`, card.name, args, updateCharacter(campaign, card, args));
      });
    },

    /**
     * 掷骰与检定合成一个工具：**传了 `target` 就是检定**。
     *
     * 两者的机械部分完全一样（解析、掷、算差值），差别只在"要不要对目标值判一档"。
     * 拆成两个工具会让模型在"这次该调哪个"上多一次选择，而选错的代价是白掷一次。
     *
     * **不自动发言** —— 要不要把点数讲给群友由模型决定。
     */
    async roll(ctx, args) {
      const reason = text(args?.reason, 80);
      // `actor` 是"这次判定算谁的行动"（用于配额）；不填就只走去重、不占配额 ——
      // 一轮里为四个人各掷一次察觉是正当的，那是四次不同的判定，不是重做。
      const actor = text(args?.actor, 24);
      // 掷骰放**在**读战役之后：顺序反了的话，没开局的会话会先白掷一次（消耗随机数），
      // 再把"还没开局"回给模型 —— 而它问的是骰子。先答"这个会话能不能掷"，再掷。
      return withCampaign(ctx, (campaign) => {
        // 同参数去重（声明了 actionSource 就放行）：这才是真正拦住"失败后重掷"的那一条 ——
        // 掷骰不改状态，主行动配额管不到它。
        const blocked = gate(ctx, {
          tool: 'roll', actor: actor || '判定', args, source: args?.actionSource, quota: Boolean(actor)
        });
        if (blocked) return ok(blocked);

        // 判据是**参数在不在**（而不是"它是不是一个数"）：目标值非数时要让 `resolveCheck` 抛出它
        // 那句写给模型的文案（"目标值必须是一个数，收到「难」"），而不是在这里悄悄降级成一次掷骰。
        const structured = args?.target !== undefined && args?.target !== null && args?.target !== '';
        let line: string;
        try {
          if (structured) {
            const lookup = rules.read(campaign.rule);
            // 规则表坏了就**拒绝**，不换一套顶上去：静默换一套会让"同一个骰面在两局里判出不同的档"
            // 变成一个没人能解释的现象。代价只是这个会话暂时做不了检定（`/掷骰` 不受影响）。
            if (!lookup.ok) return err(lookup.message);
            line = formatCheck(resolveCheck(args?.expr, args?.target, { rng, rule: lookup.rule }));
          } else {
            line = formatRoll(rollDice(args?.expr, rng));
          }
        } catch (error) {
          return diceError(error);
        }
        const body = `${line}${reason ? `（${reason}）` : ''}`;
        appendLog(campaign, structured ? 'check' : 'roll', body);
        return settle(ctx, 'roll', actor || '判定', args,
          ok(`${body}\n${structured ? '检定' : '掷骰'}不会自动发言：要报给群里就用 say。`));
      });
    }
  };
}

// ── 开局（**两个入口共用一个实现**）─────────────────────────────────────────

export interface BeginDeps {
  store: TrpgStore;
  rules: RuleStore;
  scenarios: ScenarioStore;
}

/**
 * 开一局。**命令与工具走的是这一个函数** —— 两个入口只是取参数的来源不同
 * （`/开局 <剧本> [规则]` vs `campaign action=start`），判据必须是同一套：
 * 已经开过局时怎么拒、剧本读不到时怎么办、规则表坏了怎么办，三处都不许有第二份答案。
 *
 * 剧本注入是**快照**（见 `types.ts` 的 `TrpgCampaign.scenario`）：骨架落进状态、正文复制进存档，
 * 此后与那个剧本文件再无关系。改剧本不该影响正在跑的团。
 */
export function beginCampaign(chatKey: string, args: ToolArguments, deps: BeginDeps): ToolResult {
  const existing = deps.store.read(chatKey);
  if (existing && args?.restart !== true) {
    return err(`这个会话已经有《${existing.title}》在跑了（${existing.characters.length} 张人物卡）。`
      + '改设定用 action=scene/flag、改人用 character；真要推倒重来，把 restart 设成 true'
      + '——那会清掉现有的卡与全部记录，先跟群友说一声');
  }

  // 剧本先读：读不到就**直接拒绝**，别开出一个"标题有了、骨架没有"的半截团。
  const wanted = text(args?.scenario, 40);
  let scenario: TrpgScenario | null = null;
  if (wanted) {
    const found = deps.scenarios.read(wanted);
    if (!found.ok) return err(found.message);
    scenario = found.scenario;
  }

  // 标题：显式给的优先，其次剧本的，最后从文件名兜底（剧本的 title 没写时用的就是它的 id）。
  const title = text(args?.title, 60) || scenario?.title || '';
  if (!title) {
    return err('要给这场团起个名字（title）—— 或者指定一份带标题的剧本（scenario）');
  }

  // 规则：显式给的 > 剧本推荐的 > generic。取表这一步分两种失败，处理不同：
  //   • 引用的表**不存在** → 回落 generic，并把那句 note 原样写进回执（静默回落是本仓库
  //     最忌讳的那类故障："填了、看着生效、实际用的是别的"）；
  //   • 表**本身有问题** → 拒绝开局，把问题报上去让人去修（不是"随便换一套继续跑"）。
  const ruleLookup = deps.rules.read(text(args?.rule, MAX_RULE_CHARS) || scenario?.rule || '');
  if (!ruleLookup.ok) return err(ruleLookup.message);
  const rule = ruleLookup.rule;

  const campaign = emptyCampaign(chatKey, {
    title, system: text(args?.system, 60), rule: rule.id
  });
  campaign.scene = text(args?.scene, 400) || scenario?.scene || '';

  if (scenario) {
    campaign.scenario = { id: scenario.id, body: scenario.body };
    // 骨架落进状态。**预置的在前、同名不覆盖**：将来若支持"往已经跑着的团里补一份剧本"，
    // 场上的事实该赢过纸上的设定。
    campaign.flags = { ...scenario.flags, ...campaign.flags };
    for (const card of scenario.characters) {
      if (!campaign.characters.some((existingCard) => existingCard.name === card.name)) {
        campaign.characters.push(card);
      }
    }
  }

  appendLog(campaign, 'scene',
    `开团：《${campaign.title}》${campaign.system ? `（${campaign.system}）` : ''} ｜ 检定规则：${rule.name}`
    + (scenario
      ? ` ｜ 剧本：${scenario.id}（预置 ${Object.keys(scenario.flags).length} 条旗标、${scenario.characters.length} 张人物卡）`
      : ''));
  deps.store.write(campaign);

  return ok(`《${campaign.title}》已经开局，检定规则表是 ${rule.id}（${rule.name}）。`
    + (scenario
      ? `剧本「${scenario.id}」已注入：` + (scenario.body ? `正文 ${scenario.body.length} 字，` : '没有正文，')
        + `预置 ${Object.keys(scenario.flags).length} 条旗标、${campaign.characters.length} 张人物卡。`
      : '')
    + (ruleLookup.note ? `注意：${ruleLookup.note}。` : '')
    + '接下来用 character 的 action=create 补上玩家角色，然后开始叙事（发言记得用 say）。');
}

// ── 纯助手 ───────────────────────────────────────────────────────────────────
/** 认得出 `DiceError` 就把它的中文文案原样回给模型；别的异常才走通用文案。 */
function diceError(error: unknown): ToolResult {
  if (error instanceof DiceError) return err(error.message);
  return err(errorMessage(error));
}

/** 一张卡的"一行摘要"，用在变更日志里（`阿飞 HP 10→7；备注+：受了刀伤`）。 */
function changeNote(parts: string[]): string {
  return parts.filter(Boolean).join('；');
}

/**
 * 读一组"名字 → 数值"。键去空白、值夹进区间；非对象的输入给空表（调用方会当"没给"处理）。
 *
 * 上限在这里**不查**（那是各调用点的事）：`create` 是"从头建"，
 * `update` 要看"现有的 + 这次的"总数，两者的判据不一样。
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

/**
 * 读字段级可见度。
 *
 * 合法的取值域是 `types.ts` 的 `HIDDEN_FIELDS` —— 认识的那几个之外一律丢弃，
 * 否则模型编一个 `hidden: ["hp"]`（它很可能这么写）会静默不生效，而表现是"藏了、没藏住"。
 * 单值也接受（模型常写 `hidden: "stats"` 而不是数组）。
 */
function readHidden(value: unknown): HiddenField[] {
  const list = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  const out: HiddenField[] = [];
  for (const item of list) {
    const name = text(item, 24).toLowerCase() as HiddenField;
    if ((HIDDEN_FIELDS as readonly string[]).includes(name) && !out.includes(name)) out.push(name);
  }
  return out;
}
