// 跑团工作台（剧本与规则表）的 HTTP 表面：**只读列表 + 删除**。
//
// ── 为什么这里能直接 new 两个 store ──
//
// `ScenarioStore` / `RuleStore` 是**目录的薄视图**（除了一个按 mtime 的解析缓存之外没有任何状态），
// 所以面板这一侧自己 new 一个读的就是同一批文件。另一个做法是把它们从扩展运行时里透出来 ——
// 那要给 `ExtrasRuntime` 加一个"取某个扩展的内部对象"的口子，而那种口子一旦开了，
// 每个扩展都会想往里塞东西。这两个 store 共享的只有缓存，各持一份没有语义差别。
//
// ── 不做的事（用户明确划的界）──
//
// **不能在这里编辑、也不能在这里上传**：剧本与规则表的写入路径只有两条 ——
// 群里的命令（`/跑团 开局` / 存剧本），以及管理员直接编辑数据目录里的文件。
// 面板只负责"看得见有哪些、删得掉不要的"。
import { RuleStore } from '../../extra/trpg/rule-store.js';
import { ScenarioStore } from '../../extra/trpg/scenario.js';
import { errorMessage } from '../http/http.js';
import type { Route } from '../types.js';

/**
 * 路径里那一小段 → id。
 *
 * ⚠️ 必须 `decodeURIComponent` 之后再交给 store 的 `safeFileName`：路由正则里的 `[^/]+` 是在
 * **解码之前**匹配的，所以 `%2F` 会作为普通字符被捕获、解码后变成 `/` —— 不经过 `safeFileName`
 * 就是一个目录穿越。`safeFileName` 把分隔符与 `..` 都清掉，于是 `id` 永远落在数据目录里。
 */
function idFrom(match: RegExpMatchArray | null): string {
  try {
    return decodeURIComponent(match?.[1] ?? '');
  } catch {
    return '';
  }
}

export const trpgRoutes: Route[] = [
  {
    // 设置页「跑团」那一栏的全部数据。**列表来自磁盘**（两个 store 都扫目录）——
    // 列出来的，一定是磁盘上真的有的。
    method: 'GET', path: '/api/trpg/workshop', async handle() {
      const rules = new RuleStore();
      const scenarios = new ScenarioStore();
      return {
        status: 200,
        body: { ok: true, scenarios: scenarios.list(), rules: rules.list() }
      };
    }
  },
  {
    // 删一份剧本。**不备份** —— 与"删除会话记录"同一条取舍（那是过程数据、删除意图明确），
    // 与"删存档前留备份"不同。前端会先 confirm，文案里说清删的是哪个。
    method: 'DELETE', path: /^\/api\/trpg\/scenarios\/([^/]+)$/, async handle(_ctx, _req, match) {
      const id = idFrom(match);
      if (!id) return { status: 400, body: { ok: false, error: '剧本名不能是空的' } };
      try {
        const removed = new ScenarioStore().remove(id);
        return removed
          ? { status: 200, body: { ok: true, id } }
          : { status: 404, body: { ok: false, error: `没有叫「${id}」的剧本` } };
      } catch (error) {
        return { status: 500, body: { ok: false, error: errorMessage(error) } };
      }
    }
  },
  {
    // 删一张规则表。**内置的也允许删**（它就是文件），但列表里标着 builtin ——
    // 删了之后那个会话的检定会报"规则表不存在"并回落 generic，这是可接受的结果，只要**看得见**。
    method: 'DELETE', path: /^\/api\/trpg\/rules\/([^/]+)$/, async handle(_ctx, _req, match) {
      const id = idFrom(match);
      if (!id) return { status: 400, body: { ok: false, error: '规则表 id 不能是空的' } };
      try {
        const removed = new RuleStore().remove(id);
        return removed
          ? { status: 200, body: { ok: true, id } }
          : { status: 404, body: { ok: false, error: `没有叫「${id}」的规则表` } };
      } catch (error) {
        return { status: 500, body: { ok: false, error: errorMessage(error) } };
      }
    }
  }
];
