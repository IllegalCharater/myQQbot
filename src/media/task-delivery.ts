// 文件上传与"上传结果核验"的共同助手。
//
// 只服务**非幂等的 `upload_*_file`**：请求一旦发出，超时/断线都不能证明文件没到，
// 所以只能按名字 + 大小去核验，绝不自动重传。群文件与私聊历史是两种查询接口，
// 但匹配规则（名字完全相同、字节数完全相同）和"同名但大小不符要留痕"的判据是一样的。
//
// ⚠️ **只用于文件上传**。出图的图片走 `send_group_msg`，没有群文件列表可按名字核验，
// 它的 `unsent` 是"发送接口没成功"的即时结论 —— 不要为了"统一"把图片塞进这里。
//
// 计时器不在这里：各能力自己的 queue 按 `nextAttemptAt` 排程，这里只提供常量与纯函数。

/** 能发 `upload_*_file` 的最小端口（测试用对象字面量即可）。 */
export interface OneBotFileCallPort {
  call(action: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

export interface FileUploadTarget {
  /** `group` / `private`。 */
  kind: string;
  /** 群号 / QQ 号（字符串或数字都行，内部转 Number）。 */
  chatId: string | number;
  /** 本机文件绝对路径。 */
  file: string;
  /** 群文件里显示的名字（通常是 `<id>.pdf` / `transcription-<id>.txt`）。 */
  name: string;
  /** 上传死线（慢操作，通常 120s 或 30min）。 */
  timeoutMs: number;
}

/** 发一次 `upload_group_file` / `upload_private_file`。返回协议端原始响应。 */
export function uploadFile(port: OneBotFileCallPort, target: FileUploadTarget): Promise<unknown> {
  const action = target.kind === 'group' ? 'upload_group_file' : 'upload_private_file';
  const params = target.kind === 'group'
    ? { group_id: Number(target.chatId), file: target.file, name: target.name }
    : { user_id: Number(target.chatId), file: target.file, name: target.name };
  return port.call(action, params, target.timeoutMs);
}

export interface UploadMatch {
  /** 名字与大小都命中的条目。 */
  found: Record<string, unknown> | null;
  /** 名字命中、但大小不符的条目（**不当作已上传**，只用来解释假阴性）。 */
  sameName: Record<string, unknown> | null;
  /** 列表里一共多少项（`0` / 非列表 = 读不到）。 */
  total: number;
  /** 期望的字节数，供日志对照。 */
  expectedSize: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 在 `get_group_root_files` 的响应里按 名字 + 大小 找目标文件。
 *
 * 返回 `sameName` 是为了**让假阴性可诊断**：同名文件在、但 `file_size` 缺失或口径不同时，
 * 仍然不把它当作"这次传的"（那会把没成功的上传记成 sent），但至少留一条日志 ——
 * 否则"其实在群里"与"确实没传上去"在日志里长得一模一样。
 */
export function matchGroupFile(value: unknown, { name, size }: { name: string; size: number }): UploadMatch {
  if (!isRecord(value) || !Array.isArray(value.files)) throw new Error('群文件列表返回格式无效');
  let sameName: Record<string, unknown> | null = null;
  for (const item of value.files) {
    if (!isRecord(item)) continue;
    const itemName = String(item.file_name ?? item.fileName ?? '');
    if (itemName !== name) continue;
    const itemSize = Number(item.file_size ?? item.fileSize ?? -1);
    if (itemSize === size) return { found: item, sameName: null, total: value.files.length, expectedSize: size };
    sameName ??= item;
  }
  return { found: null, sameName, total: value.files.length, expectedSize: size };
}

/**
 * 在 `get_friend_msg_history` 的响应里按 名字 + 大小 找文件段。
 * 私聊没有"群文件列表"，只能翻消息历史里的 `file` 段。
 */
export function matchPrivateHistory(value: unknown, { name, size }: { name: string; size: number }): Record<string, unknown> | null {
  if (!isRecord(value) || !Array.isArray(value.messages)) throw new Error('好友消息历史返回格式无效');
  for (const message of value.messages) {
    if (!isRecord(message) || !Array.isArray(message.message)) continue;
    for (const segment of message.message) {
      if (!isRecord(segment) || segment.type !== 'file' || !isRecord(segment.data)) continue;
      const data = segment.data;
      const itemName = String(data.name ?? data.file_name ?? data.fileName ?? data.file ?? '');
      const itemSize = Number(data.file_size ?? data.fileSize ?? data.size ?? -1);
      if (itemName === name && itemSize === size) return data;
    }
  }
  return null;
}

/** 文件 id 的宽容读取（不同协议端分别用 `file_id` / `fileId`）。 */
export function responseFileId(value: unknown): string {
  return isRecord(value) ? String(value.file_id ?? value.fileId ?? '') : '';
}

/**
 * 晚到文件的观察窗：正常核验（30s/60s/120s/300s）走完之后，如果文件还没出现，
 * 继续每 5 分钟查一次、最多 1 小时。判据是"非幂等上传可能比客户端死线更晚完成"。
 */
export const LATE_WATCH_INTERVAL_MS = 5 * 60_000;
export const LATE_WATCH_TOTAL_MS = 60 * 60_000;
