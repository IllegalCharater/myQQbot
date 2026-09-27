import { actions } from '../actions.js';
import { api } from '../api.js';
import { $, $$, esc, fmtTime } from '../dom.js';
import { state } from '../state.js';

// ── 表情包页 ────────────────────────────────────────────────────────────────
//
// 库里既有 QQ 收藏（source='qq'，源在 QQ 那边）也有 AI 收藏（source='ai'，
// collect_sticker 偷来的）。**删 qq 来源的删不掉** —— mergeStickerLibrary 每次
// 同步都会按 fetchedIds 把它收编回来，所以后端直接 409，这里也不给能点的按钮。

export const STICKER_SOURCE_LABEL = { qq: 'QQ收藏', ai: 'AI收藏', manual: '手工' };

export async function loadStickerView({ quiet = false } = {}) {
  const box = $('#sticker-items');
  if (!box) return;
  if (!quiet) box.innerHTML = '<div class="muted" style="padding:10px">加载中…</div>';
  try {
    const q = encodeURIComponent(state.stickerQuery || '');
    const data = await api(`/api/stickers?q=${q}&limit=200`);
    state.stickers = data.stickers || [];
    state.stickerTotal = data.total || 0;
    state.stickerOwned = Number(data.owned) || 0;
    state.stickerMaxKeep = Number(data.maxKeepCount) || 0;
    state.stickerSync = { fromCache: !!data.fromCache, error: data.syncError || '', at: Date.now() };
    renderStickerItems();
    // 选中的那条可能已经被删/被过滤掉了：还在就重画详情，不在就退回提示
    if (state.stickerSelectedId && state.stickers.some((s) => s.id === state.stickerSelectedId)) {
      renderStickerDetail(state.stickers.find((s) => s.id === state.stickerSelectedId));
    } else if (state.stickerSelectedId) {
      state.stickerSelectedId = null;
      const d = $('#sticker-detail');
      if (d) d.innerHTML = '<div class="empty-hint">← 从左侧选择一个表情查看</div>';
    }
  } catch (e) {
    if (!quiet) box.innerHTML = `<div class="muted" style="padding:10px">加载失败：${esc(e.message)}</div>`;
  }
}

