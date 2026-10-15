// 斜杠命令的分发层（`src/web/onebot/slash-commands.ts`）。
//
// 这里验的是**接入层的分发**：判据、顺序、回执与失败话术，以及"判据只有一份"这条结构性质。
// 各命令自己的语法不在这里重复验：
//   · `/转写` 的 URL 校验与媒体定位在 t-transcription.mjs
//   · `/画` 的解析与参考图定位在 t-image-gen.mjs
//
// 为什么值得单开一个套件：这一层是**命令判定与 `wakeEligible` 的唯一事实源**。
// 判据写两遍时的表现是"命令没被认出来、消息进了 LLM"或"同一条消息被处理两次"，
// 两种都不报任何错 —— 只有"判据只有一份"这条能拦住它。
import fs from 'node:fs';
import path from 'node:path';
import { checker, dataDir } from './lib/harness.mjs';
import { ROOT, load, stripComments } from './lib/src.mjs';

// dataDir 必须先于 load('core/config.js')：config 在加载时就把 DATA_DIR 定死。
dataDir('qqagent-slash-');
const { ok, done } = checker();

const { createSlashCommands } = await load('web/onebot/slash-commands.js');
// 命令分发器现在是**工厂**：命令表里还有扩展贡献的命令，而"谁在里面"会随装载/接管状态变，
// 所以要现算。本段先用一张**只有主流程命令**的表 —— 扩展那部分在第 4 段单独验。
const { isSlashCommand, handleSlashCommand } = createSlashCommands();

/** 读**源码**（不是 dist 产物）。 */
const readSource = (rel) => fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8');

// ── 1. 判据 ──────────────────────────────────────────────────────
ok('认命令：`/词` 后面跟空白或直接结束',
  isSlashCommand('/转写 https://example.com/a.mp4') && isSlashCommand('/画 一只猫')
  && isSlashCommand('/画') && isSlashCommand('/转写') && isSlashCommand('/漫画 12345') && isSlashCommand('/漫画'));
ok('认命令：`/转写` + 视频段时渲染出的 `/转写[视频]` 也算（不带这个分支就永远认不出）',
  isSlashCommand('/转写[视频]'));
ok('不认：关键词连在一起的（`/画xx`、`/转写啦`、`/漫画123` 都不是命令）',
  !isSlashCommand('/画xx') && !isSlashCommand('/转写啦') && !isSlashCommand('/漫画123'));
ok('不认：没有斜杠、或斜杠不在开头（普通消息绝不能被当成命令）',
  !isSlashCommand('画一只猫') && !isSlashCommand('帮我 /画 一只猫') && !isSlashCommand(''));
ok('不认：展开后的合并转发正文以命令开头也不行（判据只吃"用户真正敲的那句"，见 commandText）',
  !isSlashCommand('[合并转发 共2条]\n小明: /画 一只猫'));
ok('空值/非字符串不抛（`commandText` 在只有媒体消息时可能是 undefined）',
  isSlashCommand(null) === false && isSlashCommand(undefined) === false && isSlashCommand(123) === false);

// ── 2. 分发与回执 ────────────────────────────────────────────────
function deps({ failEnqueue = null, failSend = false } = {}) {
  const log = { enqueued: [], sent: [], errors: [] };
  const sender = {
    sendTextBatch: async (chatKey, message, options) => {
      if (failSend) throw new Error('send failed');
      log.sent.push({ chatKey, message, options });
      return { sent: [], failed: [] };
    }
  };
  const throwIfAsked = (name) => { if (failEnqueue === name) throw new Error(`${name} 拒绝：未配置`); };
  return {
    log,
    deps: {
      transcription: { enqueue: (job) => { throwIfAsked('transcription'); log.enqueued.push({ ...job, via: 'transcription' }); return { id: 'abcdef12-3456-7890-abcd-ef1234567890' }; } },
      imageGen: { enqueue: (job) => { throwIfAsked('imageGen'); log.enqueued.push({ ...job, via: 'imageGen' }); return { id: 'job-1' }; } },
      jmcomic: { enqueue: (job) => { throwIfAsked('jmcomic'); log.enqueued.push({ ...job, via: 'jmcomic' }); return { position: 1 }; } },
      sender,
      log: () => {}
    }
  };
}

