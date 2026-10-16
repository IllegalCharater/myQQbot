// `campaign` —— 开局 / 换场景 / 写旗标 / 揭示（从 `tools.ts` 拆出，2026-10-16）。
//
// 四件事合成一个工具是有意的（见 `spec.ts` 的说明）：它们的参数互不重叠，而工具 schema 是
// 请求前缀的一部分 —— 每多一个工具就打散一次提示词缓存。分支用 `action`，取值域在 schema 里是 `enum`。
import { err, errorMessage, ok } from '../../../agent/tools/shared.js';
import { MAX_FLAGS, text } from '../model/limits.js';
import { appendLog, findCharacter } from '../model/campaign.js';
import { beginCampaign } from '../model/session.js';
import { changeNote } from './shared.js';
import type { Handler, ToolGates, TrpgNote } from './shared.js';
import type { JournalPort } from '../model/campaign.js';
import type { ToolArguments, ToolContext, ToolResult } from '../../../agent/shared/types.js';
import type { RuleStore } from '../store/rule-store.js';
import type { ScenarioStore } from '../store/scenario-store.js';
import type { TrpgStore } from '../store/campaign-store.js';

export interface CampaignHandlerDeps {
  store: TrpgStore;
  rules: RuleStore;
  scenarios: ScenarioStore;
  gates: ToolGates;
  /** 把一条机器条目送进会话（落存档 + 入窗 + 通知面板）。缺省时不做任何事（测试与未接线时）。 */
  deliverNote?: (chatKey: string, note: TrpgNote) => void;
  /** 战报（写侧），透给 `beginCampaign`（开局那条日志也要进战报）。 */
  journal?: JournalPort | null;
}

export function createCampaignHandler(deps: CampaignHandlerDeps): Handler {
  const { store, rules, scenarios, gates, deliverNote, journal } = deps;
  const { gate, withCampaign } = gates;

  const startCampaign = (ctx: ToolContext, args: ToolArguments): ToolResult =>
    beginCampaign(ctx.chatKey, args, { store, rules, scenarios, journal });

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
        text: `群友现在知道了：${learned}。敲「.trpg status」能看到他们此刻的笔记 —— `
          + '在接下来的叙事里自然承接，不要照抄这句话，也不要宣布"笔记已更新"。'
      });
    }
    return result;
  };

  /**
   * 战役本身：开局 / 改场景 / 写旗标 / 揭示玩家本该知道的东西。
   */
  return async (ctx, args) => {
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
  };
}
