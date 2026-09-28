import type { HotSearchTopic } from './types.js';

interface FormatOptions {
  now?: Date;
  timezone?: string;
  generatedAt?: string;
  includeLinks?: boolean;
  maxChars?: number;
}

function dateTime(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function formatGeneratedAt(raw: string | undefined, timezone: string): string | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? dateTime(parsed, timezone) : null;
}

function topicBlock(topic: HotSearchTopic, index: number, includeLinks: boolean): string {
  const lines = [`${index + 1}. ${topic.title}`];
  if (topic.sources.length) {
    const coverage = topic.sources.length > 1 ? `（${topic.sources.length}个平台）` : '';
    lines.push(`   来源：${topic.sources.join('、')}${coverage}`);
  }
  const facts: string[] = [];
  if (topic.rank !== undefined) facts.push(`排名：#${topic.rank}`);
  if (topic.hot !== undefined && String(topic.hot).trim()) facts.push(`热度：${topic.hot}`);
  if (facts.length) lines.push(`   ${facts.join(' · ')}`);
  if (includeLinks && topic.url) lines.push(`   链接：${topic.url}`);
  return lines.join('\n');
}

export function formatHotSearchPages(topics: HotSearchTopic[], options: FormatOptions = {}): string[] {
  if (!topics.length) return [];
  const timezone = options.timezone || 'Asia/Shanghai';
  const now = options.now ?? new Date();
  const generated = formatGeneratedAt(options.generatedAt, timezone);
  const maxChars = Math.min(4_000, Math.max(500, Math.round(Number(options.maxChars) || 3_500)));
  const headerLines = [
    '📰 每日全网热搜',
    `日期：${dateTime(now, timezone)}（北京时间）`,
    ...(generated ? [`数据更新时间：${generated}`] : [])
  ];
  const footer = `共收录 ${topics.length} 条热点\n数据来源：全平台热搜聚合`;
  const blocks = topics.map((topic, index) => topicBlock(topic, index, options.includeLinks === true));
  const groups: string[][] = [];
  let current: string[] = [];
  for (const block of blocks) {
    const candidate = [...headerLines, '', ...current, ...(current.length ? [''] : []), block, '', footer].join('\n');
    if (current.length && candidate.length > maxChars) {
      groups.push(current);
      current = [block];
    } else {
      current.push(block);
    }
  }
  if (current.length) groups.push(current);

  return groups.map((group, index) => {
    const heading = groups.length > 1 ? `📰 每日全网热搜（${index + 1}/${groups.length}）` : headerLines[0];
    const pageHeader = [heading, ...headerLines.slice(1)];
    return [...pageHeader, '', group.join('\n\n'), '', footer].join('\n');
  });
}