const input = (text, extra = {}) => ({
  chatKey: 'group:10001', text, media: [], replyToMessageId: '9001', senderId: '555', ...extra
});

{
  const { deps: d, log } = deps();
  const handled = await handleSlashCommand(input('群友们晚上好'), d);
  ok('不是命令 → 返回 false，且一次都没碰队列与发送',
    handled === false && log.enqueued.length === 0 && log.sent.length === 0);
}

{
  const { deps: d, log } = deps();
  const handled = await handleSlashCommand(input('/画 一只戴墨镜的鲸鱼'), d);
  ok('`/画`：入队并回执（确定性路径，不经过模型）',
    handled === true && log.enqueued.length === 1 && log.enqueued[0].via === 'imageGen'
    && log.enqueued[0].prompt === '一只戴墨镜的鲸鱼' && log.enqueued[0].chatKey === 'group:10001',
    JSON.stringify(log.enqueued));
  // 与 `generate_image` 工具**同一个 mode**（用户要求"两边行为统一"）：图发出去之后总得有人知道。
  // 漏了它，这条命令的图就永远是"发出来了但模型不知道"——正是 2026-10-10 真机排查了半天的症状。
  ok('`/画` 走 assisted（图发完回流入窗、唤醒模型），与工具路径一致',
    log.enqueued[0].mode === 'assisted', String(log.enqueued[0].mode));
  ok('回执取自命令层、且**不带任务号**（群友等的是一张图，一串 uuid 只会让人以为要记住什么）',
    log.sent.length === 1 && String(log.sent[0].message) === '在画了，稍等'
    && !String(log.sent[0].message).includes('job-1'), JSON.stringify(log.sent));
  ok('回执挂在原消息上（引用目标透传）', String(log.sent[0].options?.replyToMessageId) === '9001');
}

{
  const { deps: d, log } = deps();
  await handleSlashCommand(input('/画 改成赛博朋克', {
    media: [{ kind: 'image', url: 'https://cdn.example.com/a.jpg' }]
  }), d);
  ok('`/画`：消息里（或它引用那条里）的图片被当作参考图递进队列（图生图）',
    log.enqueued[0]?.imageUrl === 'https://cdn.example.com/a.jpg', JSON.stringify(log.enqueued[0]));
}

{
  const { deps: d, log } = deps();
  await handleSlashCommand(input('/画'), d);
  ok('`/画` 没写描述：只回用法提示，**不入队**（别为一个空命令付一次出图的钱）',
    log.enqueued.length === 0 && log.sent.length === 1
    && String(log.sent[0].message) === '用法：/画 <画面描述>', JSON.stringify(log.sent));
}

{
  const { deps: d, log } = deps({ failEnqueue: 'imageGen' });
  await handleSlashCommand(input('/画 一只猫'), d);
  ok('入队失败时把**真实原因**原样发回群里（它是唯一能照着改的人），不吞成一句"命令执行失败"',
    log.sent.length === 1 && String(log.sent[0].message).includes('未配置'), JSON.stringify(log.sent));
}

{
  const { deps: d, log } = deps();
  await handleSlashCommand(input('/转写 https://cdn.example.com/a.mp4'), d);
  ok('`/转写`：入队并回执（回执里的任务号是给敲命令的人看的进度凭据，与 `/画` 刻意不同）',
    log.enqueued.length === 1 && log.enqueued[0].via === 'transcription'
    && log.enqueued[0].url === 'https://cdn.example.com/a.mp4'
    && String(log.sent[0].message).includes('已开始处理'), JSON.stringify(log.sent));
}

{
  const { deps: d, log } = deps();
  await handleSlashCommand(input('/转写 http://127.0.0.1/x.mp4'), d);
  ok('`/转写` 的内网地址被解析层拒绝时，那句可执行的提示原样进群（不是"命令执行失败"）',
    log.enqueued.length === 0 && log.sent.length === 1
    && String(log.sent[0].message).includes('禁止内网'), JSON.stringify(log.sent));
}

