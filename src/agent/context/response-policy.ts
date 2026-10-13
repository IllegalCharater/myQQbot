// 当前消息响应策略：只判断窗口是否需要响应。
// 不读历史配置、不更新窗口、不组装提示词；调用方必须显式传入最小数据。
//
// 返回的 responseTier 是"这次为什么响应"的编号，只用于会话面板与日志，**没有任何代码
// 按它分支**：0 非档位来源（主动机会 / 转写结果，含义看 reason）、1 被艾特、2 关键词、
// 3 随机、4 全部响应。0 与 1 不受档位闸门约束，2/3 分别要求档位 ≥2/≥3。
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
  // 转写结果是**异步交付**的，不是"谁说了句话"：它必须让模型看到并开口。
  // 不加这条规则，一条只有转写结果的窗口在低档位会被判成"未触发"、静默消费，
  // 模型永远看不到它 —— 用户等了半分钟只等来一片沉默。
  //
  // 位置是刻意的：排在"全部响应"与"被艾特"之后（那两种原因更具体，配了全部响应的
  // 用户仍看到"全部响应"），排在关键词/随机之前（那两个受档位闸门约束，而转写结果
  // 必须在**任何**档位下都触发）。
  //
  // responseTier 用 0：这是"非档位来源"，沿用已有的同类先例 —— wake-scheduler 的
  // 主动机会也是 `{ responseTier: 0, reason: '主动机会', shouldRespond: true }`。
  // 含义由 reason 承载，不往 1–4 的档位词表里塞新数字（UI 会打印"档 N · reason"）。
  //
  // 本规则**不读 roll**：`#resolvePendingResponse` 同时被 scheduleWake（建等待会话前）
  // 与 wake（真正运行前）调用，与骰子无关才能保证两处给出同一个答案。
  if (entries.some((entry) => entry?.kind === 'transcript')) {
    return { responseTier: 0, reason: '转写结果', shouldRespond: true };
  }
  // 漫画下载与转写同属异步回流：原工具调用早已结束，这里若按普通闲聊档位判断，
  // 低档位会把完成事实静默消费，用户只看到“已入队”却收不到完成后的自然回应。
  if (entries.some((entry) => entry?.kind === 'jmcomic-result')) {
    return { responseTier: 0, reason: '漫画下载结果', shouldRespond: true };
  }
  // 图像生成结果同理。注意这里**不是**"让模型去发那张图"——图已经由队列发进群了，
  // 这条规则保证的是"模型有机会补一句话"，而不是"图能发出去"。
  if (entries.some((entry) => entry?.kind === 'image-result')) {
    return { responseTier: 0, reason: '图片生成结果', shouldRespond: true };
  }
  if (tier >= 2 && hitKeyword(texts.join('\n'), policy.keywords)) return { responseTier: 2, reason: '关键词命中', shouldRespond: true };
  const rollValue = Number(roll);
  const randomHit = rollValue < Math.max(0, Math.min(100, Number(policy.randomPercent) || 0));
  if (tier >= 3 && randomHit) return { responseTier: 3, reason: `随机命中(${rollValue.toFixed(0)}%)`, shouldRespond: true };
  return { responseTier: 0, reason: '未触发', shouldRespond: false };
}
