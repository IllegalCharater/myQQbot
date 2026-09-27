export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export const fmtTok = (value) => (Number(value) || 0).toLocaleString('zh-CN');
export const fmtYuan = (value) => {
  const number = Number(value) || 0;
  if (number === 0) return '¥0';
  return Math.abs(number) < 1 ? `¥${number.toFixed(4)}` : `¥${number.toFixed(2)}`;
};
export function fmtTime(ts) {
  if (!ts) return '-';
  const date = new Date(ts);
  const pad = (number) => String(number).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function fmtClock(ts) {
  const date = new Date(ts);
  const pad = (number) => String(number).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
export function argsHint(args, max = 60) {
  if (!args || typeof args !== 'object') return '';
  const keys = ['messages', 'text', 'message', 'content', 'note', 'summary', 'reason', 'query', 'stickerId'];
  for (const key of keys) {
    const value = args[key];
    const text = Array.isArray(value)
      ? value.filter((item) => typeof item === 'string' && item.trim()).join(' / ').trim()
      : (typeof value === 'string' ? value.trim() : '');
    if (!text) continue;
    const flat = text.replace(/\s+/g, ' ');
    return `("${flat.length > max ? `${flat.slice(0, max)}…` : flat}")`;
  }
  return '';
}
export function fmtTokens(value) {
  const number = Number(value) || 0;
  return number >= 10000 ? `${(number / 1000).toFixed(1)}k tok` : `${number} tok`;
}
