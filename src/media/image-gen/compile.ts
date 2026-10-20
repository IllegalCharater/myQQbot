// 出图提示词编译层：把"原始画面描述"编译成成品提示词，再交给百炼。
//
// ── 它为什么存在 ──
//
// 出图链路上写提示词的一直是主对话模型：它按 `TOOL_PROMPT_TEXT.generate_image.prompt`
// 把群友的一句话展开成一段描述，就直接发走了。质量全看它临场发挥 —— 没有结构、没有语序、
// 没有负面词。这一层加**独立**的模型调用，按一套成套的规则把它编译成成品。
//
// ── 两段式（这是 harness 里 progressive disclosure 的形状）──
//
//   #compile → readSkillText() → splitSkillSections()          ← 逐字切分，不改写
//            → 第 1 段：给【规则目录】（只有节标题）→ 模型回节号
//            → 第 2 段：把选中的节**原文逐字**拼进 system → 产出正/负提示词
//
// Agent Skills 的三级加载是"① 元数据常驻 → ② 判定相关时读**整份** SKILL.md → ③ 附属文件按需读"。
// 第 ③ 级靠的是"模型有 Read/Bash 工具"，而这里的调用是**单发、无工具**的，所以照它的形状把
// "先看索引、再取正文"拆成两次调用：目录就是索引，选中的节就是正文。
// `imageGen.compile.select = false` 时跳过第 1 段，一次调用直接上全文（harness 的 ② 级行为）。
//
// ── 规则正文是**第三方内容**，只许切分与拼接 ──
//
// 规则来自 `assets/moss-image-prompt-skill/SKILL.md`（CC BY-NC-ND 4.0，**禁止演绎**），
// 逐字节收录。本文件对它做的全部事情就是：**按 `## ` 边界切成整节**、**原样拼回去**。
// 不摘要、不改写、不重排、不删改正文 —— 切片的边界落在节与节之间，所以
// `选中节.map(s => s.text).join('')` 逐字节等于原文里那几段。
// 出处、版本与许可边界见 `assets/moss-image-prompt-skill/NOTICE.md`。
//
// 我们自己的文本（覆盖前言、两段的任务说明）都在 `core/prompt-catalog.ts` 的 `imageCompile`
// 里 —— 模型可见的固定指令只有一个落点，而这里只负责**拼装**。
//
// ── 为什么单独一个文件，且不 import `llm/` ──
//
// `llm` 与 `media` 同属 T1、严格互斥（`check-layers.mjs` 的 `T1_ALLOW` 是空集），所以
// "真的去调模型"只能由宿主注入一个**最小端口**（`ImagePromptAskPort`），与跑团的 `AskPort`
// 同形（`extra/trpg/scenario/extract/prompt.ts`）。**端口只交回原始字符串** —— 解析归这里。
//
// ── 产出是一段 Layout JSON（规则 §15）──
//
// 正面提示词按规则 §15 的 **Layout JSON schema** 输出，直接作为 `prompt` 发给画图模型。
// 于是 §15 **恒定入选**（`LAYOUT_JSON_SECTION_ID`）：让模型按一份它没看过的 schema 写，
// 等于让它编字段。解析只做两件事 —— 剥掉 ``` 围栏、认一下它是不是能 `JSON.parse` 的对象
// （`layout` 那一格只进日志）。**解不出来不失败**：回退原始描述（fail-open）。
//
// ── fail-open（这条是刻意的，别改成 fail-closed）──
//
// 编译是**增强**：原始描述就是没有这一层时的行为。所以任何失败（规则文件读不到 / 端口抛错 /
// 格式不对 / 正面为空）都**不**让任务失败，而是回退原始描述 + 记一行固定码的日志。
// 判据是"**额度已经扣了**"：一次可选增强的失败，不该把一整张已经计过费的图搞失败。
// **非静默**是底线 —— 那行码是管理员唯一能发现"编译一直在失败"的地方（同 `NO_DELIVER_SINK`）。
import fs from 'node:fs';
import { PROMPT_CATALOG } from '../../core/prompt-catalog.js';
import { PROMPT_SKILL_FILE } from '../../core/paths.js';
import { safeErrorDetail } from './errors.js';
// 端口与产物两个类型住在 `types.ts`：那个文件是**全模块的公共依赖**（它自己不 import 本模块
// 任何文件，否则成环），而 `InternalJob.compiled` 与 `QueueDeps.compilePrompt` 都要用它们。
import type { CompiledPrompt, ImagePromptAskOutcome, ImagePromptAskPort } from './types.js';

