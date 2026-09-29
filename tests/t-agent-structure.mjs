import fs from 'node:fs';
import path from 'node:path';
import { ROOT, load } from './lib/src.mjs';

let pass = 0;
let fail = 0;
const ok = (label, condition, extra = '') => {
  if (condition) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` → ${extra}` : ''}`); }
};

const agentRoot = path.join(ROOT, 'src', 'agent');
const groups = ['runtime', 'context', 'prompting', 'tools', 'maintenance', 'shared'];
for (const group of groups) ok(`Agent 分层目录存在：${group}`, fs.statSync(path.join(agentRoot, group)).isDirectory());
const flatSources = fs.readdirSync(agentRoot).filter((name) => /\.(?:ts|js)$/.test(name));
ok('Agent 根目录没有平铺实现文件', flatSources.length === 0, flatSources.join(', '));

const catalog = await load('core/prompt-catalog.js');
ok('Catalog 暴露五类模型指令', ['personas', 'system', 'user', 'tools', 'maintenance'].every((key) => key in catalog.PROMPT_CATALOG));

const { buildToolDefs } = await load('agent/tools/index.js');
const tools = buildToolDefs();
const expectedNames = [
  'send_message', 'send_sticker', 'list_stickers', 'get_sticker_image', 'sticker_note', 'collect_sticker', 'send_poke',
  'get_recent_messages', 'read_forward', 'read_group_notice', 'get_active_members', 'get_message_detail', 'get_message_images', 'reverse_image_source',
  'get_hot_search', 'transcribe_video',
  'memory_append', 'memory_query', 'memory_remove', 'report_feedback', 'web_search', 'web_fetch', 'download_jmcomic', 'finish'
];
ok('工具名称和顺序保持不变', JSON.stringify(tools.map((tool) => tool.name)) === JSON.stringify(expectedNames));
ok('所有工具 description 来自 Catalog 且非空', tools.every((tool) => typeof tool.description === 'string' && tool.description.length > 0));

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
