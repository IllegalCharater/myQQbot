import { actions } from '../actions.js';
import { api } from '../api.js';
import { $, $$, esc, fmtTime } from '../dom.js';
import { CHAT_MSG_MORE, CHAT_MSG_PAGE, state } from '../state.js';
import { chatNameOf, formatChatTitle } from '../chat-labels.js';

// ── 存档视图 ──
export async function loadChats({ quiet = false } = {}) {
  try {
    const data = await api('/api/chats');
    state.chats = data.chats || [];
    renderChatList();
    if (state.currentChatKey) {
      // 打开着某群详情时也刷新该群消息。
      // keepView=true：只更新内容，不动分页与滚动位置 ——
      // 否则用户滚出来的内容会被每 15 秒的轮询刷回去。
      loadChatMessages(state.currentChatKey, { keepView: true });
    }
  } catch (e) { if (!quiet) console.error(e); }
}

export function renderChatList() {
  const box = $('#chat-items');
  state.seenChatKeys = state.seenChatKeys || new Set();
  box.innerHTML = state.chats.map((c) => {
    const name = formatChatTitle(c.key, chatNameOf(c.key));
    const isNew = !state.seenChatKeys.has(c.key);
    // 状态标签：回复态分"等待中/回复中"两种 phase；压缩中单独标。
    // 数据来自 /api/chats（后端实时读 orchestrator 的状态机），15s 轮询即使漏了
    // SSE 事件也能自己纠正，所以这里不需要额外的前端状态。
    // ⚠️ 背景色只用 style.css 里真实定义的变量（--accent/--orange/--red）：
    //    写一个不存在的 var() 会让整条声明在计算时失效，标签直接变透明看不见。
    const pills = [
      c.unread ? `<span class="unread-pill">${c.unread}</span>` : '',
      c.phase === 'waiting' ? '<span class="unread-pill" style="background:var(--accent)">等待中…</span>' : '',
      c.phase === 'running' ? '<span class="unread-pill" style="background:var(--orange)">回复中…</span>' : '',
      c.compacting ? '<span class="unread-pill" style="background:var(--orange)">压缩中…</span>' : ''
    ].filter(Boolean).join('');
    return `
      <div class="chat-item ${c.key === state.currentChatKey ? 'selected' : ''} ${c.unread ? 'unread-row' : ''} ${isNew ? 'new-item' : ''}" data-key="${c.key}">
        <div class="chat-item-title">
          <span class="session-chat">${esc(name)}</span>
          ${pills}
        </div>
        <div class="chat-item-sub">${esc(c.lastText || '（空）')}</div>
        <div class="session-meta"><span>${c.total} 条</span><span>${fmtTime(c.lastTs)}</span></div>
      </div>`;
  }).join('') || '<div class="list-head muted">还没有消息存档（等白名单里的群/好友来消息）</div>';
  for (const c of state.chats) state.seenChatKeys.add(c.key);
  $$('.chat-item', box).forEach((el) => {
    el.addEventListener('click', () => selectChat(el.dataset.key));
  });
}

export async function selectChat(key) {
  state.currentChatKey = key;
  // 查找词跟着会话走：为一个群写的词拿到另一个群里没有意义，留着只会让人
  // 打开新会话时看到一张莫名其妙空掉的表，还以为是存档坏了。
  state.chatQuery = '';
  // 顶部「历史印象」的注入状态也是上一个会话的：接口回来之前若有什么触发渲染，
  // 宁可整块不显示，也不要显示别的群的段数/字数（那是"面板在说假话"）。
  state.chatDigests = null;
  renderChatList();
  $('#chat-detail').innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadChatMessages(key);
}

/**
 * 拉取并渲染某会话的存档消息。
 *
 * @param {string} key
 * @param {boolean} keepView  true = 保留当前分页与滚动位置（轮询刷新用）；
 *                            false = 重置为第一页并重建结构（切换会话用）。
 *
 * ⚠️ 这个参数是修"滚动被冲掉"的关键：
 *    轮询每 15 秒一次、每次 SSE 事件也会触发，如果都走"重置分页 + 重建 DOM"，
 *    用户辛辛苦苦滚出来的内容会瞬间被刷回前 500 条，滚动位置也回到顶部
 *    —— 表现为"明明滚下去了，过一会儿自己弹回上面"。
 */
