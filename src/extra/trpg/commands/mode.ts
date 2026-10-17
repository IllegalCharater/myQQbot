// `.trpg mode [助手|DM]` —— 看 / 切换这个群的形态（从 `impl.ts` 拆出，2026-10-16）。
//
// 切模式**不动战役存档**：切回 DM 时那一局还在原地等着（助手模式下它只是不被注入）。
import { MODE_LABEL, parseMode } from '../model/mode.js';
import { argsOf } from './shared.js';
import type { CommandHandler } from './shared.js';
import type { TrpgModeStore } from '../store/mode-store.js';
import type { TrpgStore } from '../store/campaign-store.js';

export interface ModeCommandDeps {
  store: TrpgStore;
  modes: TrpgModeStore;
  /** 这条命令的词（`'.trpg mode'`）—— 由 `commands/index.ts` 递进来，见 `argsOf`。 */
  command: string;
}

export function createModeCommand({ store, modes, command }: ModeCommandDeps): CommandHandler {
  return async (input) => {
    const mode = modes.read(input.chatKey);
    const wanted = argsOf(input, command)[0];
    if (!wanted) {
      return `当前：${MODE_LABEL[mode]}\n`
        + '· `.trpg mode 助手` —— 只掷骰\n'
        + '· `.trpg mode DM` —— 跑团，我当主持人';
    }
    const next = parseMode(wanted);
    if (!next) return `不认识的模式「${wanted}」。可用的是：助手（骰子）、DM（跑团）。`;
    if (next === mode) return `已经是${MODE_LABEL[mode]}了。`;
    modes.write(input.chatKey, next);
    const kept = next === 'assistant' && store.read(input.chatKey) ? '这一局的存档留着，切回 DM 就接着跑。' : '';
    return `已切到${MODE_LABEL[next]}，下一轮运行生效。${kept}`;
  };
}