/**
 * 编译失败的档位。
 *
 * ⚠️ **只进日志，不进群里的话** —— 出图会照常继续（fail-open），所以这不是任务失败，
 * 也就没有对应的 `FailureStage`。每个码各自指向一个不同的下一步：
 * `NO_SKILL` 看规则文件在不在、`REQUEST` 看网络与接口、`FORMAT`/`EMPTY` 看模型有没有照格式答。
 */
export type CompileFailureCode = 'NO_SKILL' | 'REQUEST' | 'FORMAT' | 'EMPTY';

export type CompileFailure = { ok: false; code: CompileFailureCode; detail?: string };

/** `parseCompiledPrompt` 的返回 —— 只解析内容，不知道"挑了几节"（那是调用方的事）。 */
export type CompileOutcome = { ok: true; value: CompiledPrompt; layout: boolean } | CompileFailure;

/**
 * `compileImagePrompt` 成功时的返回值。
 *
 * 四个字段都**只给日志用**，不进任何模型可见的文本。它们是"skill 到底有没有注入进去"
 * 这件事唯一能看见的地方（出图照常成功，所以从结果上看不出区别）：
 * - `picked`   —— 挑中了几节（`'7/19'`）。总是 19/19 就说明两段式白跑了、成本与全文一样；
 * - `sections` —— 挑中的节号（`'5,17'`）；全部选中时是 `'all'`；
 * - `skillChars` —— 实际注入的**规则原文**字符数。**这一格才是"注入成功"的直接证据**：
 *   `select: false` 时它应该恰好等于 `SKILL.md` 的**字符**数 51455，小于它就是没贴全。
 * - `layout` —— 正面提示词**是不是一段能 `JSON.parse` 的对象**（我们要求的就是 §15 的
 *   Layout JSON）。它是 `false` 时出图照常进行，但画的是一段散文 —— 而"模型没照 schema
 *   写"这件事在结果图上看不出来，只能靠这一格。
 */
export type CompileSuccess = {
  ok: true;
  value: CompiledPrompt;
  picked: string;
  sections: string;
  skillChars: number;
  layout: boolean;
};

/**
 * 分段标记。
 *
 * 用这种形状而不是 JSON：**提示词里本来就全是引号、冒号、逗号**，JSON 转义是一个额外的坑，
 * 而本仓库明令禁止"猜测式的 JSON 修复"（猜错会把被改动过的文本真的发到群里）。
 * 标记取成不可能出现在画面描述里的形状，于是解析是一次 `indexOf`，没有歧义。
 */
export const PROMPT_MARK = '<<<PROMPT>>>';
export const NEGATIVE_MARK = '<<<NEGATIVE>>>';

/** 前言那一节的 id。它**恒定入选**，不进目录、也不由模型挑。 */
export const PREAMBLE_ID = 'preamble';

/**
 * Layout JSON schema 那一节的 id。它**同样恒定入选**，理由与前言不同：
 *
 * 编译的产出就是 §15 的 Layout JSON，而**模型没看过那份 schema 就只能编字段**。让它"自己
 * 从目录里挑 §15"是不行的 —— 挑漏了不会有任何报错，只会得到一段长得像 JSON 的臆造。
 * 所以这一条是**代码层的保证**，不是提示词里的请求（同前言的"恒定入选"）。
 */
