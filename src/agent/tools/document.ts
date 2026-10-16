// `read_document` —— 把一份文件的正文读给模型看（pdf / docx / txt / md）。
//
// ── 两个入口，一条路 ──
//
// `messageId`（群里的文件）与 `url`（网页直链）**二选一**，拿到一个地址之后走的是同一条
// 路：`safeFetchBinary` 取字节 → `extractDocumentText` 抽文本。合成一个工具而不是两个，
// 判据与跑团那次合并七个工具是同一条：**工具 schema 是每次请求前缀的一部分**，
// 每多一个工具就多一段每轮都要重发的文本；而这两个入口的机械部分一模一样。
//
// 代价也是同一条，如实记在这里：`required` 不能按入口分支，所以"两个都没给""两个都给了"
// 只能靠执行体里那两句中文报错兜住（schema 里 `required` 是空的）。
//
// ── 为什么走 webSearch 那本额度 ──
//
// 它一定发一次外部请求（下载），而且每次还要起一个 Python 子进程 —— 比 `web_fetch` 更重。
// 分开记一本账会让"模型卡在这条路上反复重试"没有任何闸门拦住。口径同「联网调用阀门」那条。
import { TOOL_PROMPT_TEXT } from '../../core/prompt-catalog.js';
import { safeFetchBinary } from '../../media/safe-fetch.js';
import {
  FORMAT_LABEL, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_CHARS, extractDocumentText
} from '../../media/document/index.js';
import { err, errorMessage, isRecord, midHint, ok, takeWebBudget } from './shared.js';
import type { ChatMessage } from '../../chat/types.js';
import type { ToolDefinition } from '../shared/types.js';
import type { DocumentText } from '../../media/document/index.js';

/**
 * 下载超时。**这是同步工具调用**（模型在等），所以不能像后台队列那样给到分钟级；
 * 但 32MB 的文件在慢链路上也确实要一会儿，60 秒是个"够用且不至于挂死"的数。
 */
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** 结果表头：`消息 #123 里的文件《灯塔.pdf》（PDF，12 页，共 18342 字）`。 */
function render(source: string, doc: DocumentText): string {
  const bits = [FORMAT_LABEL[doc.format]];
  if (doc.pages !== undefined) bits.push(`${doc.pages} 页`);
  bits.push(`共 ${doc.chars} 字`);
  // 非 UTF-8 的编码要**说出来**：它是"我们替你猜了一档"，不是文件自报的。
  // 不说的话，一份 GBK 文件解出来通顺但个别字不对时，没有任何线索指向"是编码的问题"。
  if (doc.encoding && doc.encoding !== 'utf-8') bits.push(`按 ${doc.encoding} 解码`);

  const tail = doc.truncated
    ? `\n\n——（正文共 ${doc.chars} 字，以上只是开头 ${doc.text.length} 字）`
    : '';
  return `${source}（${bits.join('，')}）\n——————\n${doc.text}${tail}`;
}

export interface DocumentToolDeps {
  /**
   * 抽取实现。**只给套件用**（生产路径不传，`buildToolDefs()` 就是无参调的）。
   *
   * 为什么需要这个口子：工具的正常路径会起一个 Python 子进程，而仓库的测试约定是
   * **不许启动真解释器** —— 那会让"这台机器装没装 Python"决定套件的红绿，而"套件绿"
   * 从此不再意味着代码对。媒体层自己有一个 `spawn` 注入点，但它在工具的**下一层**，
   * 这里够不着；所以同一个手法（可选参数 + 真实现作默认值）再开一层。
   */
  extract?: typeof extractDocumentText;
}

export function documentTools(deps: DocumentToolDeps = {}): ToolDefinition[] {
  const extract = deps.extract ?? extractDocumentText;
  return [
    {
      name: 'read_document',
      description: TOOL_PROMPT_TEXT.read_document.description,
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: TOOL_PROMPT_TEXT.read_document.messageId },
          url: { type: 'string', description: TOOL_PROMPT_TEXT.read_document.url }
        },
        // 两个入口二选一，所以这里**不能**写 required（写了就变成"两个都必须给"）。
        required: []
      },
      async execute(ctx, args) {
        const limited = takeWebBudget(ctx.chatKey);
        if (limited) return err(limited);

        const mid = String(args.messageId ?? '').trim();
        const url = String(args.url ?? '').trim();
        if (!mid && !url) return err('要给 messageId（消息里的文件）或 url（文件直链）其中一个');
        if (mid && url) return err('messageId 与 url 只能给一个：要么读群里的文件，要么读一个直链');

        let target: string;
        let source: string;
        if (url) {
          target = url;
          source = url;
        } else {
          // 本轮快照优先，取不到再回落到实时存档 —— 与 `get_message_images` 同一条纪律：
          // 模型作出工具决定前可能已经过了很久，实时存档可能因容量裁剪/删除而失去这条消息。
          const findEntry = (value: unknown): ChatMessage | null =>
            (ctx.triggerEntries || []).find((message) => String(message.mid) === String(value))
            ?? ctx.store.findByMid(ctx.chatKey, value);
          const fileOf = (message: ChatMessage | null) =>
            (message?.media || []).find((item) => item.kind === 'file' && item.url) ?? null;

          const entry = findEntry(mid);
          if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);

          // 没有文件但引用了别条 → 顺着 `reply.mid` 去取那条的文件。
          // **这不是猜**：`reply.mid` 是入站时就记死的关联。典型场景正是跑团那条路 ——
          // 群友把剧本发上来、再引用它说一句话，模型手里那条（引用的）消息上没有文件。
          let holder = entry;
          let file = fileOf(entry);
          let viaReply = false;
          const quotedMid = String(isRecord(entry.reply) ? (entry.reply.mid ?? '') : '');
          if (!file && quotedMid) {
            const quoted = findEntry(quotedMid);
            const quotedFile = fileOf(quoted);
            if (quoted && quotedFile) { holder = quoted; file = quotedFile; viaReply = true; }
          }
          if (!file) {
            return ok(`消息 ${args.messageId} 里没有可读的文件`
              + `${quotedMid ? `（它引用的 #${quotedMid} 里也没有）` : ''}`
              + ' —— 让群友把文件直接发到群里，或者给一个 http(s) 直链。');
          }

          target = String(file.url);
          // 是谁的那条要说清楚：走回退时不说的话，模型会把"这份文件来自哪条消息"配错，
          // 与 `get_message_images` 那条"点名是谁发的"是同一个病。
          const name = String(file.name ?? file.file ?? '').trim();
          source = `${viaReply ? `消息 #${quotedMid}` : `消息 ${holder.mid}`}里的文件${name ? `《${name}》` : ''}`;
        }

        try {
          const { buffer } = await safeFetchBinary(target, MAX_DOCUMENT_BYTES, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS));
          const doc = await extract(buffer, { maxChars: MAX_DOCUMENT_CHARS });
          return ok(render(source, doc));
        } catch (error) {
          // 失败原因**原样回给模型**（`DocumentError` 的文案本来就是中文且带下一步，
          // 而"没装 pypdf"与"这份文件读不了"是两件事，压成一句会让用户反复重传）。
          return err(errorMessage(error));
        }
      }
    }
  ];
}
