// 会话（运行）记录：每次 agent 处理 = 一个会话，完整留档供 UI 查看。
// 文件：data/sessions/<id>.json；索引在内存里维护（最近优先）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../core/config.js';
import type { SessionRecord, SessionUsage } from './types.js';

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

export function newSessionId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

export function sessionFile(id: string) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

/**
 * 命令记录的几个上限。**都是成本与防御，不是洁癖**：
 * 命令原文要落盘（`/画` 的 prompt 是用户文本，可能很长），stage 条数要防"哪天有人
 * 在循环里调 stage"把一份 JSON 撑爆。会话页不显示完整原文，截断不影响可读性。
 */
const COMMAND_TEXT_MAX = 200;
const COMMAND_DETAIL_MAX = 200;
const MAX_COMMAND_STAGES = 40;

export class SessionRegistry {
  keepFiles: number;
  index: Array<Record<string, unknown>>;
  current: Map<string, SessionRecord>;
  _lastPersistAt?: Map<string, number>;
  /**
   * 会话结束时的回调（"一次 agent 运行结束了"这件事的**唯一**通知点）。
   *
   * 收尾路径上的**旁路**：它抛错只记一行日志，绝不影响 `finish()` 的返回值或持久化 ——
   * 持久化在前、回调在后，两者不共享任何失败。
   */
  onFinish: ((s: SessionRecord) => void) | null;
  /**
   * @param {number} keepFiles 保留最近多少个会话记录文件；**0 = 不限制**。
   *   注意：不能用 `x || 300` 兜底 —— 0 是 falsy 会被误当成"未设置"变回 300，
   *   用户想"取消上限"就永远改不掉。也不能 Math.max(20,…) 强制下限。
   */
  constructor(keepFiles = 0, { onFinish = null }: { onFinish?: ((s: SessionRecord) => void) | null } = {}) {
    this.keepFiles = Math.max(0, Number.isFinite(Number(keepFiles)) ? Math.round(Number(keepFiles)) : 0);
    // 与 `StickerManager` 的 `onChange` 同形：**低层不 import 高层**，所以"运行结束了"这件事
    // 由构造参数回调交出去，由组装根接线（扩展在 `extra/`，比 `chat/` 高两级 —— 反向依赖会被
    // `check-layers.mjs` 拦）。
    this.onFinish = typeof onFinish === 'function' ? onFinish : null;
    this.index = [];   // [{ id, chatKey, startedAt, endedAt, status, outcome, usage, trigger, model, promptChars }]
    this.current = new Map(); // id -> session object（运行中的在内存里）
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    this.#loadIndex();
  }