export async function loadChatMessages(key, { keepView = false } = {}) {
  try {
    const data = await api(`/api/chats/${key.replace(':', '_')}/messages?limit=100000`);
    // 期间用户可能切走了会话，那就别覆盖当前视图
    if (state.currentChatKey !== key) return;
    state.chatMessages = data.messages || [];
    // 历史印象的注入状态：哪些摘要会进提示词、哪些被字数预算挤掉了。
    // 必须和 messages 一起存 —— 顶部那块是照着它标注的，不是前端自己猜的。
    state.chatDigests = data.digestStatus || null;

    if (keepView && (state.chatMsgLimit || 0) > 0 && $('#chat-msg-body')) {
      // 只更新表格内容：分页不变、滚动位置不变
      updateChatMessagesBody(true);
    } else {
      // 切换会话：重置分页并从第一页开始
      state.chatMsgLimit = CHAT_MSG_PAGE;
      renderChatMessages();
    }
  } catch (e) {
    if (state.currentChatKey !== key) return;
    const box = $('#chat-detail');
    if (box) box.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

/**
 * 存档消息列表：首次建结构 + 填充内容。
 *
 * ⚠️ 关键：这个只在"切换会话 / 首次打开"时调用，负责建出完整骨架并绑定工具栏事件。
 *    滚动加载更多时走 updateChatMessagesBody() —— 只替换 tbody 与底部文案，
 *    不碰外层结构。
 *
 *    曾经每次加载更多都走整个函数（innerHTML 全量重建），后果有两个：
 *      1. 浏览器丢失 scrollTop → 表现为"明明在往下滚，却自己弹回上面"
 *      2. 工具栏事件被反复绑定 → 点一次发好几条
 */
export function renderChatMessages() {
  const key = state.currentChatKey;
  if (!key) return;
  const detail = $('#chat-detail');
  if (!detail) return;

  // 切换会话时重置分页（每个会话独立从第一页开始）
  state.chatMsgLimit = CHAT_MSG_PAGE;

  const name = formatChatTitle(key, chatNameOf(key));
  const meta = state.chats.find((c) => c.key === key) || {};

  detail.innerHTML = `
    <div class="detail-header">
      <h2>${esc(name)} ${meta.unread ? `<span class="unread-pill">${meta.unread} 未读</span>` : ''}</h2>
      <div class="sub"><span data-field="chat-msg-count"></span></div>
    </div>
    <!-- 历史印象（压缩摘要）：bot 对这个会话"更早的聊天"的印象，也是每轮（或读历史
         那一轮）真正被注入提示词的那段。骨架只在这里建一次，内容由
         updateChatDigestBlock() 填 —— 轮询/SSE/查找最终都汇到 updateChatMessagesBody，
         在那里面刷这一块，才能保证任何刷新路径它都不会变成旧的。
         没有摘要、或正在查找时不显示（hidden 由那个函数管）。 -->
    <div id="chat-digest-panel" hidden>
      <details id="chat-digest-details" class="digest-panel"${state.chatDigestOpen === false ? '' : ' open'}>
        <summary id="chat-digest-summary"></summary>
        <div class="hint" id="chat-digest-meta"></div>
        <div id="chat-digest-list"></div>
        <div class="hint" id="chat-digest-more"></div>
      </details>
    </div>
    <div class="chat-toolbar">
      <button class="btn btn-small" id="chat-wake-btn">唤醒一次处理</button>
      <button class="btn btn-small" id="chat-read-btn">全部标为已读</button>
      <button class="btn btn-small" id="chat-compact-btn" title="把最老的一段聊天记录交给模型摘要成一条纪要，原文移到 data/messages/archive/ 冷归档（不删除）。不等定时巡检，立刻压一次。">立即压缩历史</button>
      <input type="text" id="chat-search" placeholder="在本会话存档里查找（内容 / 发言人 / 时间）" />
      <button class="btn btn-small" id="chat-note-btn" title="插一条人工备注。它不是任何人说的话，会以【人工备注】出现在提示词里，供机器人下一轮参考。">加备注</button>
      <input type="text" id="test-send-text" placeholder="手动发一条测试消息" style="flex:1" />
      <button class="btn btn-small" id="chat-testsend-btn">发送</button>
    </div>
    <div class="hint" id="chat-compact-status" style="margin:-4px 0 10px"></div>
    <table class="archive-table"><tbody id="chat-msg-body"></tbody></table>
    <div class="list-more muted" id="chat-msg-more"></div>`;

  // 工具栏事件：只在这里绑一次
  $('#chat-wake-btn').addEventListener('click', async () => {
    await api(`/api/chats/${key.replace(':', '_')}/wake`, { method: 'POST', body: '{}' });
    actions.refreshStatus();
  });
  $('#chat-read-btn').addEventListener('click', async () => {
    await api(`/api/chats/${key.replace(':', '_')}/mark-read`, { method: 'POST', body: '{}' });
    loadChats();
    // 保持视图：用户可能已经滚到中间了，别把他弹回顶部
    loadChatMessages(key, { keepView: true });
  });
  // 立即压缩：手动触发一次历史压缩（跳过门槛与冷却）。
  // 这是唯一不用等巡检间隔就能验证压缩是否正常的手段，所以结果要明确写出来。
  // 反馈写进工具栏下方的 #chat-compact-status（跟 SnowLuma 页的 #sl-hint 同一套做法），
  // 不用 alert：轮询刷新只重建 tbody，这行文字不会被冲掉。
  $('#chat-compact-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    const status = $('#chat-compact-status');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '压缩中…';
    if (status) status.textContent = '正在调用模型摘要，可能等几十秒…';
    try {
      const r = await api(`/api/chats/${key.replace(':', '_')}/compact`, { method: 'POST', body: '{}' });
      if (status) status.textContent = r?.note || '压缩完成';
      loadChats();
      loadChatMessages(key, { keepView: true });
    } catch (err) {
      // 409 是"这次压不了"的正常回绝（未配模型 / 正在回复 / 门槛没到 / 摘要失败），
      // 不是故障 —— 后端把原因写在 error 里，原样显示即可。
      if (status) status.textContent = `未压缩：${err.message || err}`;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
  $('#chat-testsend-btn').addEventListener('click', async () => {
    const input = $('#test-send-text');
    const text = input.value.trim();
    if (!text) return;
    await api(`/api/chats/${key.replace(':', '_')}/test-send`, {
      method: 'POST', body: JSON.stringify({ text })
    });
    input.value = '';
    // 同理，保持当前分页与滚动位置
    loadChatMessages(key, { keepView: true });
  });

  // ── 查找（纯前端：loadChatMessages 一次拿的是整个会话，过滤比再跑一趟网络快） ──
  const search = $('#chat-search');
  search.value = state.chatQuery || '';
  let searchTimer = null;
  search.addEventListener('input', () => {
    // 去掉防抖就是在输入法里每敲一个字母全量过滤 + 重排一次 innerHTML，
    // 几万条的行数下会明显卡顿。
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.chatQuery = search.value;
      state.chatMsgLimit = CHAT_MSG_PAGE;   // 换词 = 重新分页
      updateChatMessagesBody();
    }, 120);
  });

  // ── 加备注：插一条"不是任何人说的话" ──
  $('#chat-note-btn').addEventListener('click', () => {
    const overlay = actions.modelModalShell({
      head: '插入人工备注',
      body: `<div class="field">
          <label>备注内容</label>
          <textarea id="cm-note-text" rows="4" placeholder="例：张三说的那个活动改到周五了"></textarea>
          <div class="hint">这条会以【人工备注】的形式进入机器人的提示词，<b>不会</b>被当成任何群友说的话，
            也不会触发它主动回应。改动只影响<b>下一轮</b>运行 —— 正在进行的那一轮提示词已经拼好了。</div>
        </div>`,
      foot: '<button class="btn" id="cm-note-cancel">取消</button><button class="btn btn-primary" id="cm-note-save">插入</button>'
    });
    overlay.querySelector('#cm-note-cancel').addEventListener('click', () => actions.closeModelModal(overlay));
    overlay.querySelector('#cm-note-save').addEventListener('click', async (e) => {
      const text = overlay.querySelector('#cm-note-text').value.trim();
      if (!text) { alert('备注内容不能为空'); return; }
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await api(`/api/chats/${key.replace(':', '_')}/notes`, { method: 'POST', body: JSON.stringify({ text }) });
        actions.closeModelModal(overlay);
        loadChatMessages(key, { keepView: true });
      } catch (err) {
        btn.disabled = false;
        alert('插入失败：' + (err.message || err));
      }
    });
  });

  // ── 每行的 改 / 删 ──
  // 用事件委托挂在 tbody 上：updateChatMessagesBody 每次轮询都会换掉 innerHTML，
  // 逐行绑定的话几百个监听器转瞬就失效。tbody 元素本身不重建，委托能活很久。
  //
  // 顶部历史印象块的行也走这同一个处理函数（摘要允许删、不允许改，判据在行渲染里）。
  // 委托分别挂在各自容器上 —— 不要挂 #chat-detail：#chat-detail 的元素从不重建
  // （只换 innerHTML），每切一次会话就往上叠一个监听器，表现是"删一条弹两次确认框"。
  const onRowOp = async (e) => {
    const btn = e.target.closest('button[data-op]');
    if (!btn) return;
    const tr = btn.closest('tr[data-midrow]');
    if (!tr) return;
    // 按 id 找，不按下标：过滤/排序之后屏幕上的位置和 state 里的位置对不上
    const m = (state.chatMessages || []).find((x) => String(x.id) === tr.dataset.midrow);
    if (!m) return;
    const url = `/api/chats/${key.replace(':', '_')}/messages/${m.id}`;

    if (btn.dataset.op === 'edit') {
      const overlay = actions.modelModalShell({
        head: `改第 ${m.id} 条 · ${esc(m.senderName || '我')} · ${fmtTime(m.ts)}`,
        body: `<div class="field">
            <label>正文</label>
            <textarea id="cm-edit-text" rows="6">${esc(m.text)}</textarea>
            <div class="hint">只能改正文。是谁说的、什么时候说的、引用关系都不会动 ——
              改这些等于伪造历史。改完存档页立刻生效，但<b>正在进行的那一轮</b>提示词已经拼好了，
              要下一轮才会读到新内容。</div>
          </div>`,
        foot: '<button class="btn" id="cm-edit-cancel">取消</button><button class="btn btn-primary" id="cm-edit-save">保存</button>'
      });
      const ta = overlay.querySelector('#cm-edit-text');
      ta.focus();
      overlay.querySelector('#cm-edit-cancel').addEventListener('click', () => actions.closeModelModal(overlay));
      overlay.querySelector('#cm-edit-save').addEventListener('click', async (ev) => {
        const text = ta.value;
        if (!text.trim()) { alert('内容不能为空'); return; }
        ev.currentTarget.disabled = true;
        try {
          await api(url, { method: 'PATCH', body: JSON.stringify({ text }) });
          actions.closeModelModal(overlay);
          // 重拉而不是就地改本地数组：排序缓存与 SSE 推送都按"新数组引用"失效，
          // 就地打补丁会让缓存的旧排序把改动盖回去。
          loadChatMessages(key, { keepView: true });
        } catch (err) {
          ev.currentTarget.disabled = false;
          alert('保存失败：' + (err.message || err));
        }
      });
      return;
    }

    if (btn.dataset.op === 'del') {
      const snip = String(m.text || '').replace(/\s+/g, ' ').slice(0, 60);
      // 摘要 / 人工备注 / 转写结果都不是某个人说的话。套 senderName || '我' 会把它们说成"我"
      // 发的 —— 与行渲染里的 who 用同一套判定。
      const who = m.kind === 'digest' ? '摘要'
        : (m.kind === 'note' ? '备注'
          : (m.kind === 'transcript' ? '转写' : (m.self ? '我' : (m.senderName || '某人'))));
      let warn = `确定要永久删除这条存档吗？\n\n${fmtTime(m.ts)}  ${who}：${snip}\n\n`;
      warn += '· 会在 data/messages/ 下留一份 .panel.bak 备份（只保留最近一次）\n';
      // 人工备注是从没收发过的记录，对它说"原文可能仍在冷归档"是误导
      if (m.kind !== 'note') warn += '· 消息原文可能仍留在冷归档 data/messages/archive/ 里（那份只追加，面板不搜它）\n';
      warn += m.kind === 'digest'
        ? '· 这是压缩摘要，删掉后下次触发压缩会重新生成一段（不会和这段一样）\n'
        : '· 已经生成的摘要不会被改动\n';
      if (!m.read) warn += '\n⚠️ 这条还是未读：删掉后机器人不会再把它当作要回应的消息。\n';
      if (!confirm(warn)) return;
      btn.disabled = true;
      try {
        await api(url, { method: 'DELETE' });
        loadChatMessages(key, { keepView: true });
      } catch (err) {
        btn.disabled = false;
        alert('删除失败：' + (err.message || err));
      }
    }
  };
  $('#chat-msg-body').addEventListener('click', onRowOp);
  $('#chat-digest-list').addEventListener('click', onRowOp);
  // 折叠状态记在 state 里：切换会话会重建骨架，靠它还原，否则用户每切回来都被展开。
  // （轮询不会冲掉它 —— 那块内容只在 updateChatDigestBlock 里按 memo 重写。）
  const digDetails = $('#chat-digest-details');
  if (digDetails) digDetails.addEventListener('toggle', (ev) => {
    state.chatDigestOpen = ev.currentTarget.open === true;
  });

  updateChatMessagesBody();
  // 滚动加载只挂一次（attachScrollLoader 内部有防重复）
  actions.initChatScrollLoader();
}

/**
 * 排序缓存：state.chatMessages 的引用不变就复用上次的排序结果。
 *
 * 曾经在 updateChatMessagesBody 里每次都 slice + sort + 再 slice + reverse
 * （两遍全量拷贝 + O(n log n)）。轮询进来数据确实会变（新数组引用，重排一次），
 * 但滚动加载更多时数据根本没动 —— 每滚一批就白排一遍，几万条时卡在滚动事件里。
 *
 * 用"稳定排序"而不是简单 reverse：存档里 ts 是秒级精度（实测 2000 条中有 18 处
 * 同一秒内的消息毫秒级逆序）。直接 reverse 会把这些也翻过来，导致同一秒内的
 * 消息顺序不对。先按 ts 稳定升序排一遍（Array.sort 在现代引擎里是稳定的），
 * 再反转，就能保证"新的在上"且同秒内顺序也正确。
 */
let chatMsgSortCache = { src: null, newestFirst: [] };
export function chatMessagesNewestFirst() {
  const src = state.chatMessages || [];
  if (chatMsgSortCache.src !== src) {
    const sorted = src.slice().sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
    sorted.reverse();
    chatMsgSortCache = { src, newestFirst: sorted };
  }
  return chatMsgSortCache.newestFirst;
}

/**
 * 引用预览（面板侧）。存档里 `reply` 是结构化的 `{ mid, sender, text }`，
 * **预览不再拍进 text**（见 src/chat/types.ts 的 ChatReply）：面板不在这里拼的话，
 * 新收到的引用消息在存档页上会整段丢掉引用段（text 里已经没有它了）。
 *
 * 与提示词侧 formatReplyPrefix 同一形态（`[引用 #id 谁：什么]`），但**不共享代码** ——
 * ui/js 是浏览器原生 ES Module，不打包、够不着 src/。两边各自一行，改动时都要动。
 * 老存档（本改动之前）的 reply 是 null、预览本就在 text 里，这里返回空串，渲染不变。
 */
function replyPrefixHtml(m) {
  const r = m && m.reply;
  if (!r || typeof r !== 'object') return '';
  const mid = String(r.mid ?? '');
  const body = [r.sender, r.text].filter(Boolean).join('：');
  if (!mid && !body) return '';
  const label = [mid ? `#${mid}` : '', body].filter(Boolean).join(' ');
  return `<span class="reply-quote"${mid ? ` title="被引用消息 ${esc(mid)}"` : ''}>[引用 ${esc(label)}]</span>`;
}

/** 单行消息 HTML（全量渲染与滚动追加共用同一个模板，保证两处长得一样）。 */
export function chatMsgRowHtml(m, opts) {
  // ⚠️ 调用方有 `.map(chatMsgRowHtml)` 这种写法，那样第二个参数会是数组下标（数字）而不是
  //    选项对象。这里挡一下：不挡的话下标会被当成 previewChars，除第一行以外全被截断。
  const { previewChars = 0, badge = '' } = (opts && typeof opts === 'object') ? opts : {};
  // 压缩摘要（kind:'digest'）、人工备注（kind:'note'）与转写结果（kind:'transcript'）
  // 都不是某个人说的话，各自用一种弱化样式区分：多行文本靠 .text 已有的 white-space: pre-wrap 换行。
  const isDigest = m.kind === 'digest';
  const isNote = m.kind === 'note';
  const isTranscript = m.kind === 'transcript';
  const who = isDigest ? '摘要'
    : (isNote ? '备注' : (isTranscript ? '转写' : (m.self ? '我' : esc(m.senderName))));
  // 摘要由模型生成，手改会让它与 digest.summary/count 对不上（后端也会 400）。
  // 这里直接不给「改」，而不是给一个点了报错的按钮。
  // 但「删」必须给：删掉一条摘要本身完全合法 —— 后端只拦 PATCH，不拦 DELETE，
  // 它的 400 文案本身写的就是"不能手改；可以删除"。早先这里两项一起吞掉了，
  // 结果用户想清掉一段误生成的摘要时无路可走（工具提示还写着"可以删除"）。
  //
  // 转写结果同样不给「改」：面板的「改」走的是插人工备注那条路，会把一段机器识别出的
  // 正文悄悄变成一条手写批注。
  const ops = (isDigest || isTranscript
    ? `<span class="muted" title="${isTranscript ? '转写结果由任务生成，不能手改' : '摘要由模型生成，不能手改'}">—</span>`
    : '<button class="btn btn-small" data-op="edit" title="改这条的正文">改</button>')
    + '<button class="btn btn-small btn-danger" data-op="del" title="真删除这条存档">删</button>';
  // 顶部历史印象块只给预览（previewChars）：一条摘要正文可达 4000 字，整段铺在最上面
  // 会把表格挤到屏幕外。完整正文在下方表格里本来就有（摘要自己也是一行）。
  const raw = String(m.text || '');
  const body = previewChars > 0 && raw.length > previewChars
    ? `${esc(raw.slice(0, previewChars))}…`
    : esc(raw);
  return `
    <tr class="${m.read ? '' : 'unread'}${isDigest ? ' digest-row' : ''}${isNote ? ' note-row' : ''}${isTranscript ? ' transcript-row' : ''}" data-midrow="${m.id}">
      <td class="t">${fmtTime(m.ts)}</td>
      <td class="w ${m.self ? 'self' : ''}">${who}</td>
      <td class="text">${replyPrefixHtml(m)}${body}${badge}${m.read ? '' : ' <span class="unread-pill">未读</span>'}</td>
      <td class="ops">${ops}</td>
    </tr>`;
}

/**
 * 顶部「历史印象」块：这个会话被压缩出来的摘要，以及**哪些真的会进提示词**。
 *
 * 数据全部来自接口的 digestStatus，而后端那个字段是 collectInjectedDigests 算的
 * —— 和 buildUserPrompt 用的是同一个函数，所以这里标的"已注入/未注入"
 * 和模型实际收到的不会打架（这条是整套改动的验收点）。
 *
 * 措辞边界：只说"会带上"，不说"本轮已注入"。面板不知道某一轮实际用了哪个档位，
 * 所以它给的是"按当前设置，下一轮会怎样"。
 */
export function updateChatDigestBlock() {
  const panel = $('#chat-digest-panel');
  if (!panel) return;
  const status = state.chatDigests;
  // 面板按时间正序展示，和提示词里【历史印象】的顺序一致（那条通道也是正序）
  const all = (state.chatMessages || [])
    .filter((m) => m.kind === 'digest')
    .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
  // 查找态整块收起：查找是行级操作，上面挂一块不跟着过滤的纪要看像"结果集不肯缩"。
  // 摘要本身在下方表格里也是一行、也会被搜到，所以收起不等于信息没了。
  // 没有摘要（= 从未压缩过）时也收起：勾了什么设置都不该在这里显示一个空块。
  if (!all.length || !status || String(state.chatQuery || '').trim()) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  // memo：轮询每 15 秒来一次，内容没变就别重写 innerHTML —— 否则 <details> 的展开/
  // 收起状态、用户正在看的滚动位置，每轮都被冲一次。chatKey 必须进签名：
  // 两个会话的摘要 id 完全可能重合成一样的数组。
  // 签名里带正文长度：下面要报"摘要存档共多少字"，只盯 id 的话字数变了也不刷新。
  const sig = JSON.stringify([state.currentChatKey,
  all.map((m) => `${m.id}:${String(m.text || '').length}`),
  status.injectedIds, status.droppedIds, status.truncatedId, status.chars, status.budget, status.config]);
  if (state.chatDigestSig === sig) return;
  state.chatDigestSig = sig;

  const cfg = status.config || {};
  const closed = Number(cfg.maxChars) <= 0;
  const injIds = new Set(status.injectedIds || []);
  // 未注入的按"没进注入名单"算，而不是按服务端的 droppedIds 算：这样列表一定是完整的
  // 二分，不会因为两边口径哪天不一致而凭空少一段（少的那段用户以为删掉了）。
  const inj = all.filter((m) => injIds.has(m.id));
  const dropped = all.filter((m) => !injIds.has(m.id));
  const stampOf = (m, which, fallback) => {
    const v = Number(m?.digest?.[which]);
    return fmtTime(Number.isFinite(v) && v > 0 ? v : fallback);
  };
  const first = all[0];
  const last = all[all.length - 1];
  const lo = stampOf(first, 'from', first.ts);
  const hi = stampOf(last, 'to', last.ts);
  const totalRaw = all.reduce((n, m) => n + (Number(m.digest?.count) || 0), 0);

  const summary = $('#chat-digest-summary');
  if (summary) {
    summary.textContent = closed
      ? `历史印象 · 已关闭注入 · 共 ${all.length} 段`
      : `历史印象 · 已注入 ${inj.length}/${all.length} 段 · ${status.chars}/${status.budget} 字`
      + ` · 覆盖 ${lo} ~ ${hi}${totalRaw ? `（共 ${totalRaw} 条原始消息）` : ''}`;
  }
  const meta = $('#chat-digest-meta');
  if (meta) {
    const when = closed
      ? '设置里已关闭注入（设置 › 聊天设置 › 历史摘要：字数上限填 0 就是关掉）。'
      : (cfg.injectEveryRound
        ? '按当前设置：<b>每一轮</b>运行都会带上这一段 —— 也包括那些不读历史的唤醒。'
        : '按当前设置：只在<b>读历史</b>的那一轮带上（档 1/2/3 都没命中、一条历史都不读的唤醒不带）。');
    // 存档量单独说一句：它和"注入多少"是两笔账（存档大、注入小是常态 —— 预算会把老的挤掉）
    const storedChars = all.reduce((n, m) => n + String(m.text || '').length, 0);
    const keep = Number(cfg.maxKeepChars) || 0;
    const storeLine = `摘要存档共 ${storedChars} 字`
      + (keep > 0
        ? `（上限 ${keep} 字：每次压缩成功后会丢掉最旧的整条纪要，但永远留最新的一条）`
        : '（上限为 0 = 不限；想自动清最旧的，去设置 › 聊天设置 › 历史摘要里设一个）');
    meta.innerHTML = `${when}<br />${storeLine}<br />`
      + '这是"按当前设置，下一轮会怎样"，不是"上一轮实际读到了什么"；'
      + '注入时它排在提示词的【过去状态】之前，两者互不挤占。完整正文在下方表格里也有。';
  }
  const rowOpts = (isIn) => (m) => ({
    previewChars: 200,
    badge: isIn
      ? `<span class="digest-badge is-in" title="会进提示词的【历史印象】段">${m.id === status.truncatedId ? '已注入（已截断）' : '已注入'}</span>`
      : '<span class="digest-badge is-out" title="超出字数预算，模型看不到这一段">未注入</span>'
  });
  const table = (list, isIn) => `<table class="archive-table digest-table"><tbody>`
    + list.map((m) => chatMsgRowHtml(m, rowOpts(isIn)(m))).join('') + '</tbody></table>';
  const list = $('#chat-digest-list');
  if (list) {
    list.innerHTML = table(inj, true) + (dropped.length
      ? `<details class="digest-dropped"><summary>未注入 ${dropped.length} 段（超出字数预算，模型看不到）</summary>`
      + table(dropped, false) + '</details>'
      : '');
  }
  const more = $('#chat-digest-more');
  if (more) {
    more.textContent = dropped.length
      ? '未注入的那些并没有丢，还在存档里；提示词里已经告诉模型可以自行往前翻（get_recent_messages）。'
      : '';
  }
}

/**
 * 查找词过滤后的"新的在上"列表（带记忆化）。
 *
 * 必须另开一个缓存而不是改 chatMessagesNewestFirst() 的 key：排序是对全量做的，
 * 加个词就重排一遍几万条，光标每敲一下都卡。这里排序结果照旧复用，
 * 只在 query 变化时重做一次 O(n) 过滤。
 *
 * 匹配 text / senderName / 时间（这样"谁说的"和"哪天的"都能找）。
 */
let chatMsgViewCache = { src: null, q: '', list: [] };
export function chatVisibleMessages() {
  const q = String(state.chatQuery || '').trim().toLowerCase();
  const all = chatMessagesNewestFirst();
  if (!q) return all;
  if (chatMsgViewCache.src === all && chatMsgViewCache.q === q) return chatMsgViewCache.list;
  const list = all.filter((m) => {
    // 引用预览也算正文的一部分：它已经不在 m.text 里了，不并进来就搜不到
    // "被引用的那句话"（用户想找某条回复时，往往会去搜被引用的原文）。
    const r = (m.reply && typeof m.reply === 'object') ? m.reply : null;
    const quote = r ? `${r.sender || ''} ${r.text || ''}` : '';
    const hay = `${m.text || ''}\n${quote}\n${m.senderName || ''}\n${fmtTime(m.ts)}`.toLowerCase();
    return hay.includes(q);
  });
  chatMsgViewCache = { src: all, q, list };
  return list;
}

/** 更新底部"还有 N 条"与顶部计数文案（全量渲染与追加都要刷这两处）。 */
export function updateChatMessagesMeta(newestFirst) {
  const total = newestFirst.length;
  const filtered = !!String(state.chatQuery || '').trim();
  const shownCount = Math.min(Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE), total);
  const rest = total - shownCount;
  const more = $('#chat-msg-more');
  if (more) {
    more.textContent = rest > 0
      ? `向下滚动加载更早的（还有 ${rest} 条）`
      : (total > CHAT_MSG_PAGE ? `已显示全部 ${total} 条` : '');
  }
  const cnt = $('#chat-detail')?.querySelector('[data-field="chat-msg-count"]');
  if (cnt) {
    const meta = state.chats.find((c) => c.key === state.currentChatKey) || {};
    const t = meta.total || 0;
    if (filtered) {
      // 过滤态下"共 N 条"要两个数都给：只报命中数会让人以为存档里就这么多
      cnt.textContent = `匹配 ${total} 条 / 共 ${t || total} 条 · 已显示 ${shownCount} 条`;
    } else {
      cnt.textContent = t
        ? `共 ${t} 条 · 已显示 ${shownCount} 条 · 存储于 data/messages/`
        : '暂无消息';
    }
  }
}

