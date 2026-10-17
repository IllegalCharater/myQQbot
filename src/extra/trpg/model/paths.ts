// **名字 → 安全的标识符**（从 `state.ts` 拆出，2026-10-16）。
//
// 两个函数的判据不同，别合并 —— 见下面各自的文件头。两者都是**纯字符串变换**，
// 所以它们住在 `model/`（这一层不许出现 `node:fs` / `node:path`）：
// 真正拼路径的是 `store/*` 与 `scenario/*`。
import { MAX_SCENARIO_ID_CHARS } from './limits.js';

/**
 * 会话标识 → 文件名里能用的那截。
 *
 * 与 `chat/store.ts` 的 `safeName` **同形但各自一份**：两处落在**不同的目录**里，
 * 彼此不需要一致（`data/messages/group_123.json` 与 `data/trpg/group_123.json` 是两回事），
 * 所以不值得为它去动 core 的路径锚点。判据是"两个东西需不需要互相读得到"，不是"长得像不像"。
 */
export function safeName(chatKey: string): string {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

/**
 * **用户起的名字** → 安全的文件名。中文原样保留。
 *
 * ⚠️ 这与上面那个 `safeName` 是**两件事，别合并**：
 *   • `safeName` 管的是**会话标识**（`group:123` 这种 ASCII 串），它的判据是"与目录里其它
 *     文件平级、不会串台"。它把所有非 ASCII 换成 `_` —— 对 `group:123` 无所谓。
 *   • 本函数管的是**人起的名字**（剧本名、规则表 id）。同一个替换会把 `灯塔` 与 `雨港`
 *     一起变成 `__`，**两个不同的剧本撞成同一个文件** —— 那是数据丢失，不是"名字不好看"。
 *
 * 所以这里只清"当文件名不安全"的东西：Windows 非法字符与控制字符 → 尾随的点与空格
 * （Windows 上 `灯塔.` 与 `灯塔` 是同一个文件，写下去会被重定向）→ 保留字加前缀
 * （`CON` / `PRN` / `AUX` / `NUL` / `COM1..9` / `LPT1..9` 在 Windows 上是设备名，建不出来）。
 * 另外必须挡住 `.` 与 `..`（它们是目录本身与上一层）。
 *
 * 空串 = 这个名字不能当文件名，调用方要拒绝它而不是拿一个默认值顶上（顶上去就成了"用户以为
 * 存了 A、实际存的是别的东西"）。**这一条同时是路径安全的全部依据**：返回值里不可能再有
 * 分隔符或 `..`，所以 `path.join(dir, safeFileName(x))` 一定落在 dir 里。
 *
 * `maxChars` 的缺省是**剧本 id 的上限**（`MAX_SCENARIO_ID_CHARS`，剧本名是本函数的主用途），
 * 规则表那条路自己传 `MAX_RULE_CHARS`。两个数都只有具名的那一份，本文件不写字面量。
 */
export function safeFileName(name: unknown, maxChars = MAX_SCENARIO_ID_CHARS): string {
  const cleaned = String(name ?? '')
    // 路径分隔符与 Windows 非法字符 + 控制字符。`/` 与 `\` 在这里就没了，所以不可能穿目录。
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[. ]+$/, '')       // Windows 不允许尾随的点与空格
    .replace(/^[. ]+/, '')       // 也不允许以点开头（否则 `.` / `..` 与隐藏文件的歧义）
    .trim();
  if (!cleaned) return '';
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned);
  return (reserved ? `_${cleaned}` : cleaned).slice(0, Math.max(1, maxChars));
}
