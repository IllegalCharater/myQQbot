// 主流程命令的执行记录（会话页）—— 从「敲了命令」到「记录收尾」的整条接线。
//
// 这个套件**把真的分发表与真的 `SessionRegistry` 接在一起**（而不是两边各用假件），
// 因为这里最容易坏的正是那根线：`CommandRecordPort` 的三个方法与注册表上的三个方法
// 一旦对不上，`tsc` 看不见（`.mjs` 不在 include 里），症状只是"会话页里什么都没有"。
//
// 钉的四件事：
//   ① **只记主流程那四条**（`/转写` `/画` `/漫画` `/能力`）—— 扩展命令一条都不记；
//   ② 阶段顺序与三条结局（`done` / `noreply` / `error`）各自落在记录上；
//   ③ 命令记录**不占 `runs`**（它没有模型调用，不该抬高"今日运行次数"）；
//   ④ 命令记录**不触发 `onFinish`**（那是扩展的 `runEnded`，只看模型运行）。
import { checker, dataDir } from './lib/harness.mjs';
import { load } from './lib/src.mjs';

dataDir('qqagent-cmdrecord-');
const { ok, done } = checker();

const { createCommandDispatcher } = await load('web/onebot/commands.js');
const { SessionRegistry } = await load('chat/sessions.js');

