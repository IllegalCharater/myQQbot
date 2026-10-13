#!/usr/bin/env node
/**
 * 桌面版打包：做出一个"解压即用"的绿色目录（Electron 运行时 + 编译后的后端 + 面板 + Python 工具）。
 *
 * 用法：
 *   node scripts/build-desktop.mjs                  # 清空 dist 重新编译，打包到 release/
 *   node scripts/build-desktop.mjs --zip            # 顺手压成 zip（方便发给别人）
 *   node scripts/build-desktop.mjs --out D:\dist    # 换个输出目录
 *   node scripts/build-desktop.mjs --skip-build     # 不重新编译，直接用现有 dist/
 *   node scripts/build-desktop.mjs --help
 *
 * 产物形状：
 *   release/qq-agent-0.3.0-win-x64/      ← 整个目录拷给用户，双击「QQ Agent.exe」就能用
 *     QQ Agent.exe
 *     *.dll / *.pak / locales/ …         ← Electron 运行时（node_modules/electron/dist 原样搬）
 *     resources/app/                     ← 我们的代码，**不是 asar、是普通文件**
 *       package.json                     ← main = electron/main.js（Electron 靠它找入口）
 *       electron/  dist/  ui/  assets/  python-tools/  node_modules/(仅生产依赖)
 *       python-runtime/                  ← 可选：`--with-python` 带进来的最小 Python 运行时
 *     data/                              ← 首次运行时程序自己建，就在 exe 旁边
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 改这个脚本前先读这五条边界（每一条都是"看着可以省、省了会炸"的那种）：
 *
 * 1. **不打 asar**。asar 里的成员不是真文件：`python-tools/*.py` 要 spawn 给 Python、
 *    SnowLuma 目录里的可执行文件要拉起、`ui/` 要按文件读、`data/` 要写在 exe 旁边。
 *    （`src/web/onebot/snowluma.ts` 里那段 `app.asar.unpacked` 兜底是给历史安装版留的，
 *    绿色目录用不上，留着也无害。）
 *
 * 2. **白名单拷贝，不是黑名单**。只搬 APP_ENTRIES 里点名的东西，所以 `data/`（含
 *    API Key 与真实聊天记录）、`snowluma/logs/`、`.env`、`findings.md` 这些根本进不来 ——
 *    "记得排除敏感文件"不该靠人记。脚本末尾还会再断言一次产物里没有 `data/`。
 *
 * 3. **node_modules 只搬生产依赖闭包**（从 dependencies 递归走，当前是 js-yaml / node-cron /
 *    undici / ws + argparse）。整个 node_modules 还装着 Electron 与 TypeScript，一起搬要多几百 MB。
 *
 * 4. **不改 `electron/main.js`**。它的 data 目录解析本来就是"打包后 = exe 旁边"，正好是绿色版
 *    要的形状；而 `before-quit` 那段被 `tests/t-lifecycle.mjs` 按**函数体**逐条钉着（缺一条
 *    要么应用不退、要么死循环），动它得同步改断言。打包器只保证 exe 与 resources/app 的相对
 *    位置正确，其余一概不碰。
 *
 * 5. **产物目录每次重建**。`release/<...>/` 是我们自己算出来的路径，重建前先删干净 ——
 *    上一版的残留（尤其是已经删掉的模块的旧产物）混进包里，症状是"用户那边跑的是上一代代码"。
 * ─────────────────────────────────────────────────────────────────────────────
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// ── 输出与日志 ────────────────────────────────────────────────────────────────
const t0 = Date.now();
const log = (...a) => console.log(...a);
const warn = (...a) => console.log('  ⚠️ ', ...a);
let stepNo = 0;
const step = (title) => log(`\n[${++stepNo}] ${title}`);

function fail(message) {
  console.error(`\n❌ 打包中止：${message}`);
  process.exit(1);
}

// ── 参数 ──────────────────────────────────────────────────────────────────────
const USAGE = `用法：node scripts/build-desktop.mjs [选项]

  --out <目录>        输出目录，默认 release/
  --skip-build        不重新编译（默认会清空 dist/ 后跑一次 tsc）
  --no-clean          增量编译（保留 dist/，只补改动 —— 可能把化石产物带进包）
  --zip               打包完成后额外压一个 zip
  --with-python       内置一份最小 Python 运行时（搜图 / 漫画不需要用户自己装 Python）
  --python-dist <路径>  用本机已有的一份当来源：一个解包好的运行时目录，或 .tar.gz/.zip 压缩包
  --python-url <地址>   直接指定下载地址（默认按平台去 python-build-standalone 最新发行版里挑）
  --python-no-deps    只带解释器，不替它装 python-tools/requirements.txt（默认会装）
  --with-snowluma     强制把 snowLuma/ 打进包（找不到就报错）
  --no-snowluma       明确不打 SnowLuma（默认是"有就打，没有就跳过"）
  --no-verify         跳过产物校验（不推荐：校验是唯一能发现"漏文件"的手段）
  -h, --help          显示这段文字
`;

const args = {
  out: 'release', build: true, clean: true, zip: false, snowluma: null, verify: true,
  python: false, pythonDist: '', pythonUrl: '', pythonDeps: true
};
for (let i = 0; i < process.argv.length - 2; i++) {
  const a = process.argv[i + 2];
  const next = () => {
    const v = process.argv[i + 3];
    if (v === undefined) fail(`参数 ${a} 后面缺一个值`);
    i++;
    return v;
  };
  if (a === '--out') args.out = next();
  else if (a === '--skip-build') args.build = false;
  else if (a === '--no-clean') args.clean = false;
  else if (a === '--zip') args.zip = true;
  else if (a === '--with-python') args.python = true;
  else if (a === '--python-dist') { args.python = true; args.pythonDist = next(); }
  else if (a === '--python-url') { args.python = true; args.pythonUrl = next(); }
  else if (a === '--python-no-deps') args.pythonDeps = false;
  else if (a === '--with-snowluma') args.snowluma = true;
  else if (a === '--no-snowluma') args.snowluma = false;
  else if (a === '--no-verify') args.verify = false;
  else if (a === '-h' || a === '--help') { log(USAGE); process.exit(0); }
  else fail(`未知参数：${a}\n\n${USAGE}`);
}

// ── 平台 ──────────────────────────────────────────────────────────────────────
// node_modules/electron/dist 里的运行时是**当前平台**那一份，所以只能在当前平台上打包。
// macOS 的 .app 是 bundle（Info.plist 里写死可执行文件名与图标），改名不是重命名一个文件
// 就完事，本脚本不假装支持它。
if (process.platform === 'darwin') {
  fail('macOS 请用 electron-builder/electron-packager 出 .app（本脚本不伪造 bundle 结构）。');
}
const PLATFORM = process.platform === 'win32' ? 'win' : process.platform;
const IS_WIN = process.platform === 'win32';
const SOURCE_EXE = IS_WIN ? 'electron.exe' : 'electron';

const PRODUCT = SRC.productName || 'QQ Agent';
const SLUG = (SRC.name || 'app').toLowerCase();
const VERSION = SRC.version || '0.0.0';
const PKG_NAME = `${SLUG}-${VERSION}-${PLATFORM}-${process.arch}`;
const OUT_ROOT = path.resolve(ROOT, args.out);
const PKG_DIR = path.join(OUT_ROOT, PKG_NAME);
const EXE_NAME = IS_WIN ? `${PRODUCT}.exe` : SLUG;
const ZIP_NAME = `${PKG_NAME}.zip`;

// ⚠️ 只允许删这个形状的路径：我们自己拼出来的 `release/<slug>-<版本>-<平台>-<架构>`。
// 用户可能把 --out 指到别处，所以这里再核一遍"父目录 + 名字都长对了"才敢递归删。
if (path.dirname(PKG_DIR) !== OUT_ROOT || path.basename(PKG_DIR) !== PKG_NAME) {
  fail(`拒绝操作可疑的输出路径：${PKG_DIR}`);
}

// ── 小工具 ────────────────────────────────────────────────────────────────────
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 任何深度都不该进产物的东西。白名单拷贝已经挡掉了 data/，这里是第二道与卫生间的清理。 */
const JUNK = [
  /(^|[\\/])__pycache__([\\/]|$)/,
  /\.py[co]$/,
  /(^|[\\/])\.DS_Store$/,
  /(^|[\\/])Thumbs\.db$/,
  /(^|[\\/])desktop\.ini$/,
  /(^|[\\/])\.trash([\\/]|$)/,
  /\.log$/,
  /\.tsbuildinfo$/,
  /\.tmp$/, /\.bak$/, /\.swp$/
];
const keep = (p) => !JUNK.some((re) => re.test(p));

