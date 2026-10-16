// 跑团的**运行模式**：一个会话是"骰子助手"还是"DM"（从 `mode.ts` 拆出，2026-10-16）。
//
// ── 为什么是**按会话**的 ──
//
// 与接管本身同一条口径，而想要的正是那个效果：**这个群当骰子机器人、那个群跑团**。
// 全局开关做不到这件事（同一个机器人只能当一种），而模式按会话存下来之后，
// `toolsFor(chatKey)` 与 `prompt(chatKey)` 各自按自己那个会话取到正确的形态 ——
// 那两个回调本来就收 `chatKey`，所以这里不需要动任何跨会话的机制。
//
// ── 两个模式差在哪 ──
//
//   • **`dm`**（缺省）：现在这一整套 —— DM 人格、四个工具、开局/状态/剧本、兜底建议。
//   • **`assistant`**：只掷骰。工具只有 `roll` 与 `say`（见 `spec.ts` 的 `TRPG_ASSISTANT_TOOLS`），
//     **不注入任何人格**（`prompt()` 返回空 body），兜底建议也不跑。
//     判据是"模型看到的与它真能用的必须是同一套东西"：多给一个工具就是给它一次调错的机会。
//
// **本文件只有判据、没有 I/O**：读写在 `store/mode-store.ts`。

export type TrpgMode = 'dm' | 'assistant';

/** 缺省模式。**没记录 = 它**，所以 `write` 回到它时会把那条记录删掉。 */
export const DEFAULT_MODE: TrpgMode = 'dm';

/** 给群友看的名字。命令的回执与帮助都取它，别各写一份。 */
export const MODE_LABEL: Record<TrpgMode, string> = {
  dm: 'DM 模式（跑团，我当主持人）',
  assistant: '助手模式（只掷骰）'
};

/**
 * 群友敲的那个词 → 模式。**取值域显式列出**（同 `.r` 的词法白名单那条）：
 * 认不出来就返回 `null`，由调用方回一句"有哪些可用"，而不是默默当成某一个。
 */
export function parseMode(value: unknown): TrpgMode | null {
  const word = String(value ?? '').trim().toLowerCase();
  if (['助手', '骰子', 'assistant', 'dice'].includes(word)) return 'assistant';
  if (['dm', '主持人', '跑团', 'gm', 'kp'].includes(word)) return 'dm';
  return null;
}

export function isMode(value: unknown): value is TrpgMode {
  return value === 'dm' || value === 'assistant';
}

/** 会话键的形状判据。与 `core/config.ts` 里 `extras.override` 那条**同形**（两处都得守）。 */
const CHAT_KEY = /^(?:group|private):\S+$/;

export function isChatKey(value: unknown): boolean {
  return CHAT_KEY.test(String(value ?? ''));
}

/**
 * `modes.json` 的内容 → 归一化后的表。**坏键、坏值、非对象一律丢掉**（不是抛错：
 * 一个坏文件不该让跑团起不来）。
 *
 * 缺省的那一档**不落盘**：这样"文件里有的"永远是"真的切过的"。
 */
export function normalizeModes(raw: unknown): Record<string, TrpgMode> {
  const out: Record<string, TrpgMode> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [chatKey, mode] of Object.entries(raw as Record<string, unknown>)) {
    if (!isChatKey(chatKey)) continue;
    if (!isMode(mode) || mode === DEFAULT_MODE) continue;
    out[chatKey] = mode;
  }
  return out;
}
