// OneBot v11 客户端：WebSocket 只收事件，HTTP API 负责发送与查询。
// （原版经 @snowluma/sdk 收事件；这里直接实现标准 OneBot v11，去掉 SDK 补丁依赖。）
import WebSocket from 'ws';
import { sanitizeUserText, escapeCqText } from './util.js';

const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 30000;

export class OneBotClient {
  constructor({ wsUrl, httpUrl, accessToken, httpToken, onEvent }) {
    this.wsUrl = String(wsUrl || 'ws://127.0.0.1:3001');
    this.httpUrl = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    this.accessToken = String(accessToken || '');
    // SnowLuma 允许给 WS 与 HTTP 配不同令牌；httpToken 缺省沿用 accessToken
    this.httpToken = String(httpToken || accessToken || '');
    this.onEvent = onEvent || (() => {});
    this.socket = null;
    this.connected = false;
    this.everConnected = false;
    this.lastConnectError = '';
    this.selfInfo = null;      // { user_id, nickname }
    this.#closedByUs = false;
    this.statusListeners = new Set();
  }

  #closedByUs;

  onStatus(fn) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  #setStatus(connected) {
    this.connected = connected;
    if (connected) this.everConnected = true;
    for (const fn of this.statusListeners) {
      try { fn({ connected, everConnected: this.everConnected, error: this.lastConnectError }); } catch { /* ignore */ }
    }
  }

  async connect() {
    this.#closedByUs = false;
    this.#connectLoop();
  }

  /** 连接配置可能变了（比如从 SnowLuma 配置同步到了新令牌），重连一次。 */
  async reconnect() {
    // 关键：先作废旧 socket，再启新连接。否则旧 socket 的 close 事件稍后到达时
    // 会误以为需要再次重连，造成两个 WebSocket 同时连着 SnowLuma，所有事件收到两份。
    const old = this.socket;
    this.socket = null;
    this.#closedByUs = false;
    try { old?.close(); } catch { /* ignore */ }
    this.#connectLoop();
  }

  #connectLoop() {
    if (this.#closedByUs) return;
    let url = this.wsUrl;
    if (this.accessToken) url += (url.includes('?') ? '&' : '?') + `access_token=${encodeURIComponent(this.accessToken)}`;
    let socket;
    try {
      socket = new WebSocket(url, {
        headers: this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}
      });
    } catch (error) {
      this.lastConnectError = String(error?.message ?? error);
      this.#setStatus(false);
      setTimeout(() => this.#connectLoop(), RECONNECT_MIN_MS);
      return;
    }
    this.socket = socket;
    // 每个 socket 的事件处理器都先验证“我还是不是当前 socket”，
    // 旧连接被作废后其迟到事件直接忽略，避免重复重连/状态错乱。
    const isCurrent = (s) => this.socket === s;

    socket.on('open', async () => {
      if (!isCurrent(socket)) return;
      this.lastConnectError = '';
      this.#setStatus(true);
      try {
        this.selfInfo = await this.call('get_login_info');
      } catch (error) {
        console.error('[onebot] 获取登录信息失败:', error?.message ?? error);
      }
    });
    socket.on('message', (data) => {
      if (!isCurrent(socket)) return;
      let event = null;
      try { event = JSON.parse(String(data)); } catch { return; }
      if (!event || typeof event !== 'object') return;
      try { this.onEvent(event); } catch (error) { console.error('[onebot] 事件处理出错:', error); }
    });
    socket.on('close', () => {
      if (!isCurrent(socket)) return; // 旧连接的迟到 close：新连接已在处理
      this.#setStatus(false);
      if (!this.#closedByUs) setTimeout(() => this.#connectLoop(), RECONNECT_MIN_MS);
    });
    socket.on('error', (error) => {
      if (!isCurrent(socket)) return;
      this.lastConnectError = String(error?.message ?? error);
      if (!this.everConnected) {
        // 首连失败退避得久一点，避免刷屏
        this.#setStatus(false);
      }
    });
  }

  close() {
    this.#closedByUs = true;
    const old = this.socket;
    this.socket = null;
    try { old?.close(); } catch { /* ignore */ }
    this.#setStatus(false);
  }

  /** OneBot HTTP API（发送与查询都走这里）。 */
  async call(action, params = {}, timeoutMs = 15000) {
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
    const body = await res.json().catch(() => ({}));
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
  async sendSegments(kind, id, segments) {
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private'
      ? { user_id: Number(id), message: segments }
      : { group_id: Number(id), message: segments };
    return this.call(action, params);
  }

  async sendText(kind, id, text, { replyToMessageId = null, atUserId = null } = {}) {
    const segments = [];
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

  async sendSticker(kind, id, imageUrl, { replyToMessageId = null, atUserId = null } = {}) {
    const segments = [];
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
    segments.push({ type: 'image', data: { file: String(imageUrl) } });
    return this.sendSegments(kind, id, segments);
  }

  async sendPoke(kind, id, targetUserId) {
    if (kind === 'private') {
      return this.call('friend_poke', { user_id: Number(id) }).catch(() =>
        this.call('send_poke', { user_id: Number(id) }));
    }
    return this.call('group_poke', { group_id: Number(id), user_id: Number(targetUserId || id) }).catch(() =>
      this.call('send_poke', { group_id: Number(id), user_id: Number(targetUserId || id) }));
  }

  async getMsg(messageId) {
    return this.call('get_msg', { message_id: Number(messageId) });
  }

  async getGroupInfo(groupId) {
    return this.call('get_group_info', { group_id: Number(groupId) });
  }

  async getGroupMemberInfo(groupId, userId) {
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
  async getForwardNodes({ resId = '', messageId = null } = {}) {
    const attempts = [];
    if (resId) attempts.push({ id: String(resId) });
    if (messageId !== null && messageId !== undefined && String(messageId).trim() !== '') {
      attempts.push({ message_id: Number(messageId) });
    }
    if (!attempts.length) throw new Error('没有可用的转发 id（res_id 与 message_id 都没有）');
    let lastError = null;
    for (const params of attempts) {
      try {
        const r = await this.call('get_forward_msg', params);
        // 接口成功就以它为准：节点为空说明这条转发确实没内容，
        // 换另一种参数重试只会拿到更含糊的错误、把真正的原因盖掉。
        return Array.isArray(r?.messages) ? r.messages : (Array.isArray(r?.data?.messages) ? r.data.messages : []);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error('展开合并转发失败');
  }
}

// ── 入站事件 → 文本（移植自原版 segmentsToText） ─────────────────────────

export function forwardIdFromData(d) {
  const raw = d?.id ?? d?.res_id ?? d?.forward_id ?? d?.data_id;
  if (raw == null || String(raw).trim() === '') return null;
  return String(raw);
}

/**
 * 把 OneBot 消息段数组转成 AI 可读的纯文本。
 * resolveReply: async (mid) => { sender, text } | null —— 解析引用原文。
 * resolveAtName: async (qq) => string | null —— 把 @ 的 QQ 号解析成群名片。
 */
export async function segmentsToText(segments, { resolveReply = null, resolveAtName = null, includeReply = true } = {}) {
  if (typeof segments === 'string') return sanitizeUserText(segments.trim());
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
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
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch { /* 解析失败降级 */ }
        }
        out.push(replyText || '[引用消息]');
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

/** 只认字符串/数字，挡掉对象（否则 String({}) 会把 [object Object] 塞进提示词）。 */
function isTextValue(v) {
  return typeof v === 'string' || typeof v === 'number';
}

/** 取文本字段：折叠空白 + 按码点截断（避免把代理对切成乱码）。 */
function textField(value, max) {
  if (!isTextValue(value)) return '';
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('') + '…';
}

/** 只收 http/https：mqqapi:// 小程序链接、javascript: 等一律丢弃。 */
function httpUrlField(value) {
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
function firstCardBody(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const looksLikeBody = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
    && (textField(v.title, 1) || textField(v.desc, 1) || textField(v.jumpUrl, 1));
  if (looksLikeBody(meta)) return meta;
  for (const key of Object.keys(meta)) {
    if (looksLikeBody(meta[key])) return meta[key];
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
export function parseCardSegment(data) {
  const fallback = { text: '[卡片消息]', media: [] };
  const raw = data?.data;
  let card = null;

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    card = raw;   // 有的协议端直接给已解析好的对象
  } else {
    const str = isTextValue(raw) ? String(raw) : '';
    if (!str || str.length > CARD_MAX_CHARS) return fallback;
    try {
      const parsed = JSON.parse(str);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
      card = parsed;
    } catch { return fallback; }
  }

  const app = textField(card.app, 60);
  const view = textField(card.view, 40);
  const body = firstCardBody(card.meta);
  const title = textField(body?.title, CARD_FIELD_MAX);
  const desc = textField(body?.desc, CARD_FIELD_MAX);
  const tag = textField(body?.tag, 40);
  const url = httpUrlField(body?.jumpUrl);
  const preview = httpUrlField(body?.preview);

  if (!title && !desc && !url) {
    // 白名单字段全空 → 退回 prompt（协议端准备的"无法展示卡片时的文字"，形如 [QQ小程序]xxx）
    const prompt = textField(card.prompt, CARD_FIELD_MAX);
    return prompt ? { text: `[卡片 ${prompt}]`, media: [] } : fallback;
  }

  // 展示名：优先 tag（"QQ音乐"/"网易云音乐"），退到 view，再退到 app 的末段
  const label = tag || view || textField(String(app).split('.').pop(), 30);
  const bits = [];
  if (title) bits.push(`标题：${title}`);
  if (desc && desc !== title) bits.push(`描述：${desc}`);
  if (url) bits.push(`链接：${url}`);
  // 封面单独作为 image 并存：get_message_images 的筛选条件就是 kind==='image' && url，
  // 不改一行代码模型就能看到卡片封面；顺带让这条消息在提示词里带上 #id。
  const media = [{ kind: 'card', app, view, title, desc, url, tag }];
  if (preview) media.push({ kind: 'image', url: preview, summary: '卡片封面' });

  return { text: textField(`[卡片${label ? ' ' + label : ''}] ${bits.join(' ｜ ')}`, CARD_TEXT_MAX), media };
}

/** 从消息段提取媒体定位信息（不下载）。 */
export function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    if (seg.type === 'image') {
      media.push({ kind: 'image', file: String(d.file ?? ''), url: String(d.url ?? ''), summary: String(d.summary ?? '') });
    } else if (seg.type === 'face') {
      media.push({ kind: 'face', faceId: String(d.id ?? '') });
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
export async function expandForwardNodes(nodes, { maxNodes = 30, maxChars = 3000 } = {}) {
  if (!Array.isArray(nodes) || !nodes.length) return null;
  const lines = [];
  const media = [];
  let truncated = 0;

  for (let i = 0; i < nodes.length; i++) {
    if (lines.length >= maxNodes) { truncated = nodes.length - i; break; }
    const n = nodes[i] || {};
    const name = String(n.sender?.card || n.sender?.nickname || n.user_id || '?');
    const nm = n.message ?? n.content;
    let body = '';
    if (typeof nm === 'string') {
      // 字符串形态一般是 CQ 码原文，剥掉 [CQ:xxx] 段保留纯文本
      body = nm.replace(/\[CQ:[^\]]*\]/g, '').trim();
    } else if (Array.isArray(nm)) {
      // 嵌套 forward 段清空 data → segmentsToText 输出 [转发消息] 占位（深度 1 封顶）
      const segs = nm.map((s) => (s?.type === 'forward' ? { type: 'forward', data: {} } : s));
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
