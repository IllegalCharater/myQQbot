// 路径锚点：ROOT / DATA_DIR / UI_DIR / CONFIG_FILE 必须与"本文件放在哪儿"无关。
//
// S3 的核心断言。原来这些常量是数 `..` 数出来的（`path.resolve(__dirname, '..')`），
// S4 把文件搬进子目录之后，`..` 会指到 dist/——data/、ui/、python-tools/ 全部失联，
// 而且只在运行时才炸。所以这里不只验"今天算得对"，还要验**下沉一层之后仍然对**。
//
// 跑法：node tests/t-paths.mjs（或 npm test）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT as REPO, SRC_DIR, load } from './lib/src.mjs';
import { checker, dataDir } from './lib/harness.mjs';

const { ok, done, counts } = checker();

const DIR = dataDir();               // mkdtemp + 设好 QQ_AGENT_DATA_DIR，退出时自动删
const REPO_DIR = path.resolve(REPO);  // src.mjs 的 ROOT 是从 URL 算的，带尾分隔符

const paths = await load('core/paths.js');

// ── 1. 常量今天算得对 ──
ok('ROOT 是仓库根', paths.ROOT === REPO_DIR, `拿到 ${paths.ROOT}，期望 ${REPO_DIR}`);
ok('ROOT 下有 package.json', fs.existsSync(path.join(paths.ROOT, 'package.json')));
ok('DATA_DIR 跟着 QQ_AGENT_DATA_DIR 走', paths.DATA_DIR === DIR, `拿到 ${paths.DATA_DIR}`);
ok('CONFIG_FILE 在 DATA_DIR 下', paths.CONFIG_FILE === path.join(DIR, 'config.json'), `拿到 ${paths.CONFIG_FILE}`);
ok('UI_DIR 下有面板 index.html', fs.existsSync(path.join(paths.UI_DIR, 'index.html')), `拿到 ${paths.UI_DIR}`);

// ── 2. config.js 转出的那一份必须与 paths.js 一致 ──
// 防的是 2026-09-24 那类事故：`export { x } from './y.js'` 只转出、不引入本文件作用域，
// 看起来一模一样，直到用到它才 `is not defined`。光比值抓不住（值本来就相同），
// 所以这里真的调一次写盘——updateConfig() 里的 DATA_DIR / CONFIG_FILE 是无保护的。
const cfg = await load('core/config.js');
ok('config.js 转出的三个常量与 paths.js 一致',
  cfg.ROOT === paths.ROOT && cfg.DATA_DIR === paths.DATA_DIR && cfg.CONFIG_FILE === paths.CONFIG_FILE,
  `config: ${cfg.ROOT} / ${cfg.DATA_DIR} / ${cfg.CONFIG_FILE}`);

cfg.updateConfig({});                // 落盘一次，逼出未定义引用
ok('updateConfig() 写到了 DATA_DIR/config.json', fs.existsSync(path.join(DIR, 'config.json')));

// ── 3. 下沉一层之后仍然算得对（S4 就是这件事） ──
// 把编译产物原样拷进一个更深的目录，再 import 一次。
const nest = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-depth-'));
try {
  const pkg = path.join(nest, 'pkg');
  fs.mkdirSync(path.join(pkg, 'dist', 'core'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"depth-fixture","type":"module"}', 'utf8');
  fs.copyFileSync(path.join(SRC_DIR, 'core', 'paths.js'), path.join(pkg, 'dist', 'core', 'paths.js'));
  const deep = await import(pathToFileURL(path.join(pkg, 'dist', 'core', 'paths.js')).href);
  ok('下沉到 <pkg>/dist/core/ 后 ROOT 仍是 <pkg>', deep.ROOT === pkg, `拿到 ${deep.ROOT}`);
  ok('UI_DIR 跟着新 ROOT 走，而不是跟着文件位置走',
    deep.UI_DIR === path.join(pkg, 'ui'), `拿到 ${deep.UI_DIR}`);
  ok('PYTHON_TOOLS_DIR 也跟着新 ROOT 走（Python 脚本才不会随编译产物下沉而失联）',
    deep.PYTHON_TOOLS_DIR === path.join(pkg, 'python-tools'), `拿到 ${deep.PYTHON_TOOLS_DIR}`);

  // ── 4. 找不到 package.json 时不该抛（有人把 dist/ 单独拷走的情形） ──
  // 刻意放 6 层深：MAX_UP=6 意味着它爬不出这段夹具，结果就不受"机器的 TEMP 目录里
  // 恰好有个 package.json"影响。改 MAX_UP 的话这里要跟着数层数。
  const bare = path.join(nest, 'bare', 'a', 'b', 'c', 'd', 'e', 'f');
  fs.mkdirSync(bare, { recursive: true });
  fs.copyFileSync(path.join(SRC_DIR, 'core', 'paths.js'), path.join(bare, 'paths.js'));
  const orphan = await import(pathToFileURL(path.join(bare, 'paths.js')).href);
  ok('没有 package.json 时退回上一层而不是抛错',
    orphan.ROOT === path.resolve(bare, '..'), `拿到 ${orphan.ROOT}`);
} finally {
  fs.rmSync(nest, { recursive: true, force: true });
}

// ── 5. Python 工具：脚本路径锚点与"文件真的在" ──
// 这一条是**改名的唯一守卫**。`spawn` 一个不存在的脚本不会在编译期报错，只会让漫画下载
// 与搜图 worker 一起在运行期失败；而脚本路径是从 ROOT 拼出来的，所以它属于本套件的主题。
const { JMCOMIC_SCRIPT, PIC_IMAGE_SEARCH_SCRIPT } = await load('core/python-runtime.js');
ok('PYTHON_TOOLS_DIR 指向 ROOT 下的 python-tools 且存在',
  paths.PYTHON_TOOLS_DIR === path.join(REPO_DIR, 'python-tools') && fs.existsSync(paths.PYTHON_TOOLS_DIR),
  `拿到 ${paths.PYTHON_TOOLS_DIR}`);
ok('两个 Python 脚本都真的在 python-tools/ 里（改名/搬家会在这里红，而不是运行期才炸）',
  fs.existsSync(JMCOMIC_SCRIPT) && fs.existsSync(PIC_IMAGE_SEARCH_SCRIPT),
  `jmcomic=${JMCOMIC_SCRIPT} exists=${fs.existsSync(JMCOMIC_SCRIPT)}；` +
  `picImageSearch=${PIC_IMAGE_SEARCH_SCRIPT} exists=${fs.existsSync(PIC_IMAGE_SEARCH_SCRIPT)}`);
// 注意这里取 `paths.PYTHON_TOOLS_DIR` 而不是从 python-runtime 解构：后者只 import 它、
// 并不 re-export（本文件第 2 段那句"只转出、不引入本文件作用域"讲的就是这类误会）。
// 脚本常量只能来自 python-runtime —— 那是"脚本在哪"的唯一落点。
ok('两个脚本都落在同一个目录里（"只有一个 Python 工具目录"这件事的机检形态）',
  path.dirname(JMCOMIC_SCRIPT) === paths.PYTHON_TOOLS_DIR
  && path.dirname(PIC_IMAGE_SEARCH_SCRIPT) === paths.PYTHON_TOOLS_DIR);
ok('依赖清单与脚本同目录，且只此一份',
  fs.existsSync(path.join(paths.PYTHON_TOOLS_DIR, 'requirements.txt')),
  `缺少 ${path.join(paths.PYTHON_TOOLS_DIR, 'requirements.txt')}`);

process.exit(done() ? 0 : 1);