export function renderStickerItems() {
  const box = $('#sticker-items');
  if (!box) return;
  const cnt = $('#sticker-count');
  if (cnt) {
    const sync = state.stickerSync;
    const q = String(state.stickerQuery || '').trim();
    let note = q ? `匹配 ${state.stickers.length} / ${state.stickerTotal} 张` : `共 ${state.stickerTotal} 张`;
    // bot 自己收藏的那一批是唯一会被上限淘汰的（QQ 收藏不算也不删），这个数得让用户看得见
    if (state.stickerOwned || state.stickerMaxKeep > 0) {
      note += ` · bot 收藏 ${state.stickerOwned} 个${state.stickerMaxKeep > 0 ? `（上限 ${state.stickerMaxKeep}）` : ''}`;
    }
    // 手工操作的结果（缓存图片）搭这一次渲染露个面就被清掉 —— 否则紧接着的
    // loadStickerView 会把它冲掉，用户永远看不见自己刚点的那一下干了什么
    if (state.stickerCacheNote) { note += ` · ${state.stickerCacheNote}`; state.stickerCacheNote = ''; }
    // QQ 同步失败时必须说出来：否则用户看着的是本地缓存，却以为那是 QQ 里真实的收藏
    if (sync?.error) note += ' · ⚠️ 同步 QQ 失败，显示本地缓存';
    else if (sync?.fromCache) note += ' · 缓存';
    cnt.textContent = note;
  }
  if (!state.stickers.length) {
    box.innerHTML = `<div class="muted" style="padding:10px">${String(state.stickerQuery || '').trim() ? '没有匹配的表情。' : '表情库是空的（在设置里启用表情包后，同步一次 QQ 收藏即可）。'
      }</div>`;
    return;
  }
  box.innerHTML = `<div class="sticker-grid">${state.stickers.map((s) => {
    // ⚠️ src 指向后端代理，**不是** s.url：QQ 图床有防盗链，而本地库一旦被
    // 污染成内网地址，直连就是用户浏览器去打内网（代理那边有 validateImageUrl 把关）。
    const src = `/api/stickers/${encodeURIComponent(s.id)}/image`;
    const label = s.localNote || s.desc || '';
    return `<div class="sticker-card ${s.id === state.stickerSelectedId ? 'selected' : ''}" data-id="${esc(s.id)}" title="${esc(label || s.id)}">
        <img loading="lazy" alt="${esc(label || s.id)}" src="${esc(src)}" />
        <div class="sticker-card-body">
          <div class="sticker-card-note">${label ? esc(label) : '<span class="muted">（未标注）</span>'}</div>
          <div class="sticker-card-meta">
            <span class="sticker-src">${esc(STICKER_SOURCE_LABEL[s.source] || s.source)}</span>
            ${s.useCount ? `<span>用过 ${s.useCount} 次</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('')}</div>`;
  $$('.sticker-card', box).forEach((el) => {
    el.addEventListener('click', () => {
      state.stickerSelectedId = el.dataset.id;
      renderStickerItems();
      renderStickerDetail(state.stickers.find((s) => s.id === el.dataset.id));
    });
  });
}

export function renderStickerDetail(s) {
  const d = $('#sticker-detail');
  if (!d || !s) return;
  const src = `/api/stickers/${encodeURIComponent(s.id)}/image`;
  d.innerHTML = `
    <div class="detail-header">
      <h2>${esc(s.localNote || s.desc || s.id)}</h2>
      <div class="sub">
        <span class="sticker-src">${esc(STICKER_SOURCE_LABEL[s.source] || s.source)}</span>
        ${s.useCount ? `<span>用过 ${s.useCount} 次</span>` : '<span class="muted">还没用过</span>'}
        ${s.lastUsedAt ? `<span class="muted">最后 ${fmtTime(s.lastUsedAt)}</span>` : ''}
      </div>
    </div>
    <div class="sticker-detail-body">
      <div class="sticker-preview"><img src="${esc(src)}" alt="${esc(s.desc || s.id)}" /></div>
      <div class="sticker-fields">
        <div class="field"><label>QQ 备注名（自动同步，不可编辑）</label>
          <div class="sticker-field-static">${s.desc ? esc(s.desc) : '<span class="muted">（QQ 里没有名字）</span>'}</div></div>
        <div class="field"><label>备注</label>
          <div class="sticker-field-static">${s.localNote ? esc(s.localNote) : '<span class="muted">（未标注）</span>'}</div></div>
        <div class="field"><label>标签</label>
          <div class="sticker-field-static">${(s.tags || []).length ? (s.tags || []).map((t) => `<span class="sticker-tag">${esc(t)}</span>`).join(' ') : '<span class="muted">（无）</span>'}</div></div>
        <div class="field"><label>适用场景</label>
          <div class="sticker-field-static">${s.usage ? esc(s.usage) : '<span class="muted">（未标注）</span>'}</div></div>
        <div class="field"><label>id / md5</label>
          <div class="sticker-field-static mono">${esc(s.id)}<br /><span class="muted">${esc(s.md5 || '（无）')}</span></div></div>
        <div class="field"><label>本地缓存图片</label>
          <div class="sticker-field-static">${s.cached
      ? '<span class="muted">已缓存，发送时直接用本机图片</span>'
      : (s.source === 'qq'
        ? '<span class="muted">QQ 收藏不进缓存（它的链接每次同步都会换新的）</span>'
        : '<span class="muted">还没有本地图片，点上面的「缓存图片」或等它被发送时自动补一份</span>')}</div></div>
        <div class="chat-toolbar">
          <button class="btn btn-small" id="sticker-edit-btn">编辑备注 · 标签 · 场景</button>
          ${s.deletable
      ? '<button class="btn btn-small btn-danger" id="sticker-del-btn">删除</button>'
      : '<button class="btn btn-small" disabled title="这是 QQ 收藏里的表情，本地删不掉（下次同步就会回来）。想删请到 QQ 里取消收藏。">QQ 收藏不能在这里删</button>'}
        </div>
        <div class="hint">「备注 / 标签 / 适用场景」是机器人挑表情时看的依据（提示词里的【可用表情包】）。
          改完备注后，标注相同的两个表情会让它挑不出来 —— 那种情况它会明确报错并列出候选 id，不会乱挑一个。
          改动只影响<b>下一轮</b>运行。</div>
        ${s.deletable ? '' : '<div class="hint">删除按钮被禁用的原因：这张图来自 QQ 收藏本身，本地删掉下次同步就会重新出现。</div>'}
      </div>
    </div>`;
  $('#sticker-edit-btn')?.addEventListener('click', () => openStickerEditModal(s));
  $('#sticker-del-btn')?.addEventListener('click', () => deleteSticker(s));
}

export function openStickerEditModal(s) {
  state.stickerBusy = true;
  const overlay = actions.modelModalShell({
    head: `编辑表情 · ${esc(s.localNote || s.desc || s.id)}`,
    body: `<div class="field">
        <label>QQ 备注名（只读）</label>
        <div class="sticker-field-static">${s.desc ? esc(s.desc) : '<span class="muted">（QQ 里没有名字）</span>'}</div>
        <div class="hint">这个名字来自 QQ 收藏，每次同步都会被源数据盖回来，所以在面板上改不了。</div>
      </div>
      <div class="field"><label>备注</label>
        <input type="text" id="sc-note" value="${esc(s.localNote || '')}" placeholder="这张图是什么梗 / 什么情绪" /></div>
      <div class="field"><label>标签（逗号或空格分隔）</label>
        <input type="text" id="sc-tags" value="${esc((s.tags || []).join(', '))}" placeholder="可爱, 无语, 猫" /></div>
      <div class="field"><label>适用场景</label>
        <input type="text" id="sc-usage" value="${esc(s.usage || '')}" placeholder="被夸的时候 / 深夜闲聊" /></div>`,
    foot: '<button class="btn" id="sc-cancel">取消</button><button class="btn btn-primary" id="sc-save">保存</button>'
  });
  overlay.querySelector('#sc-note').focus();
  const done = () => { state.stickerBusy = false; };
  overlay.querySelector('#sc-cancel').addEventListener('click', () => { done(); actions.closeModelModal(overlay); });
  overlay.querySelector('#sc-save').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      await api(`/api/stickers/${encodeURIComponent(s.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          note: overlay.querySelector('#sc-note').value,
          tags: overlay.querySelector('#sc-tags').value,
          usage: overlay.querySelector('#sc-usage').value
        })
      });
      done();
      actions.closeModelModal(overlay);
      loadStickerView({ quiet: true });
    } catch (err) {
      e.currentTarget.disabled = false;
      alert('保存失败：' + (err.message || err));
    }
  });
}

export async function deleteSticker(s) {
  state.stickerBusy = true;
  try {
    if (!confirm(`确定从本地表情库里删掉这一张吗？\n\n${s.localNote || s.desc || s.id}\n\n· 只是本地认知层，不会动 QQ 收藏\n· 这是 AI 收藏（偷来的图），删了就真没了`)) return;
    await api(`/api/stickers/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
    state.stickerSelectedId = null;
    $('#sticker-detail').innerHTML = '<div class="empty-hint">← 从左侧选择一个表情查看</div>';
    loadStickerView({ quiet: true });
  } catch (err) {
    alert('删除失败：' + (err.message || err));
  } finally {
    state.stickerBusy = false;
  }
}

/** 编辑/添加某个群友的印象（一行一条，保存后整体替换）。 */

let stickerSearchTimer = null;
export function initStickerView() {
  // ── 表情包页：搜索框（静态骨架里的那个，列表重绘不会动它） ──
  $('#sticker-search')?.addEventListener('input', (e) => {
    state.stickerQuery = e.target.value;
    clearTimeout(stickerSearchTimer);
    // 服务端过滤：库里可能有几百条，没必要一次全发过来再在本地筛
    stickerSearchTimer = setTimeout(() => loadStickerView({ quiet: true }), 200);
  });
  
  // 刷新 QQ 收藏：结果写进状态行。失败也要写清楚 —— 显示的是缓存，
  // 不是"QQ 里就这些"，两者混淆会让人以为收藏丢了。
  $('#sticker-sync-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '同步中…';
    try {
      const r = await api('/api/stickers/sync', { method: 'POST', body: '{}' });
      const cnt = $('#sticker-count');
      if (cnt) cnt.textContent = r.ok ? `已同步，共 ${r.count} 张` : `同步失败：${r.error || '未知错误'}（显示本地缓存）`;
    } catch (err) {
      const cnt = $('#sticker-count');
      if (cnt) cnt.textContent = `同步失败：${err.message || err}`;
    } finally {
      btn.disabled = false;
      btn.textContent = old;
      loadStickerView({ quiet: true });
    }
  });
  
  // 缓存图片：把 bot 自己收藏的表情的图落到本地（发送时不再依赖会过期的图床链接），
  // 顺手删掉没人认领的缓存文件 —— 一个按钮两个活，结果行把两件事都说清楚。
  $('#sticker-cache-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '缓存中…';
    try {
      const r = await api('/api/stickers/cache', { method: 'POST', body: '{}' });
      const parts = [`新缓存 ${r.cached || 0} 张`];
      if (r.swept) parts.push(`清掉 ${r.swept} 个没人认领的旧文件`);
      if (r.failed) parts.push(`${r.failed} 张没取到（${(r.errors || []).map((x) => x.error).slice(0, 2).join('；') || '图床取不到图'}）`);
      if (r.remains) parts.push(`还剩 ${r.remains} 张，再点一次继续`);
      state.stickerCacheNote = parts.join(' · ');
    } catch (err) {
      state.stickerCacheNote = `缓存失败：${err.message || err}`;
    } finally {
      btn.disabled = false;
      btn.textContent = old;
      loadStickerView({ quiet: true });
    }
  });
  
}
