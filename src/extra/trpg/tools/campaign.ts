// `campaign` —— 开局 / 换场景 / 写旗标 / 揭示 / 战斗（从 `tools.ts` 拆出，2026-10-16；P5 加战斗）。
//
// 五件事合成一个工具是有意的（见 `spec.ts` 的说明）：它们的参数互不重叠，而工具 schema 是
// 请求前缀的一部分 —— 每多一个工具就打散一次提示词缓存。分支用 `action`，取值域在 schema 里是 `enum`。
import { err, errorMessage, ok } from '../../../agent/tools/shared.js';
import { MAX_ENDING_KEEPER_CHARS, MAX_ENDING_NAME_CHARS, MAX_FLAGS, text } from '../model/limits.js';
import { appendLog, findCharacter, mirrorLog } from '../model/campaign.js';
import { advanceCombat, currentActor, endCombat, immobileNames, startCombat } from '../model/combat.js';
import { mechanicContextOf, ruleSetFor, sceneMechanics } from '../model/rule-set.js';
import { beginCampaign, campaignSummary } from '../model/session.js';
import { actNumber, actsOf, findAct, firstAct, nextAct, resolveAct } from '../scenario/acts.js';
import { endingsOf, findEnding } from '../scenario/endings.js';
import type { StructEnding } from '../scenario/extract/schema.js';
import { advanceTo, resetAdvance } from '../model/advance.js';
import { explainUnmet, triggerMatches } from '../rules/rule-set.js';
import { describeSceneMechanics, formatInitiative, formatOrder } from '../render/format.js';
import { describeMechanic } from '../rules/rule-set.js';
import { changeNote } from './shared.js';
import type { Handler, ToolGates, TrpgNote } from './shared.js';
import type { JournalPort } from '../model/campaign.js';
import type { DiceRng } from '../rules/dice.js';
import type { ToolArguments, ToolContext, ToolResult } from '../../../agent/shared/types.js';
import type { RuleStore } from '../store/rule-store.js';
import type { ScenarioStore } from '../store/scenario-store.js';
import type { TrpgStore } from '../store/campaign-store.js';
import type { TrpgCampaign } from '../types.js';

export interface CampaignHandlerDeps {
  store: TrpgStore;
  rules: RuleStore;
  scenarios: ScenarioStore;
  /** **必填**：规则层没有默认随机源（见 `rules/dice.ts` 的文件头）。战斗排先攻要用它。 */
  rng: DiceRng;
  gates: ToolGates;
  /** 把一条机器条目送进会话（落存档 + 入窗 + 通知面板）。缺省时不做任何事（测试与未接线时）。 */
  deliverNote?: (chatKey: string, note: TrpgNote) => void;
  /** 战报（写侧），透给 `beginCampaign`（开局那条日志也要进战报）。 */
  journal?: JournalPort | null;
}