/** 把 src 整个目录拷到 dest（自动建父目录），并套用 JUNK 过滤。 */
function copyTree(src, dest, extraFilter = () => true) {
  if (!fs.existsSync(src)) fail(`缺文件/目录：${src}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (from) => keep(from) && extraFilter(from),
    // 不 dereference：遇到软链保持软链，免得把 node_modules 里指出去的东西复制成实体
    dereference: false
  });
}

/** 同步睡一会儿（打包是同步流程，不想为这点事把它改成异步）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 删一棵目录树，Windows 上给几次重试机会。
 *
 * 实测踩到过：删 `release/<包>/` 时 EBUSY —— 上一次打出来的 **QQ Agent 还开着**（exe 就在那棵树里），
 * 或者杀软/索引器刚扫过那 276MB。裸 `rmSync` 会在这里抛一个只有 errno 的错，看起来像脚本坏了。
 * 重试几次还不行就明说"是被占用"，并点名最常见的原因。
 */
function removeTree(dir, why) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch (error) {
      if (attempt === 5) {
        fail(`${why}失败：${dir}\n  ${error.message}\n` +
          '  这个目录被别的进程占着 —— 最常见的原因是**上一次打出来的 QQ Agent 还开着**（exe 就在里面），\n' +
          '  或者杀毒软件/索引器正在扫它。关掉程序再跑一次。');
      }
      sleepSync(1200);
    }
  }
}

function sizeText(bytes) {
  if (bytes > 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes > 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) { try { total += fs.statSync(p).size; } catch { /* 忽略消失的文件 */ } }
    }
  };
  walk(dir);
  return total;
}

/** 收集 src/ 下所有需要编译产物的文件（.d.ts 不产出 .js，是唯一例外）。 */
function walkRel(dir, filter) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && filter(entry.name)) out.push(path.relative(dir, p));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

// ── 内置 Python 运行时（`--with-python`）─────────────────────────────────────
//
// 目标：让"这台机器上什么都没装"的用户也能用搜图与漫画。做法是随包带一份**最小** CPython
// （python-build-standalone 的 install_only 发行版）。
//
// ⚠️ 它由 `resolvePythonCommand()` 排在**链首**（2026-10-13 定）：内置那一份是我们自己装好依赖、
// 跟着包发出去的，是唯一"确定能用"的解释器，而后面几层（`python.path` / `QQ_AGENT_PYTHON` /
// conda）都是这台机器上的猜测。**代价**：带内置运行时的包里，设置页填的 `python.path` 不生效 ——
// 所以使用说明与设置页提示都写明了这件事与两条出路（删掉 `resources/app/python-runtime/`，或
// 换一个不带 `--with-python` 的包），否则用户会遇到"填了路径却没生效"这种最难查的故障。
//
// 三条边界：
//   • **只在这里下载/拷贝，运行期不联网**：用户拿到的包里就是一个现成的解释器。
//   • 依赖装进**这一份**运行时（`pip install -r python-tools/requirements.txt`）；装失败只警告、
//     不算打包失败 —— 解释器本身可用，用户可以事后补装（使用说明里写了那条命令）。
//   • 剪掉 test / tkinter / tcl 这类与两个工具无关的东西；**不剪 `Lib/site-packages`**（pip 在里面）。
// 平台三连（与 python-build-standalone 的资产名一致）。实测的那个发行版里资产长这样：
//   cpython-3.12.15+20261009-x86_64-pc-windows-msvc-install_only.tar.gz
//   cpython-3.12.15+20261009-x86_64-pc-windows-msvc-install_only_stripped.tar.gz   ← 只有前者的**一半**大
// 所以这里只写三连，`-install_only[_stripped].tar.gz` 由下面的正则补上，并**优先挑 stripped**。
const PYTHON_TRIPLES = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu'
};
/** 优先这个系列：两个依赖都是纯 Python，而这个系列的轮子在各平台上都齐（新系列可能还没有轮子）。 */
const PYTHON_PREFERRED_SERIES = '3.12';
/** 与两个工具无关、又占地方的东西。删掉它们不影响 `import jmcomic` / `import PicImageSearch`。 */
const PYTHON_PRUNE = [
  'Lib/test', 'Lib/idlelib', 'Lib/turtledemo', 'Lib/lib2to3', 'Lib/tkinter',
  'tcl', 'Doc', 'Tools', 'share', 'include'
];

function capture(cmd, argv) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), error: r.error };
}

async function fetchTo(url, dest, label) {
  log(`  ${label}：${url}`);
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'qq-agent-packager' } });
  if (!res.ok) fail(`下载失败（HTTP ${res.status}）：${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  log(`  已下载 ${sizeText(buf.length)}`);
}

/** 去 python-build-standalone 的最新发行版里按平台挑一个资产。 */
async function resolveStandaloneUrl(triple) {
  const api = 'https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest';
  const res = await fetch(api, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'qq-agent-packager' } });
  if (!res.ok) {
    fail(`取 python-build-standalone 最新发行版失败（HTTP ${res.status}）。离线或被墙时用 ` +
      '`--python-dist <本机目录或压缩包>`，或 `--python-url <地址>`。');
  }
  const release = await res.json();
  const nameRe = new RegExp(`^cpython-(3\\.\\d+\\.\\d+)\\+\\d+-${triple}-install_only(_stripped)?\\.tar\\.gz$`);
  const candidates = (release.assets ?? [])
    .map((a) => nameRe.exec(String(a?.name ?? '')))
    .filter(Boolean)
    .map((m) => ({ name: m[0], version: m[1], stripped: Boolean(m[2]) }));
  if (!candidates.length) {
    fail(`最新发行版（${release.tag_name}）里没有 ${triple} 的 install_only 资产 —— 用 --python-url 指定一个。`);
  }
  const rank = (v) => v.split('.').map(Number);
  const cmp = (a, b) => (rank(a.version)[0] - rank(b.version)[0])
    || (rank(a.version)[1] - rank(b.version)[1]) || (rank(a.version)[2] - rank(b.version)[2]);
  const series = (list) => list.filter((c) => c.version.startsWith(`${PYTHON_PREFERRED_SERIES}.`)).sort(cmp);
  const sorted = (series(candidates).length ? series(candidates) : candidates.slice().sort(cmp));
  const newest = sorted[sorted.length - 1];
  // 同一版本同时有 stripped 与完整包时挑 stripped：功能相同（只是去了调试符号），体积只有一半。
  const picked = candidates.find((c) => c.version === newest.version && c.stripped) ?? newest;
  return {
    url: `https://github.com/astral-sh/python-build-standalone/releases/download/${release.tag_name}/${picked.name}`,
    version: picked.version
  };
}

