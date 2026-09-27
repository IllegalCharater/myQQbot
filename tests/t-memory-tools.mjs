import { load } from './lib/src.mjs';

const { buildToolDefs } = await load('agent/tools/index.js');

let pass = 0;
let fail = 0;
const ok = (label, condition, extra = '') => {
  if (condition) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}${extra ? ` → ${extra}` : ''}`);
  }
};

const tool = buildToolDefs().find((entry) => entry.name === 'memory_query');
ok('memory_query 存在', !!tool);
ok('schema 要求 userId', tool?.parameters?.required?.includes('userId'));

let queryCount = 0;
const ctx = {
  chatKey: 'group:100',
  memory: {
    query(chatKey) {
      queryCount++;
      ok('只查询当前会话', chatKey === 'group:100', chatKey);
      return {
        memberImpression: [
          { userId: '123456', target: '甲', content: '喜欢猫' },
          { userId: '654321', target: '乙', content: '喜欢狗' }
        ]
      };
    }
  }
};

let result = await tool.execute(ctx, {});
ok('缺少 userId 时拒绝查询', result.isError && queryCount === 0, result.content);

result = await tool.execute(ctx, { userId: 'not-a-qq' });
ok('非数字 userId 时拒绝查询', result.isError && queryCount === 0, result.content);

result = await tool.execute(ctx, { userId: 123456 });
ok('数字 QQ 号可以查询', !result.isError, result.content);
const payload = JSON.parse(result.content);
ok(
  '只返回指定 QQ 号的印象',
  payload.memberImpression.length === 1 && payload.memberImpression[0].userId === '123456',
  result.content
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
