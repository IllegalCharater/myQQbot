import { api } from '../api.js';
import { $, $$, esc } from '../dom.js';
import { parseList } from '../views/settings/save.js';

export async function openWhitelistPicker(kind) {
  const isGroups = kind === 'groups';
  const noun = isGroups ? '群' : '好友';
  // 拉取过程只体现在这行状态文字上（弹窗是浮层）。成功路径原先从不改写它，
  // 于是"拉取中…"会一直挂在页面上；取消也要还原成打开前的文本，因为选择没变。
  const hint = $('#pick-result');
  const previous = hint.textContent;
  hint.textContent = '拉取中…';
  let list;
  try {
    const data = await api(`/api/onebot/${kind}`);
    list = isGroups ? data.groups : data.friends;
  } catch (e) {
    hint.textContent = `拉取失败：${e.message}（OneBot 未连接？）`;
    return;
  }
  if (!list?.length) {
    hint.textContent = isGroups ? '没拉到群列表（检查 SnowLuma）' : '没拉到好友列表';
    return;
  }
  hint.textContent = `已拉取 ${list.length} 个${noun}，在弹窗里勾选后点「确定」`;
  const inputEl = $(isGroups ? '#cfg-allowgroups' : '#cfg-allowprivate');
  const selected = new Set(parseList(inputEl.value));
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head">选择${noun}（已选 ${selected.size} 个）</div>
      <div class="modal-list">
        ${list.map((g) => `
          <label class="pick-item">
            <input type="checkbox" value="${esc(g.id)}" ${selected.has(g.id) ? 'checked' : ''} />
            <span>${esc(g.name)}</span>
            <span class="muted">${esc(g.id)}</span>
          </label>`).join('')}
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" id="pick-apply">确定</button>
        <button class="btn" id="pick-cancel">取消</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  $('#pick-cancel', overlay).addEventListener('click', () => {
    hint.textContent = previous;
    overlay.remove();
  });
  $('#pick-apply', overlay).addEventListener('click', () => {
    const picked = $$('input[type=checkbox]:checked', overlay).map((el) => el.value);
    inputEl.value = picked.join(',');
    hint.textContent = `已选 ${picked.length} 个${noun}，记得点"保存设置"`;
    overlay.remove();
  });
}
