import { state } from './state.js';

export function chatNameOf(chatKey) {
  const item = (state.chats || []).find((chat) => chat.key === chatKey);
  return item?.name || item?.displayName || '';
}

export function formatChatTitle(chatKey, name = '') {
  const [kind, id] = String(chatKey || '').split(':');
  const label = name || chatNameOf(chatKey);
  if (kind === 'group') return label ? `${label}（群 ${id}）` : `群 ${id}`;
  if (kind === 'private') return label ? `${label}（${id}）` : `私聊 ${id}`;
  return label || String(chatKey || '');
}