{
  const { deps: d, log } = deps();
  const handled = await handleSlashCommand(input('/漫画 12345'), d);
  ok('`/漫画 <ID>`：入队并回执',
    handled === true && log.enqueued.length === 1 && log.enqueued[0].via === 'jmcomic'
    && log.enqueued[0].comicId === '12345' && String(log.sent[0].message).includes('在下了'),
    JSON.stringify(log.enqueued));
  // 漫画的去重键是**请求者 + 漫画 ID**（`commandKey(requesterId, comicId)`）：不带请求者的话
  // 全群共用一个额度，甲刚下过、乙再下就被判成"重复提交"。这条断言钉的就是那条链路。
  ok('`/漫画` 把请求者 QQ 与会话身份一起递下去（去重键的一半）',
    log.enqueued[0].requesterId === '555' && log.enqueued[0].kind === 'group'
    && log.enqueued[0].chatId === '10001' && log.enqueued[0].chatKey === 'group:10001',
    JSON.stringify(log.enqueued[0]));
  ok('回执不带队列位置/任务号（那些数字对敲命令的人没有用处）',
    !/位置|任务|队列/.test(String(log.sent[0].message)), String(log.sent[0].message));
}

{
  const { deps: d, log } = deps();
  await handleSlashCommand(input('/漫画'), d);
  ok('`/漫画` 没写 ID：只回用法提示，**不入队**', log.enqueued.length === 0 && log.sent.length === 1
    && String(log.sent[0].message) === '用法：/漫画 <漫画ID>', JSON.stringify(log.sent));
}

{
  // 去重/格式这类拒绝来自领域模块（`enqueueJmcomicDownload` 抛中文文案），原样进群。
  const { deps: d, log } = deps({ failEnqueue: 'jmcomic' });
  await handleSlashCommand(input('/漫画 12345'), d);
  ok('`/漫画` 被领域层拒绝（重复提交等）时，那句中文文案原样进群',
    log.sent.length === 1 && String(log.sent[0].message).includes('未配置'), JSON.stringify(log.sent));
}

{
  // 回执发不出去是接入链路的收尾动作，不该把 OneBot 的入站回调打成未处理异常。
  const { deps: d } = deps({ failSend: true });
  let threw = false;
  try { await handleSlashCommand(input('/画 一只猫'), d); } catch { threw = true; }
  ok('回执发送失败**不抛**（消息本身已经落档了，抛出去只会污染入站回调）', threw === false);
}

ok('命令表按顺序匹配、先命中的先处理（`isSlashCommand` 与 `handleSlashCommand` 用的是同一张表）',
  isSlashCommand('/画 一只猫') === true
  && isSlashCommand('/转写 https://example.com/a.mp4') === true);

