// 当前消息响应策略：只判断窗口是否需要响应。
// 不读历史配置、不更新窗口、不组装提示词；调用方必须显式传入最小数据。
import type { ChatMessage } from '../../chat/types.js';
import type { ResponseDecision, TriggerContext } from '../shared/types.js';

interface WindowPolicyConfig {
  responseTier: number;
  randomPercent: number;
  keywords: unknown;
}

/** 判断一段消息是否艾特机器人。 */
export function isAtMe(text: unknown, { selfNickname = '', botName = '', selfId = '' }: TriggerContext = {}): boolean {
  const value = String(text ?? '');
  if (!value) return false;
  const nick = String(selfNickname || '').trim();
  const name = String(botName || '').trim();
  if (nick && value.includes(`@${nick}`)) return true;
  if (name && value.includes(`@${name}`)) return true;
  if (selfId) {
    const re = /\[CQ:at(?:,[^\]]*?)?qq=(\d+)[^\]]*\]/g;
    let match;
    while ((match = re.exec(value))) if (String(match[1]) === String(selfId)) return true;
  }
  return false;
}

/** 是否命中关键词（不区分大小写）。 */
export function hitKeyword(text: unknown, keywords: unknown = []): boolean {
  const value = String(text ?? '').toLowerCase();
  if (!value) return false;
  return (Array.isArray(keywords) ? keywords : []).some((item) => {
    const keyword = String(item ?? '').trim().toLowerCase();
    return keyword !== '' && value.includes(keyword);
  });
}

/** 只检查窗口消息并决定是否响应；不计算、不读取任何历史参数。 */
export function evaluateWindowTrigger({ entries, identity = {}, policy, roll }: {
  entries: ChatMessage[];
  identity?: TriggerContext;
  policy: WindowPolicyConfig;
  roll: number;
}): ResponseDecision {
  const rawTier = Number(policy.responseTier);
  const tier = Number.isFinite(rawTier) ? Math.min(4, Math.max(1, Math.round(rawTier))) : 4;
  if (tier >= 4) return { responseTier: 4, reason: '全部响应', shouldRespond: true };

  const texts = entries.map((entry) => String(entry?.text ?? ''));
  if (texts.some((text) => isAtMe(text, identity))) return { responseTier: 1, reason: '被艾特', shouldRespond: true };
  if (tier >= 2 && hitKeyword(texts.join('\n'), policy.keywords)) return { responseTier: 2, reason: '关键词命中', shouldRespond: true };
  const rollValue = Number(roll);
  const randomHit = rollValue < Math.max(0, Math.min(100, Number(policy.randomPercent) || 0));
  if (tier >= 3 && randomHit) return { responseTier: 3, reason: `随机命中(${rollValue.toFixed(0)}%)`, shouldRespond: true };
  return { responseTier: 0, reason: '未触发', shouldRespond: false };
}
