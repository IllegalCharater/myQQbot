// 路径锚点：全仓库"项目在哪、数据在哪、界面在哪"都从这一处取。
//
// 为什么单独一个模块：这些常量原来是各文件自己数 `..` 数出来的
// （`path.resolve(__dirname, '..')`），**对目录深度敏感**——文件一旦下沉一层
// （config.js 搬进 core/，或编译到 dist/core/config.js），`..` 就指到了 dist/，
// `data/`、`ui/`、`python-tools/`、`assets/` 全部失联，而且只在运行时才炸。
// 改成"从本文件向上找 package.json"，深度就不再有意义。
//
// 本文件必须**零依赖**（不 import 同项目的任何模块）：config.js 依赖它，
// 它再依赖回去就是循环依赖。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本文件所在目录（src/ 或 dist/，S4 之后可能是 dist/core/）。 */
const HERE: string = path.dirname(fileURLToPath(import.meta.url));

/** 向上最多找几层。够覆盖 dist/core/ 这种下沉，又不会一路爬到盘符根。 */
const MAX_UP = 6;

/**
 * 项目根：从 start 出发向上找 `package.json`，找到的那一层就是根。
 *
 * 不数 `..`，所以不管本文件在 `src/`、`dist/` 还是 `dist/core/`，结果都一样。
 */
function findRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < MAX_UP; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;                       // 已经到盘符根，再向上就是它自己
    dir = up;
  }
  // 找不到（例如有人把 dist/ 单独拷出去、身边没有 package.json）：退回旧行为——上一层。
  // 不抛错是故意的：路径算不准只该让某些功能不好用，不该让整个程序起不来。
  return path.resolve(start, '..');
}

/** 项目根目录。 */
export const ROOT: string = findRoot(HERE);

/** 数据目录（聊天存档、会话留档、记忆、表情库、config.json 都在里面）。 */
export const DATA_DIR: string = process.env.QQ_AGENT_DATA_DIR || path.join(ROOT, 'data');

/** 前端静态目录（面板 `ui/`）。 */
export const UI_DIR: string = path.join(ROOT, 'ui');

/** 配置文件。 */
export const CONFIG_FILE: string = path.join(DATA_DIR, 'config.json');