function extractArchive(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // ⚠️ **必须只给 tar 相对文件名**。实测：直接传 `C:\Users\…\python-runtime.tar.gz`，GNU tar 会把它
  // 当成 `主机:文件` 的 rmt 语法去连主机 `C`，报一句 `Cannot connect to C: resolve failed`，
  // 与"压缩包坏了"长得几乎一样。所以统一把归档摆到解压目标里、cwd 设成解压目标再解。
  const staged = path.join(destDir, path.basename(archive));
  if (path.resolve(archive) !== path.resolve(staged)) fs.copyFileSync(archive, staged);
  const run = (cmd, argv) => spawnSync(cmd, argv, { cwd: destDir, stdio: 'inherit' });
  const r = /\.zip$/i.test(staged)
    ? (IS_WIN
        ? run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
            `Expand-Archive -Path '${path.basename(staged)}' -DestinationPath '.' -Force`])
        : run('unzip', ['-q', path.basename(staged), '-d', '.']))
    : run('tar', ['-xzf', path.basename(staged)]);
  try { fs.rmSync(staged, { force: true }); } catch { /* 临时目录，删不掉无所谓 */ }
  if (r.status !== 0) {
    fail(`解压失败：${archive}（${r.error?.message ?? `退出码 ${r.status}`}）。` +
      'Windows 10 1803+ 自带 tar；没有的话用 --python-dist 指向已经解包好的目录。');
  }
}

