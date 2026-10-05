import { actions } from '../actions.js';
import { api } from '../api.js';
import { $, $$, esc, fmtTime } from '../dom.js';
import { state } from '../state.js';
import { chatNameOf, formatChatTitle } from '../chat-labels.js';

let memSearchTimer = null;
// ── 记忆视图 ──
export async function loadMemoryView() {
  try {
    const [cfg, chats] = await Promise.all([api('/api/config'), api('/api/chats')]);
    state.config = cfg;
    const files = await api('/api/memory-files');
    state.memoryFiles = files.files || [];
    state.chats = chats.chats || [];
    // 用后端状态校正本地记录：覆盖"页面刚刷新""SSE 断连期间状态变化"两种情况。
    // 后端 consolidating 是唯一可信来源（它在 orchestrator 里真实维护）。
    for (const f of state.memoryFiles) {
      if (f.consolidating) {
        if (!state.consolidating[f.chatKey]) {
          state.consolidating[f.chatKey] = { startedAt: Date.now() };
        }
      } else if (state.consolidating[f.chatKey]) {
        // 后端已经不在整理，说明完成了（结果由 SSE 事件补充）
        delete state.consolidating[f.chatKey];
        if (!state.consolidateResult[f.chatKey]) {
          state.consolidateResult[f.chatKey] = { note: '整理完成', at: Date.now() };
        }
      }
    }
    renderMemoryList();
    if (state.currentMemoryChatKey) loadMemoryDetail(state.currentMemoryChatKey);
  } catch (e) {
    console.error('加载记忆视图失败:', e);
    $('#memory-items').innerHTML = '<div class="list-head muted">加载失败</div>';
  }
}

// 整理中的计时刷新：让"已 Ns"持续走动，并在没有活跃任务时自动停掉。
// 整理可能持续几十秒，用户切走再切回时靠它维持可见状态。
let consolidateTicker = null;
export function startConsolidateTicker() {
  if (consolidateTicker) return;
  consolidateTicker = setInterval(() => {
    const active = Object.keys(state.consolidating);
    if (!active.length) {
      clearInterval(consolidateTicker);
      consolidateTicker = null;
      if (state.tab === 'memory') renderMemoryList();
      return;
    }
    if (state.tab !== 'memory') return;
    // 只更新计时文本，不重建整个详情页（避免打断用户阅读/滚动）
    const key = state.currentMemoryChatKey;
    const el = $('#mem-consolidate-status');
    if (key && state.consolidating[key] && el) {
      const sec = Math.max(0, Math.round((Date.now() - (state.consolidating[key].startedAt || Date.now())) / 1000));
      el.textContent = `整理中…（已 ${sec}s）`;
    }
    renderMemoryList();
  }, 1000);
}

export function renderMemoryList() {
  const box = $('#memory-items');
  const files = state.memoryFiles || [];
  const names = {};
  for (const c of state.chats || []) names[c.key] = formatChatTitle(c.key, chatNameOf(c.key));
  if (!files.length) {
    box.innerHTML = '<div class="list-head muted">还没有任何记忆（等机器人使用记忆工具后才会出现）</div>';
    return;
  }
  box.innerHTML = files.map((f) => {
    const key = f.chatKey;
    const busy = !!state.consolidating[key];
    // 整理中：在列表项上直接标出，切页签回来也能一眼看到
    const busyHtml = busy
      ? `<span class="unread-pill" style="background:var(--orange)">整理中…</span>`
      : '';
    const sub = busy
      ? '正在整理本群记忆'
      : (f.memberCount
        ? `${f.memberCount} 位群友 · ${f.impressionCount} 条印象`
        : '暂无群友印象');
    return `
      <div class="chat-item ${key === state.currentMemoryChatKey ? 'selected' : ''}" data-key="${esc(key)}">
        <div class="chat-item-title">
          <span class="session-chat">${esc(names[key] || key)}</span>
          ${busyHtml}
        </div>
        <div class="chat-item-sub">${esc(sub)}</div>
        <div class="session-meta"><span>更新于 ${fmtTime(f.updatedAt || 0)}</span></div>
      </div>`;
  }).join('');
  $$('.chat-item', box).forEach((el) => {
    el.addEventListener('click', () => {
      state.currentMemoryChatKey = el.dataset.key;
      renderMemoryList();
      loadMemoryDetail(state.currentMemoryChatKey);
    });
  });
}

