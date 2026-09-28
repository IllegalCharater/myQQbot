export const SESSION_PAGE = 50;
export const SESSION_KEEP = 400;
export const CHAT_MSG_PAGE = 500;
export const CHAT_MSG_MORE = 200;

export const state = {
  tab: 'sessions', sessions: [], currentSessionId: null, sessionDetail: null,
  chats: [], currentChatKey: null, chatMessages: [], config: null,
  personaTemplates: {}, status: null, paused: false, pauseReason: null,
  autoFollowRunning: true, settingsSection: 'api', memoryView: 'events',
  currentMemoryChatKey: null, groupMembers: [], groupMembersLoaded: false,
  stickers: [], stickerQuery: '', stickerTotal: 0, stickerSync: null,
  stickerOwned: 0, stickerMaxKeep: 0, stickerCacheNote: '',
  stickerSelectedId: null, stickerBusy: false, chatQuery: '',
  chatDigests: null, chatDigestOpen: true, chatDigestSig: '', memQuery: '',
  consolidating: {}, consolidateResult: {}, usageRange: '7'
};

export const TOOL_META = {
  send_message: { name: '发消息', cat: '发言', icon: '💬' },
  send_sticker: { name: '发表情包', cat: '发言', icon: '🎴' },
  download_jmcomic: { name: '下载漫画', cat: '文件', icon: '📥' },
  send_poke: { name: '戳一戳', cat: '发言', icon: '👆' },
  get_recent_messages: { name: '翻聊天记录', cat: '查看', icon: '📜' },
  get_message_detail: { name: '看消息详情', cat: '查看', icon: '🔍' },
  get_message_images: { name: '看图片', cat: '查看', icon: '🖼️' },
  reverse_image_source: { name: '找图源', cat: '查看', icon: '🔎' },
  get_active_members: { name: '看活跃群友', cat: '查看', icon: '👥' },
  read_forward: { name: '展开转发', cat: '查看', icon: '📨' },
  read_group_notice: { name: '看群公告', cat: '查看', icon: '📢' },
  list_stickers: { name: '列表情库', cat: '表情', icon: '📚' },
  get_sticker_image: { name: '看表情图', cat: '表情', icon: '🖼️' },
  collect_sticker: { name: '收藏表情', cat: '表情', icon: '⭐' },
  sticker_note: { name: '备注表情', cat: '表情', icon: '📝' },
  memory_append: { name: '记一条', cat: '记忆', icon: '🧠' },
  memory_query: { name: '查记忆', cat: '记忆', icon: '🧠' },
  memory_remove: { name: '删记忆', cat: '记忆', icon: '🧹' },
  web_search: { name: '联网搜索', cat: '联网', icon: '🌐' },
  web_fetch: { name: '抓网页', cat: '联网', icon: '🔗' },
  report_feedback: { name: '汇报反馈', cat: '其他', icon: '📣' },
  finish: { name: '结束本次', cat: '其他', icon: '🏁' }
};

export const TOOL_CAT_ORDER = ['发言', '查看', '表情', '记忆', '联网', '其他'];
export const USAGE_RANGES = [['today', '今日'], ['7', '近 7 天'], ['30', '近 30 天'], ['all', '全部']];