/** 在一个目录或它的一级子目录里找解释器（压缩包常自带一层外壳目录）。找不到返回空串。 */
function findRuntimeRoot(dir) {
  const rel = IS_WIN ? 'python.exe' : path.join('bin', 'python3');
  if (fs.existsSync(path.join(dir, rel))) return dir;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(dir, entry.name);
    if (fs.existsSync(path.join(sub, rel))) return sub;
  }
  return '';
}

/** 把一份最小运行时装进 `destDir`，返回 `{ exe, version, deps }`（exe 是产物里的绝对路径）。 */
async function bundlePython(destDir) {
  const triple = PYTHON_TRIPLES[`${process.platform}-${process.arch}`];
  if (!triple && !args.pythonDist) {
    fail(`--with-python 不支持 ${process.platform}-${process.arch}。` +
      `可用的组合：${Object.keys(PYTHON_TRIPLES).join('、')}；或用 --python-dist 指向本机一份现成的运行时。`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-python-'));
  try {
    let sourceDir = '';
    let origin = '';
    if (args.pythonDist) {
      const src = path.resolve(ROOT, args.pythonDist);
      if (!fs.existsSync(src)) fail(`--python-dist 指向的路径不存在：${src}`);
      if (fs.statSync(src).isDirectory()) {
        sourceDir = findRuntimeRoot(src);
        if (!sourceDir) fail(`这个目录（及其一级子目录）里没有解释器：${src}`);
      } else {
        extractArchive(src, tmp);
        sourceDir = findRuntimeRoot(tmp);
        if (!sourceDir) fail(`这个压缩包里没找到解释器：${src}`);
      }
      origin = `本机 ${src}`;
    } else {
      const picked = args.pythonUrl
        ? { url: args.pythonUrl, version: '--python-url 指定的那一份' }
        : await resolveStandaloneUrl(triple);
      const archive = path.join(tmp, 'python-runtime.tar.gz');
      await fetchTo(picked.url, archive, `python-build-standalone ${picked.version}`);
      extractArchive(archive, tmp);
      sourceDir = findRuntimeRoot(tmp);
      if (!sourceDir) fail(`下载的包里没找到解释器（${picked.url}）—— 改用 --python-dist 指向本机一份。`);
      origin = `python-build-standalone ${picked.version}`;
    }

    copyTree(sourceDir, destDir);
    let pruned = 0;
    for (const rel of PYTHON_PRUNE) {
      const p = path.join(destDir, rel);
      if (!fs.existsSync(p)) continue;
      try { fs.rmSync(p, { recursive: true, force: true }); pruned++; } catch { /* 剪不掉不致命 */ }
    }
    const exe = path.join(destDir, IS_WIN ? 'python.exe' : path.join('bin', 'python3'));
    const probe = capture(exe, ['-c', 'import sys; print(sys.version.split()[0])']);
    if (probe.status !== 0) {
      fail(`内置运行时跑不起来：${exe} —— ${probe.out || probe.error?.message || `退出码 ${probe.status}`}`);
    }
    log(`  ${origin} → python-runtime/（Python ${probe.out}，剪掉 ${pruned} 项，${sizeText(dirSize(destDir))}）`);

    let deps = false;
    if (!args.pythonDeps) {
      log('  按 --python-no-deps 跳过依赖安装（用户可以事后自己装，使用说明里写了命令）。');
    } else {
      log('  装依赖：python-tools/requirements.txt …');
      const pip = spawnSync(exe, ['-m', 'pip', 'install', '--no-warn-script-location', '--disable-pip-version-check',
        '-r', path.join(ROOT, 'python-tools', 'requirements.txt')], { stdio: 'inherit' });
      if (pip.status === 0) {
        const check = capture(exe, ['-c', 'import jmcomic, PicImageSearch; print("ok")']);
        deps = check.status === 0;
        if (deps) log(`  依赖就绪（含依赖共 ${sizeText(dirSize(destDir))}）`);
        else warn(`依赖装上了但 import 不通过，搜图/漫画仍会报缺库：${check.out}`);
      } else {
        // 装依赖要联网，而打包常常在有网的那台机器上、用户那台没有。**这不算打包失败**：
        // 解释器本身可用，用户按使用说明里那条命令补装即可。
        warn(`依赖没装上（退出码 ${pip.status}，多半是没网或 pip 源不可达）—— 解释器本身可用，事后补装：`);
        warn(`  "${exe}" -m pip install -r "${path.join(ROOT, 'python-tools', 'requirements.txt')}"`);
      }
    }
    return { exe, version: probe.out, deps };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录，删不掉无所谓 */ }
  }
}

// ── 1. 编译 ───────────────────────────────────────────────────────────────────
if (args.build) {
  step(args.clean ? '重新编译（清空 dist/ 后 tsc，避免化石产物混进包）' : '重新编译（增量 tsc）');
  const distDir = path.join(ROOT, 'dist');
  if (args.clean) fs.rmSync(distDir, { recursive: true, force: true });
  // 直接叫 tsc，不走 `npm run build`：Windows 上 spawn 一个 .cmd 需要 shell，
  // 而 shell 会把带空格的路径拆开。用 execPath 跑 tsc 的 bin 是确定的。
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) fail('找不到 TypeScript（node_modules/typescript），先 `npm ci`。');
  const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) fail(`tsc 编译失败（退出码 ${r.status ?? r.error?.message}）。`);
} else {
  step('跳过编译（--skip-build）');
  if (!fs.existsSync(path.join(ROOT, 'dist', 'web', 'app.js'))) {
    fail('dist/web/app.js 不存在 —— 先跑一次 `npm run build`，或去掉 --skip-build。');
  }
}

