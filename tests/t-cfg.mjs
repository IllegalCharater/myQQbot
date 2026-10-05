import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from './lib/src.mjs';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-'));
// 模拟"老配置文件"：只有旧键，没有 reply/compact/maxContextMessages
// 收藏夹里塞满各种形态的脏值 —— 后端必须在配置层就把它们收口成
// 「合法枚举值 + 宿主名 + 非空用途」，因为脏值不会报错，只会让发给搜索引擎的
// site: 子句静默作废、或让模型拿到一个没法用的枚举值。
fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
  api: { model: 'x' }, wakeDelayMs: 1500,
  store: { maxMessagesPerChat: 0, contextTier: 4, allCount: 77 },
  send: { maxPerMinute: 80 }, reply: { maxPerMinute: 3 },
  webSearch: {
    bookmarks: [
      // 旧形状（纯宿主名）：应被迁移 —— slug 化枚举值、用途留空
      'zh.wikipedia.org',
      'https://www.example.com/a/b?c=1#d',
      'News.YCombinator.com',
      'ZH.WIKIPEDIA.ORG',        // 与第一条同站，迁移后 slug 相同 → 应补序号而不是并存
      // 新形状里必须被丢掉的四种：枚举值非法 / 域名认不出 / 用途为空 / 重复枚举值
      { key: '坏值 带空格', url: 'bad.example.com', purpose: '枚举值非法' },
      { key: 'ok-key', url: 'localhost', purpose: '域名认不出' },
      { key: 'no-purpose', url: 'np.example.com', purpose: '' },
      { key: 'dup', url: 'd1.example.com', purpose: '第一条 dup' },
      { key: 'dup', url: 'd2.example.com', purpose: '重复枚举值' },
      // 一条完全合法的
      { key: 'wiki-zh', url: 'https://zh.wikipedia.org/wiki/Main', purpose: '查百科条目与定义' }
    ],
    maxCallsPerChatPerHour: 999, maxCallsPerDay: 0
  }
}), 'utf8');
process.env.QQ_AGENT_DATA_DIR = DIR;
const { loadConfig, getConfig } = await load('core/config.js');
const c = loadConfig();
console.log('wakeDelayMs 保留用户值:', c.wakeDelayMs === 1500);
console.log('reply 回填:', JSON.stringify(c.reply));
console.log('compact 回填:', JSON.stringify(c.compact));
console.log('store.maxContextMessages 回填:', c.store.maxContextMessages);
console.log('store 旧档位已迁移为唯一滑条字段:', c.store.contextSliderPos === 95,
  !('contextTier' in c.store), !('randomPercent' in c.store));
console.log('旧四套历史深度已迁移为独立字段:', c.store.historyCount === 77,
  !('atCount' in c.store), !('keywordCount' in c.store), !('randomCount' in c.store), !('allCount' in c.store));
console.log('旧回复态频率并入统一上限:', c.send.maxPerMinute === 3, !('maxPerMinute' in c.reply));
// 网页收藏夹归一化：旧形状迁移 + 新形状三项校验 + 去重 + 限量。
const bms = c.webSearch.bookmarks;
console.log('收藏夹已归一为三元组:', bms.every((b) => typeof b.key === 'string' && typeof b.url === 'string' && typeof b.purpose === 'string'), JSON.stringify(bms));
console.log('旧形状已迁移（slug 枚举值 + 用途留空）:',
  bms.some((b) => b.key === 'zh-wikipedia-org' && b.url === 'zh.wikipedia.org' && b.purpose === ''));
console.log('整条 URL 的路径被剥掉:', bms.some((b) => b.url === 'www.example.com'));
// 注意这里的 3：两条旧形状（zh.wikipedia.org / ZH.WIKIPEDIA.ORG，同站但都要留）加新形状的 wiki-zh。
// 迁移去重只针对**枚举值**，不针对域名 —— 同一个站配两条不同用途是合法的，
// 拿域名去重会把"新闻站也查维基"这类正当配置删掉。
console.log('同站多条都保留、重名枚举值补序号:', bms.filter((b) => b.url === 'zh.wikipedia.org').length === 3
  && bms.some((b) => b.key === 'zh-wikipedia-org-2'), JSON.stringify(bms.map((b) => b.key)));
console.log('大写宿主名已归一:', bms.some((b) => b.url === 'news.ycombinator.com'));
console.log('新形状合法条目原样保留:',
  bms.some((b) => b.key === 'wiki-zh' && b.url === 'zh.wikipedia.org' && b.purpose === '查百科条目与定义'));
console.log('枚举值非法 / 域名认不出 / 用途为空 三种都被丢掉:',
  !bms.some((b) => ['坏值 带空格', 'ok-key', 'no-purpose'].includes(b.key)));
console.log('重复枚举值只留先到的那条:',
  bms.filter((b) => b.key === 'dup').length === 1 && bms.find((b) => b.key === 'dup').url === 'd1.example.com');
console.log('阀门上限钳制（999→200，0→1）:', c.webSearch.maxCallsPerChatPerHour === 200, c.webSearch.maxCallsPerDay === 1);
fs.rmSync(DIR, { recursive: true, force: true });
