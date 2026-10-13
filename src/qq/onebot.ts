// OneBot v11 客户端：WebSocket 只收事件，HTTP API 负责发送与查询。
// （原版经 @snowluma/sdk 收事件；这里直接实现标准 OneBot v11，去掉 SDK 补丁依赖。）
import WebSocket from 'ws';
import { sanitizeUserText, escapeCqText } from '../core/util.js';
import type { OneBotEvent, OneBotSegment } from './types.js';

type EventHandler = (event: OneBotEvent) => void;
type StatusHandler = (status: { connected: boolean; everConnected: boolean; error: string }) => void;
type MessageKind = 'group' | 'private' | string;
type SendOptions = { replyToMessageId?: unknown; atUserId?: unknown };

/**
 * **图片段**（表情与模型画出来的图）的响应超时。
 *
 * ⚠️ 它不能吃 `call()` 的 15 秒默认值 —— 那 15 秒是给"发一条文本 / 查一次资料"定的，
 * 而图片段要协议端先读本机文件、再传到 QQ 的图床。真机实测（2026-10-10，一台 VPS）
 * 稳定超过 15 秒，于是**每一次出图都死在最后一步**，而协议端其实已经在传了：
 * 群里先收到一句「画图失败」，紧接着那张图又到了 —— 一个纯粹由超时太短造成的假失败。
 *
 * 取 120 秒与转写的 `upload_group_file` 同一口径（上传是慢操作，超时要给足）。
 * 代价是协议端真的卡住时，该会话的发送链要等这么久才轮到下一条 —— 这是有意的取舍：
 * 宁可等，也不要对着一条已经在传的图说它失败了。
 */
export const SEGMENT_UPLOAD_TIMEOUT_MS = 120_000;

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/**
 * `send_poke` 是旧 OneBot 实现的兼容动作。只有服务端明确不认识较新的
 * `group_poke` / `friend_poke` 时才值得换用它；把业务拒绝（例如 QQ 服务端
 * 拒绝本次拍一拍）也重试一遍，只会造成一次无意义的第二次外部请求，并掩盖
 * 实际失败动作。
 */
function isUnsupportedActionError(error: unknown): boolean {
  const message = errorText(error);
  return /\bHTTP 404\b|\bretcode=1404\b|unsupported action|action not found/i.test(message);
}

const RECONNECT_MIN_MS = 3000;
// RECONNECT_MAX_MS = 30000 曾在这里，零引用（设计稿附录 C），S11b 删除。
// 不做指数退避是有意的：本机回环、3s 常量足够，退避会改掉重连的可观察行为。

/**
 * 端点字段的归一化规则，**构造函数与 `applyEndpoint()` 共用同一份**。
 * 共用不是为了少写两行：配置刷新时要回答"这个字段到底变了没有"，
 * 而只要归一化规则在比较的那一侧另写一份，`http://127.0.0.1:3000/` 与
 * `http://127.0.0.1:3000` 就会被判成变更 —— 用户每保存一次设置就断一次连接。
 * 空地址回落到默认值（构造函数从来就表示不了"空地址"，实例字段不该被置成空串）。
 */
function normalizeWsUrl(value: unknown): string { return String(value || 'ws://127.0.0.1:3001'); }
function normalizeHttpUrl(value: unknown): string { return String(value || 'http://127.0.0.1:3000').replace(/\/+$/, ''); }

export class OneBotClient {
  wsUrl: string;
  httpUrl: string;
  accessToken: string;
  httpToken: string;
  onEvent: EventHandler;
  socket: WebSocket | null;
  connected: boolean;
  everConnected: boolean;
  lastConnectError: string;
  selfInfo: Record<string, unknown> | null;
  statusListeners: Set<StatusHandler>;

  constructor({ wsUrl, httpUrl, accessToken, httpToken, onEvent }: { wsUrl?: unknown; httpUrl?: unknown; accessToken?: unknown; httpToken?: unknown; onEvent?: EventHandler }) {
    this.wsUrl = normalizeWsUrl(wsUrl);
    this.httpUrl = normalizeHttpUrl(httpUrl);
    this.accessToken = String(accessToken || '');
    // SnowLuma 允许给 WS 与 HTTP 配不同令牌；httpToken 缺省沿用 accessToken
    this.httpToken = String(httpToken || accessToken || '');
    this.onEvent = onEvent || (() => { });
    this.socket = null;
    this.connected = false;
    this.everConnected = false;
    this.lastConnectError = '';
    this.selfInfo = null;      // { user_id, nickname }
    this.#closedByUs = false;
    this.statusListeners = new Set();
  }

  #closedByUs: boolean;

