// 被测代码在哪 —— 整个 tests/ 只有这一处知道。
//
// 为什么单独一个模块：S4 会把 src/ 下的文件搬进子目录、S2 之后运行时看的是
// tsc 产物 dist/，这些都会改动"模块的相对路径"。套件里写死路径的话，21 个文件
// 要改 100 多处，而且漏一处只在运行时炸。集中到这里之后，那些变化只影响这一个文件。
//
// ⚠️ 绝对不要在顶层 import 被测模块：config.js 在模块加载那一刻就把 DATA_DIR
// 定死了，套件必须"先 mkdtemp + 设 QQ_AGENT_DATA_DIR，再 load 第一个模块"
// （见 harness.dataDir）。所以这里导出的是动态 import 函数。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 仓库根（tests/lib/ 往上两级）。 */
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * 被测代码的根目录：tsc 产物 `dist/`。
 *
 * S3 起 `src/` 里有 `.ts` 了（`src/paths.ts`），Node 20 跑不了 `.ts`，所以
 * `dist/` 是**唯一**的运行形态——以前那个 `QQ_AGENT_SRC=src` 的逃生口从这一刻起
 * 一定跑不通（`config.js` 会 import 不到 `./paths.js`），留着只会让人以为还有退路，
 * 所以删掉了。
 */
export const SRC_DIR = path.join(ROOT, 'dist');

/** SRC_DIR 的 file:// URL，末尾的斜杠必须留着。给动态 import 用。 */
export const BASE_URL = pathToFileURL(SRC_DIR).href + '/';

/** 动态 import 一个被测模块，例如 load('store.js')、load('chat/store.js')。 */
export const load = (rel) => import(BASE_URL + rel);

/** 读被测源码的文本（把模块当文本分析的套件用，例如 t-digest 比对旧版本）。 */
export const readSrc = (rel) => fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');

/** SRC_DIR 相对仓库根的路径，形如 'src'。给 `git show src/x.js` 这类命令用。 */
export const SRC_REL = path.relative(ROOT, SRC_DIR).split(path.sep).join('/');

/**
 * git 里那棵源码树，恒为 'src'。
 *
 * 和 SRC_DIR 是**两件事**：SRC_DIR 是"运行时从哪儿加载"（S2 之后是 tsc 产物 `dist/`），
 * 而 git 历史里躺着的永远是 `src/` 下的源码——`dist/` 是产物，不进版本库。
 * 拿 `git show` 取旧版本文件（t-digest 就是这么跟"改之前"逐字对比的）要用这个。
 */
export const SOURCE_REL = 'src';

// ── ui/：前端不参与构建，也不走 SRC_DIR，永远从仓库里读 ──
export const UI_DIR = path.join(ROOT, 'ui');
export const uiFile = (rel) => path.join(UI_DIR, rel);
export const readUI = (rel) => fs.readFileSync(uiFile(rel), 'utf8');