/** 与 `chat/sessions.ts` 里 `localDayKey` 同形（那里没导出，这里自己算一次）。 */
const dayKeyOf = (ts = Date.now()) => {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** 一套会话注册表 + 一个 spy：`onFinish` 被调了几次、调的是谁。 */
function makeSessions() {
  const finished = [];
  const sessions = new SessionRegistry(0, { onFinish: (s) => finished.push(s) });
  return { sessions, finished };
}

/** 命令层要的三个口子 + 记录端口（端口就是注册表那三个方法的原样绑定）。 */
function makeDispatcher(sessions, source = () => ({ override: false, commands: [] })) {
  return createCommandDispatcher(source, {
    list: () => [],
    load: async (id) => ({ ok: true, note: `已加载「${id}」` }),
    unload: async (id) => ({ ok: true, note: `已卸载「${id}」` })
  }, {
    begin: (input) => sessions.beginCommand(input),
    stage: (id, name, detail) => sessions.stageCommand(id, name, detail),
    end: (id, status, receipt) => sessions.finishCommand(id, status, receipt)
  });
}

function makeDeps(log) {
  return {
    transcription: { enqueue: (job) => { log.enqueued.push({ ...job, via: 'transcription' }); return { id: 'abcdef12-3456-7890' }; } },
    imageGen: { enqueue: (job) => { log.enqueued.push({ ...job, via: 'imageGen' }); return { id: 'job-1' }; } },
    jmcomic: { enqueue: (job) => { log.enqueued.push({ ...job, via: 'jmcomic' }); return { position: 1 }; } },
    sender: { sendTextBatch: async (chatKey, message) => { log.sent.push({ chatKey, message }); return { sent: [], failed: [] }; } },
    log: () => {}
  };
}

const input = (text) => ({
  chatKey: 'group:10001', text, media: [], replyToMessageId: null, senderId: '555', mentionedSelf: true
});

/** 最近一条记录的完整形状（记录只有一条时用它最省事）。 */
const latest = (sessions) => sessions.get(sessions.listSummaries()[0]?.id ?? '');
const stageNames = (rec) => (Array.isArray(rec?.stages) ? rec.stages : []).map((x) => x.name);
const stageText = (rec) => (Array.isArray(rec?.stages) ? rec.stages : [])
  .map((x) => (x.detail ? `${x.name}:${x.detail}` : x.name)).join(' → ');

// ── 1. `/转写`：完整的一条 ────────────────────────────────────────────────────
{
  const { sessions, finished } = makeSessions();
  const log = { enqueued: [], sent: [] };
  const dispatcher = makeDispatcher(sessions);
  const before = sessions.todayUsage(dayKeyOf());

  await dispatcher.handleCommandEntry(input('/转写 https://example.com/a.mp4'), makeDeps(log));

  const rec = latest(sessions);
  ok('主流程命令产生一条 `trigger:command` 记录（命令词是主词 `/转写`）',
    rec?.trigger === 'command' && rec?.command === '/转写',
    JSON.stringify({ trigger: rec?.trigger, command: rec?.command }));
  ok('**原文照记**（用户敲的那一句，不是规范化之后的）',
    rec?.commandText === '/转写 https://example.com/a.mp4', String(rec?.commandText));
  ok('阶段按发生顺序记下来：解析链接 → 已入队 → 回执已发送',
    stageText(rec) === '解析链接:https://example.com/a.mp4 → 已入队:任务 abcdef12 → 回执已发送', stageText(rec));
  ok('结局 `done`，回执进了 `sent`（详情页照着它显示"回了什么"）',
    rec?.status === 'done' && String(rec?.sent?.[0]?.text ?? '').includes('已开始处理'),
    JSON.stringify({ status: rec?.status, sent: rec?.sent }));
  ok('列表摘要带出 `kind`/`command`（会话页靠它区分"运行"与"命令"）',
    sessions.listSummaries()[0]?.kind === 'command' && sessions.listSummaries()[0]?.command === '/转写',
    JSON.stringify(sessions.listSummaries()[0]));
  ok('摘要的 `trigger` 是给人看的那句「命令 /转写」',
    sessions.listSummaries()[0]?.trigger === '命令 /转写', String(sessions.listSummaries()[0]?.trigger));

  ok('★ 命令记录**不占 `runs`**（它没有模型调用，不该抬高"今日运行次数"）',
    sessions.todayUsage(dayKeyOf()).runs === before.runs,
    JSON.stringify(sessions.todayUsage(dayKeyOf())));
  ok('★ 命令记录**不触发 `onFinish`**（那是扩展的 `runEnded`，只看模型运行）',
    finished.length === 0, String(finished.length));
  // 落盘也要能读回来（详情页走的正是 `get()`，重启后也一样）。
  const reloaded = new SessionRegistry(0, {});
  ok('记录落盘了，换个实例也读得到（含 stages）',
    Array.isArray(reloaded.get(rec.id)?.stages) && reloaded.get(rec.id)?.command === '/转写',
    JSON.stringify(reloaded.get(rec.id ?? '')?.stages));
}

// ── 2. 另外三条主流程命令各自有一步"解析" ─────────────────────────────────────
{
  const { sessions } = makeSessions();
  const log = { enqueued: [], sent: [] };
  const dispatcher = makeDispatcher(sessions);

  await dispatcher.handleCommandEntry(input('/画 一只戴墨镜的鲸鱼'), makeDeps(log));
  ok('`/画` 的流程：解析描述 → 参考图 → 已入队 → 回执已发送（纯文字）',
    stageText(latest(sessions)) === '解析描述:一只戴墨镜的鲸鱼 → 参考图:纯文字 → 已入队 → 回执已发送',
    stageText(latest(sessions)));

  await dispatcher.handleCommandEntry(input('/漫画 12345'), makeDeps(log));
  ok('`/漫画` 的流程：解析漫画 ID → 已入队 → 回执已发送',
    stageText(latest(sessions)) === '解析漫画 ID:12345 → 已入队 → 回执已发送',
    stageText(latest(sessions)));

  await dispatcher.handleCommandEntry(input('/能力'), makeDeps(log));
  ok('`/能力`（看列表）的流程：列出扩展 → 回执已发送',
    stageText(latest(sessions)) === '列出扩展:0 个 → 回执已发送', stageText(latest(sessions)));

  await dispatcher.handleCommandEntry(input('/能力 加载 trpg'), makeDeps(log));
  ok('`/能力 加载 <id>` 把动作与 id 都记进流程',
    stageText(latest(sessions)) === '加载:trpg → 回执已发送', stageText(latest(sessions)));
}

// ── 3. 三条结局：`noreply` 与 `error` ─────────────────────────────────────────
{
  const { sessions } = makeSessions();
  const log = { enqueued: [], sent: [] };
  const dispatcher = makeDispatcher(sessions);

  // `/转写[图片]`：认得出是命令（`[` 是边界），但解析层给不出 URL → body 返回 null。
  await dispatcher.handleCommandEntry(input('/转写[图片]'), makeDeps(log));
  const silent = latest(sessions);
  ok('不吭声的命令记成 `noreply`（没有回执，但流程照记）',
    silent?.status === 'noreply' && !silent?.sent?.length
    && stageText(silent) === '解析链接:没找到可转写的链接',
    JSON.stringify({ status: silent?.status, sent: silent?.sent, stages: stageText(silent) }));

  // `/画` 不给描述：解析层抛用法提示 → 外壳把它发进群 → 结局 `error`。
  await dispatcher.handleCommandEntry(input('/画'), makeDeps(log));
  const failed = latest(sessions);
  ok('抛错的命令记成 `error`，最后一步是「失败：<发给群友的那句话>」',
    failed?.status === 'error'
    && stageNames(failed).at(-1) === '失败'
    && String(failed?.stages?.at(-1)?.detail ?? '').includes('/画 <画面描述>')
    && String(failed?.sent?.[0]?.text ?? '').includes('/画 <画面描述>'),
    JSON.stringify({ status: failed?.status, stages: stageText(failed), sent: failed?.sent }));
}

// ── 4. 扩展命令**一条都不记** ────────────────────────────────────────────────
{
  const { sessions } = makeSessions();
  const log = { enqueued: [], sent: [] };
  const dispatcher = makeDispatcher(sessions, () => ({
    override: false,
    commands: [{ names: ['/天气'], run: async () => '晴' }]
  }));

  // 整个套件共用同一个临时数据目录，`new SessionRegistry()` 会把前面用例的记录读进来 ——
  // 所以这里比的是**增量**（0 条新记录），不是总数的绝对值。
  const before = sessions.listSummaries().length;
  await dispatcher.handleCommandEntry(input('/天气 北京'), makeDeps(log));
  ok('★ 扩展命令不进会话页（用户要求：只记主流程）',
    sessions.listSummaries().length === before && log.sent.length === 1,
    JSON.stringify({ before, after: sessions.listSummaries().length, sent: log.sent.length }));
}

// ── 5. 没装记录端口时命令照常跑（记录是旁路，不该有能力影响主流程）──────────
{
  const log = { enqueued: [], sent: [] };
  const dispatcher = createCommandDispatcher();   // 没有 extras、没有 record
  await dispatcher.handleCommandEntry(input('/画 一只猫'), makeDeps(log));
  ok('没装记录端口：命令照常入队并回执（只是不留记录）',
    log.enqueued.length === 1 && log.sent.length === 1,
    JSON.stringify({ enqueued: log.enqueued.length, sent: log.sent.length }));
}

process.exit(done() ? 0 : 1);
