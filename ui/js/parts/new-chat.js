// 「新建会话」弹窗：为指定的群聊或私聊建出**空存档与空记忆**。
//
// 为什么要有它：存档列表与记忆列表都是**扫磁盘**还原的（`ChatStore.listChats` 扫文件名、
// `MemoryStore.listChats` 扫目录），所以一个"还没有任何数据"的会话在两个页面上都不存在，
// 用户想先把它建出来、之后再往里加备注/印象，就没有入口。
//
// 一次建**两份**是刻意的：只建一份的话，另一个页面上这个会话仍然不存在 ——
// 用户点完"新建"去另一个页签却找不到它，会以为没建成功。
import { api } from '../api.js';
import { $, esc } from '../dom.js';

/**
 * 打开新建会话弹窗。
 *
 * @param {(chatKey: string, result: { archiveCreated?: boolean; memoryCreated?: boolean }) => void} onCreated
 *   建好之后的回调，由调用方决定刷新哪个列表、要不要切过去。
 */
export async function openNewChatModal(onCreated) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head">新建会话（建出空存档与空记忆）</div>
      <div style="padding:10px 0">
        <div class="field">
          <label>类型</label>
          <select id="nc-kind">
            <option value="group">群聊</option>
            <option value="private">私聊</option>
          </select>
        </div>
        <div class="field">
          <label>号码</label>
          <input type="text" id="nc-id" placeholder="群号或 QQ 号（纯数字）" />
        </div>
        <div class="field">
          <label>&nbsp;</label>
          <button class="btn btn-small" id="nc-pick" type="button">从列表里选…</button>
          <span class="muted" id="nc-pick-status"></span>
        </div>
        <div class="hint" id="nc-status">
          会建出这个会话的<b>空存档</b>（存档页可见，之后可加备注）与<b>空记忆</b>（记忆页可见，之后可加印象）。
          已经存在的不会被覆盖。
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" id="nc-ok">创建</button>
        <button class="btn" id="nc-cancel">取消</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const status = $('#nc-status', overlay);
  const kindEl = $('#nc-kind', overlay);
  const idEl = $('#nc-id', overlay);
  const pickStatus = $('#nc-pick-status', overlay);

  const close = () => overlay.remove();
  $('#nc-cancel', overlay).addEventListener('click', close);

  // 「从列表里选…」：拉 OneBot 的群/好友列表填充候选。
  // **不做成必须项**：OneBot 没连上时照样能手填号码，所以拉失败只提示、不禁用创建。
  let cached = { group: null, private: null };
  $('#nc-pick', overlay).addEventListener('click', async () => {
    const kind = kindEl.value === 'private' ? 'private' : 'group';
    pickStatus.textContent = '拉取中…';
    try {
      if (!cached[kind]) {
        const data = await api(kind === 'group' ? '/api/onebot/groups' : '/api/onebot/friends');
        cached[kind] = (kind === 'group' ? data.groups : data.friends) || [];
      }
      const list = cached[kind];
      if (!list.length) {
        pickStatus.textContent = kind === 'group' ? '没拉到群列表（检查 SnowLuma）' : '没拉到好友列表';
        return;
      }
      fillPickList(overlay, list, (id) => {
        idEl.value = id;
        pickStatus.textContent = `已选 ${id}`;
      });
      pickStatus.textContent = `拉到 ${list.length} 个，在上面选一个`;
    } catch (error) {
      // 手填仍然可用，所以这里只提示、不阻塞
      pickStatus.textContent = `拉取失败：${error.message}（也可以直接手填号码）`;
    }
  });

  $('#nc-ok', overlay).addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const kind = kindEl.value === 'private' ? 'private' : 'group';
    const id = String(idEl.value || '').trim();
    // 校验放在前端只是**为了先说清哪里不对**；服务端仍会独立校验（唯一判据在那边）。
    if (!/^\d+$/.test(id)) {
      status.textContent = '号码必须是纯数字（群号或 QQ 号）。';
      return;
    }
    const chatKey = `${kind}:${id}`;
    btn.disabled = true;
    status.textContent = '创建中…';
    try {
      const result = await api(`/api/chats/${chatKey.replace(':', '_')}`, { method: 'POST', body: '{}' });
      const made = [];
      if (result.archiveCreated) made.push('空存档');
      if (result.memoryCreated) made.push('空记忆');
      status.textContent = made.length
        ? `已创建：${made.join('、')}。`
        : '这个会话的存档与记忆都已经存在，没有改动。';
      onCreated?.(chatKey, result);
      close();
    } catch (error) {
      status.textContent = `创建失败：${error.message}`;
      btn.disabled = false;
    }
  });
}

/** 在弹窗内部渲染一个候选列表（点一项即回填号码）。 */
function fillPickList(overlay, list, onPick) {
  const old = $('.nc-pick-list', overlay);
  if (old) old.remove();
  const box = document.createElement('div');
  box.className = 'modal-list nc-pick-list';
  box.innerHTML = list.map((item) => `
    <label class="pick-item">
      <span>${esc(item.name || '(无名)')}</span>
      <span class="muted">${esc(item.id)}</span>
      <button class="btn btn-small" data-pick="${esc(item.id)}" type="button">用这个</button>
    </label>`).join('');
  box.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-pick]');
    if (!btn) return;
    event.preventDefault();
    onPick(btn.dataset.pick);
  });
  const anchor = $('.modal-foot', overlay);
  anchor.parentNode.insertBefore(box, anchor);
}