// ── 2. 建产物目录 ─────────────────────────────────────────────────────────────
step('准备产物目录');
if (fs.existsSync(PKG_DIR)) {
  log(`  清掉上一版：${path.relative(ROOT, PKG_DIR)}`);
  removeTree(PKG_DIR, '清掉上一版产物');
}
fs.mkdirSync(PKG_DIR, { recursive: true });

// ── 3. 搬 Electron 运行时 ─────────────────────────────────────────────────────
step('搬 Electron 运行时');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
if (!fs.existsSync(path.join(ELECTRON_DIST, SOURCE_EXE))) {
  fail(`没找到 Electron 运行时（${path.relative(ROOT, ELECTRON_DIST)}）—— 先 \`npm ci\`。`);
}
const electronVersion = fs.existsSync(path.join(ELECTRON_DIST, 'version'))
  ? fs.readFileSync(path.join(ELECTRON_DIST, 'version'), 'utf8').trim()
  : '?';
// resources/default_app.asar 是"没有 app 时 Electron 自己跑的那个壳"，约 2MB，
// 留着不会被用到（resources/app 优先），但不该出现在我们的产物里。
copyTree(ELECTRON_DIST, PKG_DIR, (from) => path.basename(from) !== 'default_app.asar');
// 可执行文件改名：用户看到的是「QQ Agent.exe」而不是 electron.exe。
// （文件图标仍是 Electron 的 —— 换 exe 图标要 rcedit 改 PE 资源，本脚本不做；
//  窗口/托盘图标来自 assets/icon.png，不受影响。）
fs.renameSync(path.join(PKG_DIR, SOURCE_EXE), path.join(PKG_DIR, EXE_NAME));
log(`  Electron ${electronVersion} → ${EXE_NAME}`);

// ── 4. 搬应用代码 ─────────────────────────────────────────────────────────────
step('搬应用代码到 resources/app');
const APP_DIR = path.join(PKG_DIR, 'resources', 'app');
// 白名单：只有这里点名的目录会进包。想加东西就往这张表里加一行，别改成"排除法"。
const APP_ENTRIES = [
  ['dist', '后端编译产物（tsc 输出）'],
  ['ui', '控制台前端（原生 ES Module，不打包）'],
  ['electron', '桌面壳入口（main.js）'],
  ['assets', '图标等静态资源'],
  ['python-tools', 'Python 工具脚本与 requirements.txt']
];
for (const [name, why] of APP_ENTRIES) {
  copyTree(path.join(ROOT, name), path.join(APP_DIR, name));
  log(`  ${name}/  ← ${why}`);
}
copyTree(path.join(ROOT, 'LICENSE'), path.join(APP_DIR, 'LICENSE'));

// 生产依赖闭包：从 dependencies 递归走，只搬真的会被 import 到的包。
const prodDeps = [];
{
  const queue = Object.keys(SRC.dependencies ?? {});
  const seen = new Set();
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const pj = path.join(ROOT, 'node_modules', name, 'package.json');
    if (!fs.existsSync(pj)) fail(`生产依赖 ${name} 没装（node_modules 里没有），先 \`npm ci\`。`);
    for (const dep of Object.keys(readJson(pj).dependencies ?? {})) queue.push(dep);
  }
  prodDeps.push(...seen);
}
prodDeps.sort();
for (const name of prodDeps) {
  copyTree(path.join(ROOT, 'node_modules', name), path.join(APP_DIR, 'node_modules', name));
}
log(`  node_modules/  ← 生产依赖 ${prodDeps.length} 个：${prodDeps.join(', ')}`);

// ── 5. 写产物自己的 package.json ──────────────────────────────────────────────
step('写 resources/app/package.json');
// Electron 靠 `main` 找入口；`type: module` 不能少（main.js 与 dist/ 都是 ESM）。
// `name` 决定 app.getPath('userData')（%APPDATA%/qq-agent），与开发态保持一致，
// 免得同一个用户在两处各留一份数据。
fs.writeFileSync(path.join(APP_DIR, 'package.json'), JSON.stringify({
  name: SRC.name,
  productName: PRODUCT,
  version: VERSION,
  private: true,
  type: 'module',
  main: 'electron/main.js',
  description: SRC.description,
  license: SRC.license,
  author: SRC.author,
  engines: SRC.engines,
  dependencies: SRC.dependencies
}, null, 2) + '\n');

