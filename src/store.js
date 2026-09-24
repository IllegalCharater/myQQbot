// 每个会话（group:xxx / private:xxx）一个不断增长的 JSON 消息存储。
// 这是新架构的核心数据结构：模型不携带对话历史，每次运行都从这里拼接"过去状态"。
//
// 条目格式：
// {
//   id:        本地递增序号（自 1 起，同群唯一，用于 UI 定位）
//   mid:       QQ 消息 id（可为负数；自己主动发送的本地记录可能没有）
//   ts:        时间戳毫秒
//   senderId:  QQ 号（自己发送的为 selfId）
//   senderName:群名片/昵称（自己发送的为 botName）
//   text:      解析后的纯文本（[图片] 等占位符已内联）
//   self:      是否是机器人自己发的
//   read:      已读状态（运行开始时批量置 true）
//   reply:     可选 { sender, text }：该消息引用/回复的对象摘要
//   media:     可选 [{ kind, url, file, faceId, summary }] 原始媒体定位信息
// }
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
// 压缩后的原文冷归档。独立子目录 + .jsonl 后缀：listChats 的正则只认
// group_*.json，天然扫不到这里，归档不会变成"新会话"。
const ARCHIVE_DIR = path.join(MESSAGES_DIR, 'archive');

function safeName(chatKey) {
  // chatKey 形如 group:123 / private:456
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

function chatFile(chatKey) {
  return path.join(MESSAGES_DIR, `${safeName(chatKey)}.json`);
}

function archiveFile(chatKey) {
  return path.join(ARCHIVE_DIR, `${safeName(chatKey)}.jsonl`);
}

/**
 * "不是某人说的话"的条目：压缩摘要（kind:'digest'）与面板插的人工备注（kind:'note'）。
 *
 * 凡是要按"人"来统计/取样的地方都得先用它过滤 —— 否则摘要的 senderId('digest')
 * 或备注的空 senderId 会变成群里一个查无此人的幽灵成员。
 */
export function isSystemRecord(m) {
  return m?.kind === 'digest' || m?.kind === 'note';
}

function loadChat(chatKey) {
  try {
    let text = fs.readFileSync(chatFile(chatKey), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.messages)) return parsed;
  } catch { /* 新会话 */ }
  return { chatKey, nextLocalId: 1, messages: [] };
}