export const LAYOUT_JSON_SECTION_ID = '15';

/**
 * 画布尺寸的回退值。
 *
 * 只有一件事要用它：§15 的 `bbox` 是**绝对像素**坐标（画布中心为原点），模型必须知道画布
 * 多大才算得出来。`imageGen.size` 留空（= auto，由接口按内容决定）时我们**不知道**真实
 * 尺寸，只能给一个常见档位 —— 比让模型自己发明一套坐标强，而 §15.4 明说编译产物里不写
 * 画布尺寸字段、尺寸在生成参数里另设，所以这个数只影响坐标的绝对值。
 */
export const DEFAULT_CANVAS = { w: 1024, h: 1024 } as const;

/**
 * 从归一化后的画幅串（`1024*1024`，见 `config.ts` 的 `normalizeSize`）取画布尺寸。
 * 认不出来（空串 = auto）就回退 `DEFAULT_CANVAS`，并如实标出"这是回退值"。
 */
export function canvasOf(size: unknown): { w: number; h: number; assumed: boolean } {
  const match = /^(\d{1,4})\*(\d{1,4})$/.exec(String(size ?? '').trim());
  if (!match) return { ...DEFAULT_CANVAS, assumed: true };
  return { w: Number(match[1]), h: Number(match[2]), assumed: false };
}

/** 规则集里的一节。`text` 是**逐字原文**（见文件头）。 */
export interface SkillSection {
  /** 节号（`'0'`…`'17'`、`'9.1'`），或 `'preamble'`。 */
  id: string;
  /** 节标题行，**逐字**（`## 5. Step 3 结构布局分流（分块 vs 极简）`）。 */
  heading: string;
  /** 这一节的**原文**（含标题行）。运行期只切分与拼接，绝不改写。 */
  text: string;
}

/**
 * 读规则文件。**本文件里唯一的 I/O**，其余全是纯函数。
 *
 * 读不到 / 读成空 → `null`，调用方按 `NO_SKILL` 降级（fail-open）。
 * 不做缓存：它是打包进来的不可变资产，一次 `readFileSync` 的代价远小于引入一套
 * "什么时候该失效"的缓存状态。
 */