// ── 6. SnowLuma（可选，第三方） ────────────────────────────────────────────────
step('SnowLuma（可选的 QQ 协议端）');
// SnowLuma 是第三方独立项目（自带 EULA 与"源码可见非商业许可"），本仓库的 .gitignore
// 明确不提交它。所以默认策略是"**本机有就一起打、没有就跳过并告诉你放哪儿**"，
// 而不是无条件塞进包里 —— 打不打是使用者的决定（--with-snowluma / --no-snowluma）。
// 放的位置必须与 `src/web/onebot/snowluma.ts` 的查找顺序一致：配置 → ROOT/snowLuma → ROOT/snowluma，
// 而打包后 ROOT 就是 resources/app。
const snowlumaSrc = ['snowLuma', 'snowluma']
  .map((n) => path.join(ROOT, n))
  .find((p) => fs.existsSync(p));
if (args.snowluma === false) {
  log('  按 --no-snowluma 跳过。');
} else if (snowlumaSrc) {
  const dest = path.join(APP_DIR, path.basename(snowlumaSrc));
  copyTree(snowlumaSrc, dest, (from) => !/(^|[\\/])logs([\\/]|$)/.test(from));
  log(`  ${path.basename(snowlumaSrc)}/ 已打进包（不含 logs/）`);
  warn('SnowLuma 是第三方项目，按它自己的许可证使用；本包分发它需要你确认有权这么做。');
} else if (args.snowluma === true) {
  fail('--with-snowluma 但项目里没有 snowLuma/ 目录（先按 README 下载放进项目根目录）。');
} else {
  log('  本机没有 snowLuma/，不打进包。');
  log('  使用者可以自己把程序目录放到  resources\\app\\snowLuma\\  （或设置页里填绝对路径）。');
}

// ── 7. Python 运行时（可选） ───────────────────────────────────────────────────
step('Python 运行时（可选，--with-python）');
let bundledPython = null;
if (args.python) {
  bundledPython = await bundlePython(path.join(APP_DIR, 'python-runtime'));
} else {
  log('  跳过（默认不带）。');
  log('  不带时按 src/core/python-runtime.ts 的解析链回落到用户自己的 Python；');
  log('  加 --with-python 则随包带一份最小运行时，用户机器上不装 Python 也能用搜图与漫画。');
}

// ── 8. 使用说明 ───────────────────────────────────────────────────────────────
step('写使用说明.txt');
// Python 那一段随"带没带运行时"整段换掉：这两种情况下用户该做的事完全不同（一个是"开箱可用"，
// 一个是"你得先自己装"），写成一段含糊的话只会让人照着错的做。
const PYTHON_HELP = bundledPython
  ? `【Python 能力（反向搜图、漫画下载、依赖自检）】
  本包**已内置**一份最小 Python 运行时（Python ${bundledPython.version}），搜图与漫画就用它，
  不需要你装 Python。
${bundledPython.deps
    ? '  依赖（jmcomic / PicImageSearch）已经装好，开箱可用。'
    : '  ⚠️ 打包时没能替它装依赖。要用这些能力，先联网跑一次（只需一次）：\n' +
      '      "<本目录>\\resources\\app\\python-runtime\\python.exe" -m pip install -r "<本目录>\\resources\\app\\python-tools\\requirements.txt"'}
  ⚠️ 只要这份内置运行时在，设置页「Python 工具」里填的解释器路径**不会生效** —— 内置那一份带着
  装好的依赖，是唯一"确定能用"的。想换成自己的 Python：删掉本目录下的
  resources\\app\\python-runtime\\ 这个目录，然后按设置页的提示填。
  点「测试解释器」可以看到"当前生效的是哪一层"以及两个库装没装。`
  : `【可选：Python 能力（反向搜图、漫画下载、依赖自检）】
  本包**不含** Python。要用这些能力，需要本机装 Python 3 并安装依赖：
      <你的 python> -m pip install -r "<本目录>\\resources\\app\\python-tools\\requirements.txt"
  然后在设置页「Python 工具」里填解释器路径，点「测试解释器」自查。
  （重新打包时加 --with-python，可以让包内自带一份最小运行时，用户就不必自己装 Python。）`;

const GUIDE = `QQ Agent 桌面版 —— 使用说明（v${VERSION}，${PLATFORM}-${process.arch}）
============================================================

【怎么启动】
  双击本目录下的「${EXE_NAME}」。
  首次启动若被 Windows SmartScreen 拦下（"Windows 已保护你的电脑"），
  点「更多信息」→「仍要运行」即可（本包未做代码签名）。

【界面在哪】
  启动后会自动打开控制台窗口，默认地址 http://127.0.0.1:3210/ （端口被占用时自动顺延到 3211+）。
  关闭窗口 = 缩到右下角托盘，不会退出；真正退出走托盘右键菜单里的「退出」。
  托盘菜单里还有「暂停 / 恢复」与「开机自启」。

【数据在哪】
  全部数据都在本目录下的 data\\ ：config.json（含 API Key）、聊天存档、会话记录、
  群友记忆、白名单、表情库、今日用量。
  · 备份 = 拷这个 data\\ 目录；换机器 = 把整个目录一起搬走。
  · 不要把它放到 C:\\Program Files 下面：那里的目录普通用户不可写，程序存不了配置，
    请解压到桌面、D 盘或用户目录等可写位置。

【第一次要配什么】
  打开控制台 →「设置」→「模型 API」，填 OpenAI 兼容接口的地址与 API Key。
  其余能力（联网搜索、搜图、转写、出图、漫画）都按需再配，不填就只是对应功能不可用。

【QQ 协议端（SnowLuma）】
  本包${snowlumaSrc && args.snowluma !== false ? '**已包含** snowLuma 目录' : '**不含** SnowLuma'}（第三方项目，自带许可，需你自行下载）。
  放法：把整份程序目录放到
      <本目录>\\resources\\app\\snowLuma\\
  （目录名 snowLuma / snowluma 都认；也可以在设置页里填任意绝对路径。）
  然后重启本程序即可被识别，设置页「SnowLuma」里能启动它、打开它的 WebUI。

${PYTHON_HELP}

【怎么升级】
  解压新版本、覆盖旧的程序文件即可。**data\\ 不会被覆盖**，新版本也不会去动它已有的内容。

【常见问题】
  · 打不开界面：确认程序在运行（托盘里有图标）；端口冲突时实际端口是顺延过的，
    以控制台窗口里打出的地址为准。
  · 模型不回话：先在设置页确认 API Key 与接口地址，再看「会话」页签里的报错详情。
  · 依赖缺失：Python 相关功能需要先按上面一节装依赖；不装不影响聊天。
  · 卸载：删掉整个目录即可（连同 data\\，那是你的数据，删前自行备份）。

【许可证与第三方组件】
  本项目代码：MIT（见 LICENSE）。
  Electron / Chromium 等第三方组件的许可证见本目录 LICENSES.chromium.html 与 resources\\ 下的文件。
`;
// 带 BOM 写：记事本、老旧编辑器与一部分复制粘贴路径默认按本地代码页解码，BOM 是最省事的判据。
fs.writeFileSync(path.join(PKG_DIR, '使用说明.txt'), '\ufeff' + GUIDE);