export function createCampaignHandler(deps: CampaignHandlerDeps): Handler {
  const { store, rules, scenarios, rng, gates, deliverNote, journal } = deps;
  const { gate, settle, withCampaign } = gates;

  /**
   * 这一局面下**此刻**压着哪些规则（P7-d 的 `campaign` 钩子：换场景与开局各报一次）。
   *
   * 三条边界：
   * - **读不出来时明说一句，不假装很太平**（`sceneMechanics` 给 `null` 就是那个意思）。
   *   正常路径上走不到：`beginCampaign` 已经拒绝过坏扩展，能到这儿只有"有人手改了
   *   `data/trpg/<会话>.json` 里冻结的那份 `ruleExt`"。
   * - **触发详情记日志时标 `visible: false`**：机制名可能来自暗线旗标（`describeTrigger`），
   *   而日志会镜像进战报、战报会被 `.log export` 发进群。
   * - ⚠️ **只在 `campaign` 工具这一侧调**（回执只给模型）。`beginCampaign` 的回执被
   *   `.trpg new` 原样印进群，见 `describeSceneMechanics` 那段说明。
   *
   * 返回空串 = 什么都不用说（也没有写日志，调用方按 `seq` 变没变判断要不要落盘）。
   */
  const sceneNotes = (campaign: TrpgCampaign): string => {
    const hits = sceneMechanics(campaign, rules);
    if (!hits) {
      return '\n（这一局的规则集读不出来 —— 按基础规则表照常跑，但那些特殊机制都没生效）';
    }
    if (!hits.length) return '';
    appendLog(campaign, 'state', `生效机制：${hits.map(describeMechanic).join('；')}`, false);
    return describeSceneMechanics(hits);
  };

  const startCampaign = (ctx: ToolContext, args: ToolArguments): ToolResult => {
    const result = beginCampaign(ctx.chatKey, args, { store, rules, scenarios, journal });
    if (result.isError) return result;
    // 开局也报一次"这一局压着哪些规则"。⚠️ **补在 `beginCampaign` 之外是有意的**：`.trpg new`
    // 把那份回执**原样印进群**，而这一段里的机制名可能带暗线旗标（见 `describeSceneMechanics`）。
    // 代价是这一条路多一次落盘（`beginCampaign` 刚写过），换来的是"人那条路一个字都不多说"。
    const campaign = store.read(ctx.chatKey);
    if (!campaign) return result;
    const beforeSeq = campaign.seq;
    const notes = sceneNotes(campaign);
    // `sceneNotes` 只在真有机制命中时才写日志 —— 所以"要不要落盘"就是"seq 动了没有"。
    if (campaign.seq !== beforeSeq) {
      store.write(campaign);
      mirrorLog(campaign, beforeSeq, journal ?? null);
    }
    return notes ? ok(`${String(result.content)}${notes}`) : result;
  };

  const setScene = (ctx: ToolContext, args: ToolArguments): Promise<ToolResult> => {
    const scene = text(args?.scene, 400);
    if (!scene) return Promise.resolve(err('要换场景就给一个 scene（一句话，比如「废弃灯塔的控制室」）'));
    return withCampaign(ctx, (campaign) => {
      const blocked = gate(ctx, { tool: 'campaign:scene', actor: '场景', args, source: args?.actionSource, quota: true });
      if (blocked) return ok(blocked);
      campaign.scene = scene;
      resetAdvance(campaign, 'scene');
      // ── 分幕推进（P8）──
      //
      // 判据全在 `scenario/acts.ts` 的 `resolveAct`（场景命中 → 当前幕的 exitCondition →
      // 不动）。**模型不需要显式声明换幕**：这是确定性状态，与 HP / 旗标同一条分界。
      //
      // ⚠️ 未知场景**保持当前幕**（不回落第一幕）—— DM 随手写个过场场景不该把进度打回去。
      const acts = actsOf(campaign.scenario.struct);
      const step = resolveAct(acts, campaign.currentAct, scene, mechanicContextOf(campaign, '', ''));
      campaign.currentAct = step.act?.id ?? '';
      if (step.moved && step.act) resetAdvance(campaign, 'act');
      appendLog(campaign, 'scene', `场景：${scene}`);
      if (step.moved && step.act) {
        // 幕名可能属于暗线幕（`visible: false`）—— 那条日志按同一条判据挡在战报外，
        // 否则 `.log export` 会把"第 3 幕：真凶现身"发进群。
        appendLog(campaign, 'state', `进入第 ${actNumber(acts, step.act.id)} 幕：${step.act.name}`, step.act.visible);
      }
      const actNote = step.moved && step.act
        ? `\n进入第 ${actNumber(acts, step.act.id)} 幕：${step.act.name}`
          + '（本幕的目标与完成条件在状态段的【阶段】里）'
        : '';
      // 换场景是**机制最可能变的那一刻**，所以顺手把"现在压着哪些"报一遍 —— 不给的话 DM
      // 得自己从一大段设定里推出"进了灯塔所以要 -20"，而那正是它最容易推错的地方。
      return ok(`场景已更新：${scene}${actNote}${sceneNotes(campaign)}`);
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
      // 这一条要不要**挡在战报外面**（见 `TrpgLogEntry.visible`）。两个来源：
      //   ① 这一批写的就是暗线（`visible: false`）；
      //   ② **删掉**一条暗线 —— 正文里的 `旗标-：真凶是医生` 把那名字说出来了，
      //      而它本来只该在 DM 的记账里。改值那一侧不用单判：暗线改完还是暗线，①已经盖住；
      //      改成明线则是"揭示"，那一刻它本来就该公开（同 `reveal` 那条路）。
      let leaked = !visible;
      for (const [key, value] of Object.entries(rawFlags as Record<string, unknown>)) {
        const label = text(key, 24);
        if (!label) continue;
        const body = text(value, 160);
        if (!body) {
          if (label in campaign.flags) {
            if (campaign.flags[label].visible === false) leaked = true;
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
      resetAdvance(campaign, 'flag');
      appendLog(campaign, 'scene', changeNote(changes), !leaked);
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
        // 揭示暗线 = 玩家的认知变了：旗标指标归零（人物卡的揭示不算 —— 那不改变旗标）。
        resetAdvance(campaign, 'flag');
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
        text: `群友现在知道了：${learned}。敲「.trpg status」能看到他们此刻的笔记 —— `
          + '在接下来的叙事里自然承接，不要照抄这句话，也不要宣布"笔记已更新"。'
      });
    }
    return result;
  };

  /**
   * 战斗段的一行摘要：第几轮、轮到谁。
   *
   * ⚠️ **指针停在倒下的人身上时要明说**：`advance` 会自动跳过他们，但"自动"只在**有人动过**
   * 的时候发生 —— DM 若整轮只在叙事里说"敌人倒了"，指针就会停在那里，而它下一轮看到的状态
   * 里那个人还挂在"轮到"的位置上。这句话是把那件事变成可执行的一步（`sub=next`）。
   */
  const turnLine = (campaign: TrpgCampaign): string => {
    const combat = campaign.combat;
    if (!combat) return '';
    const current = currentActor(combat);
    const downed = immobileNames(campaign, combat).has(current);
    return `第 ${combat.round} 轮，轮到「${current}」${downed ? '（这个人已经倒下了 —— 用 sub=next 跳过）' : ''}。`;
  };

  /**
   * 顺序的紧凑写法（`.combat next` 那一类的回执用；`start` 那一份已经是带数值的编号列表，
   * 不重复印）。
   */
  const orderLine = (campaign: TrpgCampaign): string => {
    const combat = campaign.combat;
    if (!combat) return '';
    return `顺序：${formatOrder(combat.order, immobileNames(campaign, combat))}`;
  };

  /**
   * 战斗：排先攻 / 推进指针 / 收场（P5）。
   *
   * ⚠️ **代码不拦越权行动**（决策 9，知情取舍）：它只管"轮到谁"，不管"这一轮该不该是他" ——
   * 顺序错了不会有任何机制发现，只能靠 DM 照提示词走。所以回执每次都把当前行动者念出来，
   * 让 DM 手里有一个可以对的锚。
   *
   * ⚠️ **`quota: false`**：指针不是任何角色的行动，它是 DM 的记账 —— 而且它还会被角色的行动
   * **自动推进**（`tools/shared.ts` 的 `acted`）。占配额的话，DM 会刚好在"轮到某个人、该给他
   * 记伤害"那一刻被自己的记账锁在门外。去重仍然要有（同一轮里敲两次 `next` 不该走两格），
   * 所以这里**必须调 `settle`** —— 去重的判据正是"上一次的结果被记下来了吗"。
   */
  const combatAction = (ctx: ToolContext, args: ToolArguments): Promise<ToolResult> => {
    const sub = text(args?.sub, 16).toLowerCase();
    if (sub !== 'start' && sub !== 'next' && sub !== 'end') {
      return Promise.resolve(err(`combat 的 sub 只能是 start / next / end，收到「${String(args?.sub ?? '')}」`
        + '—— start 排一次先攻（再排一次 = 重排）、next 轮到下一个人、end 收场'));
    }
    return withCampaign(ctx, (campaign) => {
      const blocked = gate(ctx, {
        tool: 'campaign:combat', actor: '战斗', args, source: args?.actionSource, quota: false
      });
      if (blocked) return ok(blocked);
      const done = (result: ToolResult): ToolResult =>
        settle(ctx, 'campaign:combat', '战斗', args, result);

      if (sub === 'end') {
        if (!endCombat(campaign)) return err('现在没有在进行中的战斗 —— 不用收场。');
        appendLog(campaign, 'state', '战斗结束');
        return done(ok('战斗收场了。接下来照常叙事 —— 要再打就重新排一次先攻。'));
      }

      if (sub === 'next') {
        if (!campaign.combat) return err('现在没有在进行中的战斗 —— 先用 combat（sub=start）排一次先攻。');
        advanceCombat(campaign);
        return done(ok(`轮到下一个了。\n${turnLine(campaign)}\n${orderLine(campaign)}`));
      }

      // sub=start：按规则表声明的属性排先攻。**规则表坏了就拒绝**，不换一套顶上去
      // （与 `roll.ts` 那条逐字同源：静默换一套会让"同一个骰面在两局里判出不同的档"没人能解释）。
      const found = ruleSetFor(campaign, rules);
      if (!found.ok) return err(found.message);
      const key = found.base.initiative;
      const restarted = Boolean(campaign.combat);
      const rolled = startCombat(campaign, { key, rng });
      if (!rolled) {
        return err('没有可以参战的人 —— 先攻序排的是「玩家已经见过、还站着」的人物卡，'
          + '现在一张都没有。先用 character 的 action=create 把在场的人建出来。');
      }
      // 日志里只留**名字顺序**（一行、不印数值）：`appendLog` 的正文会镜像进战报，而战报是
      // 给人看的（P6 的 `.log export` 会把它发进群）。先攻数值就是卡上的属性，
      // 而 `hidden: ['stats']` 存在的理由正是"藏属性" —— 印进日志等于把藏起来的东西写进
      // 一份以后要发给全群的文件里。
      appendLog(campaign, 'state', `先攻（按 ${key}）：${formatOrder(rolled.order)}`);
      const notes: string[] = [];
      if (restarted) notes.push('这次是重排 —— 上一场的指针作废，从第 1 轮重新开始');
      if (rolled.missing.length) {
        notes.push(`${rolled.missing.join('、')} 的卡上没有 ${key}，按 0 参与排序`
          + '（想让他们正常排，就先给卡补上这一项）');
      }
      return done(ok(
        `${restarted ? '已重新排好' : '已排好'}先攻（按卡上的 ${key}）：\n`
        + `${formatInitiative(rolled.order, { scores: rolled.scores })}\n${turnLine(campaign)}`
        + (notes.length ? `\n（${notes.join('；')}）` : '')
      ));
    });
  };

  /**
   * `action=advance` —— **模型主动宣布推进到下一幕**（P8-b）。
   *
   * 三条判据（全部确定性）：
   *   ① 这一局有分幕、且当前不是最后一幕；
   *   ② 当前幕的 `exitCondition` 成立（**`null` 视为无条件**：第一幕或线性模组本来就该能推）；
   *   ③ 不满足时**逐条说出还差什么**（`explainUnmet`）—— 只说"还不能推进"会让模型反复试。
   *
   * ⚠️ **不占主行动配额**（`quota: false`，同 `combat`）：切幕是 DM 的记账，不是角色行动。
   * 去重仍然保留（同一轮连按两次不该走两幕）。
   */
  const advanceAct = (ctx: ToolContext, args: ToolArguments): Promise<ToolResult> =>
    withCampaign(ctx, (campaign) => {
      const blocked = gate(ctx, {
        tool: 'campaign:advance', actor: '幕', args, source: args?.actionSource, quota: false
      });
      if (blocked) return ok(blocked);
      const acts = actsOf(campaign.scenario.struct);
      const current = findAct(acts, campaign.currentAct) ?? firstAct(acts);
      if (!current) return err('这一局没有分幕（剧本里没有 acts）—— 直接叙事就行，不需要切幕');
      const next = nextAct(acts, current.id);
      if (!next) {
        return err(`已经是最后一幕了（第 ${actNumber(acts, current.id)} 幕「${current.name}」）—— 继续把这一幕演完就好`);
      }
      const here = mechanicContextOf(campaign, '', '');
      if (current.exitCondition && !triggerMatches(current.exitCondition, here)) {
        const missing = explainUnmet(current.exitCondition, here);
        return err(`还不能进第 ${actNumber(acts, next.id)} 幕「${next.name}」—— 还差：`
          + `${missing.join('；') || '这一幕的条件还没满足'}`);
      }
      const noCondition = current.exitCondition ? '' : '（这一幕没有完成条件，直接放行）';
      advanceTo(campaign, next);
      return ok(`已推进到第 ${actNumber(acts, next.id)} 幕「${next.name}」${noCondition}。`
        + '本幕的目标与完成条件在状态段的【阶段】里。');
    });

  /**
   * `action=end` —— **模型宣布这一局结束**（P8-c）。
   *
   * 三条判据：
   *   ① 给了 `endingId` → 必须**是剧本里真的有的那一个**（硬约束：不许幻觉），
   *      且它的 `trigger` 成立（不成立就逐条说"还差什么"）；
   *   ② 没给 `endingId` → `reason` 必填（自由结局）；
   *   ③ 通过 → 写 `campaign.ended` 标记 + 落一条 `[ending]` 日志，**把摘要回给模型**。
   *
   * ⚠️ **存档不在这里删**：`withCampaign` 在处理器之后一定还会 `store.write` 一次，
   * 直接 `remove` 会被原地复活（表现为"收团了但下一轮还在"）。真正的删除在
   * `impl.ts` 的 `onRunEnd` —— 那一轮跑完、模型也把结局讲完了才删。
   *
   * ⚠️ **摘要只回给模型，不发群**：发群就是"工具代模型发言"，而且模型还要念 `readAloud`。
   */
  const endAct = (ctx: ToolContext, args: ToolArguments): Promise<ToolResult> => {
    const wanted = text(args?.endingId, MAX_ENDING_NAME_CHARS);
    const reason = text(args?.reason, MAX_ENDING_KEEPER_CHARS);
    return withCampaign(ctx, (campaign) => {
      const blocked = gate(ctx, {
        tool: 'campaign:end', actor: '结局', args, source: args?.actionSource, quota: false
      });
      if (blocked) return ok(blocked);
      const endings = endingsOf(campaign.scenario.struct);
      let ending: StructEnding | null = null;
      if (wanted) {
        ending = findEnding(endings, wanted);
        if (!ending) {
          const list = endings.map((item) => item.name).join('、');
          return err(`没有叫「${wanted}」的结局。这份剧本的结局有：${list || '（一个都没有）'}`);
        }
        const here = mechanicContextOf(campaign, '', '');
        if (ending.trigger && !triggerMatches(ending.trigger, here)) {
          const missing = explainUnmet(ending.trigger, here);
          return err(`还不能宣布「${ending.name}」—— 还差：${missing.join('；') || '条件还没满足'}`);
        }
      } else if (!reason) {
        return err('要收团就给一个 endingId（剧本里的结局），'
          + '或者给一个 reason（一句话说明为什么结束）');
      }
      campaign.ended = { endingId: ending?.id ?? '', reason, at: Date.now() };
      // 战报里那一条：**只有模型收团才有**（人敲 `.trpg end` 不落）。自由结局把 reason 写进去，
      // 好让读战报的人知道"这一局为什么结束"。
      appendLog(campaign, 'ending',
        `结局：${ending ? ending.name : reason || '自由结局'}${ending ? '' : '（自由结局）'}`);
      const summary = campaignSummary(campaign);
      const tail = ending
        ? `把这一段结局讲给群里听 —— 下面是剧本里写的那份，可以按需改写，别照抄：\n${ending.readAloud}`
        : (endings.length
          ? '把收场讲给群里听（这是自由结局，剧本里的结局一个都没用上）。'
          : '把收场讲给群里听。本剧本没有预定义结局，按 reason 收团。');
      return ok(`${summary}\n\n${tail}`);
    });
  };

  /**
   * 战役本身：开局 / 改场景 / 写旗标 / 揭示玩家本该知道的东西 / 战斗 / 推进到下一幕 / 收团。
   */
  return async (ctx, args) => {
    try {
      switch (text(args?.action, 16).toLowerCase()) {
        case 'start': return startCampaign(ctx, args);
        case 'scene': return await setScene(ctx, args);
        case 'flag': return await setFlags(ctx, args);
        case 'reveal': return await reveal(ctx, args);
        case 'combat': return await combatAction(ctx, args);
        case 'advance': return await advanceAct(ctx, args);
        case 'end': return await endAct(ctx, args);
        default:
          return err(`campaign 的 action 只能是 start / scene / flag / reveal / combat / advance / end，收到「${String(args?.action ?? '')}」`
            + '—— start 开局、scene 换场景、flag 写剧情旗标（含暗线）、reveal 把藏起来的东西揭示给玩家、'
            + 'combat 排先攻与推进战斗回合（用 sub 选 start / next / end）、'
            + 'advance 推进到下一幕（只在剧本分了幕、且本幕的完成条件已满足时才行）、'
            + 'end 收团（给 endingId 就走剧本里的结局，不给就带 reason 自由收场）');
      }
    } catch (error) {
      return err(errorMessage(error));
    }
  };
}