// ── 4. 扩展命令：走同一只外壳，且遮蔽不了内置；接管时主流程命令让位但 `/能力` 留着 ──
//
// 这一段的每一件事都**不会报错**地坏掉：外壳漏了 → 回执发不出去；顺序反了 → 内置被遮蔽；
// 接管时把 `/能力` 一起换掉 → 装得上、卸不掉（死锁）。所以逐条钉。
console.log('\n── 扩展命令与接管模式 ──');
{
  const extrasPort = {
    rows: [{ id: 'fake', title: '假扩展', displayDesc: '', mode: 'attach', enabled: true, loaded: false }],
    loads: [], unloads: [],
    list() { return this.rows; },
    async load(id) { this.loads.push(id); return { ok: true, note: `已加载「${id}」` }; },
    async unload(id) { this.unloads.push(id); return { ok: true, note: `已卸载「${id}」` }; }
  };

  const extraCommands = {
    '/天气': {
      name: '/天气',
      match: (text) => /^\/天气(?:\s|$)/u.test(text),
      run: async (input) => `天气：${input.text.slice(3).trim() || '（没说地方）'}`
    }
  };

  const { deps: d, log } = deps();
  const attach = createSlashCommands(() => ({ override: false, commands: [extraCommands['/天气']] }), extrasPort);
  ok('附加模式：扩展命令被认出来，且走的是同一个 runCommand 外壳（回执由命令层发出）',
    attach.isSlashCommand('/天气 北京') === true
    && await attach.handleSlashCommand(input('/天气 北京'), d) === true
    && String(log.sent.at(-1)?.message) === '天气：北京',
    JSON.stringify(log.sent));

  {
    const { deps: d2 } = deps({ failSend: true });
    let threw = false;
    try { await attach.handleSlashCommand(input('/天气 北京'), d2); } catch { threw = true; }
    ok('扩展命令的回执发送失败**也不抛**（与内置命令同一只外壳）', threw === false);
  }
  {
    const { deps: dThrow, log: logThrow } = deps();
    const throwing = createSlashCommands(() => ({
      override: false,
      commands: [{
        name: '/爆炸', match: (text) => /^\/爆炸(?:\s|$)/u.test(text),
        run: async () => { throw new Error('用法：/爆炸 <参数>'); }
      }]
    }), extrasPort);
    await throwing.handleSlashCommand(input('/爆炸'), dThrow);
    ok('扩展命令抛出的中文**原样**进群（不吞成"命令执行失败"）',
      String(logThrow.sent.at(-1)?.message) === '用法：/爆炸 <参数>', JSON.stringify(logThrow.sent));
  }

  // 内置命令在前 ⇒ 扩展声明同样的文案也遮蔽不了它（那条扩展命令是死代码，而不是覆盖）。
  const shadow = createSlashCommands(() => ({
    override: false,
    commands: [{ ...extraCommands['/天气'], name: '/画', match: (text) => /^\/画(?:\s|$)/u.test(text) }]
  }), extrasPort);
  {
    const { deps: d3, log: log3 } = deps();
    await shadow.handleSlashCommand(input('/画 一只猫'), d3);
    ok('扩展遮蔽不了内置：`/画` 仍然走内置那条（入队而不是回一句扩展文案）',
      log3.enqueued.length === 1 && log3.enqueued[0].via === 'imageGen', JSON.stringify(log3.enqueued));
  }

  // 接管模式：主流程三条命令让位，**但 `/能力` 必须留着** —— 它是卸载接管者的唯一入口。
  const override = createSlashCommands(() => ({ override: true, commands: [] }), extrasPort);
  ok('接管模式：主流程的三条功能命令让位',
    override.isSlashCommand('/转写 https://e.com/a.mp4') === false
    && override.isSlashCommand('/画 一只猫') === false
    && override.isSlashCommand('/漫画 12345') === false);
  ok('接管模式：`/能力` 仍然认（否则装得上、卸不掉）', override.isSlashCommand('/能力') === true);
  {
    const { deps: d4, log: log4 } = deps();
    await override.handleSlashCommand(input('/能力 卸载 anything'), d4);
    ok('接管模式下 `/能力 卸载` 真的调到了扩展运行时',
      extrasPort.unloads.includes('anything'), JSON.stringify(extrasPort.unloads));
    ok('`/能力 加载/卸载` 的回执把运行时那句话原样带回群里',
      String(log4.sent.at(-1)?.message).includes('已卸载'), JSON.stringify(log4.sent));
  }
  {
    const { deps: d5, log: log5 } = deps();
    await override.handleSlashCommand(input('/能力'), d5);
    ok('`/能力` 无子命令时列出注册表与装载状态',
      String(log5.sent.at(-1)?.message).includes('假扩展'), JSON.stringify(log5.sent));
  }
  {
    const { deps: d6, log: log6 } = deps();
    await override.handleSlashCommand(input('/能力 加载'), d6);
    ok('`/能力 加载` 没给 id 时只回用法（不去调运行时）',
      String(log6.sent.at(-1)?.message).includes('用法'), JSON.stringify(log6.sent));
  }
  {
    const { deps: d7, log: log7 } = deps();   // 注意：这份 deps 里没有 extras
    const bare = createSlashCommands();
    await bare.handleSlashCommand(input('/能力'), d7);
    ok('没有扩展运行时端口时 `/能力` 如实说不可用，不假装成功',
      String(log7.sent.at(-1)?.message).includes('不可用'), JSON.stringify(log7.sent));
  }

  // ── 别名（可选）：命中别名时，分发层把开头那个词换成主命令词再交给处理函数 ──
  {
    const before = extrasPort.unloads.length;
    const { deps: dAlias, log: logAlias } = deps();
    const plain = createSlashCommands(() => ({ override: false, commands: [] }), extrasPort);
    ok('内置命令的别名被认出来（`/能力` 的另一个叫法）',
      plain.isSlashCommand('/扩展') === true && plain.isSlashCommand('/扩展 加载 x') === true);
    await plain.handleSlashCommand(input('/扩展 卸载 anything'), dAlias);
    ok('内置命令命中别名后**照样解析得出子命令**（说明被规范回了主命令词）',
      extrasPort.unloads.length === before + 1, JSON.stringify(extrasPort.unloads));
    ok('别名同样要跟边界（`/扩展包` 不是命令）', plain.isSlashCommand('/扩展包') === false);
  }
  {
    // 用法提示里印的仍是主命令词 —— 别名只是"另一个叫法"，提示该给一个肯定能用的写法。
    const { deps: dUsage, log: logUsage } = deps();
    const plain = createSlashCommands(() => ({ override: false, commands: [] }), extrasPort);
    await plain.handleSlashCommand(input('/扩展 加载'), dUsage);
    ok('用法提示里印的是主命令词 `/能力`（别名不改文案）',
      String(logUsage.sent.at(-1)?.message).includes('/能力 加载'), JSON.stringify(logUsage.sent));
  }
  {
    const { deps: d, log } = deps();
    const withAlias = createSlashCommands(() => ({
      override: false,
      commands: [{
        name: '/天气',
        aliases: ['/weather', '/tq'],
        match: (text) => /^\/天气(?:\s|$)/u.test(text),
        // 只认主命令词 —— 别名若没被规范回来，这里会拿到 `/weather 北京`、参数解析不出来。
        run: async (inputText) => `主词=${inputText.text.slice(0, 3)} 参数=${inputText.text.replace(/^\/天气/u, '').trim()}`
      }]
    }), extrasPort);
    ok('扩展命令：声明的别名被认出来',
      withAlias.isSlashCommand('/weather 北京') === true && withAlias.isSlashCommand('/tq 北京') === true
      && withAlias.isSlashCommand('/weather') === true);
    ok('扩展命令：别名同样要跟边界（`/weatherx`、`/tqx` 都不是命令）',
      withAlias.isSlashCommand('/weatherx') === false && withAlias.isSlashCommand('/tqx') === false);
    await withAlias.handleSlashCommand(input('/weather 北京'), d);
    ok('扩展命令：命中别名时把开头那个词换成主命令词再交给处理函数',
      String(log.sent.at(-1)?.message) === '主词=/天气 参数=北京', JSON.stringify(log.sent));
  }
}

