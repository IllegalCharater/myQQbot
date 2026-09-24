// 表情包体系（移植自原版 sticker-lib.js）：本地表情知识库 + 搜索 + 提示词摘要。
// QQ 收藏表情（SnowLuma fetch_custom_face_detail）是"源"，本地库是 AI 认知层。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const STICKER_FILE = path.join(DATA_DIR, 'stickers.json');

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeStickerEntry(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const id = String(entry.id || entry.emoji_id || entry.resId || '').trim();
  if (!id) return null;
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 20)
    : [];
  return {
    id,
    resId: String(entry.resId || entry.emoji_id || id).trim(),
    url: String(entry.url || '').trim(),
    md5: String(entry.md5 || '').trim().toUpperCase(),
    desc: String(entry.desc ?? '').trim(),
    localNote: String(entry.localNote ?? '').trim(),
    tags,
    usage: String(entry.usage ?? '').trim(),
    source: entry.source === 'manual' ? 'manual' : (entry.source === 'ai' ? 'ai' : 'qq'),
    useCount: Math.max(0, Number(entry.useCount) || 0),
    lastUsedAt: Number(entry.lastUsedAt) || 0,
    lastContext: String(entry.lastContext ?? '').slice(0, 200),
    createdAt: String(entry.createdAt || nowIso()),
    updatedAt: String(entry.updatedAt || nowIso()),
    // 本地缓存图片的文件名（见 sticker-cache.js）。
    // ⚠️ 这个白名单是**写死的**：任何新字段不加进来，一次 load/save 往返就被静默丢掉，
    // 表现为"缓存明明写了却永远查不到"。新增字段时务必同时改这里。
    cacheFile: String(entry.cacheFile || '').trim(),
    cachedAt: String(entry.cachedAt || '').trim()
  };
}

export function loadStickerStore(file = STICKER_FILE) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeStickerEntry).filter(Boolean);
  } catch {
    return [];
  }
}

export function saveStickerStore(entries, file = STICKER_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function mergeStickerLibrary(existing, fetched) {
  const out = existing.map(normalizeStickerEntry).filter(Boolean);
  const byId = new Map(out.map((e) => [e.id, e]));
  const fetchedIds = new Set();
  for (const item of Array.isArray(fetched) ? fetched : []) {
    const id = String(item?.emoji_id || item?.resId || item?.id || '').trim();
    if (id) fetchedIds.add(id);
  }
  for (const item of Array.isArray(fetched) ? fetched : []) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.emoji_id || item.resId || item.id || '').trim();
    if (!id) continue;
    const old = byId.get(id);
    const merged = normalizeStickerEntry({
      ...(old || {}),
      id,
      resId: String(item.resId || item.emoji_id || id).trim(),
      url: String(item.url || old?.url || '').trim(),
      md5: String(item.md5 || old?.md5 || '').trim().toUpperCase(),
      desc: String(item.desc ?? old?.desc ?? '').trim(),
      localNote: old?.localNote || '',
      tags: old?.tags || [],
      usage: old?.usage || '',
      source: old?.source || 'qq',
      useCount: old?.useCount || 0,
      lastUsedAt: old?.lastUsedAt || 0,
      lastContext: old?.lastContext || '',
      createdAt: old?.createdAt || nowIso(),
      updatedAt: nowIso(),
      // 缓存文件跟着条目走。url 换了也不在这里失效：bot 自己收的 url 根本不会变，
      // 真变了说明是同 id 换了内容，那该由收藏路径去处理，合并这边不猜。
      cacheFile: old?.cacheFile || '',
      cachedAt: old?.cachedAt || ''
    });
    if (!merged) continue;
    if (!byId.has(id)) {
      out.push(merged);
      byId.set(id, merged);
    } else {
      const idx = out.findIndex((e) => e.id === id);
      if (idx >= 0) out[idx] = merged;
    }
  }
  return out.filter((e) => e.source !== 'qq' || fetchedIds.has(e.id));
}

