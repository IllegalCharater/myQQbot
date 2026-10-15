// 参考扩展 `clock` 的**实现**（懒加载的那一半）。
//
// 它被那条 `/能力 加载 clock` 命令（或群友直接敲 `/时间`）拉起来后才被 `import()`，
// 空闲到点后由 `dispose()` 放掉自己持有的东西。这里刻意把"重资源"做得很小但**真实**：
// 一份 `Intl.DateTimeFormat` 实例缓存 —— 它是这个扩展唯一的长期持有物，
// `dispose()` 清掉它，于是"卸载真的释放了东西"这件事在测试里可观察
// （真扩展的重资源会是子进程 / socket / 大缓存，形状一样）。
//
// ⚠️ `dispose()` 之后本对象就作废了：运行时会把引用从它的装载表里删掉，下次装载重新
// `createRuntime()` 一个**新的**。所以这里不需要"复活"逻辑，只需要保证 `dispose()` 幂等。
//
// ⚠️ `handlers` / `commandHandlers` 的键必须与 `spec.ts` 里的名字**逐个对上**（两个方向都查）：
// 少了 = 调得到却执行不了；多了 = 死代码。装载时会校验，对不上直接拒绝装载。
import { EXTRA_PROMPT_SECTIONS } from '../prompts.js';
import type { ExtraRuntime } from '../types.js';

/** 不填 `timeZone` 时用的时区。写死是刻意的：群聊的默认语境就是这里。 */
const DEFAULT_ZONE = 'Asia/Shanghai';

/** 时区名的长度上限。只为挡住畸形输入 —— `Intl` 自己会拒绝不认识的名字。 */
const MAX_ZONE_CHARS = 64;

export function createRuntime(): ExtraRuntime {
  // ── 重资源：时区 → 格式化器 ──
  // 建它有点贵（`Intl` 初始化要读 ICU 数据），而一次会话里同一时区会被反复问，
  // 所以缓存起来。这就是本扩展"值得被空闲卸载"的全部理由。
  const formatters = new Map<string, Intl.DateTimeFormat>();
  let disposed = false;

  /** 算出"某时区现在几点"。工具与命令共用这一份 —— 两处各写一遍必然有一处先漂。 */
  const nowIn = (raw: unknown): string => {
    const wanted = String(raw ?? '').trim();
    if (wanted.length > MAX_ZONE_CHARS) return `错误：时区名太长（最多 ${MAX_ZONE_CHARS} 个字符）`;
    const zone = wanted || DEFAULT_ZONE;
    let formatter = formatters.get(zone);
    if (!formatter) {
      try {
        // 不认识的时区会在这里抛 RangeError —— 转成给模型/群友看的可读错误。
        formatter = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, dateStyle: 'full', timeStyle: 'short' });
      } catch {
        return `错误：不认识的时区「${wanted}」。请用 IANA 名称，例如 Asia/Shanghai、UTC、America/New_York、Europe/London。`;
      }
      formatters.set(zone, formatter);
    }
    return `${zone} 现在是 ${formatter.format(new Date())}`;
  };

  /** 卸载之后还被调用时的自保：如实报，不要返回一个可能已经算错的时间。 */
  const disposedGuard = (): string | null => (disposed ? '错误：时间工具已被卸载，请重新加载' : null);

  return {
    handlers: {
      async get_current_time(_ctx, args) {
        const gone = disposedGuard();
        if (gone) return { content: gone, isError: true };
        const text = nowIn(args?.timeZone);
        return text.startsWith('错误：') ? { content: text, isError: true } : { content: text };
      }
    },
    commandHandlers: {
      // 键与 `spec.commands[].name` 逐字相同 —— 那个名字就是命令词本身。
      // 返回的是**回执文本**，由 `web/onebot/slash-commands.ts` 的 `runCommand` 发进群
      // （回执的发送与失败话术全在那一处，扩展不碰 sender）。
      async '/时间'(input) {
        const gone = disposedGuard();
        if (gone) throw new Error(gone);
        // 去掉命令词本身，剩下的就是时区参数（没写就用默认时区）。
        return nowIn(input.text.replace(/^\/时间/u, '').trim());
      }
    },
    /**
     * 往 system prompt 追加一段 —— **只在本扩展装载后才生效**（"随装载状态变化"那条取舍）。
     * 文案取自 `extra/prompts.ts`（模型可见的固定指令的唯一落点），这里只负责"什么时候给"。
     *
     * ⚠️ 收下 `chatKey` 但**不用它**：clock 的贡献与是哪个群无关。要按会话渲染的扩展（跑团那种）
     * 才需要它 —— 见 `ExtraRuntime.prompt` 的说明。
     */
    prompt(_chatKey) {
      return { append: [...EXTRA_PROMPT_SECTIONS.clock.append] };
    },
    dispose() {
      // 幂等：运行时可能因为 stop() / `/能力 卸载` / 空闲到点几条路各调一次。
      formatters.clear();
      disposed = true;
    }
  };
}
