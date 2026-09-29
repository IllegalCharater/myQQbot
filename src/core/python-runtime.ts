// Python 运行时：**脚本在哪** 与 **用哪个解释器** 的唯一落点。
//
// 为什么单独一个模块：项目里有两个 Python 工具（漫画下载、搜图 worker），它们必须
// 共用同一个解释器。原先是把解析链写死在 `media/jmcomic.ts` 里的，第二个工具一接上就得
// 再抄一份 —— 而"两份规则必然漂移"在本项目已经有过多次实测代价（最近一次是 S11b 的
// `applyEndpoint` 归一化：只要比较的那一侧另写一份规则，用户每保存一次设置就断一次连接）。
//
// 本模块属于 core 层，**零项目依赖**（只 import `node:fs`/`node:path` 与 `./paths.js`），
// 所以 media/ 下的任何工具都能安全引用，不会制造反向依赖。
import fs from 'node:fs';
import path from 'node:path';
import { PYTHON_TOOLS_DIR } from './paths.js';

/** 漫画下载脚本。 */
export const JMCOMIC_SCRIPT: string = path.join(PYTHON_TOOLS_DIR, 'jmcomic_download.py');

/** 搜图 worker（PicImageSearch 常驻进程）。 */
export const PIC_IMAGE_SEARCH_SCRIPT: string = path.join(PYTHON_TOOLS_DIR, 'pic_image_search_worker.py');

/**
 * 统一的解释器环境变量。**只认这一个。**
 *
 * 之所以不按工具各给一个（原有的 `JMCOMIC_PYTHON` 就是这么来的）：两个工具用的是同一个
 * 解释器，各给一个变量的结果就是"装了 A 库的那个环境跑不了 B"，而报错会指向库缺失，
 * 排查方向完全错。
 *
 * `JMCOMIC_PYTHON` 这个旧名**已于 2026-09-29 正式废弃并删除**（此前作为"已废弃别名"保留了
 * 一段时间）。删除是用户拍板的，随之要一起做的是 `tests/t-jmcomic.mjs` 的安全网改造：那道
 * 安全网原先就挂在这个别名上，别名一删，套件里任何"跑起来去 spawn"的用例都会真的启动本机
 * 解释器、真的联网下载漫画。现在它改为**在夹具 `config.json` 里写死一个不存在的 `python.path`**，
 * 顺手也去掉了"本机恰好设了某个环境变量就会变红"的脆弱性。
 */
export const PYTHON_ENV_VAR = 'QQ_AGENT_PYTHON';

/**
 * 命中的是解析链的哪一级。
 *
 * 存在的理由很具体：解释器可能来自四条路中的任意一条，而**只有用户自己知道他填了哪个**。
 * 搜图或漫画因为"环境里没装库"失败时，报错文本完全一样；把它报出来才能让"我明明填了路径"
 * 与"其实还在用 conda 回退"这两件事分得开。设置页的「测试解释器」按钮就显示这个值。
 *
 * ⚠️ 这里是**字面量联合**而不是展示串：中文文案属于 UI（`ui/js/views/settings/index.js`），
 * core 层不该长出用户可见的话术。
 */
export type PythonCommandSource = 'config' | 'env-primary' | 'windows-direct' | 'conda';

/** 解析结果。`prefix` 是交给 `spawn` 的前置参数（conda 那条路要用）。 */
export interface PythonCommand {
  command: string;
  prefix: string[];
  source: PythonCommandSource;
}

/**
 * 只需要 `python.path` 这一小块，所以参数用**结构化窄类型**而不是整个 `AppConfig`。
 * 这样调用方可以只递它真正要的那几个字段，测试也不必凑一份完整配置。
 */
export interface PythonPathConfig {
  python?: { path?: unknown };
}

/** Windows 上优先直用的固定环境（存在才用，不存在则退回 conda）。 */
const WINDOWS_DIRECT_PYTHON = 'E:\\anaconda\\envs\\my_bot\\python.exe';

/** conda 环境名。与 `python-tools/jmcomic_download.py` 里的报错文案是同一个。 */
const CONDA_ENV = 'my_bot';

/**
 * 按优先级解析出该用哪个 Python 解释器。
 *
 * 1. `config.python.path` —— 设置页「Python 工具」里填的那个（唯一的配置入口）
 * 2. `QQ_AGENT_PYTHON`
 * 3. Windows：固定环境存在则直用，否则 `conda.exe run -n my_bot python`
 * 4. 其它平台：`conda run -n my_bot python`
 *
 * 第 1 步空值（`''`、纯空白、非字符串）一律视为"没配"，继续往下走 ——
 * 设置页把输入框清空时存的就是 `''`，那种情况必须回落而不是当成一个空路径去 spawn。
 *
 * 返回值里的 `source` 就是上面命中的那一级（1 → `config`、2 → `env-primary`、
 * 3 → `windows-direct`、4 → `conda`），供设置页显示与测试断言。
 */
export function resolvePythonCommand(config: PythonPathConfig = {}): PythonCommand {
  const configured = typeof config.python?.path === 'string' ? config.python.path.trim() : '';
  if (configured) return { command: configured, prefix: [], source: 'config' };

  if (process.env[PYTHON_ENV_VAR]) return { command: process.env[PYTHON_ENV_VAR]!, prefix: [], source: 'env-primary' };

  const condaArgs = ['run', '--no-capture-output', '-n', CONDA_ENV, 'python'];
  if (process.platform === 'win32') {
    if (fs.existsSync(WINDOWS_DIRECT_PYTHON)) return { command: WINDOWS_DIRECT_PYTHON, prefix: [], source: 'windows-direct' };
    return { command: 'conda.exe', prefix: condaArgs, source: 'conda' };
  }
  return { command: 'conda', prefix: condaArgs, source: 'conda' };
}