/**
 * 滚动加载更多的追加路径：只把新批次的行插到 tbody 末尾。
 * 不重排（走缓存）、不重建已有行、不碰滚动位置 —— 内容加在视口下方，
 * 浏览器天然保持视口稳定，所以这里**绝对不能**做 scrollTop 补偿。
 */
export function appendChatMessageRows(prevShown) {
  const tbody = $('#chat-msg-body');
  if (!tbody) return;
  const newestFirst = chatVisibleMessages();
  const limit = Math.min(state.chatMsgLimit, newestFirst.length);
  const rows = newestFirst.slice(prevShown, limit);
  // 显式包一层箭头函数：直接写 `.map(chatMsgRowHtml)` 的话第二个参数是下标，
  // chatMsgRowHtml 的选项参数会收到一个数字（它内部挡了，但别依赖那个）。
  if (rows.length) tbody.insertAdjacentHTML('beforeend', rows.map((m) => chatMsgRowHtml(m)).join(''));
  state.chatMsgRendered = limit;
  updateChatMessagesMeta(newestFirst);
}

/**
 * 只更新消息表格的内容（不重建外层结构）。
 * 轮询刷新与首次填充走这里 —— 表格内容变长，但滚动容器没动，
 * 所以用户的滚动位置天然保持，不会再"自己弹回上面"。
 *
 * @param {boolean} keepScroll 轮询路径传 true：新消息从**顶部**进来，
 *        内容高度变化会把视口顶走，按增量补偿回阅读位置。
 *        （滚动加载更多不走这里，走 appendChatMessageRows —— 底部追加不需要补偿）
 */
