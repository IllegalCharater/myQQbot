import { actions } from '../../actions.js';
import { api } from '../../api.js';
import { $, $$, esc, fmtClock, fmtTime, fmtTok, fmtYuan } from '../../dom.js';
import { state, TOOL_CAT_ORDER, TOOL_META } from '../../state.js';
import { applyTheme, getThemePref, THEME_ICON, THEME_LABEL } from '../../theme.js';
import { closeModelModal, modelModalShell } from '../../parts/modal.js';
import { openBatchPriceModal, refreshModelPriceCard, renderPriceFeedStatus } from '../../parts/pricing.js';
import { applyProviderPick, bindModelDdDismiss, renderModelColumn, renderProviderColumn, visionBadge } from '../../parts/providers.js';
import { clampInt, renderChatSection, sliderDesc, sliderToTierUI, sliderToTierUI_tierToSlider } from '../../parts/chat-settings.js';
import {
  renderAllowSection, renderApiSection, renderDesktopSection, renderMemorySettingsSection,
  renderHotSearchSection, renderOnebotSection, renderPersonaSection, renderPythonSection,
  renderSearchSection, renderTranscriptionSection, renderImageSourceSection, renderBookmarkRows
} from './sections.js';
import { parseList, saveConfig } from './save.js';
import { openBlocklistModal } from '../../parts/blocklist.js';
import { openPersonaCreateModal, openPersonaPicker } from '../../parts/persona.js';
import { openMemoryModelPicker, openModelAddModal, openModelDeleteModal, openModelPicker } from '../../parts/model-modals.js';
import { openWhitelistPicker } from '../../parts/whitelist.js';

export async function loadSettings() {
  const [cfg, tplData, provData, visionData, priceData] = await Promise.all([
    api('/api/config'),
    api('/api/persona-templates').catch(() => ({ templates: [] })),
    api('/api/providers').catch(() => ({ providers: [] })),
    api('/api/vision/results').catch(() => ({ results: {}, scanning: false })),
    api('/api/model-prices').catch(() => ({ prices: [], current: null }))
  ]);
  state.config = cfg;
  state.providers = provData.providers || [];
  state.visionResults = visionData.results || {};
  state.visionScanning = !!visionData.scanning;
  state.modelPrices = priceData || { prices: [], current: null };
  state.personaTemplates = {};
  for (const t of tplData.templates || []) state.personaTemplates[t.id] = { name: t.name, text: t.text, builtin: !!t.builtin };
  renderSettings();
}

/** 设置页「远程价格表」状态行：来源（在线/缓存/内置）、时间、条目数、错误。 */
export function renderHealthCard() {
  const { ready, checks } = actions.assessReadiness(state.config, state.status);
  const rows = checks.map((c) => {
    let extra = '';
    if (!c.ok && c.fix === 'snowluma-tab') {
      extra = ' <button class="btn btn-small" id="hc-goto-snowluma">前往 SnowLuma 页签</button>';
    }
    return `
    <div class="h-item ${c.ok ? 'ok' : 'bad'}">
      <span>${c.ok ? '✓' : '✗'}</span>
      <span class="h-label">${esc(c.label)}${extra}</span>
    </div>`;
  }).join('');
  const testRow = `
    <div class="h-item ${'mute'}">
      <span>·</span>
      <span class="h-label">API 连通性：
        <button class="btn btn-small" id="test-api-btn">测试一下</button>
        <span id="test-api-result" class="muted"></span>
      </span>
    </div>`;
  return `
    <div class="health-card ${ready ? 'all-ok' : ''}">
      <div class="h-title">${ready ? '✅ 一切就绪，机器人运行中' : '🧭 完成下面缺失项就能跑起来'}</div>
      ${rows}
      ${testRow}
    </div>`;
}

// 人设模板数据：state.personaTemplates（由 loadSettings 从后端填充）

// ── 模型目录（多提供商；面板式选择 + 图片输入能力徽标） ──
export function renderSettingsSidebar() {
  const s = state.status;
  const sidebar = $('#settings-sidebar');
  if (!sidebar) return;
  const menu = [
    ['api', '模型 API'],
    ['search', '搜索服务'],
    ['image-source', '图片来源识别'],
    ['memory', '记忆'],
    ['persona', '人设'],
    ['allow', '聊天白名单'],
    ['hotsearch', '每日热搜播报'],
    ['transcription', '音视频转写'],
    ['python', 'Python 工具'],
    ['chat', '聊天设置'],
    ['desktop', '桌面端'],
    ['onebot', 'OneBot（SnowLuma）']
  ];
  sidebar.innerHTML = `
    <div class="settings-runstate">
      <div class="rs-title">机器人运行状态</div>
      <div class="rs-row"><span class="dot ${s?.onebot?.connected ? 'dot-on' : 'dot-off'}"></span><span>${s?.onebot?.connected ? '运行中' : '未就绪'}</span></div>
      <div class="rs-row muted">${state.paused ? '⏸ 已暂停' : (s?.orchestrator?.model ? `模型：${s.orchestrator.model}` : '模型：未设置')}</div>
    </div>
    <div class="settings-menu">
      ${menu.map(([id, label]) => `<button class="settings-menu-item ${state.settingsSection === id ? 'active' : ''}" data-section="${id}">${label}</button>`).join('')}
    </div>`;
  sidebar.querySelectorAll('.settings-menu-item').forEach((el) => {
    el.addEventListener('click', () => {
      state.settingsSection = el.dataset.section;
      renderSettingsSidebar();
      renderSettings();
    });
  });
}

export function renderSettings() {
  const c = state.config;
  const box = $('#settings-form');
  renderSettingsSidebar();
  box.innerHTML = `
    ${renderSettingsSection(c)}`;
  bindSettingsEvents(c);
}

export function renderSettingsSection(c) {
  const sec = state.settingsSection || 'api';
  const sections = {
    api: () => renderApiSection(c),
    search: () => renderSearchSection(c),
    'image-source': () => renderImageSourceSection(c),
    memory: () => renderMemorySettingsSection(c),
    persona: () => renderPersonaSection(c),
    allow: () => renderAllowSection(c),
    hotsearch: () => renderHotSearchSection(c),
    transcription: () => renderTranscriptionSection(c),
    python: () => renderPythonSection(c),
    chat: () => renderChatSection(c),
    desktop: () => renderDesktopSection(c),
    onebot: () => renderOnebotSection(c)
  };
  const render = sections[sec] || sections.api;
  return `
    <div class="save-bar">
      <button class="btn btn-primary" id="save-cfg-btn">保存设置</button>
      <span id="cfg-save-result" class="muted"></span>
    </div>
    ${render()}`;
}

