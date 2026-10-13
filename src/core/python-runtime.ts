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
import { PYTHON_RUNTIME_DIR, PYTHON_TOOLS_DIR } from './paths.js';

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
export type PythonCommandSource = 'config' | 'env-primary' | 'bundled' | 'conda';

/** 解析结果。`prefix` 是交给 `spawn` 的前置参数（conda 那条路要用）。 */
export interface PythonCommand {
  command: string;
  prefix: string[];
  source: PythonCommandSource;
}

/**
 * 只需要 `python` 这一小块（解释器路径 + conda 环境），所以参数用**结构化窄类型**而不是
 * 整个 `AppConfig`。这样调用方可以只递它真正要的那几个字段，测试也不必凑一份完整配置。
 */
export interface PythonConfig {
  python?: { path?: unknown; condaEnv?: unknown };
}

/** `resolvePythonCommand()` 的可选项。 */
export interface PythonResolveOptions {
  /**
   * 内置运行时的目录，默认 {@link PYTHON_RUNTIME_DIR}。
   *
   * 存在的唯一理由是**可测**：内置层要么命中要么跳过，全看那个目录在不在，而它由 ROOT 算出、
   * 生产代码里改不了。没有这个参数，套件就只能往仓库根目录里放一个假 `python.exe` 再删掉
   * （污染工作区，且进程中途死掉就留下垃圾），或者干脆不测。
   */
  bundledDir?: string;
}

/** 内置运行时里解释器的相对位置（官方 Windows 发行版与 POSIX 布局不同）。 */
function bundledPythonExe(dir: string): string {
  return process.platform === 'win32' ? path.join(dir, 'python.exe') : path.join(dir, 'bin', 'python3');
}

/**
 * 按优先级解析出该用哪个 Python 解释器。
 *
 * 1. **随包内置的运行时**（`PYTHON_RUNTIME_DIR`，只有打包时带了 `--with-python` 才存在）
 * 2. `config.python.path` —— 设置页「Python 工具」里填的解释器（`DEFAULT_CONFIG` 里是空串）
 * 3. `QQ_AGENT_PYTHON`
 * 4. `conda run …`（环境由 `config.python.condaEnv` 决定，见下）
 *
 * ⚠️ **内置层排在最前面是有意的**（2026-10-13 定）：它是我们自己装好依赖、跟着包一起发出去的
 * 那一份，也是唯一"确定能用"的解释器；后面三层都是**这台机器上的猜测**（用户随手填的路径、
 * 环境变量、conda 回退）。带了内置运行时的包 = 开箱可用，不该被机器上恰好设过的某个变量改写。
 *
 * 代价必须说清，因为它正是本项目最忌讳的那类故障（填了、面板看着生效、实际用的却是别的）：
 * **包里有内置运行时时，设置页填的 `python.path` 不会生效**。所以设置页那一栏的提示与使用说明
 * 都写明了这句话，并给出两条出路：删掉 `resources/app/python-runtime/` 这个目录，或者换一个
 * 不带 `--with-python` 打的包。
 *
 * 2–4 层的相对顺序不变（配置 > 环境变量 > conda），且它们**必须**排在 conda 之前：conda 那一级
 * 选出来的 `command` 是一个未必存在的命令名（`conda` / `conda.exe`），解析这一步永远不会因此失败
 * ——失败发生在 `spawn` 那一刻，于是排在它之后的层在"这台机器上真的什么都没装"时永远不会被用到。
 *
 * 第 2 步的空值（`''`、纯空白、非字符串）一律视为"没配"，继续往下走 —— 设置页把输入框清空时
 * 存的就是 `''`，那种情况必须回落而不是当成一个空路径去 spawn。
 *
 * 返回值里的 `source` 就是命中的那一级（`bundled` / `config` / `env-primary` / `conda`），
 * 供设置页显示与测试断言。
 *
 * conda 那一级的 `prefix` 由 `python.condaEnv` 决定，三种形态：
 *   • 环境名（`my_bot`）→ `conda run --no-capture-output -n my_bot python`
 *   • 环境目录（含 `\` 或 `/`）→ `-p <目录>`。**这不是猜测**：设置页上面那栏的占位符就是
 *     一个环境目录的形状（`…\envs\my_bot\python.exe`），用户把目录填进这一栏是很自然的动作，
 *     而 `-n <一个目录>` 只会得到 `EnvironmentNameNotFound`；conda 自己的 `-p` 正好表达它。
 *   • 留空 → 两个都不带（`conda run --no-capture-output python`），含义是"用 conda 当前环境"。
 *     出厂值（`my_bot`）在 `core/config.ts` 的 `DEFAULT_CONFIG.python.condaEnv`：**配置项的
 *     定义处就是它的定义处**，这里只负责"拿到什么用什么"。
 *
 * 历史：conda 那一级以前是**一行写死的绝对路径** `E:\anaconda\envs\my_bot\python.exe`（存在就直用，
 * 否则退回 conda）。它只对作者的机器成立，换环境只能改代码；现在整级交给配置。
 */
export function resolvePythonCommand(
  config: PythonConfig = {},
  options: PythonResolveOptions = {}
): PythonCommand {
  // 内置层：目录在，就用它；不在（没带 --with-python，或用户自己删了）就当作没有这一层。
  const bundled = bundledPythonExe(options.bundledDir ?? PYTHON_RUNTIME_DIR);
  if (fs.existsSync(bundled)) return { command: bundled, prefix: [], source: 'bundled' };

  const configured = typeof config.python?.path === 'string' ? config.python.path.trim() : '';
  if (configured) return { command: configured, prefix: [], source: 'config' };

  if (process.env[PYTHON_ENV_VAR]) return { command: process.env[PYTHON_ENV_VAR]!, prefix: [], source: 'env-primary' };

  const envValue = typeof config.python?.condaEnv === 'string' ? config.python.condaEnv.trim() : '';
  const selector = envValue ? (/[\\/]/.test(envValue) ? ['-p', envValue] : ['-n', envValue]) : [];
  const condaArgs = ['run', '--no-capture-output', ...selector, 'python'];
  return { command: process.platform === 'win32' ? 'conda.exe' : 'conda', prefix: condaArgs, source: 'conda' };
}
