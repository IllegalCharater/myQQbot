// 跑团扩展 · 行动建议的**兜底生成器**。
//
// ── 它为什么是"兜底"而不是"每轮都跑" ──
//
// 提示词已经要求 DM 自己每轮收尾时给 2-4 个选项（那一次是**零成本**的，它本来就在生成）。
// 只有它整轮**一句话都没说**时才走这里 —— 那正是群里等不到任何回应、最需要给点方向的一刻。
// 判据是**确定性事实**（`session.status === 'noreply'`），不读 DM 的正文：读正文去判断
// "它给没给选项"就是被本仓库否掉的关键词正则复查（见 memory 里的 `tool-invocation-model-judgment`）。
//
// ── 产物去哪 ──
//
// 落一条 `trpg-note`（`kind: 'suggest'`）的**回流条目**，由**下一轮的主 DM 自己用 say 说出来**。
// 这里绝不代它发群：代发的后果实测过 —— 消息进了 `session.sent`，那一轮按"已发送"收尾成 `done`，
// 模型以为群里已经说过了，于是不再开口。与 AGENTS.md 的「工具不得代模型发言」是同一条。
//
// ── 已知缺口（别以为被算进账里了）──
//
// 这一次模型调用的用量**没有进会话的 token 账**：它发生在 `finish()` 之后，而那时会话已经
// 持久化、今日用量也已经累加过了（`SessionRegistry.#persist` → `#bumpTodayUsage`），
// 再跑一次那个累加会**重复计**。所以这里只把用量写进日志（`[trpg] 兜底建议`），
// 账面上少算这几百个 token。要补齐得给 `SessionRegistry` 加一个"只累加增量"的入口，
// 那是它自己的一处设计隐患（`#persist` 对已结束的会话会重复累加），不该由这个扩展顺手改。
import { chatCompletion } from '../../llm/llm.js';
import { EXTRA_PROMPT_JOBS } from '../prompts.js';
import { MAX_LOG_RENDER } from './model/limits.js';
import type { TrpgCampaign } from './types.js';

const MAX_OPTIONS = 4;
const MIN_OPTIONS = 2;
/** 一个选项最多几个字。与 `extra/prompts.ts` 里告诉模型的上限一致（两边都写是有意的：模型偶尔会超）。 */
const MAX_OPTION_CHARS = 25;
/** 生成选项的调用最多等多久。它挂在一次运行收尾的旁路上，卡住不该拖住别的东西。 */
const TIMEOUT_MS = 20000;

/**
 * 只滤掉**明显在说这份清单本身**的行（"以下是几个选项""你可以选择："）。
 *
 * ⚠️ **刻意不做语义过滤**：TRPG-AI-DM 的同名实现把「骰子」「系统」「思考」也写进了黑名单，
 * 于是"用骰子砸他""潜入系统"这类完全正常的选项会被静默吃掉。措辞上的约束归提示词
 * （那里说了不要元描述），代码只负责剥格式。
 */
const META_LINE = /(选项|建议如下|以下几种|可以选择|请选择|你想做什么|行动计划)/;

/**
 * 给模型看的局面摘要。
 *
 * 只用**已经渲染给 DM 的那几样**（场景 / 人物 / 最近的日志），不另建一份世界快照 ——
 * 两份必然漂移，而漂移的表现是"建议基于的局面与 DM 看到的不一样"。
 */
export function suggestionContext(campaign: TrpgCampaign): string {
  const lines: string[] = [`场景：${campaign.scene || '（还没定）'}`];
  if (campaign.characters.length) {
    lines.push('在场的人：', ...campaign.characters.slice(0, 12).map((card) => {
      const pools: string[] = [];
      if (card.hpMax > 0) pools.push(`HP ${card.hp}/${card.hpMax}`);
      if (card.sanMax > 0) pools.push(`SAN ${card.san}/${card.sanMax}`);
      return `- ${card.name}（${card.ownerId ? '玩家' : 'NPC'}）${pools.join(' ')}`;
    }));
  }
  const recent = campaign.log.slice(-MAX_LOG_RENDER);
  if (recent.length) lines.push('最近发生：', ...recent.map((entry) => `- ${entry.text}`));
  return lines.join('\n');
}

/**
 * 生成 2-4 个行动选项。**任何失败都返回空数组**（调用方据此不发条目）——
 * 它是旁路，不该有能力影响主流程；而"发一条空的建议条目"比不发更糟（会白白唤醒一次模型）。
 */
export async function generateSuggestions(campaign: TrpgCampaign): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let content = '';
    try {
      const result = await chatCompletion({
        messages: [
          { role: 'system', content: EXTRA_PROMPT_JOBS.trpg.suggest.system },
          {
            role: 'user',
            content: EXTRA_PROMPT_JOBS.trpg.suggest.user({
              context: suggestionContext(campaign),
              min: MIN_OPTIONS,
              max: MAX_OPTIONS,
              maxOptionChars: MAX_OPTION_CHARS
            })
          }
        ],
        temperature: 0.8,
        signal: controller.signal
      });
      content = String(result.message?.content ?? '');
      const usage = result.usage;
      if (usage) {
        console.log(`[trpg] 兜底建议用量（不进 token 账，见 suggest.ts 头部）：`
          + `prompt=${usage.prompt_tokens ?? 0} completion=${usage.completion_tokens ?? 0}`);
      }
    } finally {
      clearTimeout(timer);
    }
    return parseOptions(content);
  } catch (error) {
    console.warn('[trpg] 兜底建议生成失败（忽略）:', error instanceof Error ? error.message : error);
    return [];
  }
}

/**
 * 从模型输出里取出选项。
 *
 * 三级：先认「- 」这种列点 → 认不出就按行切（模型偶尔不写前缀）→ 还凑不够就放弃。
 * **不做"实在不行就编三条"那种兜底**（TRPG-AI-DM 有）：凭空造的行动与当前局面无关，
 * 而它会被当成真的建议念给群友听。
 */
export function parseOptions(raw: unknown): string[] {
  const text = String(raw ?? '');
  const bulleted = take(text.split('\n').filter((line) => /^\s*[-*•]/.test(line))
    .map((line) => line.replace(/^\s*[-*•]\s*/, '')));
  if (bulleted.length >= MIN_OPTIONS) return bulleted;
  const loose = take(text.split(/[\n；;]+/).filter((line) => !/^\s*[-*•]/.test(line)));
  return loose.length >= MIN_OPTIONS ? loose : [];
}

function take(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const option = line.trim().replace(/^["'“”「」]+|["'“”「」]+$/g, '').slice(0, MAX_OPTION_CHARS);
    if (option.length < 2 || META_LINE.test(option) || out.includes(option)) continue;
    out.push(option);
    if (out.length >= MAX_OPTIONS) break;
  }
  return out;
}