export function readSkillText(): string | null {
  try {
    const text = fs.readFileSync(PROMPT_SKILL_FILE, 'utf8');
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/**
 * 按 `## ` 边界把规则集切成整节。**纯函数**。
 *
 * 三条边界：
 * - **只切 `## `，不切 `### `**（`/^## (?!#)/`）—— `### 2.1` 那一层是节内的子标题，
 *   跟着父节走。⚠️ 原文里 `## 9.1 日系写真集…` 确实是 **`##` 层**（作者把 9.1 写在了与 9
 *   同级的位置），所以它是一节独立的节、有自己的节号。
 * - **切片按原文字符下标**，不按行重组 —— 于是 `选中节.map(s => s.text).join('')`
 *   逐字节等于原文里那几段，节与节之间的空行也跟着各自的前一节走。
 * - **前言（第一个 `##` 之前的一切：frontmatter + 标题 + 总闸）自成 `preamble` 节**。
 *   它是全文优先级最高的那一段，恒定入选。
 */
export function splitSkillSections(text: unknown): SkillSection[] {
  const body = String(text ?? '');
  if (!body.trim()) return [];
  const starts: number[] = [];
  for (const match of body.matchAll(/^## (?!#)/gm)) starts.push(match.index as number);
  // 一个 `## ` 都没有：整份当前言，照样能用（不至于因为"格式不像预期"就整条失效）。
  if (!starts.length) return [{ id: PREAMBLE_ID, heading: '', text: body }];

  const sections: SkillSection[] = [];
  const preamble = body.slice(0, starts[0]);
  if (preamble.trim()) sections.push({ id: PREAMBLE_ID, heading: '', text: preamble });

  for (let i = 0; i < starts.length; i++) {
    const raw = body.slice(starts[i], starts[i + 1] ?? body.length);
    const heading = (raw.split('\n', 1)[0] || '').replace(/\r$/, '');
    const num = /^##\s+(\d+(?:\.\d+)?)/.exec(heading);
    // 认不出节号也**照样收下**（用 `s<n>` 兜底）—— 宁可目录里出现一个怪名字，
    // 也不要静默丢掉一整节规则。
    sections.push({ id: num ? num[1] : `s${i}`, heading, text: raw });
  }
  return sections;
}

/**
 * 目录：**逐字的节标题**，一行一节。
 *
 * ⚠️ **不写我们自己的摘要**。给节写一句"这节讲什么"会随上游改版立刻过期，而这份文件是
 * 整份替换着更新的（见 NOTICE）；标题本身就是文档自己的目录，够模型判断了。
 * 前言不进目录（它恒定入选，模型不需要知道它存在）。
 */
export function buildSkillToc(sections: SkillSection[]): string {
  return sections.filter((s) => s.id !== PREAMBLE_ID).map((s) => s.heading).join('\n');
}

/**
 * 解析第 1 段的回答。**纯函数**。
 *
 * **认不出来就返回全部** —— 这是刻意的 fail-open 方向：漏选一节的代价是画错，
 * 多选一节的代价只是几百 token。空回答、`all`、或者一串解释文字，都会走到这一档。
 */
export function parseSectionSelection(text: unknown, sections: SkillSection[]): SkillSection[] {
  const all = sections.filter((s) => s.id !== PREAMBLE_ID);
  const body = String(text ?? '').trim().toLowerCase();
  if (!body) return all;
  if (/\ball\b/.test(body) || /全部|都要|所有/.test(body)) return all;
  const wanted = new Set(body.match(/\d+(?:\.\d+)?/g) || []);
  const picked = all.filter((s) => wanted.has(s.id));
  return picked.length ? picked : all;
}

export interface CompileInput {
  /** 模型 / `/画` 给的原始画面描述。 */
  raw: string;
  /** 图生图（有参考图）。影响提示词里那句"只写要改的地方"。 */
  hasReference: boolean;
  /** 归一化后的画幅（空串 = 自动）。它同时决定 `bbox` 用的画布尺寸，见 `canvasOf`。 */
  size: string;
  /** 当前模型认不认 `negative_prompt`。不认就别让模型白写那一串。 */
  wantsNegative: boolean;
  /** 两段式开关（`imageGen.compile.select`）。`false` = 跳过选节、一次调用上全文。 */
  select: boolean;
}

/** 两段调用共用的 user 段。 */
export function buildUserText(input: Pick<CompileInput, 'raw' | 'hasReference' | 'size'>): string {
  const canvas = canvasOf(input.size);
  return PROMPT_CATALOG.imageCompile.user({
    raw: input.raw, hasReference: input.hasReference, size: input.size,
    canvasW: canvas.w, canvasH: canvas.h, canvasAssumed: canvas.assumed
  });
}

/**
 * 覆盖前言拼在最前面，两段共用。
 *
 * 顺序是刻意的：它是**稳定前缀**（不随画面变化），前缀缓存的命中全靠它 ——
 * 别把它挪到后面，也别把随画面变化的东西插到它前面。
 */
const withOverlay = (rest: string) => `${PROMPT_CATALOG.imageCompile.overlay}\n\n${rest}`;

/** 第 1 段（选节）的请求。 */
export function buildSelectRequest(
  input: Pick<CompileInput, 'raw' | 'hasReference' | 'size'>, toc: string
): { system: string; user: string } {
  return {
    system: withOverlay(PROMPT_CATALOG.imageCompile.selectSystem({ toc })),
    user: buildUserText(input)
  };
}

/**
 * 第 2 段（编译）的请求。`body` 是选中的节**逐字**拼起来的原文。
 *
 * 拼装顺序也照顾前缀缓存：覆盖前言 → 任务说明（稳定）→ 规则原文（前言那一节恒定在首位，
 * 于是"覆盖前言 + 任务说明 + 前言节"是跨调用稳定的前缀）→ 输出格式（放最后，贴近生成位置）。
 */
export function buildCompileRequest(input: CompileInput, body: string): { system: string; user: string } {
  return {
    system: withOverlay(PROMPT_CATALOG.imageCompile.compileSystem({
      body, wantsNegative: input.wantsNegative
    })),
    user: buildUserText(input)
  };
}

/**
 * 把模型回的正面提示词整理成"能直接发给画图模型的那段文本"，并回报它是不是一段合法 JSON。
 *
 * 三种形态都要收：裸 JSON、被 ``` 围栏包住的 JSON（模型最常见的写法）、以及前后夹了几句
 * 说明的 JSON。⚠️ 这**不是**本仓库禁止的那种"猜测式 JSON 修复"（那里猜错会把被改动过的
 * 文本真的发出去）—— 这里每一档候选都**必须先过 `JSON.parse`** 才会被采用，解不出来就
 * 原样退回文本，不会把半截 JSON 当结果。
 */
function readLayoutJson(text: string): { text: string; layout: boolean } {
  const fenced = /^```[A-Za-z]*\s*\n([\s\S]*?)\n?```$/.exec(text.trim());
  const bare = (fenced ? fenced[1] : text).trim();
  const first = bare.indexOf('{');
  const last = bare.lastIndexOf('}');
  const sliced = first >= 0 && last > first ? bare.slice(first, last + 1) : '';
  for (const candidate of [bare, sliced]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { text: candidate, layout: true };
      }
    } catch {
      // 解不出来就试下一档；全都不成才退回文本。
    }
  }
  return { text: bare, layout: false };
}

/**
 * 解析编译结果。**纯函数**。
 *
 * 两条判据：
 * - 缺 `<<<PROMPT>>>` / 正面为空 → **整条作废**（没有正面提示词，这一趟等于什么都没做）；
 * - 其余一律**收下**。⚠️ **代码层没有字数上限**：合适的长度与结构是规则集的事（§15 的
 *   Layout JSON 有自己的字段与取值域），"写得比我们预期的长"就把整条编译结果扔掉是本末倒置
 *   —— 判据是"额度已经扣了"，一次可选增强不该白跑。正面**是不是**一段能解析的 Layout JSON
 *   由 `layout` 报出去（**只进日志**）：出图照常进行，但"模型没照 schema 写"这件事在结果图
 *   上看不出来，只能靠这一格。
 */
export function parseCompiledPrompt(text: unknown): CompileOutcome {
  const body = String(text ?? '');
  const start = body.indexOf(PROMPT_MARK);
  if (start < 0) return { ok: false, code: 'FORMAT' };

  const rest = body.slice(start + PROMPT_MARK.length);
  const split = rest.indexOf(NEGATIVE_MARK);
  const positive = (split < 0 ? rest : rest.slice(0, split)).trim();
  // 缺 `<<<NEGATIVE>>>` 是**宽容**的：2.1 那一档本来就不产负面词，模型照要求留空
  // 与压根不写这个标记，对我们是一回事。
  const negative = split < 0 ? '' : rest.slice(split + NEGATIVE_MARK.length).trim();

  if (!positive) return { ok: false, code: 'EMPTY' };
  const layout = readLayoutJson(positive);
  return { ok: true, value: { positive: layout.text, negative }, layout: layout.layout };
}

/** 调一次端口，把两种失败形状（抛错 / 回 `ok:false`）归一成同一种。 */
async function askOnce(
  request: { system: string; user: string }, ask: ImagePromptAskPort, signal: AbortSignal
): Promise<{ ok: true; content: string } | { ok: false; detail: string }> {
  let outcome: ImagePromptAskOutcome;
  try {
    outcome = await ask(request, signal);
  } catch (error) {
    // 细节先洗过（去 URL 与本机路径）—— 日志里不许出现这两样，与 `#fail` 那条同一条规矩。
    return { ok: false, detail: safeErrorDetail(error) };
  }
  if (!outcome || outcome.ok !== true) {
    const raw = outcome && !outcome.ok ? outcome.message : '';
    return { ok: false, detail: raw ? safeErrorDetail(raw) : '' };
  }
  return { ok: true, content: outcome.content };
}

/**
 * 编译一次。
 *
 * **超时不在这里**：死线归调用方（队列那边的 `signal`），本文件只把收进来的 `signal` 转交 ——
 * 与跑团抽取管线那条分工一致。**两次调用共用同一条死线**（`select` 那一次也吃它），
 * 所以两段加起来不超过 `imageGen.compile.timeoutMs`。
 *
 * 这一层**不往外抛**：调用方只认 `ok`，于是"编译失败"永远走不到任务失败那条路上（fail-open）。
 */
export async function compileImagePrompt(
  input: CompileInput, ask: ImagePromptAskPort, signal: AbortSignal,
  /**
   * 读规则文件的方式。**留这个参数只为一件事**：让"文件读不到"这条退路能被测到 ——
   * 否则要验它就只能在用例里临时挪走仓库中的真文件，那是一次崩溃就毁掉工作区的做法。
   * 缺省是 `readSkillText`，生产路径永远走缺省。
   */
  readSkill: () => string | null = readSkillText
): Promise<CompileSuccess | CompileFailure> {
  const skillText = readSkill();
  if (!skillText) return { ok: false, code: 'NO_SKILL' };
  const sections = splitSkillSections(skillText);
  if (!sections.length) return { ok: false, code: 'NO_SKILL' };

  const numbered = sections.filter((s) => s.id !== PREAMBLE_ID);
  let picked = numbered;
  if (input.select) {
    const selection = await askOnce(buildSelectRequest(input, buildSkillToc(sections)), ask, signal);
    if (!selection.ok) return { ok: false, code: 'REQUEST', detail: selection.detail };
    picked = parseSectionSelection(selection.content, sections);
  }

  // §15（Layout JSON schema）**恒定入选**：编译的产出就是按它写的 JSON，模型没看过 schema
  // 只能编字段。它因此不在目录里（模型不必知道它存在），也不受"模型有没有挑中它"影响。
  const injected = numbered.filter((s) => s.id === LAYOUT_JSON_SECTION_ID || picked.includes(s));

  // ⚠️ **逐字拼装**：前言恒定在首位（它就是原文的第一段），选中的节按原顺序接上，
  // 分隔符是空串 —— 于是这一串与原文里那几段**逐字节相同**。别改成 `join('\n\n')`：
  // 那会在节与节之间插入原文里没有的东西，就不再是"原样引用"了。
  const keep = new Set([PREAMBLE_ID, ...injected.map((s) => s.id)]);
  const body = sections.filter((s) => keep.has(s.id)).map((s) => s.text).join('');

  const answer = await askOnce(buildCompileRequest(input, body), ask, signal);
  if (!answer.ok) return { ok: false, code: 'REQUEST', detail: answer.detail };
  const parsed = parseCompiledPrompt(answer.content);
  if (!parsed.ok) return parsed;
  // 四格都进日志：`picked` 看两段式有没有白跑、`sections` 看它挑了谁（**含恒定入选的 §15**）、
  // `skillChars` 看规则原文到底注入了多少（**`select: false` 时它应恰好等于 SKILL.md 的长度**）、
  // `layout` 看模型有没有照 §15 的 schema 写（**只进日志**，出图照常）。
  return {
    ...parsed,
    picked: `${injected.length}/${numbered.length}`,
    sections: injected.length === numbered.length ? 'all' : injected.map((s) => s.id).join(','),
    skillChars: body.length
  };
}
