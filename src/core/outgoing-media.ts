// 出站媒体的**共同形状与文本约定**。
//
// 为什么放在 `core/`：`qq`、`media`、`chat` 同属 T1（`T1_ALLOW` 是空集），三者之间
// **不能互相 import**，而发送队列（qq）、漫画/转写（media）与存档（chat）都要用同一套
// `[文件:…]` / `[语音]` / `[图片]` / `[表情包:…]` 约定。放在 core 是唯一能让三边都 import
// 的位置，且它零依赖、只有纯函数。
//
// 判据：这里是**数据形状 + 文本约定**，不碰任何 I/O、不认识任何具体能力。

/** 出站媒体的种类。`string` 兜底是为了将来的新类型不必先改这里才能发。 */
export type OutgoingMediaKind = 'file' | 'audio' | 'image' | 'sticker';

export interface OutgoingMedia extends Record<string, unknown> {
  kind: OutgoingMediaKind | string;
  /** 文件名 / 表情备注（给人和模型看的那个名字）。 */
  name?: string;
  /** 本机路径（仅当它在发送后仍然有效时才有意义；临时文件不要写）。 */
  file?: string;
  /** 公网地址（表情、结果图等）。 */
  url?: string;
  /** QQ 消息 id / 群文件 id（协议端给了就记）。 */
  fileId?: string;
  /** 字节数（文件/语音）；文本内容按 UTF-8 字节算。 */
  size?: number;
}

/**
 * 出站媒体在存档里的文本形态。
 *
 * **必须与入站占位符同形**（`[文件X]` / `[语音]` / `[图片]`）：模型在【过去状态】里
 * 看到的"自己发过什么"与"别人发过什么"应当是同一种读法。`[文件:name]` 里的冒号是
 * 既有约定（`SendQueue.sendFile` 与 jmcomic 都这么写），不要改。
 */
export function outgoingMediaText(media: OutgoingMedia | null | undefined): string {
  const kind = String(media?.kind ?? '');
  const name = String(media?.name ?? '').trim();
  if (kind === 'file') return name ? `[文件:${name}]` : '[文件]';
  if (kind === 'audio') return '[语音]';
  if (kind === 'image') return '[图片]';
  if (kind === 'sticker') return name ? `[表情包:${name}]` : '[表情包]';
  return `[${kind || '媒体'}]`;
}