function saveChat(state) {
  fs.mkdirSync(MESSAGES_DIR, { recursive: true });
  const tmp = `${chatFile(state.chatKey)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
  fs.renameSync(tmp, chatFile(state.chatKey));
}

export class ChatStore {
  constructor(maxPerChat = 0) {
    this.maxPerChat = Math.max(0, Number(maxPerChat) || 0);
    this.chats = new Map(); // chatKey -> state
  }

  setMaxPerChat(cap) {
    this.maxPerChat = Math.max(0, Number(cap) || 0);
  }

  #state(chatKey) {
    if (!this.chats.has(chatKey)) this.chats.set(chatKey, loadChat(chatKey));
    return this.chats.get(chatKey);
  }

  listChats() {
    // 从磁盘文件名还原（group_123.json -> group:123），已加载的直接带上
    try {
      const files = fs.readdirSync(MESSAGES_DIR).filter((f) => /^(group|private)_\d+\.json$/.test(f));
      for (const f of files) {
        const m = /^(group|private)_(\d+)\.json$/.exec(f);
        if (m) this.#state(`${m[1]}:${m[2]}`);
      }
    } catch { /* 目录不存在 */ }
    return [...this.chats.keys()];
  }

  getChatMeta(chatKey) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read).length;
    const last = st.messages[st.messages.length - 1] || null;
    return { chatKey, total: st.messages.length, unread, lastTs: last?.ts ?? 0, lastText: last?.text ?? '' };
  }

  /** 追加一条收到的消息（未读）。返回写入的条目。 */
  appendIncoming(chatKey, { mid, ts, senderId, senderName, text, reply = null, media = [] }) {
    const st = this.#state(chatKey);
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: String(senderId ?? ''),
      senderName: String(senderName ?? ''),
      text: String(text ?? ''),
      self: false,
      read: false,
      reply: reply || null,
      media: Array.isArray(media) ? media : []
    };
    st.messages.push(entry);
    this.#trim(st);
    saveChat(st);
    return entry;
  }

  /** 记录机器人自己发出的消息（已读）。 */
  appendSelf(chatKey, { text, ts, mid = null }) {
    const st = this.#state(chatKey);
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: 'self',
      senderName: '我',
      text: String(text ?? ''),
      self: true,
      read: true,
      reply: null,
      media: []
    };
    st.messages.push(entry);
    this.#trim(st);
    saveChat(st);
    return entry;
  }

  /** 快照当前未读并全部置为已读（运行开始时调用）。 */
  drainUnread(chatKey) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read && !m.self);
    for (const m of st.messages) m.read = true;
    saveChat(st);
    return unread;
  }

  /**
   * 把当前所有未读标记为已读，**但不取走它们**。
   *
   * 这是"档位控制是否响应"的关键：机器人判断"这次不回应"时调用它，
   * 消息就沉入历史（已读），不会产生会话、不消耗 token；
   * 但内容仍留在存档里，日后被艾特时还能作为"已读上下文"带进提示词。
   * 与 drainUnread 的区别：drainUnread 取走并作为触发批，这个只标记。
   *
   * @returns {number} 被标记为已读的条数
   */
  markAllRead(chatKey) {
    const st = this.#state(chatKey);
    let n = 0;
    for (const m of st.messages) {
      if (!m.read && !m.self) { m.read = true; n++; }
    }
    if (n) saveChat(st);
    return n;
  }

  unreadCount(chatKey) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).length;
  }

  /** 查看当前未读消息（不置已读），用于“等待中”会话的触发摘要。 */
  peekUnread(chatKey, limit = 3) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).slice(0, Math.max(1, Number(limit) || 3));
  }

  recent(chatKey, { limit = 80, offset = 0, includeSelf = true } = {}) {
    const st = this.#state(chatKey);
    const all = includeSelf ? st.messages : st.messages.filter((m) => !m.self);
    // offset = 跳过最近 N 条（用于工具翻页）。只读，绝不能修改 st.messages！
    const start = Math.max(0, all.length - Math.max(0, Number(offset) || 0));
    return all.slice(0, start).slice(-Math.max(1, Number(limit) || 1));
  }

  findByMid(chatKey, mid) {
    const st = this.#state(chatKey);
    const target = String(mid);
    return st.messages.find((m) => String(m.mid) === target) || null;
  }

  /**
   * 该会话的全部压缩摘要（kind:'digest'），**新的在前**（ts 降序，同 ts 按 id 降序）。
   *
   * 顺序是契约不是巧合：提示词的【历史印象】段按"新的优先"吃字数预算，
   * 越旧越先被挤掉；面板反过来自己倒序显示。两边都不必再排一次。
   *
   * ⚠️ filter 出来的是**新数组**，排序它不会动到 st.messages。绝不能对
   *    st.messages 原地排序 —— 那会重排整个存档，连带把 recent() 的窗口改掉。
   * 摘要按 ts 堆在存档头部（commitCompaction 按 ts 插入），但这里仍显式排序，
   * 不依赖插入顺序（老存档、手工修过的数据都可能不守规矩）。
   */
  digests(chatKey) {
    const st = this.#state(chatKey);
    return st.messages
      .filter((m) => m && m.kind === 'digest')
      .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0) || (Number(b.id) || 0) - (Number(a.id) || 0));
  }

  /**
   * 按 QQ 消息 id 更新一条已存档消息（文本/补媒体），并落盘。
   * 用途：read_forward 工具把"合并转发占位符"永久升级成展开后的文本
   * —— 一次展开，以后谁（模型/存档页）都直接读到内容。
   */
  updateByMid(chatKey, mid, { text, appendMedia = [] } = {}) {
    const st = this.#state(chatKey);
    const target = String(mid);
    const m = st.messages.find((x) => String(x.mid) === target);
    if (!m) return false;
    if (text != null) m.text = String(text);
    if (appendMedia.length) {
      m.media = Array.isArray(m.media) ? m.media : [];
      const seen = new Set(m.media.map((x) => x && x.url));
      for (const x of appendMedia) {
        if (x && x.url && !seen.has(x.url)) { m.media.push(x); seen.add(x.url); }
      }
    }
    saveChat(st);
    return true;
  }

  findByLocalId(chatKey, localId) {
    const st = this.#state(chatKey);
    return st.messages.find((m) => m.id === Number(localId)) || null;
  }

  // ── 面板管理端：单条改 / 删 / 插备注 ────────────────────────────────────
  //
  // 三条约束与 commitCompaction 一脉相承，每一条都对应一类难以察觉的损坏：
  //  1. **按显式 id 找，绝不用下标** —— 一次运行/一条新消息随时会改动数组，
  //     面板拿到的下标一转眼就是错的。
  //  2. **绝不回退 nextLocalId** —— 它被持久化，回退会让 UI 的 data-midrow、
  //     findByLocalId 与已归档条目撞车。
  //  3. **读改写之间不夹 await** —— 下面每个方法都是同步改完立刻 saveChat。
  //     Node 单线程下这就是原子的；一旦中间让出事件循环，bot 的追加就会挤进来。

  /**
   * 备份存档文件，文件名带 tag（`.panel.bak`）。
   *
   * **不要复用 backupChatFile**：那个固定写 `${file}.bak`，是压缩的回滚点
   * （"永远保存着最近一次重写之前的完整状态"）。面板删一条消息就把它冲掉，
   * 等于用一次小操作毁掉了整轮压缩的后悔药。同样是只保留最近一次。
   */
  backupChatFileTo(chatKey, tag = 'panel') {
    try {
      const src = chatFile(chatKey);
      if (!fs.existsSync(src)) return '';
      const dest = `${src}.${tag}.bak`;
      fs.copyFileSync(src, dest);
      return dest;
    } catch (error) {
      console.warn(`[store] 备份失败(${tag}):`, error?.message ?? error);
      return '';
    }
  }

  /**
   * 按本地 id 改一条存档的文本（面板编辑）。
   *
   * 只允许改 text：senderId/self/mid/ts/read 一概不动 —— 面板换个说法可以，
   * 改"这话是谁说的/什么时候说的"会直接伪造历史，而且会让 mid 与消息对不上。
   */
  updateByLocalId(chatKey, localId, { text } = {}) {
    const st = this.#state(chatKey);
    const m = st.messages.find((x) => x.id === Number(localId));
    if (!m) return null;
    if (text != null) m.text = String(text);
    saveChat(st);
    return m;
  }

  /**
   * 按本地 id 真删一条存档。删掉的 id 不回收（nextLocalId 不动）。
   * @returns {{removed:object, backup:string}|null}
   */
  deleteByLocalId(chatKey, localId) {
    const st = this.#state(chatKey);
    const idx = st.messages.findIndex((x) => x.id === Number(localId));
    if (idx < 0) return null;
    const backup = this.backupChatFileTo(chatKey, 'panel');   // 与下面之间不夹 await
    const [removed] = st.messages.splice(idx, 1);
    saveChat(st);
    return { removed, backup };
  }

  /**
   * 插一条**人工备注**：kind:'note'，不是群友说的话，也不冒充 bot 自己。
   *
   * read:true 是关键 —— drainUnread/unreadCount/markAllRead 过滤的都是
   * `!m.read && !m.self`，置 true 它才不会变成一次运行的触发批。
   *
   * 按 ts 找位置插入（同 commitCompaction）：给几天前那段对话补一句更正，
   * 它应该落在当时的位置，而不是漂在末尾。
   */
  insertNote(chatKey, { text, ts = Date.now() } = {}) {
    const st = this.#state(chatKey);
    const entry = {
      id: st.nextLocalId++,
      mid: null,
      ts: Number(ts) || Date.now(),
      senderId: '',
      senderName: '',
      text: String(text ?? ''),
      self: false,
      read: true,
      reply: null,
      media: [],
      kind: 'note'
    };
    const at = st.messages.findIndex((m) => m.ts > entry.ts);
    st.messages.splice(at < 0 ? st.messages.length : at, 0, entry);
    saveChat(st);
    return entry;
  }

  /** 最近 senderId 出现过的活跃成员（带最后发言时间）。 */
  activeMembers(chatKey, limit = 10) {
    const st = this.#state(chatKey);
    const map = new Map();
    for (const m of st.messages) {
      if (m.self) continue;
      // 压缩摘要 / 人工备注都是系统生成的，不是人：不跳过就会在"活跃成员"里
      // 凭空多出幻影成员（摘要的 senderId 是 'digest'，备注是空串），
      // 进而污染群友印象。
      if (isSystemRecord(m)) continue;
      const prev = map.get(m.senderId);
      if (!prev || prev.lastTs < m.ts) {
        map.set(m.senderId, { userId: m.senderId, name: m.senderName, lastTs: m.ts, count: (prev?.count || 0) + 1 });
      } else {
        prev.count += 1;
      }
    }
    return [...map.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, Math.max(1, limit));
  }

  // ── 定时压缩：摘要入档 + 原文冷归档 ─────────────────────────────────────
  //
  // 长期运行的群里，存档只增不减，磁盘和 token 都会慢慢失控。压缩把最老的一段
  // 交给模型摘要成一段纪要写回存档，原文移到冷归档（**不删除**）。
  //
  // 提交顺序是刻意的：先 append 冷归档 → 再重写主文件，两步之间不夹 await。
  // 中途崩溃只会让消息**同时存在于两处**（可恢复的重复），而不是**两处都没有**（丢失）。

  /**
   * 挑出"可以被压缩归档"的候选区间（**只读**，不改任何状态）。
   *
   *   - 不碰最近 keepRecent 条（正在进行的对话必须原样留着）
   *   - 最多 maxMessages 条（控成本）
   *   - **从最老的一端开始吃**：多轮压缩才能持续推进、不留死角。
   *     若改成取"eligible 区间里最新的 N 条"，窗口会随新消息一路前移，
   *     最开头那几条永远落在窗口之外、永远压不掉 —— 磁盘上留下一段死库存。
   *   - **跳过已有的摘要条目**：摘要绝不能被二次摘要。否则每一轮都在"摘要的摘要"
   *     上做有损压缩，几轮之后那段历史就退化成一句空话。这条保证让每一条纪要
   *     永远直接来自原文。代价是纪要会缓慢累积（每条 ≤4000 字），
   *     相比原文的增长量级可以忽略。
   *     （人工备注同样跳过：它是给人看的批注，摘要它的成本换不来信息。）
   *
   * ⚠️ 返回的是原数组的切片（元素是**引用**）：调用方只能读，不能改内容。
   *    "按字符预算再裁一刀"由调用方在拼完提示词后做 —— 只有拼提示词的那一步
   *    知道模型**真正看到了**多少条，压缩区间必须与它严格一致。
   */
  selectArchiveRange(chatKey, { keepRecent = 300, maxMessages = 400 } = {}) {
    const st = this.#state(chatKey);
    const keep = Math.max(0, Number(keepRecent) || 0);
    const cap = Math.max(1, Number(maxMessages) || 1);
    const end = st.messages.length - keep;   // 不含：最近的 keep 条不参与
    if (end <= 0) return { entries: [], end: 0, total: st.messages.length };
    // 从 0 开始取：压缩顺序严格从最老到最新，每一轮都往前推进一段。
    // 先跳过再计数（而不是先切片再过滤）：否则文件头部堆满摘要时，
    // 一块全是摘要的切片会被过滤成空区间，压缩从此永久卡住。
    const entries = [];
    for (let i = 0; i < end && entries.length < cap; i++) {
      const m = st.messages[i];
      if (isSystemRecord(m)) continue;
      entries.push(m);
    }
    return { entries, end, total: st.messages.length };
  }

  /**
   * 把原消息**追加**进冷归档（只追加，绝不删改）。返回归档文件名，供摘要条目记录。
   *
   * 用 JSONL 而不是一个大 JSON：追加是 O(1)，且任何一行坏掉都不影响其它行。
   */
  appendArchive(chatKey, entries) {
    const list = Array.isArray(entries) ? entries : [];
    if (!list.length) return { file: '', count: 0 };
    const file = archiveFile(chatKey);
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    fs.appendFileSync(file, list.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');
    return { file: path.basename(file), count: list.length };
  }

  /**
   * 压缩前给主文件留一份备份，模仿 memory.replaceConsolidated 的"先备份再重写"。
   * 固定文件名（每次覆盖）：永远保存着**最近一次重写之前**的完整状态，
   * 既是有用的回滚点，又不会随压缩次数无限堆积。
   */
  backupChatFile(chatKey) {
    try {
      const src = chatFile(chatKey);
      if (!fs.existsSync(src)) return '';
      const dest = `${src}.bak`;
      fs.copyFileSync(src, dest);
      return dest;
    } catch (error) {
      console.warn('[store] 压缩前备份失败:', error?.message ?? error);
      return '';
    }
  }

  /**
   * 提交一次压缩：删掉已归档的条目，把摘要插进存档最前面。
   *
   * 三条硬性要求，每一条都对应一类难以察觉的数据损坏：
   *  1. **按显式 id 集合过滤**，绝不用 slice/下标 —— LLM 调用期间新到的消息
   *     会让下标整体错位，按下标删就会误删刚发生的新消息。
   *  2. **绝不重算 nextLocalId**（它会被持久化）：回退会让 UI 的 data-midrow 键、
   *     findByLocalId 与已归档的 id 全部撞车。
   *  3. 摘要插在第一条"比它新"的消息之前（实践中即 index 0）—— recent() 按数组
   *     位置切片，放最前面它才会成为【过去状态】里最老的一行。
   *
   * 拿到摘要前**什么都不删**：没有 digestEntry 就原样返回（摘要失败 = 整轮零改动）。
   *
   * @returns {{removed:number, remaining:number, backup:string, archive:string}}
   */
  commitCompaction(chatKey, { removeIds, digestEntry }) {
    const st = this.#state(chatKey);
    const kill = removeIds instanceof Set ? removeIds : new Set(removeIds || []);
    if (!kill.size || !digestEntry) {
      return { removed: 0, remaining: st.messages.length, backup: '', archive: '' };
    }
    const backup = this.backupChatFile(chatKey);   // 与重写之间不夹任何 await
    const before = st.messages.length;
    st.messages = st.messages.filter((m) => !kill.has(m.id));
    const removed = before - st.messages.length;

    // id 取自 nextLocalId 的**下一个**值：被删掉的 id 绝不回收（回收会让
    // 已经归档的旧条目和新的摘要共用同一个 id）。
    if (!Number.isFinite(st.nextLocalId) || st.nextLocalId <= 0) st.nextLocalId = 1;
    digestEntry.id = st.nextLocalId++;

    const at = st.messages.findIndex((m) => m.ts > digestEntry.ts);
    st.messages.splice(at < 0 ? st.messages.length : at, 0, digestEntry);

    // 冷却状态顺带记在主文件里（随 saveChat 免费持久化，无需新文件）
    st.lastCompactedAt = Date.now();
    st.archivedCount = (Number(st.archivedCount) || 0) + removed;
    saveChat(st);
    return { removed, remaining: st.messages.length, backup, archive: digestEntry?.digest?.archivedFile || '' };
  }

  /** 上次压缩时间（0 = 从未压缩过），供冷却判断。 */
  lastCompactedAt(chatKey) {
    return Number(this.#state(chatKey).lastCompactedAt) || 0;
  }

  #trim(st) {
    if (this.maxPerChat > 0 && st.messages.length > this.maxPerChat) {
      st.messages.splice(0, st.messages.length - this.maxPerChat);
    }
  }
}