export async function loadMemoryDetail(chatKey) {
  const detail = $('#memory-detail');
  detail.innerHTML = '<div class="empty-hint">加载中…</div>';
  try {
    const [mem, cfg] = await Promise.all([
      api(`/api/memory-files/${chatKey.replace(':', '_')}`),
      api('/api/config')
    ]);
    const notes = cfg.memberNotes || {};
    const kind = chatKey.startsWith('group') ? 'group' : 'private';
    const chatId = chatKey.split(':')[1] || '';
    const members = Array.isArray(mem.members) ? mem.members : [];
    const membersHtml = kind === 'group'
      ? `<div class="field" style="margin:8px 0"><button class="btn btn-small" id="mem-load-members-btn">拉取群成员列表（编辑备注）</button><span id="mem-members-status" class="muted"></span></div><div id="mem-members"></div>`
      : '';
    // 查找：命中成员名/QQ/备注名，或命中任意一条印象的文字。命中时不隐藏成员，
    // 只把该成员下不匹配的印象折起来 —— 否则搜一个词会连带看不到"这个人还有别的什么印象"。
    const mq = String(state.memQuery || '').trim().toLowerCase();
    const memberHit = (m, who) => `${who}\n${m.name || ''}\n${m.userId || ''}`.toLowerCase().includes(mq);
    let shownImps = 0;
    const rows = members.map((m) => {
      const who = notes[String(m.userId)] || m.name || m.userId || '某人';
      const hitMember = !mq || memberHit(m, who);
      const imps = m.impressions || [];
      const matched = hitMember ? imps : imps.filter((e) => String(e.content || '').toLowerCase().includes(mq));
      if (mq && !matched.length) return '';
      shownImps += matched.length;
      // 每行一条 + 改/删。寻址用 data-uid + data-idx：
      // idx 只在这个渲染快照里定位，正文从闭包里的 members 取 —— 不走 DOM 属性，
      // 省掉转义/换行归一化的坑；服务端仍按 (userId, content) 校验，对不上就 404。
      const impRows = matched.map((e) => {
        const idx = imps.indexOf(e);
        return `<div class="imp-row">
            <span class="imp-text">${esc(e.content)}</span>
            <button class="btn btn-small imp-edit" data-uid="${esc(m.userId)}" data-idx="${idx}" title="改这条印象（保留原本的记录时间）">改</button>
            <button class="btn btn-small btn-danger imp-del" data-uid="${esc(m.userId)}" data-idx="${idx}" title="删掉这条印象">删</button>
          </div>`;
      }).join('');
      const qq = m.userId ? ` <span class="muted">(QQ ${esc(m.userId)})</span>` : '';
      const countLabel = mq ? `匹配 ${matched.length} / ${imps.length} 条` : `${imps.length} 条`;
      return `<div class="collapsible" open>
        <summary>${esc(who)}${qq}（${countLabel}）
          <button class="btn btn-small mem-add-one" data-uid="${esc(m.userId)}" data-name="${esc(m.name)}" style="margin-left:8px" title="给这个人再加一条印象">＋</button>
          <button class="btn btn-small mem-edit-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" style="margin-left:6px">批量编辑</button>
          <button class="btn btn-small mem-refresh-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" style="margin-left:6px" title="让模型重新分析这个人：有印象则整理合并，没印象则从聊天记录里提炼">更新记忆</button>
        </summary>
        <div class="coll-body">
          ${impRows || '<div class="muted">（没有印象）</div>'}
        </div>
      </div>`;
    }).join('');
    //   <div class="hint">单条「改」保留原本的记录时间；「批量编辑」是把整份印象重写一遍，
    //     会把所有条目的时间刷成当下 —— 想让"这条印象是什么时候形成的"保持准确，用单条改。</div>
    // 整理状态从 state 恢复：切页签回来 / 刷新页面后依然可见
    const busy = !!state.consolidating[chatKey];
    const result = state.consolidateResult[chatKey];
    let consolidateStatusHtml = '';
    if (busy) {
      const started = state.consolidating[chatKey]?.startedAt || Date.now();
      const sec = Math.max(0, Math.round((Date.now() - started) / 1000));
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted">整理中…（已 ${sec}s）</span>`;
    } else if (result) {
      const ago = Math.max(0, Math.round((Date.now() - (result.at || 0)) / 1000));
      const when = ago < 60 ? `${ago}s 前` : `${Math.round(ago / 60)} 分钟前`;
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted">${esc(result.note)}（${when}）</span>`;
    } else {
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted"></span>`;
    }
    detail.innerHTML = `
      <div class="detail-header">
        <h2>${esc(formatChatTitle(chatKey, chatNameOf(chatKey)))} 的记忆</h2>
        <div class="sub">
          <span>每个群友一个文件：data/memory/${esc(chatKey.replace(':', '_'))}/&lt;QQ&gt;.json</span>
          <input type="text" id="mem-search" placeholder="查找群友 / 印象内容" />
          <button class="btn btn-small" id="mem-add-imp-btn">＋ 添加印象</button>
          <button class="btn btn-small" id="mem-consolidate-btn" ${busy ? 'disabled' : ''}>${busy ? '整理中…' : '整理本群记忆'}</button>
          <button class="btn btn-small btn-danger" id="mem-clear-all-btn" title="删掉这个会话下所有群友的全部印象文件">清空本会话记忆</button>
          ${consolidateStatusHtml}
        </div>
      </div>
      ${membersHtml}
      ${rows || (mq
        ? `<div class="muted" style="padding:10px">没有匹配「${esc(state.memQuery)}」的群友或印象。</div>`
        : '<div class="muted" style="padding:10px">还没有任何群友印象（可点右上角「＋ 添加印象」手动记，或点「整理本群记忆」让模型从聊天记录里提炼）。</div>')}
    `;
    const loadMembersBtn = $('#mem-load-members-btn');
    if (loadMembersBtn) loadMembersBtn.addEventListener('click', () => actions.loadGroupMembers(chatId, chatKey));

    // ── 查找框 ──
    // 重新渲染会把整块 innerHTML 换掉，所以要先恢复词、再把光标放回原处 ——
    // 否则整理流程每推一条 memory-update，用户正在敲的字就被清空了。
    const search = $('#mem-search');
    if (search) {
      search.value = state.memQuery || '';
      search.addEventListener('input', () => {
        state.memQuery = search.value;
        clearTimeout(memSearchTimer);
        memSearchTimer = setTimeout(() => {
          const caret = search.selectionStart;
          loadMemoryDetail(chatKey).then(() => {
            const again = $('#mem-search');
            if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch { /* 忽略 */ } }
          });
        }, 150);
      });
    }

    // ── 单条印象的 改 / 删 ──
    // 定位走 data-idx → 闭包里的 members：正文从渲染时的快照对象上取，
    // 而不是从 DOM 属性回读（省掉转义与换行归一化的坑）。服务端仍按
    // (userId|target, content) 校验，对不上就 404 让用户刷新。
    const impTarget = (el) => {
      const uid = String(el.dataset.uid || '');
      const idx = Number(el.dataset.idx);
      const m = members.find((x) => String(x.userId) === uid);
      const entry = m?.impressions?.[idx];
      if (!m || !entry) return null;
      // 有 QQ 号按号寻址；没有的（整理时没能确定 QQ）只能按名字 —— 与后端一致
      return { m, entry, address: uid ? { userId: uid } : { target: m.name || m.userId } };
    };
    $$('.imp-edit', detail).forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();   // 不拦的话这次点击会顺手把 <details> 折叠了
        const t = impTarget(el);
        if (!t) return;
        const overlay = actions.modelModalShell({
          head: `改印象 · ${esc(t.m.name || t.m.userId)}`,
          body: `<div class="field">
              <label>印象内容</label>
              <textarea id="mi-single" rows="3">${esc(t.entry.content)}</textarea>
              <div class="hint">原记录时间（${fmtTime(t.entry.createdAt)}）会保留。
                改成与这个人已有的某条一字不差会被拒绝 —— 那样以后删一条会连另一条一起删掉。</div>
            </div>`,
          foot: '<button class="btn" id="mi-cancel">取消</button><button class="btn btn-primary" id="mi-save">保存</button>'
        });
        const ta = overlay.querySelector('#mi-single');
        ta.focus();
        overlay.querySelector('#mi-cancel').addEventListener('click', () => actions.closeModelModal(overlay));
        overlay.querySelector('#mi-save').addEventListener('click', async (ev) => {
          const next = ta.value.trim();
          if (!next) { alert('印象内容不能为空'); return; }
          ev.currentTarget.disabled = true;
          try {
            await api(`/api/memory-files/${chatKey.replace(':', '_')}/impressions`, {
              method: 'PATCH',
              body: JSON.stringify({ ...t.address, content: t.entry.content, next })
            });
            actions.closeModelModal(overlay);
            loadMemoryDetail(chatKey);
          } catch (err) {
            ev.currentTarget.disabled = false;
            alert('保存失败：' + (err.message || err));
            // 404 = 这份数据已经被模型整理流程改写过了，刷新让用户看到真实现状
            if (/刷新/.test(err.message || '')) { actions.closeModelModal(overlay); loadMemoryDetail(chatKey); }
          }
        });
      });
    });
    $$('.imp-del', detail).forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const t = impTarget(el);
        if (!t) return;
        const last = (t.m.impressions || []).length === 1;
        let warn = `确定删掉这条印象吗？\n\n${t.m.name || t.m.userId}：${t.entry.content}\n\n`;
        if (last) warn += '⚠️ 这是此人最后一条印象：删掉后他的记忆文件（data/memory/…/' + (t.address.userId || t.m.name) + '.json）也会被删除。\n';
        else warn += '（会在 data/memory/backups/ 留一份备份，保留最近一次）\n';
        if (!confirm(warn)) return;
        el.disabled = true;
        try {
          const r = await api(`/api/memory-files/${chatKey.replace(':', '_')}/impressions`, {
            method: 'DELETE',
            body: JSON.stringify({ ...t.address, content: t.entry.content })
          });
          if (r?.memberGone) alert('已删除。这是最后一条，这个人的记忆文件也一并删掉了。');
          loadMemoryDetail(chatKey);
        } catch (err) {
          el.disabled = false;
          alert('删除失败：' + (err.message || err));
          if (/刷新/.test(err.message || '')) loadMemoryDetail(chatKey);
        }
      });
    });

    // ── 给某个人单加一条印象（不重写他现有的印象） ──
    $$('.mem-add-one', detail).forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const uid = String(el.dataset.uid || '');
        const nm = String(el.dataset.name || '');
        const overlay = actions.modelModalShell({
          head: `添加印象 · ${esc(nm || uid)}`,
          body: `<div class="field">
              <label>印象内容</label>
              <textarea id="mi-add" rows="3" placeholder="例：说话喜欢带感叹号"></textarea>
              <div class="hint">只追加这一条，不动这个人已有的印象。</div>
            </div>`,
          foot: '<button class="btn" id="mia-cancel">取消</button><button class="btn btn-primary" id="mia-save">添加</button>'
        });
        overlay.querySelector('#mi-add').focus();
        overlay.querySelector('#mia-cancel').addEventListener('click', () => actions.closeModelModal(overlay));
        overlay.querySelector('#mia-save').addEventListener('click', async (ev) => {
          const content = overlay.querySelector('#mi-add').value.trim();
          if (!content) { alert('印象内容不能为空'); return; }
          ev.currentTarget.disabled = true;
          try {
            const r = await api(`/api/memory-files/${chatKey.replace(':', '_')}/impressions`, {
              method: 'POST',
              body: JSON.stringify({ userId: uid, target: nm, content })
            });
            actions.closeModelModal(overlay);
            if (r?.duplicate) alert('这个人已经有一条一字不差的印象了，没有重复添加。');
            loadMemoryDetail(chatKey);
          } catch (err) {
            ev.currentTarget.disabled = false;
            alert('添加失败：' + (err.message || err));
          }
        });
      });
    });

    $$('.mem-edit-imp', detail).forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const m = members.find((x) => String(x.userId) === String(el.dataset.qq));
        actions.openMemberImpressModal(chatKey, m || { userId: el.dataset.qq, name: el.dataset.name, impressions: [] });
      });
    });
    $('#mem-add-imp-btn')?.addEventListener('click', () => actions.openMemberImpressModal(chatKey, null));
    // 针对单个群友更新记忆：有印象→整理合并；无印象→从聊天记录提炼
    $$('.mem-refresh-imp', detail).forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const uid = String(el.dataset.qq || '').trim();
        if (!/^\d{1,15}$/.test(uid)) { alert('该群友缺少 QQ 号，无法定位聊天记录'); return; }
        el.disabled = true;
        const old = el.textContent;
        el.textContent = '更新中…';
        // 同样记进 state，切页签回来后仍能看到进行中
        state.consolidating[chatKey] = { startedAt: Date.now() };
        delete state.consolidateResult[chatKey];
        startConsolidateTicker();
        renderMemoryList();
        try {
          await api('/api/memory-files/consolidate', {
            method: 'POST',
            body: JSON.stringify({ chatKey, userIds: [uid] })
          });
          el.textContent = '已提交 ✓';
        } catch (err) {
          el.textContent = '失败';
          alert(`更新记忆失败：${err.message}`);
        }
        setTimeout(() => { el.disabled = false; el.textContent = old; }, 2500);
      });
    });
    $('#mem-consolidate-btn')?.addEventListener('click', async () => {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      // 立刻记进 state：即使马上切走页签，回来也能看到"整理中"
      state.consolidating[chatKey] = { startedAt: Date.now() };
      delete state.consolidateResult[chatKey];
      startConsolidateTicker();
      renderMemoryList();
      if (btn) { btn.disabled = true; btn.textContent = '整理中…'; }
      if (status) status.textContent = '整理中…';
      try {
        const r = await api('/api/memory-files/consolidate', {
          method: 'POST',
          body: JSON.stringify({ chatKey })
        });
        if (r.error) {
          delete state.consolidating[chatKey];
          state.consolidateResult[chatKey] = { note: `失败：${r.error}`, at: Date.now(), failed: true };
          if (status) status.textContent = `失败：${r.error}`;
          if (btn) { btn.disabled = false; btn.textContent = '整理本群记忆'; }
          renderMemoryList();
        }
        // 成功时保持"整理中"，等 SSE 的 consolidate-done 事件来收尾
      } catch (e) {
        delete state.consolidating[chatKey];
        state.consolidateResult[chatKey] = { note: `失败：${e.message}`, at: Date.now(), failed: true };
        if (status) status.textContent = `失败：${e.message}`;
        if (btn) { btn.disabled = false; btn.textContent = '整理本群记忆'; }
        renderMemoryList();
      }
    });
    // 清空本会话记忆：删掉这个 chatKey 下**所有群友**的印象文件。
    // 与"删除此人"（成员级）是两个粒度，所以确认文案要写清是"全部群友"，避免误点。
    $('#mem-clear-all-btn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      const label = formatChatTitle(chatKey, chatNameOf(chatKey));
      const count = members.length;
      const total = members.reduce((n, m) => n + (m.impressions?.length || 0), 0);
      if (!confirm(`确定清空「${label}」的**全部记忆**？\n\n`
        + `这会删掉 ${count} 个群友的 ${total} 条印象（整个 data/memory/${chatKey.replace(':', '_')}/ 目录）。\n`
        + '每个群友的印象是机器人对这个人的长期认知，删掉后无法从界面恢复。\n\n'
        + '只想去掉某个人，用那个人那一行的「删」按钮。')) return;
      btn.disabled = true;
      const status = $('#mem-consolidate-status');
      try {
        const r = await api(`/api/memory-files/${chatKey.replace(':', '_')}`, { method: 'DELETE' });
        if (status) status.textContent = `已清空（${r.removedMembers ?? count} 个群友）`;
        loadMemoryDetail(chatKey);
        renderMemoryList();
      } catch (error) {
        if (status) status.textContent = `清空失败：${error.message}`;
        alert(`清空失败：${error.message}`);
        btn.disabled = false;
      }
    });
    // 若本群正在整理，启动计时刷新（切回来时也能接着走）
    if (state.consolidating[chatKey]) startConsolidateTicker();
  } catch (e) {
    detail.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}