export function bindSettingsEvents(c) {
  const testImageSource = $('#test-image-source-btn');
  if (testImageSource) testImageSource.addEventListener('click', async () => {
    const out = $('#image-source-test-result'); out.textContent = '测试中…';
    try { const r = await api('/api/image-source/test', { method: 'POST', body: '{}' }); out.textContent = `trace.moe：${r.traceMoe ? '可用' : '失败'}；SauceNAO：${r.sauceNao}；百度识图：${r.baidu}`; }
    catch { out.textContent = '测试失败（未暴露任何密钥）'; }
  });
  // 保存当前区块设置（通用保存按钮）。只有当前区块的字段才会被读取，不会 null 报错。
  const saveCfgBtn = $('#save-cfg-btn');
  if (saveCfgBtn) saveCfgBtn.addEventListener('click', async () => {
    try {
      await saveConfig();
      const res = $('#cfg-save-result');
      res.textContent = '已保存 ✓';
      res.classList.remove('saved-flash');
      void res.offsetWidth;
      res.classList.add('saved-flash');
      actions.refreshStatus();
      actions.startListPoller();   // 刷新间隔可能刚被改过，用新值重启轮询
    } catch (e) {
      $('#cfg-save-result').textContent = `保存失败：${e.message}`;
    }
  });

  // ── Python 工具：解释器探测 / 依赖自检 ──
  // 两个按钮都**先保存本页再探测**（刻意如此）：只有保存过的值才是后端真正会用的那个，
  // 否则页面显示的是"刚敲进去的路径"而不是"生效的路径" —— 而解释器填错时后端报的错
  // （"环境里没有某某库"）与填对但库没装完全一样，看不出区别。
  // 后端那边也**拒绝从请求体取路径**（见 routes/system.ts），所以这里必须真的保存。
  const pySourceNames = {
    config: '本页填写的路径（python.path）',
    'env-primary': '环境变量 QQ_AGENT_PYTHON',
    'windows-direct': 'Windows 固定环境',
    conda: 'conda run -n my_bot python'
  };
  const pythonTest = $('#cfg-python-test');
  if (pythonTest) pythonTest.addEventListener('click', async () => {
    const out = $('#cfg-python-test-result');
    out.textContent = '保存并测试中…';
    try {
      await saveConfig({ quiet: true });
    } catch (e) {
      out.textContent = `保存失败，未探测：${e.message}`;
      return;
    }
    try {
      const r = await api('/api/system/python-probe', { method: 'POST', body: '{}' });
      const parts = [`来源：${pySourceNames[r.source] || r.source}`, `命令：${r.command}`];
      if (r.exists === false) parts.push('⚠️ 这个路径下没有文件');
      const dep = (name) => (r.interpreter?.deps?.[name] ? `${name} ${r.interpreter.deps[name]}` : `${name} 未安装`);
      if (r.interpreter) parts.push(`Python ${r.interpreter.version}`, dep('PicImageSearch'), dep('jmcomic'));
      if (r.error) parts.push(`❌ ${r.error}`);
      out.textContent = parts.join(' · ');
    } catch (e) {
      out.textContent = `测试失败：${e.message}`;
    }
  });
  const pythonCheck = $('#cfg-python-selfcheck');
  if (pythonCheck) pythonCheck.addEventListener('click', async () => {
    const out = $('#cfg-python-test-result');
    const pre = $('#cfg-python-selfcheck-output');
    pre.style.display = 'block';
    pre.textContent = '保存并运行中…（conda 冷启动时可能要等十几秒）';
    out.textContent = '';
    pythonCheck.disabled = true;
    try {
      try {
        await saveConfig({ quiet: true });
      } catch (e) {
        pre.textContent = `保存失败，未运行自检：${e.message}`;
        return;
      }
      const r = await api('/api/system/python-selfcheck', { method: 'POST', body: '{}' });
      out.textContent = r.ok ? '自检通过 ✓' : `自检未通过（退出码 ${r.exitCode ?? '—'}${r.timedOut ? '，已超时终止' : ''}）`;
      // 原文照登，不做润色：worker 头部那几张待验证的映射表要靠这段输出对齐。
      pre.textContent = r.output || '（没有输出）';
    } catch (e) {
      out.textContent = '自检失败';
      pre.textContent = `自检请求失败：${e.message}`;
    } finally {
      pythonCheck.disabled = false;
    }
  });

  // ── 每日热搜播报 ──
  const hotGroupSelect = $('#cfg-hotsearch-groups');
  if (hotGroupSelect) {
    const selected = new Set((c.hotSearchTargetGroupIds || []).map(String));
    const allowed = new Set((c.allow?.groups || []).map(String));
    api('/api/onebot/groups').then((data) => {
      const groups = (data.groups || []).filter((group) => allowed.size === 0
        ? c.allowAllWhenEmpty === true
        : allowed.has(String(group.id)));
      hotGroupSelect.innerHTML = groups.length
        ? groups.map((group) => `<option value="${esc(group.id)}" ${selected.has(String(group.id)) ? 'selected' : ''}>${esc(group.name)}（${esc(group.id)}）</option>`).join('')
        : '<option value="" disabled>（没有可用的白名单群）</option>';
      const hint = $('#hotsearch-groups-hint');
      if (hint) hint.textContent = groups.length
        ? `可选 ${groups.length} 个当前存在且在发送白名单范围内的群。`
        : '没有可选目标群：请先在“聊天白名单”中加入群，并确认机器人仍在该群。';
    }).catch((error) => {
      const hint = $('#hotsearch-groups-hint');
      if (hint) hint.textContent = `群列表读取失败，暂按白名单群号显示：${error.message}`;
    });

    const renderHotStatus = async () => {
      const box = $('#hotsearch-status');
      if (!box) return;
      try {
        const result = await api('/api/hot-search/status');
        const status = result.status || {};
        const labels = { idle: '尚未运行', running: '运行中', success: '成功', failed: '失败', skipped: '已跳过' };
        const when = status.updatedAt ? new Date(status.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—';
        const next = status.nextRunAt ? new Date(status.nextRunAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未排定';
        const auth = status.hasApiKey ? 'API Key' : '匿名额度';
        box.textContent = `${labels[status.status] || status.status || '未知'} · 鉴权：${auth} · 时间：${when} · 条数：${status.itemCount || 0} · 目标群：${status.targetCount || 0} · 下次：${next}${status.error ? ` · ${status.error}` : ''}`;
      } catch (error) { box.textContent = `状态读取失败：${error.message}`; }
    };
    renderHotStatus();

    $('#hotsearch-preview-btn')?.addEventListener('click', async () => {
      const hint = $('#hotsearch-action-hint');
      const preview = $('#hotsearch-preview');
      if (hint) hint.textContent = '正在拉取…';
      try {
        await saveConfig({ quiet: true });
        const result = await api('/api/hot-search/preview', { method: 'POST', body: '{}' });
        if (preview) {
          preview.style.display = '';
          preview.textContent = (result.preview?.pages || []).join('\n\n────────\n\n');
        }
        if (hint) hint.textContent = `拉取成功：${result.preview?.itemCount || 0} 条，仅预览，未发送。`;
      } catch (error) { if (hint) hint.textContent = `拉取失败：${error.message}`; }
      await renderHotStatus();
    });

    $('#hotsearch-broadcast-btn')?.addEventListener('click', async () => {
      const chosen = [...hotGroupSelect.selectedOptions].filter((option) => option.value);
      const hint = $('#hotsearch-action-hint');
      if (!chosen.length) { if (hint) hint.textContent = '请至少选择一个目标群。'; return; }
      if (!confirm(`确定立即向当前配置的 ${chosen.length} 个目标群播报一次热搜吗？`)) return;
      if (hint) hint.textContent = '正在播报…';
      try {
        await saveConfig({ quiet: true });
        const result = await api('/api/hot-search/broadcast', { method: 'POST', body: '{}' });
        if (hint) hint.textContent = `播报完成：${result.result?.itemCount || 0} 条，${result.result?.sentGroupIds?.length || 0} 个群。`;
      } catch (error) { if (hint) hint.textContent = `播报失败：${error.message}`; }
      await renderHotStatus();
    });
  }

  // ── 网页收藏夹：加一行 / 删一行 ──
  //
  // 只动 DOM、不重渲染整页：重渲染会把用户在同一页其他输入框里**还没保存的**改动冲掉
  // （设置页的重渲染读的是 `state.config`，不是当前 DOM 值）。复用 `renderBookmarkRows()`
  // 是为了让新增行与首次渲染**同一份模板** —— 各写一份必然漂移。
  $('#add-search-bookmark-btn')?.addEventListener('click', () => {
    const body = $('#search-bookmarks-body');
    if (!body) return;
    body.insertAdjacentHTML('beforeend', renderBookmarkRows([]));
  });
  // 删除走事件委托：新增行是后插进来的，绑到具体按钮上会漏掉它们。
  $('#search-bookmarks-body')?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const body = $('#search-bookmarks-body');
    if (!body) return;
    // ── 自动检测站内搜索地址 ──
    const probeBtn = target.closest('[data-bm-probe]');
    if (probeBtn) {
      const row = probeBtn.closest('tr');
      const status = row?.querySelector('[data-bm-status]');
      const site = (row?.querySelector('[data-bm-url]')?.value || '').trim();
      // 用户已经填了一半的地址当 hint 发过去：这是唯一能覆盖"参数名不在这几个里"
      // 与"结果在另一个主机上"（如 cn.bing.com 的搜索其实由 www.bing.com 出结果）的办法。
      const hint = (row?.querySelector('[data-bm-searchurl]')?.value || '').trim();
      if (!site) { if (status) status.textContent = '请先填「网页地址」，检测要靠它找搜索入口'; return; }
      probeBtn.disabled = true;
      if (status) status.textContent = '检测中…（最多约 12 秒）';
      api('/api/search-bookmark/probe', { method: 'POST', body: JSON.stringify({ site, hint }) })
        .then((r) => {
          const res = r?.result || {};
          if (res.ok) {
            const urlInput = row?.querySelector('[data-bm-searchurl]');
            if (urlInput) urlInput.value = res.searchUrl || '';
            const clsInput = row?.querySelector('[data-bm-resultclass]');
            // 只在检测出类名时才覆盖：检测不出类名不代表用户原来填的是错的
            if (clsInput && res.resultClass) clsInput.value = res.resultClass;
            if (status) status.textContent = `✓ 已填入。${res.note || ''}（请自己搜一次确认结果对不对）`;
          } else {
            if (status) status.textContent = `✗ ${res.note || '检测失败'}`;
          }
        })
        .catch((e) => { if (status) status.textContent = `✗ 检测请求失败：${e.message}`; })
        .finally(() => { probeBtn.disabled = false; });
      return;
    }
    // ── 删一行 ──
    const btn = target.closest('[data-bm-del]');
    if (!btn) return;
    btn.closest('tr')?.remove();
    // 删空了就补一个空行，否则用户没有可填的输入框（得先点"添加一条"才能开始填）
    if (!body.querySelector('tr[data-bm]')) body.insertAdjacentHTML('beforeend', renderBookmarkRows([]));
  });

  // 搜索提供方切换
  const searchProviderSel = $('#cfg-searchprovider');
  if (searchProviderSel) searchProviderSel.addEventListener('change', () => {
    const v = searchProviderSel.value;
    const fields = {
      bing: '#bing-search-fields',
      deepseek: '#deepseek-search-fields',
      zhipu: '#zhipu-search-fields',
      bocha: '#bocha-search-fields',
      baidu: '#baidu-search-fields',
      metaso: '#metaso-search-fields',
      yandex: '#yandex-search-fields'
    };
    for (const [provider, sel] of Object.entries(fields)) {
      const el = $(sel);
      // 自定义项形如 'custom:<id>'，统一按 custom 前缀匹配
      if (el) el.style.display = provider === v ? '' : 'none';
    }
    // Yandex 的两组选择器各自成行（field-row），要跟主体一起显隐
    for (const sel of ['#yandex-selector-fields', '#yandex-selector-fields2']) {
      const el = $(sel);
      if (el) el.style.display = v === 'yandex' ? '' : 'none';
    }
    const manage = $('#custom-provider-manage');
    if (manage) manage.style.display = v.startsWith('custom:') ? '' : 'none';
  });

  // ── 自定义搜索服务：添加 / 测试 / 删除 ──
  $('#add-search-provider-btn')?.addEventListener('click', async () => {
    const hint = $('#add-search-provider-hint');
    const baseUrl = ($('#new-sp-baseurl')?.value || '').trim();
    if (!baseUrl) { if (hint) hint.textContent = '请先填接口地址'; return; }
    if (hint) hint.textContent = '添加中…';
    try {
      const r = await api('/api/search-providers', {
        method: 'POST',
        body: JSON.stringify({
          name: ($('#new-sp-name')?.value || '').trim(),
          type: $('#new-sp-type')?.value || 'openai',
          baseUrl,
          apiKey: ($('#new-sp-apikey')?.value || '').trim(),
          model: ($('#new-sp-model')?.value || '').trim()
        })
      });
      // 添加后直接选中它（省一次手动切换）
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ webSearch: { provider: `custom:${r.provider.id}` } })
      });
      if (hint) hint.textContent = '已添加并选中 ✓';
      for (const id of ['#new-sp-name', '#new-sp-baseurl', '#new-sp-apikey', '#new-sp-model']) {
        const el = $(id);
        if (el) el.value = '';
      }
      await loadSettings();
    } catch (e) {
      if (hint) hint.textContent = `添加失败：${e.message}`;
    }
  });

  $('#test-search-provider-btn')?.addEventListener('click', async () => {
    const hint = $('#search-provider-action-hint');
    const sel = $('#cfg-searchprovider');
    const v = sel?.value || '';
    if (!v.startsWith('custom:')) { if (hint) hint.textContent = '请先选择一个自定义搜索服务'; return; }
    if (hint) hint.textContent = '测试中…';
    try {
      const r = await api('/api/search-providers/test', {
        method: 'POST',
        body: JSON.stringify({ providerId: v })
      });
      const res = r.result || {};
      if (hint) {
        hint.textContent = res.ok
          ? `✓ 可用（${res.count} 条结果，${res.latencyMs}ms）${res.sample ? `：${res.sample.slice(0, 30)}` : ''}`
          : `✗ ${res.note || '不可用'}`;
      }
    } catch (e) {
      if (hint) hint.textContent = `测试失败：${e.message}`;
    }
  });

  $('#del-search-provider-btn')?.addEventListener('click', async () => {
    const sel = $('#cfg-searchprovider');
    const v = sel?.value || '';
    if (!v.startsWith('custom:')) return;
    const id = v.slice('custom:'.length);
    const opt = sel.querySelector(`option[value="${v}"]`);
    const name = opt ? opt.textContent : id;
    if (!confirm(`确定删除搜索服务「${name}」？`)) return;
    try {
      await api('/api/search-providers', { method: 'DELETE', body: JSON.stringify({ id }) });
      await loadSettings();
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });

  // ── 响应档位滑条：拖动时即时反馈（档位 + 概率）────────────────────
  // ⚠️ 档位的唯一真相是滑条的 value（DOM 实时值），不用全局变量记录 ——
  //   曾经用过 window.__ctxTier，结果每次重渲染重新绑定事件时被"未保存的旧配置"
  //   无条件覆盖（选了 2 档，切走再切回就变回 4 档），还踩了 `|| 4` 的 falsy 陷阱。
  const tierSlider = $('#ctx-tier-slider');
  if (tierSlider) {
    const sync = () => {
      const pos = Number(tierSlider.value);
      const { tier: t } = sliderToTierUI(pos);
      // 提示行：显示当前档位与概率
      const note = $('#ctx-tier-note');
      if (note) note.innerHTML = sliderDesc(pos);
      // 刻度段高亮：滑到哪一档，那一档的标签 + 上边线一起变色。
      // ⚠️ 之前这段完全没做，颜色全靠 CSS 写死（.s1 永远亮、.s4 永远橙），
      //    所以拖动滑条时刻度毫无反应 —— 看起来就像"没生效"。
      const segs = document.querySelectorAll('#tier-scale .tier-seg');
      segs.forEach((el) => {
        el.classList.toggle('on', Number(el.dataset.seg) === t);
      });
      // 滑条填充色（用 CSS 变量告诉样式当前百分比）
      tierSlider.style.setProperty('--pos', pos + '%');
    };
    tierSlider.addEventListener('input', sync);
    sync();   // 初始同步一次
  }

  // ── 统一/分群开关：切换两块 UI 的显隐 ──
  const unifiedChk = $('#cfg-unifiedtier');
  if (unifiedChk) unifiedChk.addEventListener('change', () => {
    const on = unifiedChk.checked;
    const uw = $('#tier-unified-wrap'); if (uw) uw.style.display = on ? '' : 'none';
    const pw = $('#tier-pergroup-wrap'); if (pw) pw.style.display = on ? 'none' : '';
  });

  // ── 分群档位：下拉选群 + 每群一条滑条 ──
  // ⚠️ 唯一真相是隐藏 input 里的 JSON（tier-group-json），滑条每次 input 都即时写回 ——
  //    不用全局变量（这个文件里"全局变量被重渲染覆盖"的坑已经踩过两次了）。
  const groupSel = $('#tier-group-select');
  if (groupSel) {
    const jsonEl = $('#tier-group-json');
    const gSlider = $('#ctx-tier-slider-g');
    const gNote = $('#ctx-tier-note-g');
    const readMap = () => { try { return JSON.parse(jsonEl.value || '{}'); } catch { return {}; } };
    const writeMap = (m) => { jsonEl.value = JSON.stringify(m); };

    // 群列表 = 白名单群 ∪ 已单独设置过的群（后者标"已不在白名单"，留着让用户能清理）
    const allowIds = (c.allow?.groups || []).map(String);
    const extraIds = Object.keys(readMap()).filter((id) => !allowIds.includes(id));
    const ids = [...allowIds, ...extraIds];
    groupSel.innerHTML = ids.length
      ? ids.map((id) => `<option value="${esc(id)}">${esc(id)}${extraIds.includes(id) ? '（已不在白名单）' : ''}</option>`).join('')
      : '<option value="">（白名单为空，先去「白名单」页签加群）</option>';
    // 异步补群名（协议端不在线就保持纯 QQ 号，不影响使用）
    api('/api/onebot/groups').then((d) => {
      const names = new Map((d.groups || []).map((g) => [String(g.id), g.name]));
      groupSel.querySelectorAll('option').forEach((o) => {
        const n = names.get(o.value);
        if (n) o.textContent = `${n}（${o.value}）${extraIds.includes(o.value) ? ' · 已不在白名单' : ''}`;
      });
    }).catch(() => { });

    const syncG = () => {
      const pos = Number(gSlider.value);
      const { tier: t } = sliderToTierUI(pos);
      if (gNote) gNote.innerHTML = sliderDesc(pos);
      document.querySelectorAll('#tier-scale-g .tier-seg')
        .forEach((el) => el.classList.toggle('on', Number(el.dataset.seg) === t));
      gSlider.style.setProperty('--pos', pos + '%');
    };
    const loadGroup = () => {
      const gid = groupSel.value;
      const m = readMap();
      // 没单独设置过的群：从全局滑条当前值起步，所见即所得
      gSlider.value = m[gid] !== undefined ? m[gid] : (Number($('#ctx-tier-slider')?.value) || 100);
      syncG();
    };
    groupSel.addEventListener('change', loadGroup);
    gSlider.addEventListener('input', () => {
      syncG();
      const gid = groupSel.value;
      if (!gid) return;
      const m = readMap(); m[gid] = Number(gSlider.value); writeMap(m);
    });
    $('#tier-group-clear-btn')?.addEventListener('click', () => {
      const gid = groupSel.value;
      if (!gid) return;
      const m = readMap(); delete m[gid]; writeMap(m); loadGroup();
    });
    loadGroup();
  }

  // ── 分群「历史摘要」：下拉选群 + 每组三个控件 ──
  // 与上面分群档位同一套做法（那个的注释里写着这个坑踩过两次）：唯一真相是隐藏 input
  // 里的 JSON，控件改动即时写回，不引全局变量。
  // ⚠️ 写入时必须一次写全三个字段：解析函数（digestConfigForChat）对"缺字段"是按
  //    默认值兜底的，只写一个字段会让另外两个悄悄回到默认值，而不是跟随全局 ——
  //    用户会觉得"我只是改了这个群的字数上限，怎么每轮注入被关了"。
  const digUnified = $('#cfg-digest-unified');
  if (digUnified) digUnified.addEventListener('change', () => {
    const on = digUnified.checked;
    const uw = $('#digest-unified-wrap'); if (uw) uw.style.display = on ? '' : 'none';
    const pw = $('#digest-pergroup-wrap'); if (pw) pw.style.display = on ? 'none' : '';
  });
  const digGroupSel = $('#digest-group-select');
  if (digGroupSel) {
    const jsonEl = $('#digest-group-json');
    const gEvery = $('#cfg-digest-everyround-g');
    const gMerge = $('#cfg-digest-merge-g');
    const gMax = $('#cfg-digest-maxchars-g');
    const gNote = $('#digest-group-note');
    if (jsonEl && gEvery && gMerge && gMax) {
      const readMap = () => { try { return JSON.parse(jsonEl.value || '{}'); } catch { return {}; } };
      const writeMap = (m) => { jsonEl.value = JSON.stringify(m); };
      // 全局那三个控件必然同区渲染：没单独设过的群从它们起步，所见即所得
      // —— 切过去看到的就是这个群此刻实际生效的值。
      const globalVals = () => ({
        injectEveryRound: !!$('#cfg-digest-everyround')?.checked,
        merge: $('#cfg-digest-merge') ? !!$('#cfg-digest-merge').checked : true,
        maxChars: clampInt($('#cfg-digest-maxchars')?.value, 0, 200000, 8000)
      });
      const syncNote = () => {
        if (!gNote) return;
        const gid = digGroupSel.value;
        gNote.innerHTML = (gid && readMap()[gid])
          ? '这个群<b>已单独设置</b>（改完点保存生效）。'
          : '这个群还没单独设置过 —— 现在显示的是跟随全局的值；动任意一项就会为它建一份单独设置。';
      };
      const loadGroup = () => {
        const gid = digGroupSel.value;
        const o = (gid && readMap()[gid]) || null;
        const base = globalVals();
        gEvery.checked = o ? o.injectEveryRound === true : base.injectEveryRound;
        gMerge.checked = o ? o.merge !== false : base.merge;
        gMax.value = String(o && Number.isFinite(Number(o.maxChars)) ? Number(o.maxChars) : base.maxChars);
        syncNote();
      };
      const storeGroup = () => {
        const gid = digGroupSel.value;
        if (!gid) return;
        const m = readMap();
        m[gid] = {
          injectEveryRound: !!gEvery.checked,
          merge: !!gMerge.checked,
          maxChars: clampInt(gMax.value, 0, 200000, 8000)
        };
        writeMap(m);
        syncNote();
      };
      // 群列表 = 白名单群 ∪ 已单独设置过的群（后者标"已不在白名单"，留着让用户能清理）
      const allowIds = (c.allow?.groups || []).map(String);
      const extraIds = Object.keys(readMap()).filter((id) => !allowIds.includes(id));
      const ids = [...allowIds, ...extraIds];
      digGroupSel.innerHTML = ids.length
        ? ids.map((id) => `<option value="${esc(id)}">${esc(id)}${extraIds.includes(id) ? '（已不在白名单）' : ''}</option>`).join('')
        : '<option value="">（白名单为空，先去「白名单」页签加群）</option>';
      api('/api/onebot/groups').then((d) => {
        const names = new Map((d.groups || []).map((g) => [String(g.id), g.name]));
        digGroupSel.querySelectorAll('option').forEach((o) => {
          const n = names.get(o.value);
          if (n) o.textContent = `${n}（${o.value}）${extraIds.includes(o.value) ? ' · 已不在白名单' : ''}`;
        });
      }).catch(() => { });

      digGroupSel.addEventListener('change', loadGroup);
      gEvery.addEventListener('change', storeGroup);
      gMerge.addEventListener('change', storeGroup);
      gMax.addEventListener('input', storeGroup);
      $('#digest-group-clear-btn')?.addEventListener('click', () => {
        const gid = digGroupSel.value;
        if (!gid) return;
        const m = readMap(); delete m[gid]; writeMap(m); loadGroup();
      });
      loadGroup();
    }
  }

  // ── 屏蔽名单 ──
  $('#blocklist-btn')?.addEventListener('click', () => openBlocklistModal());

  // ── 主题选择器（设置页「界面」区）──
  const themePicker = $('#theme-picker');
  if (themePicker) {
    themePicker.querySelectorAll('[data-theme-opt]').forEach((el) => {
      const pick = () => {
        applyTheme(el.dataset.themeOpt);
        themePicker.querySelectorAll('[data-theme-opt]').forEach((x) => x.classList.toggle('on', x === el));
      };
      el.addEventListener('click', pick);
      // 键盘可达：Enter / Space 等价点击
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });
    });
  }

  // ── 成本核算：价格卡片随模型/开关变化 ──
  const useOfficialBox = $('#cfg-useofficialprice');
  if (useOfficialBox) useOfficialBox.addEventListener('change', () => {
    // 开关一变，当前模型的可用单价来源就变了，重刷卡片
    refreshModelPriceCard();
  });
  // 直接在模型输入框里改模型时也要刷新 —— 只有从目录里选才会走另一条路径。
  // 用 input 而非 change：边打字边更新，避免"点了别处才变"的迟滞感。
  const modelInput = $('#cfg-model');
  if (modelInput) modelInput.addEventListener('input', () => refreshModelPriceCard());
  refreshModelPriceCard();

  // 批量自定义价格编辑
  $('#batch-price-btn')?.addEventListener('click', () => openBatchPriceModal());

  // ── 远程价格表：状态展示 + 立即拉取 ──
  renderPriceFeedStatus();
  $('#price-feed-refresh-btn')?.addEventListener('click', async () => {
    const statusEl = $('#price-feed-status');
    // URL 改了还没保存就先拉会拉到旧地址 —— 先顺手保存配置再拉
    try { await saveConfig({ quiet: true }); } catch { /* 保存失败也继续尝试拉取 */ }
    if (statusEl) statusEl.textContent = '正在拉取…';
    try {
      const r = await api('/api/model-prices/refresh', { method: 'POST', body: '{}' });
      state.modelPrices = { prices: r.prices, current: r.current, remote: r.remote };
      renderPriceFeedStatus();
      refreshModelPriceCard();   // 价格可能变了，当前模型卡片跟着刷
    } catch (e) {
      if (statusEl) statusEl.textContent = `拉取失败：${e.message}`;
    }
  });

  // ── 记忆整理区块事件 ──
  const memUseChat = $('#cfg-mem-usechat');
  if (memUseChat) memUseChat.addEventListener('change', () => {
    const box = $('#mem-model-box');
    if (box) box.style.display = memUseChat.checked ? 'none' : '';
  });
  const memModelPick = $('#cfg-mem-model-pick');
  if (memModelPick) memModelPick.addEventListener('click', () => openMemoryModelPicker());

  // ── 模型 API 区块事件 ──
  // 密码框显示/隐藏切换（点击按钮切换对应输入框的 type）
  // 已保存 Key 的输入框初始值统一为掩码 "******"；
  // 点「显示」→ 替换成真实 Key 明文；点「隐藏」→ 重新变回掩码 "******"。
  const pwdToggles = [
    ['cfg-apikey-toggle', 'cfg-apikey'],
    ['new-apikey-toggle', 'new-apikey'],
    ['cfg-ds-searchkey-toggle', 'cfg-ds-searchkey'],
    ['cfg-zhipu-key-toggle', 'cfg-zhipu-key'],
    ['cfg-bocha-key-toggle', 'cfg-bocha-key'],
    ['cfg-baidu-key-toggle', 'cfg-baidu-key'],
    ['cfg-metaso-key-toggle', 'cfg-metaso-key']
  ];
  for (const [btnId, inputId] of pwdToggles) {
    const btn = $(`#${btnId}`);
    const input = $(`#${inputId}`);
    if (btn && input) {
      btn.addEventListener('click', async () => {
        const show = input.type === 'password';
        // 所有 Key 统一走 fetchRealKey：/api/config 里的密钥都是脱敏的，
        // 明文只能向后端专用端点取（服务端会校验请求来源）。
        const real = await fetchRealKey(inputId);
        if (show) {
          // 切到明文：显示真实 Key（若之前是掩码/空占位）
          input.type = 'text';
          input.value = real;
          btn.textContent = '隐藏';
        } else {
          // 切回密码态：如果框里是真实 Key（用户没改过），用掩码盖住；用户改了的新 Key 也盖住
          const current = input.value || '';
          input.type = 'password';
          if (real && (current === real || current === '' || current === '******')) {
            input.value = '******';
          } else if (!real && current === '') {
            input.value = '';
          } else if (current) {
            // 用户输入了新 Key：保持新值（密码态下浏览器会显示圆点）
          }
          btn.textContent = '显示';
        }
      });
    }
  }

  // 输入框 id -> 搜索服务字段名（/api/config 里的搜索 Key 是脱敏的，
  // 所以“显示”必须向后端专用端点要明文，不能直接读 state.config）
  const SEARCH_KEY_FIELDS = {
    'cfg-ds-searchkey': 'deepseek',
    'cfg-zhipu-key': 'zhipu',
    'cfg-bocha-key': 'bocha',
    'cfg-baidu-key': 'baidu',
    'cfg-metaso-key': 'metaso'
  };

  // 前端点“显示”时向后端要真实 Key。
  // 说明：三个端点都只放行本机控制台请求（服务端校验来源），本地单机使用不受影响。
  async function fetchRealKey(inputId) {
    if (inputId === 'cfg-apikey') {
      const pid = state.config?.api?.provider;
      if (pid) {
        const r = await api(`/api/providers/key?providerId=${encodeURIComponent(pid)}`);
        return String(r.apiKey || '');
      }
      const r = await api('/api/api-key');
      return String(r.apiKey || '');
    }
    const field = SEARCH_KEY_FIELDS[inputId];
    if (field) {
      const r = await api(`/api/search-key?field=${encodeURIComponent(field)}`);
      return String(r.apiKey || '');
    }
    return '';
  }
  // 点击文本框弹出选择模态框（无“选择”按钮）
  const modelPickInput = $('#cfg-model-pick');
  if (modelPickInput) modelPickInput.addEventListener('click', () => openModelPicker());
  // 拿当前 API Key 的真实值：如果输入框里是用户刚输入的新 Key（非掩码非空），优先用；否则向后端取
  async function currentApiKey() {
    const input = $('#cfg-apikey');
    const raw = (input?.value || '').trim();
    if (raw && raw !== '******') return raw;          // 用户明文输入的新 Key / 刚点过“显示”的明文
    return await fetchRealKey('cfg-apikey');          // 掩码/空 → 用后端真实 Key
  }

  // 连通性测试：抽成公共逻辑，两个入口共用
  // （健康卡片的 test-api-btn 与模型区块的 test-provider-btn 做的是同一件事）
  async function runConnectivityTest(btn, out, idleLabel) {
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = '测试中…';
    if (out) out.textContent = '';
    try {
      const baseUrl = $('#cfg-baseurl')?.value.trim() || '';
      const model = $('#cfg-model')?.value.trim() || '';
      // 只把"用户新输入的明文 Key"传给服务端；若是掩码/空则不传，
      // 让服务端用自己保存的 Key —— 不依赖明文读取端点，未设 token 时也能测试。
      const input = $('#cfg-apikey');
      const raw = (input?.value || '').trim();
      const apiKey = (raw && raw !== '******') ? raw : '';
      const r = await api('/api/providers/test-chat', {
        method: 'POST',
        body: JSON.stringify({ baseUrl, apiKey, model })
      });
      const res = r.result || {};
      if (out) out.textContent = res.ok
        ? `✓ 测试通过（${res.latencyMs}ms）：${res.note || '请求成功'}`
        : `✗ 测试失败：${res.note || '未知错误'}`;
    } catch (e) {
      if (out) out.textContent = `测试失败：${e.message}`;
    }
    btn.disabled = false;
    btn.textContent = idleLabel;
  }

  const testProviderBtn = $('#test-provider-btn');
  if (testProviderBtn) testProviderBtn.addEventListener('click', () => runConnectivityTest(testProviderBtn, $('#provider-test-result'), '测试连通性'));

  // 健康卡片上的「测试一下」：此前 renderHealthCard 渲染后从未绑定事件
  // （绑的是 test-provider-btn，id 不匹配），按钮点了完全没反应。
  const testApiBtn = $('#test-api-btn');
  if (testApiBtn) testApiBtn.addEventListener('click', () => runConnectivityTest(testApiBtn, $('#test-api-result'), '测试一下'));

  // 当前 Base URL 右侧的“获取列表”
  const fetchCurrentBtn = $('#fetch-current-models-btn');
  if (fetchCurrentBtn) fetchCurrentBtn.addEventListener('click', async () => {
    const btn = fetchCurrentBtn;
    const base = $('#cfg-baseurl')?.value.trim() || '';
    if (!base) { $('#provider-action-hint').textContent = '当前 Base URL 为空'; return; }
    btn.textContent = '拉取中…';
    try {
      const key = await currentApiKey();
      const r = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: base, apiKey: key })
      });
      openModelAddModal(base, key, r.models || []);
      btn.textContent = '获取列表';
    } catch (e) {
      btn.textContent = '获取列表';
      $('#provider-action-hint').textContent = `拉取失败：${e.message}`;
    }
  });

  const fetchModelsBtn = $('#fetch-models-btn');
  if (fetchModelsBtn) fetchModelsBtn.addEventListener('click', async () => {
    const btn = fetchModelsBtn;
    const base = $('#new-baseurl')?.value.trim() || '';
    const key = $('#new-apikey')?.value.trim() || '';
    if (!base) { $('#provider-action-hint').textContent = '请先填写 Base URL'; return; }
    btn.textContent = '拉取中…';
    try {
      const r = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: base, apiKey: key })
      });
      openModelAddModal(base, key, r.models || []);
      btn.textContent = '获取列表';
    } catch (e) {
      btn.textContent = '获取列表';
      $('#provider-action-hint').textContent = `拉取失败：${e.message}`;
    }
  });

  // 模型列表行：ID + 显示名
  let modelRows = [{ id: '', name: '' }];
  function renderModelRows() {
    const box = $('#model-rows');
    if (!box) return;
    box.innerHTML = `
      <table class="model-rows-table">
        <tr><th style="width:44%">模型 ID</th><th style="width:44%">模型目录显示名</th><th></th></tr>
        ${modelRows.map((row, i) => `
          <tr>
            <td><input type="text" class="mr-id" data-i="${i}" placeholder="如 glm-5.3-flash" value="${esc(row.id)}" /></td>
            <td><input type="text" class="mr-name" data-i="${i}" placeholder="如 智谱 GLM 5.3 Flash" value="${esc(row.name)}" /></td>
            <td style="width:56px;text-align:right"><button class="btn btn-small btn-danger mr-del" data-i="${i}" ${modelRows.length <= 1 ? 'disabled' : ''}>删除</button></td>
          </tr>`).join('')}
      </table>`;
    box.querySelectorAll('.mr-id').forEach((el) => {
      el.addEventListener('input', () => { modelRows[Number(el.dataset.i)].id = el.value; });
    });
    box.querySelectorAll('.mr-name').forEach((el) => {
      el.addEventListener('input', () => { modelRows[Number(el.dataset.i)].name = el.value; });
    });
    box.querySelectorAll('.mr-del').forEach((el) => {
      el.addEventListener('click', () => {
        if (modelRows.length <= 1) return;
        modelRows.splice(Number(el.dataset.i), 1);
        renderModelRows();
      });
    });
  }
  renderModelRows();
  const addModelRowBtn = $('#add-model-row-btn');
  if (addModelRowBtn) addModelRowBtn.addEventListener('click', () => {
    modelRows.push({ id: '', name: '' });
    renderModelRows();
  });

  const confirmAddProviderBtn = $('#confirm-add-provider-btn');
  if (confirmAddProviderBtn) confirmAddProviderBtn.addEventListener('click', async () => {
    const baseUrl = $('#new-baseurl').value.trim();
    const apiKey = $('#new-apikey').value.trim();
    const models = modelRows.map((r) => ({ id: r.id.trim(), name: (r.name || r.id).trim() })).filter((m) => m.id);
    if (!baseUrl) { $('#provider-action-hint').textContent = '请填写 Base URL'; return; }
    if (!apiKey) { $('#provider-action-hint').textContent = '请填写 API Key（提供商必须带密钥才能测试连通性/在线探测图片能力）'; return; }
    if (!models.length) { $('#provider-action-hint').textContent = '请至少添加一个模型（先点「获取列表」勾选，或手动填一行）'; return; }
    try {
      const r = await api('/api/providers', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey, models }) });
      $('#provider-action-hint').textContent = r.created ? '已添加新提供商，并自动切换为当前模型。' : '该 Base URL 已存在，模型已合并进该提供商。';
      modelRows = [{ id: '', name: '' }];
      renderModelRows();
      $('#new-baseurl').value = '';
      $('#new-apikey').value = '';
      setTimeout(() => loadSettings(), 500);
    } catch (e) {
      $('#provider-action-hint').textContent = `添加失败：${e.message}`;
    }
  });

  const deleteModelBtn = $('#delete-model-btn');
  if (deleteModelBtn) deleteModelBtn.addEventListener('click', () => openModelDeleteModal());

  // 图片输入开关联动（视觉扫描结果）
  function syncVisionSwitch(pid, model) {
    const box = $('#cfg-vision');
    const hint = $('#vision-switch-hint');
    const vhint = $('#model-vision-hint');
    if (box) {
      const r = (state.visionResults || {})[`${pid || ''}|||${model || ''}`];
      if (r && r.verdict === 'no-vision') {
        box.checked = false;
        box.disabled = true;
        hint.textContent = '此模型不支持图片输入';
      } else {
        box.disabled = false;
        box.checked = state.config.api.vision !== false;
        hint.textContent = r && r.verdict === 'vision' ? '检测结果：支持图片输入' : '';
      }
    }
    if (vhint) {
      const r = (state.visionResults || {})[`${pid || ''}|||${model || ''}`];
      if (r && (r.verdict === 'vision' || r.verdict === 'no-vision')) {
        vhint.textContent = r.verdict === 'vision' ? '✅ 当前模型支持图片输入' : '🚫 当前模型不支持图片输入';
      } else {
        vhint.textContent = '';
      }
    }
  }
  syncVisionSwitch(c.api.provider, c.api.model);

  // 模型目录“支持图片输入/不支持图片输入”徽标开关
  function applyShowVision() {
    const show = state.config?.ui?.showVision !== false;
    $$('.vbadge').forEach((el) => { el.style.display = show ? '' : 'none'; });
  }
  applyShowVision();

  // ── 人设区块事件 ──
  const personaPick = $('#cfg-persona-pick');
  function currentPersonaId() {
    const roleText = $('#cfg-roletext')?.value ?? '';
    const found = Object.entries(state.personaTemplates || {}).find(([, p]) => p.text === roleText);
    return found ? found[0] : '';
  }
  function syncPersonaButtons() {
    const id = currentPersonaId();
    const tpl = state.personaTemplates[id];
    const isCustom = id.startsWith('custom_');
    const delBtn = $('#del-persona-btn');
    if (delBtn) delBtn.classList.toggle('hidden', !isCustom);
    const hint = $('#persona-pick-hint');
    if (hint) hint.textContent = tpl ? (tpl.builtin ? '内置人设' : '自定义人设') : '';
  }
  if (personaPick) {
    personaPick.addEventListener('click', () => openPersonaPicker());
  }
  const newPersonaBtn = $('#new-persona-btn');
  if (newPersonaBtn) newPersonaBtn.addEventListener('click', () => openPersonaCreateModal());
  const delPersonaBtn = $('#del-persona-btn');
  if (delPersonaBtn) delPersonaBtn.addEventListener('click', async () => {
    const id = currentPersonaId();
    if (!id.startsWith('custom_')) return;
    const tpl = state.personaTemplates[id];
    if (!tpl) return;
    if (!confirm(`确定删除自定义人设「${tpl.name}」？`)) return;
    try {
      await api(`/api/persona-templates/${id}`, { method: 'DELETE', body: '{}' });
      $('#cfg-roletext').value = state.personaTemplates.xiaojingyu?.text || '';
      $('#cfg-customrules').value = '';
      await loadSettings();
    } catch (e) {
      $('#persona-pick-hint').textContent = `删除失败：${e.message}`;
    }
  });
  const savePersonaBtn = $('#save-persona-btn');
  if (savePersonaBtn) savePersonaBtn.addEventListener('click', async () => {
    try {
      await saveConfig();
      $('#persona-save-result').textContent = '人设已保存 ✓';
      setTimeout(() => { $('#persona-save-result').textContent = ''; }, 3000);
    } catch (e) {
      $('#persona-save-result').textContent = `保存失败：${e.message}`;
    }
  });
  syncPersonaButtons();

  // ── 白名单区块事件 ──
  const pickGroupsBtn = $('#pick-groups-btn');
  if (pickGroupsBtn) pickGroupsBtn.addEventListener('click', () => openWhitelistPicker('groups'));
  const pickFriendsBtn = $('#pick-friends-btn');
  if (pickFriendsBtn) pickFriendsBtn.addEventListener('click', () => openWhitelistPicker('friends'));

  // ── 当前版本（桌面端区块；纯本地读取，不联网） ──
  const curVerEl = $('#update-current');
  if (curVerEl) {
    api('/api/version').then((d) => { curVerEl.textContent = `v${d.version || '?'}`; })
      .catch(() => { curVerEl.textContent = ''; });
  }

  // ── OneBot 区块事件 ──
  const openSnowlumaBtn = $('#open-snowluma-btn');
  if (openSnowlumaBtn) openSnowlumaBtn.addEventListener('click', async () => {
    await saveConfig({ quiet: true });
    try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
    catch (e) { $('#snowluma-hint').textContent = `失败：${e.message}`; }
  });
}

// ── 模型选择/添加/删除 模态框 ──
// ── 人设选择/添加 模态框 ──

/** 选择人设：弹窗列出所有人设（含自定义），点击后填入角色设定文本框。 */
