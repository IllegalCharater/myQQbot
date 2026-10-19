// 战报的**渲染**（P6）：把 `data/trpg/journal/<会话>.jsonl` 那串条目渲染成一份给人看的 `.md`。
//
// 纯函数、零 I/O —— 落盘与读取在 `store/journal-store.ts`，这里只管"长什么样"。
// 所以它能脱离磁盘被测（同 `scenario/parse.ts` 与 `render/*` 其余几份同一条纪律）。
//
// ── 两条边界 ──
//
// ⚠️ **进到这里的东西已经筛过了**：`mirrorLog` 只把 `visible !== false` 的写进战报
// （见 `TrpgLogEntry.visible`）。**别在这里再筛一遍** —— 再筛一遍就是第二份判据，
// 迟早与第一份漂移（`journal-store.ts` 文件头那句"不必在这里再筛一遍"是同一条）。
//
// ⚠️ **它是给人看的，不是给模型看的**：读它的是群友/管理员，所以
//   ① 不出现任何"给模型的话"（`用 campaign 的 action=…` 之类）；
//   ② 一条日志**一行**（`campaign.log` 的正文本来就按"一条一行"写 —— 见 `formatOrder`）；
//   ③ 类型标签用中文（`[roll]` 那种英文标签是给模型与源码看的）。
import { formatClockTime, todayKey } from '../../../core/util.js';
import type { TrpgLogEntry } from '../types.js';

/**
 * 日志类型 → 中文标签。
 *
 * 认不出来就**原样印那个 kind**（同 `render/format.ts` 的 `GRADE_LABEL` 那条规矩：
 * 不替它编名字）。`kind` 不是封闭枚举，加一种日志不必改这里。
 */
const KIND_LABEL: Record<string, string> = {
  narration: '叙事',
  roll: '掷骰',
  check: '检定',
  state: '状态',
  scene: '场景',
  // P8-c：模型收团那一条。人敲的 `.trpg end` 不落这条。
  ending: '结局'
};

/** `2026-10-17 21:03:12`。两段都取自 `core/util.js` —— 不在跑团这一层另写一份补零逻辑。 */
function stamp(ts: number): string {
  return `${todayKey(ts)} ${formatClockTime(ts)}`;
}

/**
 * 导出时用的文件名：`跑团战报-20261017-2103.md`。
 *
 * 与 `renderJournal` 同住这里，是为了让"这份文件长什么样"（名字 + 正文）只有一处实现 ——
 * 名字里那个时间戳与正文头部那个导出时间是**同一个时刻**，分两处取会差出一秒。
 *
 * ⚠️ 它**不是**一个路径，是 `upload_group_file` 的 `name` 参数（群文件列表里显示的那个名字），
 * 所以不走 `safeFileName` —— 中文正是它该有的样子。
 */
export function journalFileName(ts = Date.now()): string {
  const day = todayKey(ts).replace(/-/g, '');
  const clock = formatClockTime(ts).slice(0, 5).replace(/:/g, '');
  return `跑团战报-${day}-${clock}.md`;
}

/**
 * 一局的**分界行**。
 *
 * `sessionId` 是 `Date.now().toString(36)`（见 `emptyCampaign`），所以能解回开局时刻 ——
 * 但它**也可能是人手改过的任意字符串**，所以解出来的时间要落在合理区间才印，否则只印序号。
 */
function sessionLine(index: number, session: string): string {
  const at = Number.parseInt(session, 36);
  const sane = Number.isFinite(at) && at > 1_577_836_800_000 && at < Date.now() + 86_400_000;
  return `—— 第 ${index} 局${sane ? `（${stamp(at)} 开的）` : ''} ——`;
}

/**
 * 渲染整份战报。
 *
 * `exportedAt` 只是为了让人知道这份文件是什么时候导出的（**不参与内容**，所以它可以被测试
 * 固定住，导出结果的其余部分才是与 journal 逐字一致的判据）。
 *
 * ── 分界行：只在**真的有第二局**时才印（2026-10-19 加）──
 *
 * 战报按**会话** append，而 `.trpg end` 不清它 —— 于是连开两局之后，那份文件里两局的条目
 * 混在一起，`seq` 还是每局从 1 重来的。`TrpgLogEntry.session` 就是那条判据。
 *
 * ⚠️ **单局的输出逐字未变**：只有出现第二个 `session` 时才插一行，所以"只玩过一局"的
 * 导出与加这个功能之前完全一样（旧战报没有 `session` 字段，更是一条都不印）。
 */
export function renderJournal(chatKey: string, entries: readonly TrpgLogEntry[], exportedAt = Date.now()): string {
  const lines: string[] = [
    `# 跑团战报 · ${chatKey}`,
    '',
    `- 导出时间：${stamp(exportedAt)}`,
    `- 条目：${entries.length} 条`,
    '',
    '---',
    ''
  ];
  let current = '';
  let index = 0;
  for (const entry of entries) {
    if (entry.session && entry.session !== current) {
      current = entry.session;
      index += 1;
      // 第一局不印（单局导出与旧版逐字相同）；从第二局起才需要"这里换了一局"这条线索。
      if (index > 1) lines.push('', sessionLine(index, entry.session));
    }
    const label = KIND_LABEL[entry.kind] ?? entry.kind;
    // 正文原样印（它已经过 `MAX_LOG_CHARS` 的截断，见 `appendLog`）—— 这里不做二次加工：
    // 战报的价值就在"逐字"（它是这一局唯一完整的一份记录）。
    lines.push(`${entry.seq} ${formatClockTime(entry.ts)} [${label}] ${entry.text}`);
  }
  // 空战报也要给一份合法文件（不是空串）：头三行本身就说清了"这一局还没发生什么"。
  return `${lines.join('\n')}\n`;
}
