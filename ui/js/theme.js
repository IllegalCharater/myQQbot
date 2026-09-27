import { api } from './api.js';
import { $ } from './dom.js';

/* ══════════════════════════════════════════════════════════════
   主题（明/暗/系统/？）
   ══════════════════════════════════════════════════════════════
   四种取值：'dark' | 'light' | 'system'（跟随系统偏好）| '?'（整活主题）。
   持久化两层：
     1. localStorage —— 立即生效，避免每次启动都等接口
     2. 后端 config.ui.theme —— 跨设备/重装后保留（尽力而为，失败不阻塞）
   首屏防闪由 index.html 的内联脚本负责（读 localStorage 直接设 data-theme）。
*/
export const THEME_ICON = { dark: '🌙', light: '☀️', system: '🖥️', '?': '❓' };
export const THEME_LABEL = { dark: '暗色', light: '亮色', system: '跟随系统', '?': '？' };
export const THEME_VALUES = ['dark', 'light', 'system', '?'];

/** 读取当前主题设置（localStorage 优先，其次系统偏好）。 */
export function getThemePref() {
  try {
    const v = localStorage.getItem('qqa-theme');
    if (THEME_VALUES.includes(v)) return v;
  } catch { /* 隐私模式下 localStorage 可能不可用 */ }
  return 'dark';
}

/** 把设置解析成实际要应用的主题名。 */
export function resolveTheme(pref) {
  if (THEME_VALUES.includes(pref) && pref !== 'system') return pref;
  // system：跟随系统
  try {
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  } catch { return 'dark'; }
}

/** 应用主题到 <html>，并同步按钮图标。 */
export function applyTheme(pref) {
  const actual = resolveTheme(pref);
  document.documentElement.setAttribute('data-theme', actual);
  syncChaosLayers(actual === '?');
  const btn = $('#theme-btn');
  if (btn) {
    btn.textContent = THEME_ICON[pref] || THEME_ICON.dark;
    btn.title = `主题：${THEME_LABEL[pref] || '暗色'}（点击切换）`;
  }
  try { localStorage.setItem('qqa-theme', pref); } catch { /* 忽略 */ }
}

/* ── 「？」主题的 JS 层：VHS 覆盖层 + 点击爆粒子 ──
   CSS 管不了的就这两件需要一个真实 DOM 层（body 的 ::before/::after 已被占用）。
   主题切走即移除，零残留。 */
export function syncChaosLayers(on) {
  let vhs = document.getElementById('chaos-vhs');
  if (on && !vhs) {
    vhs = document.createElement('div');
    vhs.id = 'chaos-vhs';
    vhs.innerHTML = '<div class="vhs-track"></div>';   // 白闪太刺眼已移除，只留扫描线+追踪误差带
    document.body.appendChild(vhs);
  } else if (!on && vhs) {
    vhs.remove();
  }
}

// 点击爆「？」粒子：只在「？」主题下生效（判断放点击时，不绑状态）
function spawnChaosParticles(e) {
  if (document.documentElement.getAttribute('data-theme') !== '?') return;
  // 一次爆 3~5 个，方向随机（抽象 = 不统一）
  const n = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const el = document.createElement('span');
    el.className = 'chaos-pop';
    el.textContent = '？';
    el.style.left = `${e.clientX}px`;
    el.style.top = `${e.clientY}px`;
    el.style.setProperty('--dx', `${(Math.random() - 0.5) * 160}px`);
    el.style.setProperty('--dy', `${-40 - Math.random() * 90}px`);
    el.style.setProperty('--rot', `${(Math.random() - 0.5) * 540}deg`);
    el.style.fontSize = `${14 + Math.random() * 20}px`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 850);
  }
}

export function initTheme() {
  document.addEventListener('click', spawnChaosParticles, { passive: true });
  $('#theme-btn')?.addEventListener('click', cycleTheme);
}

/** 点击按钮：暗 → 亮 → 跟随系统 → ？ → 暗。 */
export function cycleTheme() {
  const order = THEME_VALUES;
  const next = order[(order.indexOf(getThemePref()) + 1) % order.length];
  applyTheme(next);
  // 尽力同步到后端，失败不影响本地使用
  api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { theme: next } }) })
    .catch(() => { /* 后端不可达时静默：localStorage 已经生效 */ });
}