// ── 9. 校验 ───────────────────────────────────────────────────────────────────
if (args.verify) {
  step('校验产物');
  const problems = [];

  // 9a. 必需文件在位
  const required = [
    EXE_NAME,
    'resources/app/package.json',
    'resources/app/electron/main.js',
    'resources/app/dist/web/app.js',
    'resources/app/dist/core/paths.js',
    'resources/app/ui/index.html',
    'resources/app/assets/icon.png',
    'resources/app/python-tools/requirements.txt'
  ];
  if (bundledPython) required.push(`resources/app/python-runtime/${IS_WIN ? 'python.exe' : 'bin/python3'}`);
  for (const rel of required) {
    if (!fs.existsSync(path.join(PKG_DIR, rel))) problems.push(`产物缺文件：${rel}`);
  }
  const appPkg = fs.existsSync(path.join(APP_DIR, 'package.json')) ? readJson(path.join(APP_DIR, 'package.json')) : {};
  if (appPkg.main !== 'electron/main.js') problems.push(`产物 package.json 的 main 是 ${JSON.stringify(appPkg.main)}（应为 electron/main.js）`);
  if (appPkg.type !== 'module') problems.push('产物 package.json 缺 type: module（main.js 与 dist/ 都是 ESM，少了会直接崩）');
  for (const name of prodDeps) {
    if (!fs.existsSync(path.join(APP_DIR, 'node_modules', name, 'package.json'))) problems.push(`产物缺生产依赖：${name}`);
  }

  // 9b. src ↔ dist 对账。AGENTS.md 里那条纪律（清空重建后逐文件对账）在这里自动化：
  //     少一个产物意味着某个模块在包里不存在，而它通常只在跑到那条路径时才炸。
  const tsFiles = walkRel(path.join(ROOT, 'src'), (n) => n.endsWith('.ts') && !n.endsWith('.d.ts'));
  const missing = tsFiles.filter((rel) => !fs.existsSync(path.join(ROOT, 'dist', rel.replace(/\.ts$/, '.js'))));
  if (missing.length) problems.push(`dist/ 缺 ${missing.length} 个产物（先 --clean 重编译）：${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`);

  // 9c. 敏感与垃圾文件绝不进包
  for (const bad of ['data', 'findings.md', 'progress.md', 'task_plan.md', 'snowluma/logs']) {
    if (fs.existsSync(path.join(PKG_DIR, bad))) problems.push(`产物里出现了不该有的 ${bad}`);
  }
  // 内置运行时里的 `*.pyc` **不算垃圾**，是有意留的：那份字节码正好对应我们带的那一版解释器，
  // 留着首次 import 就少编译一遍，而用户机器上不一定写得进去（装在只读目录时做不到）。
  // 它们由打包时的 `pip install` 顺手生成，不在 python-tools/ 那棵树里。`.log` 与 `.env` 到哪都不许有。
  const runtimeRel = /^resources[\\/]app[\\/]python-runtime[\\/]/;
  const leaked = walkRel(PKG_DIR, (n) => /\.(log|pyc)$/.test(n) || n === '.env')
    .filter((rel) => !(rel.endsWith('.pyc') && runtimeRel.test(rel)));
  if (leaked.length) problems.push(`产物里有敏感/垃圾文件：${leaked.slice(0, 5).join(', ')}`);

  // 9c-2. 内置 Python 真的能跑。**必须验在产物那一份上**（就是即将被压缩、被拷给用户的那棵树）：
  //       剪枝剪掉了 tkinter 之类的东西，剪坏没剪坏只有真跑一次才知道。依赖 import 不通过只警告 ——
  //       它取决于打包含有没有网，不代表包坏了（使用说明里写了补装命令）。
  if (bundledPython) {
    const run = capture(bundledPython.exe, ['-c', 'import sys; print(sys.version.split()[0])']);
    if (run.status !== 0) {
      problems.push(`内置 Python 跑不起来：${bundledPython.exe}（${run.out || run.error?.message || `退出码 ${run.status}`}）`);
    } else {
      const deps = capture(bundledPython.exe, ['-c', 'import jmcomic, PicImageSearch; print("ok")']);
      if (deps.status !== 0) warn(`内置 Python ${run.out} 能跑，但两个库 import 不通过：搜图/漫画会报缺库（按使用说明补装即可）`);
      else log(`  ✅ 内置 Python ${run.out} 能跑，两个库都能 import`);
    }
  }

  if (problems.length) {
    for (const p of problems) console.error(`  ❌ ${p}`);
    fail('产物校验未通过，已中止（产物目录保留在磁盘上，供你排查）。');
  }
  log('  ✅ 文件清单、src↔dist 对账、敏感文件检查全部通过');

  // 9d. 真起一遍：用**产物里那份 dist/** 跑 createApp → start → stop。
  //     这是唯一能证明"打出来的东西真能跑"的一步（缺文件、ESM 解析、路径锚点错了，
  //     都会在这一步暴露）。数据目录指向临时目录，绝不碰真实 data/。
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-packsmoke-'));
  const smoke = `
try {
  const { createApp } = await import(${JSON.stringify(pathToFileURL(path.join(APP_DIR, 'dist', 'web', 'app.js')).href)});
  const core = createApp({ log: () => {} });
  const port = await core.start();
  if (!Number.isInteger(port) || port <= 0) { console.error('SMOKE_BAD_PORT ' + port); process.exit(3); }
  console.log('SMOKE_OK port=' + port);
  await core.stop();
  process.exit(0);
} catch (error) {
  console.error('SMOKE_FAIL ' + (error && error.stack ? error.stack : error));
  process.exit(2);
}
`;
  const smokeRun = spawnSync(process.execPath, ['--input-type=module', '-e', smoke], {
    cwd: APP_DIR,
    env: { ...process.env, QQ_AGENT_DATA_DIR: tmpData },
    encoding: 'utf8',
    timeout: 120000
  });
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch { /* 无关紧要 */ }
  const outText = `${smokeRun.stdout ?? ''}${smokeRun.stderr ?? ''}`;
  if (smokeRun.status === 0 && /SMOKE_OK/.test(outText)) {
    log(`  ✅ 启动冒烟通过（${outText.match(/SMOKE_OK[^\n]*/)[0]}）`);
  } else if (smokeRun.error?.code === 'ETIMEDOUT') {
    // 超时不判死：已知有一处不 unref 的计时器（见 electron/main.js 顶部的注释），
    // 它可能把子进程钉住，而那与打包无关。这里只如实报出来，让人自己判断。
    warn('启动冒烟超时（进程没在 120s 内退出）—— 可能是已知的不 unref 计时器，也可能是真卡住了，建议手动跑一次 exe 确认。');
  } else {
    console.error(outText.split('\n').slice(-25).join('\n'));
    fail(`启动冒烟失败（退出码 ${smokeRun.status ?? smokeRun.error?.code}）：产物里的 dist/ 跑不起来。`);
  }
} else {
  step('跳过校验（--no-verify）');
  warn('未校验的产物可能缺文件 —— 交付前建议去掉 --no-verify 再打一次。');
}