export function updateChatMessagesBody(keepScroll = false) {
  const detail = $('#chat-detail');
  const tbody = $('#chat-msg-body');
  if (!detail || !tbody) return;

  const prevTop = keepScroll ? detail.scrollTop : 0;
  const prevHeight = keepScroll ? detail.scrollHeight : 0;

  // 倒序后取前 N 条 = 最新的 N 条（排序结果走引用缓存，数据没变不重排）
  const newestFirst = chatVisibleMessages();
  // 有查找词时一次性显示全部命中：命中通常是几十条，分页只会让"还有 N 条"的
  // 账目和旁边的"匹配 K 条"对不上，用户还得滚到底才发现后面还有。
  state.chatMsgLimit = String(state.chatQuery || '').trim()
    ? Math.max(newestFirst.length, 1)
    : Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE);
  const shown = newestFirst.slice(0, state.chatMsgLimit);

  tbody.innerHTML = shown.map((m) => chatMsgRowHtml(m)).join('');
  state.chatMsgRendered = shown.length;   // 行数账本：滚动追加靠它判断该不该走增量
  updateChatMessagesMeta(newestFirst);
  // 顶部「历史印象」块在这里刷 —— 只有这一处。轮询 / chat-update SSE / 查找 /
  // 翻页最终都会走到 updateChatMessagesBody，所以挂在这里所有刷新路径都覆盖到了。
  // （它其实不在 tbody 里，不会随 tbody.innerHTML 自动更新，漏了这一步就是
  //    "摘要删了、面板还挂着一条"或者"刚压完、面板还是旧的"。）
  updateChatDigestBlock();

  // 保险：若内容高度变了导致视口跳动，按增量补偿回来
  if (keepScroll) {
    const delta = detail.scrollHeight - prevHeight;
    if (delta !== 0) detail.scrollTop = prevTop + delta;
  }
}
