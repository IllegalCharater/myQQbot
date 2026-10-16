// 跑团的**运行模式**：一个会话是"骰子助手"还是"DM"。
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
//     人格换成一段"你只做掷骰这一件事"，**不注入清单/剧本/状态**，兜底建议也不跑。
//     判据是"模型看到的与它真能用的必须是同一套东西"：多给一个工具就是给它一次调错的机会。
//
// ── 存在哪 ──
//
// `data/trpg/modes.json` 一个文件装全部会话，形状与 `extras.override` 那套一样
// （键是 `group:<群号>` / `private:<QQ号>`，值是模式名）。**只有非缺省的模式才写进去** ——
// 缺省是 `dm`，所以一份没切过模式的配置里这个文件可以压根不存在。
//
// ⚠️ 与 `TrpgStore` 一样**不做内存缓存**：每次现读这个小文件。它是被 `toolsFor` / `prompt`
// 在**每一轮运行开头**读的，文件只有几百字节；而缓存的代价是"手改了文件不生效"这类
// 只有下次重启才发现的问题（`ScenarioStore` 用 mtime 缓存是为了懒补齐的种子文件，不是这条）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../core/paths.js';

export type TrpgMode = 'dm' | 'assistant';

/** 缺省模式。**没记录 = 它**，所以 `write` 回到它时会把那条记录删掉。 */
export const DEFAULT_MODE: TrpgMode = 'dm';

/** 给群友看的名字。命令的回执与帮助都取它，别各写一份。 */
export const MODE_LABEL: Record<TrpgMode, string> = {
  dm: 'DM 模式（跑团，我当主持人）',
  assistant: '助手模式（只掷骰）'
};

/**
 * 群友敲的那个词 → 模式。**取值域显式列出**（同 `/掷骰` 的词法白名单那条）：
 * 认不出来就返回 `null`，由调用方回一句"有哪些可用"，而不是默默当成某一个。
 */
export function parseMode(value: unknown): TrpgMode | null {
  const word = String(value ?? '').trim().toLowerCase();
  if (['助手', '骰子', 'assistant', 'dice'].includes(word)) return 'assistant';
  if (['dm', '主持人', '跑团', 'gm', 'kp'].includes(word)) return 'dm';
  return null;
}

/** 会话键的形状判据。与 `core/config.ts` 里 `extras.override` 那条**同形**（两处都得守）。 */
const CHAT_KEY = /^(?:group|private):\S+$/;

function isMode(value: unknown): value is TrpgMode {
  return value === 'dm' || value === 'assistant';
}

function normalize(raw: unknown): Record<string, TrpgMode> {
  const out: Record<string, TrpgMode> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [chatKey, mode] of Object.entries(raw as Record<string, unknown>)) {
    if (!CHAT_KEY.test(chatKey)) continue;
    // 缺省的那一档不落盘（见文件头）：这样"文件里有的"永远是"真的切过的"。
    if (!isMode(mode) || mode === DEFAULT_MODE) continue;
    out[chatKey] = mode;
  }
  return out;
}

export class TrpgModeStore {
  readonly file: string;

  constructor(file: string = path.join(DATA_DIR, 'trpg', 'modes.json')) {
    this.file = file;
  }

  /** 这个会话的模式。读不到 / 值不合法 / 键不合法 → **缺省**（不是抛错：一个坏文件不该让跑团起不来）。 */
  read(chatKey: string): TrpgMode {
    if (!CHAT_KEY.test(String(chatKey ?? ''))) return DEFAULT_MODE;
    const mode = this.all()[chatKey];
    return mode ?? DEFAULT_MODE;
  }

  /** 现在有哪些会话被切成非缺省的模式。设置页与排查都靠它。 */
  all(): Record<string, TrpgMode> {
    try {
      return normalize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      return {};
    }
  }

  /** 切模式。传缺省那一档 = **删掉这条记录**（见文件头）。返回落盘后的值。 */
  write(chatKey: string, mode: TrpgMode): TrpgMode {
    const key = String(chatKey ?? '');
    if (!CHAT_KEY.test(key) || !isMode(mode)) return this.read(key);
    const next = this.all();
    if (mode === DEFAULT_MODE) delete next[key];
    else next[key] = mode;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 1), 'utf8');
    fs.renameSync(tmp, this.file);
    return this.read(key);
  }
}
