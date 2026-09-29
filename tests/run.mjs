// 一条命令跑完 tests/ 下的套件。
//
//   node tests/run.mjs               跑断言套件（会红的那些），全绿才退 0
//   node tests/run.mjs --all         连打印式诊断脚本一起跑（永远退 0，只看输出）
//   node tests/run.mjs --no-build    跳过开跑前的 tsc（默认会先 build）
//   node tests/run.mjs --list        只列清单，不跑
//   node tests/run.mjs t-sticker     只跑名字里含 t-sticker 的（可以给多个关键字）
//
// 套件验的是 tsc 产物 dist/，所以默认先 build 一次——否则你验的是上一次的产物，
// 改了源码没生效却"全绿"是最坏的一种骗自己。
//
// 跑法上不引入任何测试框架：套件就是独立的 .mjs 脚本，每个起一个子进程
// （各套件都会改全局配置、起假服务器、写自己的临时数据目录，同进程会互相污染）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, SRC_DIR } from './lib/src.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

// ── 断言套件：有 ok() 计数，失败会退非零，是真正的闸门 ──
const ASSERT = [
  't-paths.mjs',           // 路径锚点（含"下沉一层仍算得对"）
  't-agent-structure.mjs', // Agent 子目录、Catalog 与工具顺序
  't-web-router.mjs',      // Web 路由匹配、请求体与统一响应写出
  't-window.mjs',          // 上下文窗口 / 滑动
  't-window-http.mjs',     // 窗口相关 HTTP 接口
  't-reply.mjs',           // 提示词拼装
  't-notice.mjs',          // 通知 / 卡片消息解析
  't-digest.mjs',          // 历史摘要注入（含与旧版提示词逐字对比）
  't-memory-tools.mjs',    // 长期记忆工具的参数边界与定向查询
  't-sticker.mjs',         // 表情包（含缓存）
  't-smoke.mjs',           // 端到端冒烟（真起 app 再 fetch）
  't-panel.mjs',           // 面板接口
  't-panel-wiring.mjs',    // 面板静态接线（ui/* 文本层）
  't-sse-project.mjs',     // SSE 帧投影（event-projector 纯函数，逐字节）
  't-events.mjs',          // 事件名一致性（发射点必须用 EVENTS.*，词表无空转名字）
  't-ports.mjs',           // 跨模块端口（implements 挂载、成员与外部调用对账、名录只作文档）
  't-tasks.mjs',           // 长期任务描述符表（6 行如实标注；反查局部计时器不在表内）
  't-timers.mjs',          // 长期任务的计时器句柄（start 起了什么、stop 有没有收干净）
  't-transcription.mjs',   // 视频 URL 转写（SSRF、单并发状态机、凭证脱敏）
  't-hot-search.mjs',      // 每日热搜（接口契约、重试、去重分页、幂等与互斥）
  't-image-source.mjs',    // 图片来源识别（Provider、队列、缓存、脱敏与 UI 接线）
  't-media-tools.mjs',     // 模型自主调用的两个能力工具（取榜单 / 转写、配额闸门与按配置过滤）
  't-jmcomic.mjs',         // 漫画队列去重（按请求者+漫画ID）与完成后记录留存
  't-jmcomic-upload.mjs',  // 漫画上传超时/重启恢复只核验，不盲目重传
  't-lifecycle.mjs',       // 注册层执行侧（关停路径、装配清单、清单与描述表对账）
  't-ui-modules.mjs',      // 原生 ES Module 入口、依赖图与资源完整性
  't-admin.mjs',           // 管理接口
  't-ui-render.mjs',       // UI 领域模块在假 DOM 下真跑一遍看 HTML
  't-vision-log.mjs'       // 读图 → 会话记录回填（假模型端点跑整轮）
];