export function findSticker(entries, ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  const md5 = raw.toUpperCase();
  // URL 只做"看起来像 URL（带 / ）"的匹配：否则一个纯标签（库里的 desc 就有 "9"、"AA"
  // 这种）会先被 URL 子串命中，静默指到别的表情上，比报错更糟。
  const wantUrl = raw.includes('/');
  const urlNormalized = raw.replace(/\/+$/, '').replace(/^https?:\/\//i, '');
  return (Array.isArray(entries) ? entries : []).find((e) => {
    if (!e) return false;
    if (e.id === raw || e.resId === raw) return true;
    if (e.md5 && e.md5 === md5) return true;
    if (!wantUrl) return false;
    const eUrl = String(e.url || '').replace(/\/+$/, '').replace(/^https?:\/\//i, '');
    if (eUrl && urlNormalized && (eUrl === urlNormalized || eUrl.includes(urlNormalized) || urlNormalized.includes(eUrl))) return true;
    return false;
  }) || null;
}

/**
 * 按"人话标签"找表情：desc / localNote / usage / tags 全等命中（大小写与首尾空白不敏感）。
 * 提示词里的【可用表情包】只给标签不给 id，模型手上唯一的"源"就是标签 —— 这里认它，
 * 那个参数才不是无源之水。全等而非子串：子串会让"可爱"匹配一大片，歧义直接爆掉。
 */
export function matchStickerLabel(entries, ref) {
  const raw = String(ref ?? '').trim().toLowerCase();
  if (!raw) return [];
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  return list.filter((e) => {
    const fields = [e.desc, e.localNote, e.usage, ...(e.tags || [])];
    return fields.some((v) => {
      const s = String(v ?? '').trim().toLowerCase();
      return s !== '' && s === raw;
    });
  });
}

/**
 * 把【可用表情包】里渲染出来的那一整行还原成可寻址的候选串（按可信度排序）。
 *
 * 模型手上最常见的东西就是那一整行（`- （未标注）id=collected_123 [搞笑]（用过3次）`），
 * 它经常就这么原样粘回来，所以这里把渲染加上去的装饰一层层剥掉。
 * 剥不干净也不要紧：resolveStickerRef 会把候选逐个试过去。
 */
export function cleanStickerRef(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  const out = [];
  const push = (v) => {
    const t = String(v ?? '').trim();
    if (t && !out.includes(t)) out.push(t);
  };
  // 1) 行内的 id=xxx 是最强信号（菜单里就是这么给的）。要求它自成一段 ——
  //    否则一个带 "?id=" 的图床地址会被当成 id 抽出来，越认越歪。
  //    ⚠️ "自成一段"不能写成"前面是空白"：菜单渲染出来的是 `- （未标注）id=collected_-1`，
  //    那个 id= 前面是右括号而不是空格，按空白判会整行漏掉未标注的条目 ——
  //    而"把菜单那一行粘回来"恰恰是模型最常做的事。所以这里排除的是 URL/标识符字符。
  const m = /(?:^|[^\w/?&=%.-])id=([^\s]+)/.exec(s);
  if (m) push(m[1]);
  // 2) 剥掉渲染加上去的装饰：列表符号 `- `、`（未标注）` 标记、`（QQ 名：xxx）`、
  //    尾部 `（用过N次）`、以及**前面带空白的** ` [a/b/c]`。
  //    要求括号前有空白，是因为备注本身可能就叫 `[doge]`（QQ 收藏里真有这种），
  //    无差别剥括号会把这种备注直接吃掉。
  const label = s.replace(/^-\s*/, '')
    .replace(/^[（(]未标注[）)]\s*/, '')
    .replace(/[（(]\s*(?:QQ\s*名|名称|原名)\s*[:：][^）)]*[）)]/g, ' ')
    .replace(/[（(]用过\d+次[）)]\s*$/, '')
    .replace(/\s+\[[^\[\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (label) push(label);
  // 3) 原串兜底：万一剥过头，至少还把原文试一次。绝不因为清理而丢掉用户的输入。
  push(s);
  return out;
}

/**
 * 解析一个表情引用：先按 id/resId/md5/url 精确认，认不出来再按标签（全等）认。
 *
 * 这是 sticker_note / send_sticker / get_sticker_image **共用**的解析器 ——
 * "先标记、再按标签挑"这条闭环能成立，靠的就是三处认的是同一套东西：
 * 一个标签在 sticker_note 里认得出，在 send_sticker 里就必须同样认得出。
 *
 * 标签命中多个时**不猜**（改错备注、发错表情都比不作声更糟），返回 ambiguous 让调用方报错。
 * 返回 { entry, ambiguous }：唯一命中时 entry 有值；多命中时 entry 为 null、ambiguous 是候选数组。
 */
export function resolveStickerRef(entries, ref) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  let ambiguous = [];
  for (const candidate of cleanStickerRef(ref)) {
    const exact = findSticker(list, candidate);
    if (exact) return { entry: exact, ambiguous: [] };
    const matches = matchStickerLabel(list, candidate);
    if (matches.length === 1) return { entry: matches[0], ambiguous: [] };
    if (matches.length > 1 && !ambiguous.length) ambiguous = matches;
  }
  return { entry: null, ambiguous };
}

/**
 * 从本地库删掉一条表情。
 *
 * **只用 findSticker 精确匹配，不做标签兜底** —— 与 applyStickerNote 的关键区别。
 * 改错备注可以再改回来，删错条目删掉的可能是别人偷来的图：不可逆的操作宁可失败也不猜。
 *
 * ⚠️ source === 'qq' 的条目删了也会回来：mergeStickerLibrary 结尾会把"还在 QQ 收藏里"
 * 的条目重新并进来。这个判断留给调用方（HTTP 层要回一句人话的 409），纯函数只管删。
 */
export function removeSticker(entries, ref) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, ref);
  if (!target) return { entries: list, removed: null };
  return { entries: list.filter((e) => e.id !== target.id), removed: target };
}

/**
 * 「bot 自己收藏的最多留几个」该删哪些（纯策略，不碰磁盘；文件由调用方按 drop 列表删）。
 *
 * 三条边界：
 *   1. 只动 source !== 'qq' 的条目 —— QQ 收藏是"源"，本地删了下次同步就并回来，
 *      所以它们既不算进上限、也一条都不删。
 *   2. 排序是"使用频率升序，同频率按保存时间升序"，从头开始删：频率最低的、
 *      其中保存最早的先走，正是用户要的「删除使用频率最低保存时间最早的表情包」。
 *   3. cap 非有限或 ≤0 = 不限（与 digest.maxKeepChars / store.keepSessionFiles 同一惯例：
 *      默认值绝不能是"删用户数据"）。
 *
 * 顺带一个副作用是好的：刚收藏的那条 useCount 为 0、createdAt 最新，在零使用那一组里
 * 排最后 —— 超出一条时被删的永远是更早的那条，不会"刚收就被删"。
 */
export function selectEvictions(entries, cap) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const n = Number(cap);
  if (!Number.isFinite(n) || n <= 0) return { keep: list, drop: [] };
  const owned = list.filter((e) => e.source !== 'qq');
  if (owned.length <= n) return { keep: list, drop: [] };
  const sorted = [...owned].sort((a, b) =>
    (a.useCount || 0) - (b.useCount || 0)
    || (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
  const drop = sorted.slice(0, owned.length - n);
  const dropIds = new Set(drop.map((e) => e.id));
  return { keep: list.filter((e) => !dropIds.has(e.id)), drop };
}

/**
 * 管理页用的完整列表：比 formatStickerList 多带 url / usage / source / 使用统计。
 *
 * 单独一个函数而不给 formatStickerList 加开关：那个是给 list_stickers **工具**吃的，
 * 返回体积直接进模型上下文，不能顺手变大。
 */
export function formatStickerAdminList(entries, query = '', limit = 500) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const q = String(query ?? '').trim().toLowerCase();
  const filtered = q
    ? list.filter((e) => {
        const haystack = [e.desc, e.localNote, e.usage, e.id, e.resId, e.md5, ...(e.tags || [])].join(' ').toLowerCase();
        return haystack.includes(q);
      })
    : list;
  const max = Math.max(1, Math.min(500, Number(limit) || 500));
  const items = filtered.slice(0, max).map((e) => ({
    id: e.id,
    url: e.url || '',
    desc: e.desc || '',
    localNote: e.localNote || '',
    tags: e.tags || [],
    usage: e.usage || '',
    source: e.source || 'qq',
    useCount: e.useCount || 0,
    lastUsedAt: e.lastUsedAt || 0,
    createdAt: e.createdAt || '',
    // 让前端不必自己判断"这个能不能删"：QQ 收藏是源，删了下次同步就回来
    deletable: e.source !== 'qq',
    // 图已经落到本地缓存里了（发送时给协议端的是本机路径，不再看图床脸色）
    cached: !!e.cacheFile
  }));
  return {
    total: list.length,
    // bot 自己收藏的条数（= 受 sticker.maxKeepCount 管的那一批），面板要拿它跟上限比
    owned: list.filter((e) => e.source !== 'qq').length,
    matched: filtered.length,
    truncated: filtered.length > max,
    stickers: items
  };
}

export function formatStickerList(entries, query = '', limit = 48) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const q = String(query ?? '').trim().toLowerCase();
  const filtered = q
    ? list.filter((e) => {
        const haystack = [e.desc, e.localNote, e.usage, e.id, e.resId, e.md5, ...(e.tags || [])].join(' ').toLowerCase();
        return haystack.includes(q);
      })
    : list;
  const max = Math.max(1, Math.min(500, Number(limit) || 48));
  const items = filtered.slice(0, max).map((e) => ({
    id: e.id,
    desc: e.desc || '',
    localNote: e.localNote || '',
    tags: e.tags || [],
    useCount: e.useCount || 0
  }));
  return { total: list.length, matched: filtered.length, truncated: filtered.length > max, stickers: items };
}

/**
 * 提示词里的【可用表情包】摘要（不暴露完整 URL，控制上下文体积）。
 *
 * **未标注的条目要带上 id=**。模型手上唯一能寻址的东西就是这里给的东西：它看得见标签，
 * 而工具要的是 id。"先标记、再按标签挑"这条闭环要求未标注的那批能被点出来 ——
 * 不然它们永远没机会被标注，也就永远进不了菜单（这正是之前 send_sticker 失败的根因之一）。
 * 已经有备注的不带 id：它们按标签就认得出（matchStickerLabel），每行省下的十几个字
 * 在这个每轮都注入的段里是要紧的。
 *
 * 未标注的排在最前，但**最多 3 个**：一库没标注的图会把这几行全占满，把能直接用的
 * 表情挤出菜单。段头里报"还剩几个没标注"，让它在后续轮次里继续推进。
 */
/**
 * 拼【可用表情包】段（模型挑表情时的唯一菜单）。
 *
 * 一条表情算不算"bot 标注过"看的是 **localNote**（bot 自己记下的意思），不是"有没有名字"：
 * QQ 收藏一同步进来就带着 QQ 给的名字（desc 由 fetch_custom_face_detail 提供），
 * 但 bot 从没看过它、不知道什么场合能用 —— 按"有名字就算标注过"会把这一大批整个漏出
 * "待标注"那一队，而它们恰恰是最该标的一批。所以两种来源一视同仁：
 * 只要 bot 还没记过它的意思，就带 id= 出现在菜单里、请它先看图再标注。
 *
 * 已标注的照旧只给标签（不带 id，省 token）；未标注的带 id=、并把已有的名字一起带着，
 * 免得"还没标注"反而比"有名字"更难用。
 */
export function buildStickerContext(entries, max = 10) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  if (!list.length) return '';
  const limit = Math.max(1, Math.min(30, Number(max) || 10));
  const FRESH_QUOTA = 3;   // 一轮最多推几个"待标注"的（与策略段里"一轮最多标 3 个"对齐）
  const needNote = (e) => !e.localNote;
  // 待标注的：用得多的先标（用得越频繁越值得知道它是什么意思），同频率里新收的优先
  const fresh = list.filter(needNote)
    .sort((a, b) => (b.useCount || 0) - (a.useCount || 0)
      || (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
    .slice(0, Math.min(FRESH_QUOTA, limit));
  const freshIds = new Set(fresh.map((e) => e.id));
  // 剩下的位置**不按"标没标注"锯开**，一律按使用次数排：否则一个还没标过几个的库会被
  // 饿成三行，bot 反而没得挑 —— 名字（desc）本来就够它大致判断，缺的只是"按意思精确挑"。
  const rest = list.filter((e) => !freshIds.has(e.id))
    .sort((a, b) => (b.useCount || 0) - (a.useCount || 0))
    .slice(0, Math.max(0, limit - fresh.length));
  const lines = [...fresh, ...rest].map((e) => {
    const extra = e.tags?.length ? ` [${e.tags.join('/')}]` : '';
    const used = e.useCount ? `（用过${e.useCount}次）` : '';
    if (e.localNote) return `- ${e.desc || e.localNote}${extra}${used}`;
    // ⚠️ id= 后面必须跟空格：cleanStickerRef 按 `[^\s]+` 取值，名字紧挨着会被一起吞进 id
    const name = e.desc ? (e.source === 'qq' ? ` （QQ 名：${e.desc}）` : ` （名称：${e.desc}）`) : '';
    return `- （未标注）id=${e.id}${name}${extra}${used}`;
  });
  const pending = list.filter(needNote).length - fresh.length;
  const head = [
    `【可用表情包】表情库里 ${list.length} 个（下面是常用的 ${lines.length} 个，完整列表可用 list_stickers 查询）。`,
    '带 id= 的是你还没标注过的（QQ 收藏里那些只有名字、你还没看过的也算）：先 get_sticker_image 看图、sticker_note 记下它的意思和适用场合，再判断这张合不合适发。'
  ];
  if (pending > 0) head.push(`（另有 ${pending} 个还没标注的 —— 一轮先标最前面那 ${fresh.length} 个就够，别一口气全标）`);
  return `${head.join('\n')}\n${lines.join('\n')}`;
}

/** 发送前的表情包策略提示（软策略）。 */
export function buildStickerStrategyHint(level = 1) {
  // 活跃度引导放在系统提示的策略段里（而不是"本次输入"的【表情包用法】）——
  // 同一主题两处引导会左右脑互搏（2026-09-07）：策略讲时机、档位讲频率，
  // 合并成一处由档位直接改写频率行。
  // ⚠️ 索引严格对应 0~3 档，与 ui 的 STICKER_LEVELS 一致。
  const freqByLevel = [
    '表情包是备选项，不勉强；纯文字回应完全没问题。',
    '频率：普通闲聊不用每条都配；大约每 3~5 轮来一张就够，热闹/玩梗时可以更密，但不要连续刷屏。',
    '频率：回应、吐槽、接梗时优先考虑配一个贴切的表情，让对话更有活人感；别每次都用同一张。',
    '频率：你是表情包爱好者——能配表情的地方尽量配，接梗/调侃/附和时几乎都会带一张，聊天要有表情包的烟火气；注意换着用，不要连发同一张。'
  ][Math.min(3, Math.max(0, Number(level) || 0))];
  return [
    '【表情包策略：像真人一样用，不刷屏】',
    '- 合适时机：被戳中笑点/槽点、接梗、怼人、赞同、自嘲、安慰、无语、赢了/输了、告别/晚安、别人发了表情时回一张，都可以自然用。',
    `- ${freqByLevel}`,
    '- 选择：优先用备注（desc）和你的记忆（localNote/tags）能准确对上语境的；还没标注过、你也不确定的表情，先 get_sticker_image 看图再决定，不要瞎发。',
    '- 标注优先：菜单里带 id= 的那些你还没标注过（**自己收藏的和 QQ 里原来就有的都算**）—— 打算发表情时，遇到这种就先 get_sticker_image 看图、用 sticker_note 记下它的意思和适用场景（一轮最多标 3 个），标注完再判断这张合不合适：合适就发，不合适就换一张。看图、标注、发送可以在同一轮里连着做完。',
    '- 发送：用 send_sticker；stickerId 可以填 id，也可以直接填菜单（或 list_stickers）里那个表情的备注/标签 —— 唯一命中时才作数，撞了它会让你改用 id。一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话先用 send_message 作为单独气泡发出，再单独发表情。',
    '- 不要：在严肃/正式/敏感话题硬塞表情；不要每次都用同一个；不要一条消息里塞多个表情；不要把文字和表情混在同一个气泡里。'
  ].join('\n');
}

/**
 * 改一条表情的本地认知。ref 先按 id/resId/md5/url 精确认，认不出来再按标签认
 * （两者都由 resolveStickerRef 统一处理，与 send_sticker 认的是同一套东西）。
 * 标签命中多个时**不猜**（改备注改错对象比不改还糟），返回 ambiguous 让调用方报错。
 * 返回值里的 ambiguous 是候选条目数组（未命中为 []）。
 */
export function applyStickerNote(entries, ref, patch = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const { entry: target, ambiguous } = resolveStickerRef(list, ref);
  if (!target) return { entries: list, entry: null, ambiguous };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    localNote: patch.note !== undefined ? String(patch.note ?? '').trim() : target.localNote,
    tags: Array.isArray(patch.tags) ? patch.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : target.tags,
    usage: patch.usage !== undefined ? String(patch.usage ?? '').trim() : target.usage,
    source: patch.source || target.source || 'ai',
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null, ambiguous: [] };
  list[idx] = next;
  return { entries: list, entry: next, ambiguous: [] };
}

export function markStickerUsed(entries, id, context = '') {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    useCount: (target.useCount || 0) + 1,
    lastUsedAt: Date.now(),
    lastContext: String(context || '').slice(0, 200),
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}