  /**
   * 待触发的重连定时器句柄。非 null ⟺ 有一次重连已经排定、还没触发。
   * 存句柄是为了让 close()/connect()/reconnect() 能取消掉那一次：不存的话，
   * 迟到的定时器会再进 #connectLoop 建第二个 WebSocket 覆盖 this.socket，
   * 旧 socket 就再也没人关了（connect/reconnect 刚作废的那一个反而漏掉）。
   * **刻意不 unref**：有重连待办时钉住进程是对的，unref 会让进程在等待重连期间可退出。
   */
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  onStatus(fn: StatusHandler) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  #setStatus(connected: boolean) {
    this.connected = connected;
    if (connected) this.everConnected = true;
    for (const fn of this.statusListeners) {
      try { fn({ connected, everConnected: this.everConnected, error: this.lastConnectError }); } catch { /* ignore */ }
    }
  }

  /**
   * 排定下一次重连。**先清旧、再存新**：重复排定时旧句柄必须作废，
   * 否则它会按旧的时间点触发一次多余的重连，而新句柄从此再也取消不掉它。
   */
  #scheduleReconnect() {
    this.#cancelReconnect();
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null; // 触发即失效，保持"非 null ⟺ 有待办"这条不变量
      this.#connectLoop();
    }, RECONNECT_MIN_MS);
  }

  /** 取消"已排定但尚未触发"的那一次重连。幂等。 */
  #cancelReconnect() {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  async connect() {
    this.#closedByUs = false;
    // 上一次连接留下的重连排定要一起作废：它会在新连接建好之后再建一个 socket
    // 覆盖 this.socket，而新 socket 之外的那个就再也没人关了。
    this.#cancelReconnect();
    this.#connectLoop();
  }

  /** 连接配置可能变了（比如从 SnowLuma 配置同步到了新令牌），重连一次。 */
  async reconnect() {
    // 关键：先作废旧 socket，再启新连接。否则旧 socket 的 close 事件稍后到达时
    // 会误以为需要再次重连，造成两个 WebSocket 同时连着 SnowLuma，所有事件收到两份。
    const old = this.socket;
    this.socket = null;
    this.#closedByUs = false;
    // 同一个病的另一半：待触发的重连定时器也要作废，否则它同样会再建一个 socket。
    this.#cancelReconnect();
    try { old?.close(); } catch { /* ignore */ }
    this.#connectLoop();
  }

  /**
   * 把配置里的端点字段应用到实例上（配置刷新用，S11b）。返回**是否有字段真的变了** ——
   * 调用方据此决定要不要 `reconnect()`：不变也重连的话，用户每保存一次设置都会断开一次
   * WebSocket（面板上状态灯乱闪、正在收的事件丢一帧），而这完全没必要。
   *
   * 三条规则：
   *   • `undefined` = 这个字段不动。配置里没有这一项，不等于要把它清空。
   *   • 其余值走**与构造函数同一份归一化**（见 `normalizeWsUrl` / `normalizeHttpUrl`），
   *     所以尾斜杠差异不算变更、空地址回落到默认值。
   *   • 令牌是**真的清空**（构造函数对令牌也是 `String(v || '')`，空令牌本来就表示免鉴权）。
   *     注意 httpToken 与 accessToken 的"留空沿用"配对规则在调用方（`app.ts`），
   *     这里只管单个字段：它不该知道"httpAccessToken 为空时该用哪个 token"。
   *
   * 只改实例字段：**不重连、不发事件、不动已建的 socket**。重连与否是调用方的决策——
   * `app.ts` 的 `applyConfigPatch` 比较后调 `reconnect()`，`start()` 只是补 URL（还没有连接）。
   */
  applyEndpoint(next: { wsUrl?: unknown; httpUrl?: unknown; accessToken?: unknown; httpToken?: unknown }): boolean {
    let changed = false;
    if (next.wsUrl !== undefined) {
      const value = normalizeWsUrl(next.wsUrl);
      if (value !== this.wsUrl) { this.wsUrl = value; changed = true; }
    }
    if (next.httpUrl !== undefined) {
      const value = normalizeHttpUrl(next.httpUrl);
      if (value !== this.httpUrl) { this.httpUrl = value; changed = true; }
    }
    if (next.accessToken !== undefined) {
      const value = String(next.accessToken || '');
      if (value !== this.accessToken) { this.accessToken = value; changed = true; }
    }
    if (next.httpToken !== undefined) {
      const value = String(next.httpToken || '');
      if (value !== this.httpToken) { this.httpToken = value; changed = true; }
    }
    return changed;
  }

  #connectLoop() {
    // 第二道闸门：第一道是 close()/connect()/reconnect() 里已经取消掉待触发的重连，
    // 正常情况下走不到这里。留着是因为"不再建 socket"这条不变量不该依赖
    // "每个排定重连的地方都记得判一次 #closedByUs"。
    if (this.#closedByUs) return;
    let url = this.wsUrl;
    if (this.accessToken) url += (url.includes('?') ? '&' : '?') + `access_token=${encodeURIComponent(this.accessToken)}`;
    let socket;
    try {
      socket = new WebSocket(url, {
        headers: this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}
      });
    } catch (error) {
      this.lastConnectError = errorText(error);
      this.#setStatus(false);
      this.#scheduleReconnect();
      return;
    }
    this.socket = socket;
    // 每个 socket 的事件处理器都先验证“我还是不是当前 socket”，
    // 旧连接被作废后其迟到事件直接忽略，避免重复重连/状态错乱。
    const isCurrent = (s: WebSocket) => this.socket === s;

    socket.on('open', async () => {
      if (!isCurrent(socket)) return;
      this.lastConnectError = '';
      this.#setStatus(true);
      try {
        const info = await this.call('get_login_info');
        this.selfInfo = isRecord(info) ? info : null;
      } catch (error: unknown) {
        console.error('[onebot] 获取登录信息失败:', errorText(error));
      }
    });
    socket.on('message', (data) => {
      if (!isCurrent(socket)) return;
      let event: unknown = null;
      try { event = JSON.parse(String(data)); } catch { return; }
      if (!isRecord(event)) return;
      try { this.onEvent(event as OneBotEvent); } catch (error) { console.error('[onebot] 事件处理出错:', error); }
    });
    socket.on('close', () => {
      if (!isCurrent(socket)) return; // 旧连接的迟到 close：新连接已在处理
      this.#setStatus(false);
      if (!this.#closedByUs) this.#scheduleReconnect();
    });
    socket.on('error', (error) => {
      if (!isCurrent(socket)) return;
      this.lastConnectError = errorText(error);
      if (!this.everConnected) {
        // 首连失败退避得久一点，避免刷屏
        this.#setStatus(false);
      }
    });
  }

  close() {
    this.#closedByUs = true;
    // 真正的"停"：不只要停止排定新的重连，还要撤掉已经排定的那一次。
    // 只置 #closedByUs 的话那个定时器仍然活着，会白钉住事件循环最多 RECONNECT_MIN_MS。
    this.#cancelReconnect();
    const old = this.socket;
    this.socket = null;
    try { old?.close(); } catch { /* ignore */ }
    this.#setStatus(false);
  }

  /** OneBot HTTP API（发送与查询都走这里）。 */
  async call(action: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<unknown> {
    const res = await fetch(`${this.httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.httpToken ? { authorization: `Bearer ${this.httpToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      const hint = res.status === 426
        ? '（HTTP 426：httpUrl 可能指向了 WebSocket 端口，请检查 snowluma.httpUrl 是否为 OneBot HTTP API 地址）'
        : '';
      throw new Error(`OneBot ${action} HTTP ${res.status}${hint}`);
    }
    const value: unknown = await res.json().catch(() => ({}));
    const body = isRecord(value) ? value : {};
    if (body.status !== 'ok' && body.retcode !== 0) {
      throw new Error(`OneBot ${action} 失败: retcode=${body.retcode ?? body.status} ${body.wording ?? ''}`);
    }
    return body.data;
  }

  get selfId() {
    return this.selfInfo?.user_id != null ? String(this.selfInfo.user_id) : '';
  }

  get selfNickname() {
    return this.selfInfo?.nickname ? String(this.selfInfo.nickname) : '';
  }

  /** 发送消息段。返回 OneBot 响应 data（含 message_id）。 */
  async sendSegments(kind: MessageKind, id: unknown, segments: OneBotSegment[], timeoutMs?: number) {
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private'
      ? { user_id: Number(id), message: segments }
      : { group_id: Number(id), message: segments };
    return this.call(action, params, timeoutMs);
  }

  async sendText(kind: MessageKind, id: unknown, text: unknown, { replyToMessageId = null, atUserId = null }: SendOptions = {}) {
    const segments: OneBotSegment[] = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    segments.push({ type: 'text', data: { text: escapeCqText(String(text ?? '')) } });
    return this.sendSegments(kind, id, segments);
  }

  /**
   * 发送一张图片（本机绝对路径或公网 URL）。返回 OneBot 响应 data（含 message_id）。
   *
   * 表情与"模型画出来的图"发的是**同一种消息段**，所以只有这一份实现；
   * `sendSticker` 只是它的旧名字（委托过来），保留是因为既有调用点都按那个语义读得通。
   * 分开命名是为了让调用点自己说清楚发的是什么 —— 在 sender.ts 里出现
   * `sendSticker(…一张生成的画…)` 是会让人停下来重读三遍的那种代码。
   *
   * ⚠️ 超时用 `SEGMENT_UPLOAD_TIMEOUT_MS`，**不能吃 `call` 的 15 秒默认值**（见那个常量的注释）。
   */
  async sendImage(kind: MessageKind, id: unknown, file: unknown, { replyToMessageId = null, atUserId = null }: SendOptions = {}) {
    const segments: OneBotSegment[] = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    segments.push({ type: 'image', data: { file: String(file) } });
    return this.sendSegments(kind, id, segments, SEGMENT_UPLOAD_TIMEOUT_MS);
  }

  async sendSticker(kind: MessageKind, id: unknown, imageUrl: unknown, options: SendOptions = {}) {
    return this.sendImage(kind, id, imageUrl, options);
  }

  async sendPoke(kind: MessageKind, id: unknown, targetUserId: unknown) {
    if (kind === 'private') {
      try {
        return await this.call('friend_poke', { user_id: Number(id) });
      } catch (error) {
        if (!isUnsupportedActionError(error)) throw error;
        return this.call('send_poke', { user_id: Number(id) });
      }
    }
    const params = { group_id: Number(id), user_id: Number(targetUserId || id) };
    try {
      return await this.call('group_poke', params);
    } catch (error) {
      if (!isUnsupportedActionError(error)) throw error;
      return this.call('send_poke', params);
    }
  }

  async getMsg(messageId: unknown) {
    return this.call('get_msg', { message_id: Number(messageId) });
  }

  async getGroupInfo(groupId: unknown) {
    return this.call('get_group_info', { group_id: Number(groupId) });
  }

  async getGroupMemberInfo(groupId: unknown, userId: unknown) {
    return this.call('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId) });
  }

  /**
   * 展开一条合并转发，返回节点数组（可能是空数组 —— 那表示这条转发确实没内容）。
   *
   * ⚠️ 参数形态是踩过坑的。实测（2026-09-22，SnowLuma，群 623820457）：
   *   get_forward_msg { message_id: -1563345974 }        → retcode=100 "download forward message payload is empty"
   *   get_forward_msg { id: "e4C6ZyYg…"（转发段的 id）}  → 正常返回全部节点
   * 即**认 res_id、不认 message_id**，且 res_id 并不像旧注释说的那样会过期。
   * 旧注释把这个因果记反了（原话："只认 message_id；res_id 会过期，报 payload is empty"），
   * 据此写出的两处调用（app.js 的入库展开、tools.js 的 read_forward）**从来没成功过** ——
   * 后果是每条收到的合并转发都只留下占位符，正文永远进不了存档。
   *
   * 这里 res_id 优先、message_id 兜底：别的协议端（如 NapCat）可能只认后者，
   * 代价仅是前者失败时多一次请求。
   */
  async getForwardNodes({ resId = '', messageId = null }: { resId?: unknown; messageId?: unknown } = {}) {
    const attempts: Array<Record<string, unknown>> = [];
    if (resId) attempts.push({ id: String(resId) });
    if (messageId !== null && messageId !== undefined && String(messageId).trim() !== '') {
      attempts.push({ message_id: Number(messageId) });
    }
    if (!attempts.length) throw new Error('没有可用的转发 id（res_id 与 message_id 都没有）');
    let lastError: unknown = null;
    for (const params of attempts) {
      try {
        const r = await this.call('get_forward_msg', params);
        // 接口成功就以它为准：节点为空说明这条转发确实没内容，
        // 换另一种参数重试只会拿到更含糊的错误、把真正的原因盖掉。
        const root = isRecord(r) ? r : {};
        const nested = isRecord(root.data) ? root.data : {};
        return Array.isArray(root.messages) ? root.messages : (Array.isArray(nested.messages) ? nested.messages : []);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error('展开合并转发失败');
  }

  /**
   * 取群公告列表（正文在这里，不在卡片里）。
   *
   * ⚠️ action 名要回退：go-cqhttp 是 `get_group_notice`，更老的实现叫 `_get_group_notice`
   *   （带下划线的私有动作名）。SnowLuma 认哪一个没有实测过，所以两个都试。
   *   与 getForwardNodes 同理：接口成功就以它为准，不再往下试 —— 换名字重试只会拿到
   *   更含糊的错误，把真正的原因盖掉（"这个群没有公告" 和 "协议端不支持" 是两回事）。
   *
   * 返回统一成 [{ id, senderId, publishTime, text, imageCount }]：
   *   publishTime 是毫秒时间戳（各实现对秒/毫秒不一致，这里统一归一化）。
   * 取不到内容的条目会被丢掉（有的实现会给一堆只有 id 的空壳）。
   *
   * 正文与聊天记录同等不可信（公告是群管理员发的，但接口返回的内容仍当作外部输入处理）：
   * 过一遍 sanitizeUserText、去掉控制字符、按 NOTICE_TEXT_MAX 截断。
   */
  async getGroupNotice(groupId: unknown) {
    let lastError: unknown = null;
    // "接口答了但字段对不上" 要单独记：它和 "协议端不支持这个 action" 是两回事，
    // 而且更接近真相 —— 后者只是别名没试对，前者说明版本有差异。若共用 lastError，
    // 第二个 action 的 1404 会把结构错误覆盖掉，最后报出去的就是最没用的那句话。
    let shapeError: Error | null = null;
    for (const action of ['get_group_notice', '_get_group_notice']) {
      let data: unknown;
      try {
        data = await this.call(action, { group_id: Number(groupId) });
      } catch (error) {
        lastError = error;
        continue;
      }
      // 见过的三种形态：直接数组 / { notices: [...] } / 再套一层 data。
      // ⚠️ "认不出结构" 必须和 "确实是空列表" 分开：前者若也返回 []，调用方会当成
      //    "这个群没有公告" 自信地答错。认不出就换下一个 action 试，都认不出才报错。
      const root = isRecord(data) ? data : {};
      const list = Array.isArray(data) ? data
        : (Array.isArray(root.notices) ? root.notices
          : (Array.isArray(root.data) ? root.data : null));
      if (list === null) {
        const shape = (data && typeof data === 'object') ? Object.keys(data).join(',') || '空对象' : typeof data;
        shapeError ??= new Error(`OneBot ${action} 返回了无法识别的结构（字段：${shape}）`);
        continue;
      }
      return list.map((value) => {
        const n = isRecord(value) ? value : {};
        const message = isRecord(n.message) ? n.message : {};
        const rawField = isTextValue(message.text) ? message.text
          : (isTextValue(n.content) ? n.content : '');
        const raw = decodeBase64Text(rawField) || String(rawField);
        // 控制字符（\u0000 之类）会污染提示词；换行保留（公告常是条目式的），
        // 但三个以上连续换行折成两个，免得一大段空行把上下文撑开。
        const text = clipText(
          sanitizeUserText(raw).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n'),
          NOTICE_TEXT_MAX
        );
        // 有的实现时间是秒，有的是毫秒；小于 1e12 当秒处理（2026 年的毫秒时间戳远大于它）
        let ts = Number(n?.publish_time ?? n?.publishTime ?? 0) || 0;
        if (ts > 0 && ts < 1e12) ts *= 1000;
        const images = message.images ?? n.images;
        return {
          id: String(n?.notice_id ?? n?.id ?? ''),
          senderId: String(n?.sender_id ?? n?.senderId ?? ''),
          publishTime: ts,
          text,
          imageCount: Array.isArray(images) ? images.length : 0
        };
      }).filter((n) => n.text);
    }
    throw shapeError ?? lastError ?? new Error('取群公告失败');
  }
}

// ── 入站事件 → 文本（移植自原版 segmentsToText） ─────────────────────────

export function forwardIdFromData(value: unknown) {
  const d = isRecord(value) ? value : {};
  const raw = d.id ?? d.res_id ?? d.forward_id ?? d.data_id;
  if (raw == null || String(raw).trim() === '') return null;
  return String(raw);
}

/**
 * 把 OneBot 消息段数组转成 AI 可读的纯文本。
 * resolveAtName: async (qq) => string | null —— 把 @ 的 QQ 号解析成群名片。
 *
 * **引用段不在这一层解析**：`includeReply:false` 时整个 reply 段被跳过（调用方会把它
 * 结构化地存进 `ChatMessage.reply`，渲染时再拼成 `[引用 #id 谁：什么]`）；为 true 时只留
 * 一个 `[引用消息]` 占位符，供合并转发这类**没有存档条目**的场合说明"这里有个引用"。
 * 早先这里还有一个 `resolveReply` 回调，让这一层去取被引用消息的正文 —— 那条路会把
 * 被引用消息的 **id 吃掉**（预览串里没有它），模型于是无法寻址被引用的那张图/那条消息。
 * 现在正文与 id 一起在 `Ingest.resolveReply` 里取，形式化的关系存在存档里。
 */
export async function segmentsToText(segments: OneBotSegment[] | string | null | undefined, { resolveAtName = null, includeReply = true }: { resolveAtName?: ((qq: string) => Promise<string | null>) | null; includeReply?: boolean } = {}) {
  if (typeof segments === 'string') return sanitizeUserText(segments.trim());
  const out: string[] = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(String(d.text ?? '')); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      case 'image': out.push('[图片]'); break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        if (includeReply) out.push('[引用消息]');
        break;
      }
      case 'json': out.push(parseCardSegment(d).text); break;
      case 'forward': {
        // 文本里不带 res_id：模型该用的是消息前的 #数字（read_forward 会自己去取 res_id）。
        // 实测 res_id 并不会过期（旧注释说"会过期"是记反了），但一串 70 字符的长 id 印在
        // 聊天记录里只会误导模型拿它当参数。res_id 存在 media 里（kind:'forward'）。
        out.push('[合并转发聊天记录]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return sanitizeUserText(out.join('').trim());
}

// ── 卡片消息（json 段）解析 ──────────────────────────────────────────────
// OneBot 的 json 段是 { type:'json', data:{ data: <JSON字符串|对象> } }，解析出来是
// 一张卡片报文：app（模板）/ view（展示形态）/ prompt（无法展示时的兜底文字）/ meta
// （按卡片类型再嵌一层，如 meta.music / meta.news，含 title/desc/jumpUrl/preview/tag）。
//
// ⚠️ 卡片报文是完全由群成员伪造的不可信输入，且会进系统提示词，所以：
//   1. 只按白名单取字段 —— 绝不把卡片对象展开进任何对象（防 __proto__ 原型污染）
//   2. 绝不在这里请求卡片里的 URL —— jumpUrl / preview 只作为文本和存档输出。
//      要看内容由模型自己决定 web_fetch（那里有 safe-fetch 的 SSRF 防护）；
//      否则任何群友发一张卡片就能让本机去请求任意地址（内网探测 / DNS rebinding）。
//   3. 折叠空白 —— 卡片 title 里若含换行，会伪造出整行假历史
//      （formatEntry 把 text 原样拼进行里）。这里沿用 expandForwardNodes 的同款做法。
const CARD_MAX_CHARS = 32 * 1024;   // 超过就不解析了，走 prompt 兜底
const CARD_FIELD_MAX = 120;
const CARD_URL_MAX = 300;
const CARD_TEXT_MAX = 300;
// base64 解码命中时的上限，比 CARD_FIELD_MAX 宽得多：群公告的正文经常直接躺在
// 卡片 title 里（几百字），用 120 截掉就只剩个开头。普通字段仍走 CARD_FIELD_MAX。
const CARD_DECODED_MAX = 800;
// 单条群公告正文的上限。接口返回的内容长度完全由服务端决定，不设限的话一条超大公告
// 就能把一次运行的上下文吃掉。
const NOTICE_TEXT_MAX = 1500;

/** 只认字符串/数字，挡掉对象（否则 String({}) 会把 [object Object] 塞进提示词）。 */
function isTextValue(v: unknown): v is string | number {
  return typeof v === 'string' || typeof v === 'number';
}

// 判断"解码出来是不是中文文本"用的 CJK 区间（含全角标点，公告正文里 、。： 很常见）。
const CJK_RE = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

/**
 * 把"看起来是 UTF-8 base64 的字符串"解回明文，解不出来返回 ''。
 *
 * 为什么需要它：QQ 的 Ark 卡片（尤其是群公告）把中文字段用 base64 塞在 title/desc 里。
 * 不解码的话，存档和系统提示词里看到的是 `标题：576k5YWs5ZGK` 这种东西 —— 人和模型都读不懂。
 *
 * 判定刻意收得很紧，宁可漏判也不能误伤普通标题：
 *   1. 长度 ≥8 且是 4 的倍数，字符集就是标准 base64
 *   2. 解码后**再编回 base64 必须与原文一致** —— Buffer.from 对非法输入是宽松的
 *      （会静默丢弃不认识的字符），不校验的话 "abc!!" 之类的垃圾也会被"解出"东西
 *   3. 严格 UTF-8 解码（fatal），拒绝任何非法字节序列
 *   4. **必须含 CJK 字符** —— QQ 里被 base64 的都是中文内容；这道门挡掉"恰好是合法
 *      base64 的英文串"（实测 "aGVsbG8gd29ybGQ=" 解出来是 "hello world"，会被正确拒绝）
 *   5. 不含控制字符（会污染提示词格式）
 *
 * @param {*} s 待判定的值（非字符串直接放弃）
 * @returns {string} 解码后的明文；未命中返回 ''
 */
export function decodeBase64Text(s: unknown) {
  if (!isTextValue(s)) return '';
  const t = String(s).trim();
  if (t.length < 8 || t.length % 4 !== 0) return '';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return '';
  let buf;
  try { buf = Buffer.from(t, 'base64'); } catch { return ''; }
  if (!buf.length) return '';
  // 往返校验：不这样写的话非法输入会被宽松解码成别的东西
  if (buf.toString('base64').replace(/=+$/, '') !== t.replace(/=+$/, '')) return '';
  let out;
  try { out = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return ''; }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(out)) return '';
  if (!CJK_RE.test(out)) return '';
  return out;
}

/** 取文本字段：折叠空白 + 按码点截断（避免把代理对切成乱码）。 */
function textField(value: unknown, max: number) {
  if (!isTextValue(value)) return '';
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('') + '…';
}

/**
 * 只截断、**不折叠空白**（按码点，避免切坏代理对）。
 *
 * 与 textField 的区别是保留换行。给群公告正文用：公告常是条目式的，折成一行会读不懂；
 * 而它进的是工具结果的 JSON（`JSON.stringify(payload, null, 1)` 会把换行转义成 \n），
 * 伪造不出"整行假历史"，所以这里不需要 textField 那道折叠防线的保护。
 */
function clipText(value: unknown, max: number) {
  const s = String(value ?? '').trim();
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('') + '…';
}

/**
 * 卡片文本字段：**先解码再截断**。
 *
 * ⚠️ 顺序不能反。textField 会按 CARD_FIELD_MAX 截断，而 base64 一旦被截断就再也不是
 *    合法编码（长度不是 4 的倍数）—— 先截后解等于永远解不开。所以这里先拿原始值去解码，
 *    命中就用解密文（放宽到 CARD_DECODED_MAX），未命中才回退原值按 CARD_FIELD_MAX 处理。
 */
function cardTextField(value: unknown, max = CARD_FIELD_MAX) {
  const decoded = decodeBase64Text(value);
  return decoded ? textField(decoded, CARD_DECODED_MAX) : textField(value, max);
}

/** 只收 http/https：mqqapi:// 小程序链接、javascript: 等一律丢弃。 */
function httpUrlField(value: unknown) {
  const s = textField(value, CARD_URL_MAX);
  if (!s) return '';
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.toString() : '';
  } catch { return ''; }
}

/**
 * 从 meta 里挑出承载正文的子对象。
 * 常见形态是 meta.music / meta.news / meta.miniapp 再嵌一层；也有协议端把
 * title/desc 直接挂在 meta 上。只下探一层 —— 再深就是小程序自己的私有结构。
 */
function firstCardBody(meta: unknown): Record<string, unknown> | null {
  if (!isRecord(meta)) return null;
  const looksLikeBody = (v: unknown): v is Record<string, unknown> => isRecord(v)
    && Boolean(textField(v.title, 1) || textField(v.desc, 1) || textField(v.jumpUrl, 1));
  if (looksLikeBody(meta)) return meta;
  for (const key of Object.keys(meta)) {
    if (looksLikeBody(meta[key])) return meta[key] as Record<string, unknown>;
  }
  return null;
}

/**
 * 把 json 卡片段解析成可读文本 + 媒体（纯函数，便于测试）。
 * 解析不出内容时 text 保持 '[卡片消息]'（与旧行为一致，模型会如实说看不到）。
 *
 * @param {object} data json 段的 data（形如 { data: <JSON字符串|对象> }）
 * @returns {{ text: string, media: Array }}
 */
export function parseCardSegment(value: unknown): { text: string; media: Array<Record<string, unknown>> } {
  const fallback: { text: string; media: Array<Record<string, unknown>> } = { text: '[卡片消息]', media: [] };
  const data = isRecord(value) ? value : {};
  const raw = data.data;
  let card: Record<string, unknown> | null = null;

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    card = raw as Record<string, unknown>;   // 有的协议端直接给已解析好的对象
  } else {
    const str = isTextValue(raw) ? String(raw) : '';
    if (!str || str.length > CARD_MAX_CHARS) return fallback;
    try {
      const parsed = JSON.parse(str);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
      card = parsed as Record<string, unknown>;
    } catch { return fallback; }
  }

  const app = textField(card.app, 60);
  const view = textField(card.view, 40);
  const body = firstCardBody(card.meta);
  // title/desc 走 cardTextField：QQ 的群公告卡片把它们做成了 UTF-8 的 base64
  // （title 通常是 "576k5YWs5ZGK" = "群公告"），直接显示就是一段乱码。
  const title = cardTextField(body?.title);
  const desc = cardTextField(body?.desc);
  const tag = textField(body?.tag, 40);
  const url = httpUrlField(body?.jumpUrl);
  const preview = httpUrlField(body?.preview);
  // 协议端给的兜底文字，两种形态都见过：明文 "[群公告]"，或同样被 base64 过
  const prompt = cardTextField(card.prompt);

  // 群公告走独立分支：它虽然也是卡片，但**正文根本不在卡片里**（title 解出来只有
  // "群公告"三个字，那只是个标签）。正文得靠 read_group_notice 调 OneBot 接口去取，
  // 所以这里必须给出一个可辨认的占位符，不能落进下面通用的 [卡片 xxx] 渲染 ——
  // 否则模型会以为卡片里的链接就是全部内容，跑去 web_fetch 白跑一趟。
  // 识别按"从确定到宽松"：app 模板名最可靠，退到 prompt，再退到标题恰好是"群公告"。
  //
  // ⚠️ prompt 的实际形态是 "[群公告]"（带方括号），同族卡片还见过【群公告】/（群公告）。
  //    不剥掉外层括号直接比 '群公告' 的话，这级兜底永远不会命中（实测），所以先归一化。
  const promptPlain = prompt.replace(/^[\s[【（(]+/, '').replace(/[\s\]】）)]+$/, '');
  const isAnnounce = /announce/i.test(String(card.app ?? ''))
    || promptPlain === '群公告'
    || title === '群公告';
  // 封面单独作为 image 并存（两条分支共用同一份）：get_message_images 的筛选条件就是
  // kind==='image' && url，不改一行代码模型就能看到卡片封面。
  const media: Array<Record<string, unknown>> = [{ kind: 'card', app, view, title, desc, url, tag }];
  if (preview) media.push({ kind: 'image', url: preview, summary: '卡片封面' });
  if (isAnnounce) {
    // title 解出来往往就是"群公告"这个标签本身，带上它只会得到"标题：群公告"这种废话；
    // 只有当它确实多说了点什么（少数协议端会把正文塞进 title）才附上。
    const extra = [title, desc].filter((v) => v && v !== '群公告');
    return {
      text: textField(`[群公告] 检测到一条群公告${extra.length ? `：${extra.join(' ｜ ')}` : ''}（正文用 read_group_notice 查看）`, CARD_TEXT_MAX),
      media
    };
  }

  if (!title && !desc && !url) {
    // 白名单字段全空 → 退回 prompt（协议端准备的"无法展示卡片时的文字"，形如 [QQ小程序]xxx）
    return prompt ? { text: `[卡片 ${prompt}]`, media: [] } : fallback;
  }

  // 展示名：优先 tag（"QQ音乐"/"网易云音乐"），退到 view，再退到 app 的末段
  const label = tag || view || textField(String(app).split('.').pop(), 30);
  const bits: string[] = [];
  if (title) bits.push(`标题：${title}`);
  if (desc && desc !== title) bits.push(`描述：${desc}`);
  if (url) bits.push(`链接：${url}`);
  return { text: textField(`[卡片${label ? ' ' + label : ''}] ${bits.join(' ｜ ')}`, CARD_TEXT_MAX), media };
}

/** 从消息段提取媒体定位信息（不下载）。 */
export function extractMediaFromSegments(segments: unknown): Array<Record<string, unknown>> {
  const media: Array<Record<string, unknown>> = [];
  for (const value of Array.isArray(segments) ? segments : []) {
    if (!isRecord(value)) continue;
    const seg = value;
    const d = isRecord(seg.data) ? seg.data : {};
    if (seg.type === 'image') {
      media.push({ kind: 'image', file: String(d.file ?? ''), url: String(d.url ?? ''), summary: String(d.summary ?? '') });
    } else if (seg.type === 'face') {
      media.push({ kind: 'face', faceId: String(d.id ?? '') });
    } else if (seg.type === 'record') {
      // 语音。**与 image 同形**（`file` / `url` 两栏），但它多一栏 `text`：有些协议端会
      // 自带服务端语音转文字的结果，那一栏是白拿的信息，存下来省一次识别（与 image 存
      // `summary` 同一个理由）。按 OneBot v11 规范 `url` 可能不存在或会过期，所以
      // **没有 url 时不产出条目** —— 一条没有地址的 `kind:'audio'` 只会让下游白找一轮。
      const url = String(d.url ?? '').trim();
      if (url) {
        media.push({
          kind: 'audio',
          file: String(d.file ?? ''),
          url,
          ...(String(d.magic ?? '') ? { magic: String(d.magic) } : {}),
          // 协议端自带的转写文本（可能为空）。**不参与任何判据**，只是可用的补充信息。
          ...(String(d.text ?? '').trim() ? { text: String(d.text).trim() } : {})
        });
      }
    } else if (seg.type === 'forward') {
      // 存下 res_id：get_forward_msg 认它、不认 message_id（见 getForwardNodes），
      // 存了就不必再花一次 get_msg 去取；顺带让这条消息在提示词里带上 #id，
      // 模型更容易瞄对目标。这项没有 url/file，取图逻辑会自动跳过它。
      const id = forwardIdFromData(d);
      if (id) media.push({ kind: 'forward', id });
    } else if (seg.type === 'json') {
      // 卡片：结构化字段 + 封面图（封面已在 parseCardSegment 里拆成 kind:'image'）
      media.push(...parseCardSegment(d).media);
    }
  }
  return media;
}

/**
 * 展开合并转发节点为可读文本（纯函数，便于测试）。
 *
 * 背景：OneBot 事件里的 forward 段只带一个 res_id，
 * 需要 get_forward_msg 拿回节点数组（本函数处理的就是这个数组）。
 * 取节点请用 OneBotClient.getForwardNodes —— 它认 res_id、不认 message_id，
 * 参数形态的实测记录见那个方法的注释。
 *
 * 规则：
 *   - 每个节点一行「昵称: 内容」，内容复用 segmentsToText（@/图片/表情等占位一致）
 *   - 嵌套转发不再展开（深度 1 封顶，套娃截断）
 *   - 封顶：maxNodes 条 / maxChars 字符，超出注明"还有 N 条未展开"
 *   - 节点里的图片段同时提取到 media（url 新鲜，可用于取图）
 *
 * @param {Array} nodes get_forward_msg 返回的 messages 数组
 * @returns {{ text: string, media: Array } | null} 无可用节点返回 null
 */
export async function expandForwardNodes(nodes: unknown, { maxNodes = 30, maxChars = 3000 }: { maxNodes?: number; maxChars?: number } = {}) {
  if (!Array.isArray(nodes) || !nodes.length) return null;
  const lines: string[] = [];
  const media: Array<Record<string, unknown>> = [];
  let truncated = 0;

  for (let i = 0; i < nodes.length; i++) {
    if (lines.length >= maxNodes) { truncated = nodes.length - i; break; }
    const n = isRecord(nodes[i]) ? nodes[i] : {};
    const sender = isRecord(n.sender) ? n.sender : {};
    const name = String(sender.card || sender.nickname || n.user_id || '?');
    const nm = n.message ?? n.content;
    let body = '';
    if (typeof nm === 'string') {
      // 字符串形态一般是 CQ 码原文，剥掉 [CQ:xxx] 段保留纯文本
      body = nm.replace(/\[CQ:[^\]]*\]/g, '').trim();
    } else if (Array.isArray(nm)) {
      // 嵌套 forward 段清空 data → segmentsToText 输出 [转发消息] 占位（深度 1 封顶）
      const segs: OneBotSegment[] = nm.map((value) => {
        const segment = isRecord(value) ? value : {};
        return segment.type === 'forward' ? { type: 'forward', data: {} } : { type: String(segment.type ?? 'unknown'), data: isRecord(segment.data) ? segment.data : {} };
      });
      body = await segmentsToText(segs, {});
      media.push(...extractMediaFromSegments(segs));
    }
    body = body.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!body) continue;
    lines.push(`${name}: ${body}`);
    if (lines.join('\n').length > maxChars) { truncated = nodes.length - i - 1; break; }
  }

  const head = `[合并转发 共${nodes.length}条]`;
  if (!lines.length) return { text: head, media };
  const tail = truncated > 0 ? `\n…（还有 ${truncated} 条未展开）` : '';
  return { text: `${head}\n${lines.join('\n')}${tail}`, media };
}
