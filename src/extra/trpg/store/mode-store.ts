// 运行模式的**落盘**（从 `mode.ts` 拆出，2026-10-16）。
//
// `data/trpg/modes.json` 一个文件装全部会话，形状与 `extras.override` 那套一样
// （键是 `group:<群号>` / `private:<QQ号>`，值是模式名）。**只有非缺省的模式才写进去** ——
// 缺省是 `dm`，所以一份没切过模式的配置里这个文件可以压根不存在。
//
// ⚠️ 与 `TrpgStore` 一样**不做内存缓存**：每次现读这个小文件。它是被 `toolsFor` / `prompt`
// 在**每一轮运行开头**读的，文件只有几百字节；而缓存的代价是"手改了文件不生效"这类
// 只有下次重启才发现的问题（`ScenarioStore` 用 mtime 缓存是为了懒补齐的种子文件，不是这条）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../core/paths.js';
import { DEFAULT_MODE, isChatKey, isMode, normalizeModes } from '../model/mode.js';
import type { TrpgMode } from '../model/mode.js';

export class TrpgModeStore {
  readonly file: string;

  constructor(file: string = path.join(DATA_DIR, 'trpg', 'modes.json')) {
    this.file = file;
  }

  /** 这个会话的模式。读不到 / 值不合法 / 键不合法 → **缺省**（不是抛错：一个坏文件不该让跑团起不来）。 */
  read(chatKey: string): TrpgMode {
    if (!isChatKey(chatKey)) return DEFAULT_MODE;
    return this.all()[chatKey] ?? DEFAULT_MODE;
  }

  /** 现在有哪些会话被切成非缺省的模式。设置页与排查都靠它。 */
  all(): Record<string, TrpgMode> {
    try {
      return normalizeModes(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      return {};
    }
  }

  /** 切模式。传缺省那一档 = **删掉这条记录**（见文件头）。返回落盘后的值。 */
  write(chatKey: string, mode: TrpgMode): TrpgMode {
    const key = String(chatKey ?? '');
    if (!isChatKey(key) || !isMode(mode)) return this.read(key);
    const next = this.all();
    if (mode === DEFAULT_MODE) delete next[key];
    else next[key] = mode;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 1), 'utf8');
    fs.renameSync(tmp, this.file);
    return this.read(key);
  }
}