// ── 5. 判据只有一份（这条是这一层唯一能被机检的结构性质）─────────
{
  const ingestSrc = stripComments(readSource('web/onebot/ingest.ts'));
  const commandsSrc = stripComments(readSource('web/onebot/slash-commands.ts'));
  ok('ingest.ts 里不再有任何命令正则（判据只许在 slash-commands.ts 一处）',
    !ingestSrc.includes('^\\/画') && !ingestSrc.includes('^\\/转写')
    && !ingestSrc.includes('isDrawCommand') && !ingestSrc.includes('isTranscriptionCommand'),
    'ingest.ts 里又长出了命令判据 —— 两份判据漂移时不会有任何报错');
  ok('slash-commands.ts 里两条命令的判据都在（`[视频]` 那条分支也还在）',
    commandsSrc.includes('^\\/转写') && commandsSrc.includes('^\\/画') && commandsSrc.includes('\\[视频\\]'));
  ok('ingest.ts 只用同一个判据决定 wakeEligible（命令 → 已读历史，不进窗口）',
    /wakeEligible: !slashCommand/.test(ingestSrc)
    && /const slashCommand = commands\.isSlashCommand\(commandText\)/.test(ingestSrc));
  ok('命令表存的是**函数引用**，没有按键分发（与装配清单同一形态）',
    !/COMMANDS\[/.test(commandsSrc) && !/COMMANDS\.get\(/.test(commandsSrc));
}

process.exit(done() ? 0 : 1);