// ── 诊断脚本：只打印行为、没有断言、永远退 0，默认不跑（--all 才带上） ──
const DIAG = [
  't-cfg.mjs', 't-compact.mjs', 't-diag.mjs', 't-orch.mjs', 't-orch2.mjs',
  't-fire.mjs', 't-final.mjs', 't-final2.mjs', 't-reentry.mjs', 't-stall.mjs'
];

const args = process.argv.slice(2);
const all = args.includes('--all');
const listOnly = args.includes('--list');
const noBuild = args.includes('--no-build');
const filters = args.filter((a) => !a.startsWith('--'));

// 清单必须覆盖磁盘上每一个 t-*.mjs：新加的套件要显式归到 ASSERT 或 DIAG，
// 不允许"悄悄躺着不跑"——那个习惯一旦养成，红的套件会一直红着没人管。
const onDisk = fs.readdirSync(HERE).filter((f) => /^t-.*\.mjs$/.test(f));
const unclassified = onDisk.filter((f) => !ASSERT.includes(f) && !DIAG.includes(f));
const missing = [...ASSERT, ...DIAG].filter((f) => !onDisk.includes(f));
if (unclassified.length) console.error(`❌ 这些套件没归类（ASSERT / DIAG 二选一）：${unclassified.join(', ')}`);
if (missing.length) console.error(`❌ 清单里有、磁盘上找不到：${missing.join(', ')}`);
if (unclassified.length || missing.length) process.exit(1);

const suites = [...ASSERT, ...(all ? DIAG : [])]
  .filter((s) => !filters.length || filters.some((f) => s.includes(f)));

console.log(`被测代码：${SRC_DIR}`);
console.log(`断言套件 ${ASSERT.length} 个` +
  (all ? `，加上 ${DIAG.length} 个诊断脚本` : `（另有 ${DIAG.length} 个诊断脚本，--all 才跑）`));

// 验的是 dist，就先 build——不然跑的是上一次的产物，"改了源码却全绿"最容易骗到人。
if (!noBuild && suites.length) {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) {
    console.error('❌ 没有 node_modules/typescript，先 `npm install`。');
    process.exit(1);
  }
  const r = spawnSync(process.execPath, [tsc, '-p', path.join(ROOT, 'tsconfig.json')], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('❌ build 失败（tsc），先修编译再跑套件：\n');
    console.error(`${r.stdout || ''}${r.stderr || ''}`.replace(/\s+$/, ''));
    process.exit(1);
  }
  console.log('✓ 已 build（tsc → dist/）');
}
console.log('─'.repeat(60));

if (listOnly || !suites.length) {
  for (const s of suites) console.log(`${ASSERT.includes(s) ? '断言' : '诊断'}  ${s}`);
  process.exit(0);
}

const failed = [];
const t0 = Date.now();
for (const s of suites) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, s)], {
    cwd: ROOT, encoding: 'utf8', timeout: 180000, env: process.env
  });
  const ms = Date.now() - started;
  const bad = r.status !== 0;
  if (bad) failed.push(s);
  console.log(`${bad ? '❌' : '✅'} ${s.padEnd(22)} ${String(ms).padStart(6)}ms`);

  if (bad || all) {
    const out = `${r.stdout || ''}${r.stderr || ''}`.replace(/\s+$/, '');
    const lines = out ? out.split('\n') : ['（没有任何输出）'];
    const shown = lines.length > 80
      ? [...lines.slice(0, 10), `……（中间省略 ${lines.length - 70} 行）……`, ...lines.slice(-60)]
      : lines;
    console.log(shown.map((l) => `     ${l}`).join('\n'));
    if (r.error) console.log(`     运行失败：${r.error.message}`);
    console.log('');
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log('─'.repeat(60));
if (failed.length) {
  console.log(`❌ ${suites.length - failed.length} 通过 / ${failed.length} 失败（${secs}s）`);
  console.log(`   失败：${failed.join(', ')}`);
  process.exit(1);
}
console.log(`✅ 全部通过：${suites.length} 个套件（${secs}s）`);