  #loadIndex() {
    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort().reverse();
      // keepFiles=0 表示不限制，全部加载
      const pick = this.keepFiles > 0 ? files.slice(0, this.keepFiles) : files;
      for (const f of pick) {
        try {
          const data: unknown = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
          const session = normalizeSession(data);
          if (session) this.index.push(this.#summary(session));
        } catch { /* 跳过坏文件 */ }
      }
    } catch { /* 目录还没建 */ }
  }

  #summary(s: SessionRecord): Record<string, unknown> {
    return {
      id: s.id,
      chatKey: s.chatKey,
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      status: s.status,                      // waiting | running | done | noreply | error | aborted
      waitUntil: s.waitUntil ?? null,
      activity: s.activity ?? '',
      webSearchCount: s.webSearchCount ?? 0,
      outcome: s.outcome ?? null,            // { sent: n, finishReason }
      usage: s.usage ?? null,
      model: s.model ?? '',
      trigger: s.triggerSummary ?? '',
      // 会话页要分清"一次模型运行"与"一条命令的记录"：前者有 round/token，
      // 后者那些列全是 0，显示成 0 会让人以为"跑了一轮但什么都没用"。
      kind: s.trigger === 'command' ? 'command' : 'run',
      command: s.command ?? '',
      promptChars: s.promptChars ?? 0,
      rounds: s.rounds ?? 0
    };
  }

  create({ chatKey, trigger, triggerSummary, status = 'running', waitUntil = null, command, commandText }: {
    chatKey: string; trigger: unknown; triggerSummary?: unknown; status?: string; waitUntil?: number | null;
    /** 只有 `trigger:'command'` 的记录给：主命令词与收到的那句话（见 `beginCommand`）。 */
    command?: string; commandText?: string;
  }) {
    const session: SessionRecord = {
      id: newSessionId(),
      chatKey,
      startedAt: Date.now(),
      endedAt: null,
      status,
      waitUntil,
      trigger,                                 // 'message' | 'proactive' | 'command'
      triggerSummary: String(triggerSummary ?? '').slice(0, 120),
      triggerText: String(triggerEntriesToText(trigger) ?? ''),
      ...(command ? { command } : {}),
      ...(commandText !== undefined ? { commandText: String(commandText).slice(0, COMMAND_TEXT_MAX) } : {}),
      ...(command ? { stages: [] } : {}),
      systemPrompt: '',
      userPrompt: '',
      llmRequests: [],                         // 每轮真正发送给模型的 messages/tools 快照
      promptChars: 0,
      model: '',
      rounds: 0,
      messages: [],                            // OpenAI 消息序列（含工具调用与结果）
      sent: [],                                // 实际发出的每一条
      feedbacks: [],
      finishReason: null,
      error: null,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 }
    };
    this.current.set(session.id, session);
    this.#persist(session);
    this.index.unshift(this.#summary(session));
    if (this.keepFiles > 0) this.index = this.index.slice(0, this.keepFiles);
    return session;
  }

  // ── 主流程命令的记录（2026-10-20 加）──────────────────────────────────────
  //
  // 命令是**确定性快路径**：它不调模型，所以既没有一整轮 messages/llmRequests，也不该
  // 占用 `runs`、不该触发 `onFinish`（两条都在 `#persist` / `finish` 里按 `trigger` 跳过）。
  // 但它同样是"用户敲了一句话、系统做了一串动作"，会话页该看得到 —— 于是复用同一个存储与
  // 同一套列表/详情/删除/裁剪，只多三件事：`trigger:'command'`、`command`、`stages`。
  //
  // ⚠️ **只记主流程那四条**（`/转写` `/画` `/漫画` `/能力`）：判据在
  // `web/onebot/commands.ts` 的 `CommandEntry.recordSession`。扩展命令不记 ——
  // `.r 3d6` 那种一局几百条，记了只会把真会话挤出 `keepSessionFiles` 的额度。
  //
  // ⚠️ **记录在回执发出时闭合**，不跟随后台队列（转写/出图/漫画的活儿由它们自己的异步结果
  // 回流条目承载，存档页看得到）。用户明确选了这一档：后台任务结束会另行触发一轮运行，
  // 那是一条独立的会话记录，不该被塞进命令的流程里。

  /** 开一条命令记录，返回 id（后两步用它）。 */
  beginCommand({ chatKey, command, text }: { chatKey: string; command: string; text: string }): string {
    const session = this.create({
      chatKey,
      // 字符串而不是数组：`triggerEntriesToText` 只认数组，于是 `triggerText` 天然为空 ——
      // 命令记录没有"触发消息批"，这是对的，不是漏填。
      trigger: 'command',
      triggerSummary: `命令 ${command}`,
      command,
      commandText: text
    });
    return session.id;
  }

  /** 追加一行执行流程。记录已经收尾/被删时静默忽略（那是旁路，不该抛）。 */
  stageCommand(id: string, name: string, detail?: string): void {
    const s = this.current.get(String(id ?? ''));
    if (!s || s.trigger !== 'command') return;
    const stages = Array.isArray(s.stages) ? s.stages : (s.stages = []);
    if (stages.length >= MAX_COMMAND_STAGES) return;
    stages.push({
      at: Date.now(),
      name: String(name ?? '').slice(0, COMMAND_DETAIL_MAX),
      ...(detail == null || detail === '' ? {} : { detail: String(detail).slice(0, COMMAND_DETAIL_MAX) })
    });
    this.update(s.id);
  }

  /**
   * 收尾。`receipt` 是发进群的那句话（有就进 `sent`，详情页照着它显示"回了什么"）。
   *
   * 状态三档与 `runCommand` 的三个出口一一对应：发了回执 `done`、不吭声 `noreply`、
   * 抛错（错误文案已经发进群）`error`。
   */
  finishCommand(id: string, status: 'done' | 'noreply' | 'error', receipt?: string): void {
    const s = this.current.get(String(id ?? ''));
    if (!s || s.trigger !== 'command') return;
    if (receipt) s.sent = [{ text: String(receipt), at: Date.now() }];
    s.outcome = { sent: (s.sent || []).length, finishReason: status };
    this.finish(s.id, status);
  }

  get(id: string): SessionRecord | null {
    if (this.current.has(id)) {
      const s = this.current.get(id);
      return s ? structuredClone(s) : null;
    }
    try {
      const data: unknown = JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
      return normalizeSession(data);
    } catch {
      return null;
    }
  }

  /**
   * 不克隆的读取：**只用于"读出来马上序列化"的热路径**（如 SSE 广播）。
   * 运行中的会话每次 session-update 都要走一次，get() 的 structuredClone
   * 会把整个会话（含每轮 raw 响应）全量复制一遍 —— 纯序列化用不到这份拷贝。
   * ⚠️ 返回的是活对象，调用方绝对不能改它；要改请用 get()。
   */
  peek(id: string): SessionRecord | null {
    if (this.current.has(id)) return this.current.get(id) ?? null;
    try {
      const data: unknown = JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
      return normalizeSession(data);
    } catch {
      return null;
    }
  }

  update(id: string) {
    const s = this.current.get(id);
    if (s) {
      this.#persistThrottled(s);
      const idx = this.index.findIndex((e) => e.id === id);
      if (idx >= 0) this.index[idx] = this.#summary(s);
    }
    return s ?? null;
  }

  /** 设置运行中的活动状态（思考/调用工具）并广播。 */
  setActivity(id: string, activity: unknown) {
    const s = this.current.get(id);
    if (!s) return null;
    s.activity = String(activity ?? '');
    this.update(id);
    return s;
  }

  finish(id: string, status: string) {
    const s = this.current.get(id);
    if (!s) return null;
    s.status = status;
    s.endedAt = Date.now();
    this.current.delete(id);
    this._lastPersistAt?.delete(id);   // 节流时间戳随会话结束清理，防止 map 无限增长
    this.#persist(s);
    const idx = this.index.findIndex((e) => e.id === id);
    if (idx >= 0) this.index[idx] = this.#summary(s);
    // 清理超出保留数的旧文件
    try {
      if (this.keepFiles > 0) {
        const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort();
        if (files.length > this.keepFiles) {
          for (const f of files.slice(0, files.length - this.keepFiles)) {
            try { fs.unlinkSync(path.join(SESSIONS_DIR, f)); } catch { /* ignore */ }
          }
        }
      }
    } catch { /* ignore */ }
    // 通知放在**最后**：此刻会话已经落盘、索引已经更新，回调里读到的是一个稳定的收尾快照。
    // 抛错只记日志 —— 它是旁路，不该有能力影响这次收尾。
    //
    // ⚠️ **命令记录不通知**：`onFinish` 的订阅者是扩展的 `runEnded`（跑团拿它判"DM 整轮
    // 沉默"）。一条命令不是一轮运行 —— 让跑团看见"`/能力 加载 trpg` 结束了"只会制造
    // 幽灵触发，而它的触发批是空的，症状极难归因。判据与用量那条同源（`trigger === 'command'`）。
    if (s.trigger !== 'command') {
      try {
        this.onFinish?.(s);
      } catch (error: unknown) {
        console.error('[sessions] onFinish 回调失败:', error instanceof Error ? error.message : error);
      }
    }
    return s;
  }

  /**
   * 彻底丢弃一个会话：从内存索引移除 + 删掉磁盘文件，**不留"中止"记录**。
   *
   * 用途：档位判定"这次不响应"时，连"等待中"会话都不该出现在会话页
   * （否则用户会看到一堆等半天最后变"中止"的条目，还以为出错了）。
   * 与 finish(id,'aborted') 的区别：finish 是"开始了但没成"，会留下痕迹；
   * 这个是"压根没开始"，干净消失。
   *
   * ⚠️ 只用于从未真正运行过的会话（status='waiting'）。
   *    已经跑过并消耗了 token 的会话要走 finish，别用这个抹掉用量记录。
   */
  discard(id: string) {
    if (!id) return false;
    const s = this.current.get(id);
    // 已运行过的不允许丢弃（会抹掉用量/成本记录，导致对不上账）
    if (s && s.status !== 'waiting') return false;
    this.current.delete(id);
    const before = this.index.length;
    this.index = this.index.filter((e) => e.id !== id);
    try {
      const f = path.join(SESSIONS_DIR, `${id}.json`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch { /* ignore */ }
    return this.index.length < before;
  }

  /**
   * 手动删除**单个会话记录**（会话页的删除按钮）。
   *
   * 与 `discard()` 的分工：`discard` 是给编排层用的"这次唤醒没跑起来、把占位会话撤掉"，
   * 所以它**只允许删 `waiting` 的占位**；而这里是用户在管理端明确点的一次删除，
   * 已结束的会话（done/noreply/error/aborted）都在允许范围内 —— 那才是用户真正想清理的东西。
   *
   * 两条边界是有意的：
   *   · **`running` 的会话拒绝删除**。它还在跑，删掉文件之后收尾的 `#persist` 会把文件
   *     原样写回来（还会有 `#bumpTodayUsage` 继续累加），用户看到的是"删了又出现"；
   *   · **删记录不影响今日用量**。已结束会话的 token 在 `finish()` 时就累加进
   *     `usage-today.json` 这个**独立聚合**了，`todayUsage()` 读的是那个文件 + 运行中的内存态，
   *     不再读单条会话文件 —— 所以删掉历史会话不会把账弄对不上。
   *
   * 不写备份：会话记录是**过程**数据（每轮请求/响应），对它的删除意图很明确；
   * 要留凭据的是存档（那边 `removeChat` 会备份）。
   */
  remove(id: string, { force = false }: { force?: boolean } = {}) {
    if (!id) return { ok: false, reason: '缺少会话 id' };
    const live = this.current.get(id);
    if (live && live.status === 'running' && !force) {
      return { ok: false, reason: '这个会话正在运行，等它结束后再删' };
    }
    this.current.delete(id);
    this._lastPersistAt?.delete(id);
    const before = this.index.length;
    this.index = this.index.filter((entry) => entry.id !== id);
    let fileRemoved = false;
    try {
      const file = path.join(SESSIONS_DIR, `${id}.json`);
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
        fileRemoved = true;
      }
    } catch (error: unknown) {
      return { ok: false, reason: `会话文件删除失败：${error instanceof Error ? error.message : error}` };
    }
    return { ok: true, indexRemoved: this.index.length < before, fileRemoved };
  }

  listSummaries(limit = 100) {
    return this.index.slice(0, limit);
  }

  /** 今日 token 统计（含运行中的）。 */
  todayUsage(dayKey: string) {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let cachedTokens = 0;
    let runs = 0;
    let webSearchCount = 0;
    // 结束的会话记在汇总文件里
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
      if (data?.dayKey === dayKey) {
        promptTokens = data.promptTokens || 0;
        completionTokens = data.completionTokens || 0;
        totalTokens = data.totalTokens || 0;
        cachedTokens = data.cachedTokens || 0;
        runs = data.runs || 0;
        webSearchCount = data.webSearchCount || 0;
      }
    } catch { /* 无记录 */ }
    // 加上运行中的
    for (const s of this.current.values()) {
      promptTokens += s.usage.promptTokens;
      completionTokens += s.usage.completionTokens;
      totalTokens += s.usage.totalTokens;
      cachedTokens += Number(s.usage.cachedTokens) || 0;
      webSearchCount += Number(s.webSearchCount) || 0;
    }
    return { dayKey, promptTokens, completionTokens, totalTokens, cachedTokens, runs, webSearchCount };
  }

  /** 在会话结束时累加今日用量（`runs` 加一：这一整轮**就是**一次 agent 运行）。 */
  #bumpTodayUsage(s: SessionRecord) {
    this.#addTodayUsage(localDayKey(s.startedAt), {
      promptTokens: s.usage.promptTokens,
      completionTokens: s.usage.completionTokens,
      totalTokens: s.usage.totalTokens,
      cachedTokens: Number(s.usage.cachedTokens) || 0,
      webSearchCount: Number(s.webSearchCount) || 0,
      runs: 1
    });
  }

  /**
   * 记一次**不属于任何会话**的模型调用用量（跑团的兜底建议与暗骰叙事那两次独立调用）。
   *
   * ── 为什么不能借用 `#persist` 那条路 ──
   *
   * 那两次调用都发生在 `finish()` **之后**（一条挂在 `onFinish` 回调上、一条在命令回执里），
   * 而 `#persist` 对**已结束**的会话每次都会调 `#bumpTodayUsage`，它整份累加 `s.usage` ——
   * 于是"补记一次增量"会变成"把那一整轮的账再加一遍"。这个入口只叠增量，所以补记是安全的。
   *
   * ── 两条刻意的取舍 ──
   *
   * ① **不动 `runs`**：那个数数的是"一次 agent 运行"（面板拿它算平均每次花多少），
   *    而这两次调用不是运行 —— 算进去会让均值失真。代价是 `totalTokens / runs` 会略偏高，
   *    这是两个数各自都更准的那一侧。
   * ② **参数是结构类型而不是 `extra` 的类型**：`chat`(1) 比 `extra`(4) 低，反向 import 会被
   *    `check-layers.mjs` 拦。所以这里只描述"要收哪四个数"，调用方（组装根）把扩展递上来的
   *    那份原样转过来即可 —— 形状与 `llm` 的 `UsageTotals` 一致，没有第二套命名。
   *
   * 四个数全是 0 时**直接返回**：那表示这次调用没有用量可记（提供商没报 usage），
   * 而"为一次什么都没变的增量写盘"是白开销。
   */
  addExtraUsage(
    usage: {
      promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedTokens?: number;
    } | null | undefined,
    at: number = Date.now()
  ): void {
    const delta = {
      promptTokens: Number(usage?.promptTokens) || 0,
      completionTokens: Number(usage?.completionTokens) || 0,
      totalTokens: Number(usage?.totalTokens) || 0,
      cachedTokens: Number(usage?.cachedTokens) || 0
    };
    if (!delta.promptTokens && !delta.completionTokens && !delta.totalTokens && !delta.cachedTokens) return;
    this.#addTodayUsage(localDayKey(at), { ...delta, webSearchCount: 0, runs: 0 });
  }

  /**
   * 今日汇总的**唯一写入点**：读 → 叠增量 → 原子落盘。
   *
   * 两条路共用它（`#bumpTodayUsage` 与 `addExtraUsage`），差别只有增量里那几个数 ——
   * 各写一份读改写的话，"新的一天"与原子落盘这两件事就有了第二份实现。
   */
  #addTodayUsage(dayKey: string, delta: {
    promptTokens: number; completionTokens: number; totalTokens: number;
    cachedTokens: number; webSearchCount: number; runs: number;
  }) {
    let data = { dayKey, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, runs: 0, webSearchCount: 0 };
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
      if (parsed?.dayKey === dayKey) data = parsed;
    } catch { /* 新的一天 */ }
    data.promptTokens += delta.promptTokens;
    data.completionTokens += delta.completionTokens;
    data.totalTokens += delta.totalTokens;
    data.cachedTokens = (data.cachedTokens || 0) + delta.cachedTokens;
    data.runs += delta.runs;
    data.webSearchCount = (data.webSearchCount || 0) + delta.webSearchCount;
    const tmp = path.join(DATA_DIR, 'usage-today.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, path.join(DATA_DIR, 'usage-today.json'));
  }

  /**
   * 运行中会话的落盘节流：每个会话 2 秒内最多写一次盘。
   *
   * 曾经 update() 每次都 #persist —— activity 翻转（每轮 2 次）、每个工具调用
   * 都会同步 writeFileSync 整个会话 JSON（含提示词与所有消息，越跑越大）。
   * 同步写盘阻塞 event loop，排在后面的 SSE 广播/HTTP 响应全被拖慢。
   *
   * 可靠性：finish() 仍走 #persist 直接落最终态，所以留档完整性不变；
   * 代价是进程崩溃时最多丢 2 秒的运行中进度（索引摘要不受影响，在内存里）。
   */
  #persistThrottled(s: SessionRecord) {
    const now = Date.now();
    this._lastPersistAt ||= new Map();
    const last = this._lastPersistAt.get(s.id) || 0;
    if (now - last < 2000) return;
    this._lastPersistAt.set(s.id, now);
    this.#persist(s);
  }

  #persist(s: SessionRecord) {
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      const tmp = `${sessionFile(s.id)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s, null, 1), 'utf8');
      fs.renameSync(tmp, sessionFile(s.id));
      // ⚠️ **命令记录不是一次 agent 运行**：`#bumpTodayUsage` 会把 `runs` 加一，
      // 让用量页的"今日运行次数"虚高（命令根本没有模型调用）。`totalTokens` 那几项本来就是 0，
      // 跳过整次累加不会有任何信息丢失。
      if (s.trigger !== 'command' && s.status !== 'running' && s.status !== 'waiting') this.#bumpTodayUsage(s);
    } catch (error: unknown) {
      console.error('[sessions] 持久化失败:', error instanceof Error ? error.message : error);
    }
  }
}

function localDayKey(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function triggerEntriesToText(trigger: unknown) {
  // trigger 在创建时是数组（触发条目），这里只做摘要展示用
  if (Array.isArray(trigger)) {
    return trigger.map((value) => {
      const m = isRecord(value) ? value : {};
      return `${m.senderName || m.senderId || '?'}: ${String(m.text ?? '').slice(0, 80)}`;
    }).join(' | ');
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeUsage(value: unknown): SessionUsage {
  const usage = isRecord(value) ? value : {};
  return {
    promptTokens: Number(usage.promptTokens) || 0,
    completionTokens: Number(usage.completionTokens) || 0,
    totalTokens: Number(usage.totalTokens) || 0,
    cachedTokens: Number(usage.cachedTokens) || 0,
    calls: Number(usage.calls) || 0
  };
}

function normalizeSession(value: unknown): SessionRecord | null {
  if (!isRecord(value) || value.id == null) return null;
  return {
    ...value,
    id: String(value.id),
    chatKey: String(value.chatKey ?? ''),
    startedAt: Number(value.startedAt) || 0,
    endedAt: value.endedAt == null ? null : Number(value.endedAt) || null,
    status: String(value.status ?? ''),
    usage: normalizeUsage(value.usage)
  } as SessionRecord;
}