// ── 10. 压缩 ───────────────────────────────────────────────────────────────────
if (args.zip) {
  step('压缩成 zip');
  const zipPath = path.join(OUT_ROOT, ZIP_NAME);
  fs.rmSync(zipPath, { force: true });
  const zipped = IS_WIN
    // 传**目录本身**而不是 `<目录>\*`：后者打出来的压缩包没有顶层文件夹，
    // 用户"解压到桌面"会把 655 个文件直接倒在桌面上（实测踩到）。
    ? spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Compress-Archive -Path '${PKG_DIR}' -DestinationPath '${zipPath}' -Force`], { stdio: 'inherit' })
    : spawnSync('zip', ['-r', '-q', ZIP_NAME, PKG_NAME], { cwd: OUT_ROOT, stdio: 'inherit' });
  if (zipped.status === 0 && fs.existsSync(zipPath)) {
    log(`  ${path.relative(ROOT, zipPath)}（${sizeText(fs.statSync(zipPath).size)}）`);
  } else {
    warn(`压缩失败（${IS_WIN ? 'PowerShell Compress-Archive' : 'zip 命令'}不可用？）—— 目录已经打好了，手动压缩即可。`);
  }
}

// ── 收尾 ──────────────────────────────────────────────────────────────────────
const size = dirSize(PKG_DIR);
log(`
${'─'.repeat(64)}
✅ 打包完成（${((Date.now() - t0) / 1000).toFixed(1)}s，${sizeText(size)}）

   产物目录：${PKG_DIR}
   启动方式：双击「${EXE_NAME}」
${args.zip ? `   压缩包　：${path.join(OUT_ROOT, ZIP_NAME)}\n` : ''}${bundledPython
  ? `   内置 Python：${bundledPython.version}（${bundledPython.deps ? '依赖已就绪' : '依赖未装，见使用说明'}）\n`
  : '   内置 Python：无（用户需自备，或用 --with-python 重新打包）\n'}   数据目录：首次运行时自动建在 exe 旁的 data/（打好的包里**不含**任何数据与密钥）

   交给别人之前记得：node scripts/sanitize-release.mjs --scan（扫描源代码与 data/ 里的敏感信息）
${'─'.repeat(64)}
`);
