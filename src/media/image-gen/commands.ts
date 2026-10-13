// `/画` 命令的解析与参考图定位。
//
// 这一层是**只读、无副作用**的：把一句话解析成一段画面描述（或抛出一条可执行的用法提示）。
// 真正的出图在 `client.ts` / `queue.ts`，与 `media/transcription/commands.ts` 同一分工。
import { ImageGenError } from './errors.js';

/** 能被当作图生图参考图的条目形状（存档 `MediaEntry` 的最小子集）。 */
export interface ReferenceImageMedia extends Record<string, unknown> { kind: string; url?: string }

/**
 * 从 media 里挑出第一张可用作参考图的图。
 *
 * ⚠️ 判据必须与 `agent/tools/image-gen.ts` 里那一处**同形**：两处是同一个问题的两个入口
 * （`/画` 命令与模型自主调用的 `generate_image`），一边放宽另一边没放，表现就是
 * "命令能跑、工具说没有图片" —— 那种不一致没人会去核对。
 */
export function findReferenceImage(media: ReferenceImageMedia[] = []): string {
  const hit = media.find((item) => item?.kind === 'image'
    && typeof item.url === 'string' && item.url.trim());
  return hit?.url ? hit.url : '';
}

/**
 * 解析 `/画` 命令：返回画面描述，**不是这条命令**时返回 `null`。
 *
 * 认命令要求 `/画` 后面跟空白或直接结束（`/画xx` 不是这条命令），与 `/转写` 同一条判据。
 * 描述为空抛用法提示 —— **这与"不是命令"是两回事**：前者是用户想用但没说画什么，
 * 后者是这条消息压根不归我们管，混成一个返回值会让 ingest 对着普通消息发一句用法提示。
 */
export function parseDrawCommand(text: unknown): string | null {
  const value = String(text ?? '').trim();
  const match = /^\/画(?:\s+([\s\S]+))?$/u.exec(value);
  if (!match) return null;
  const prompt = String(match[1] || '').trim();
  if (!prompt) throw new ImageGenError('validation', 'MISSING_PROMPT', '用法：/画 <画面描述>');
  return prompt;
}
