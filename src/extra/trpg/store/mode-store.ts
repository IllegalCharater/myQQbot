// 运行模式的**落盘**（从 `mode.ts` 拆出，2026-10-16）。
//
// `data/trpg/modes.json` 一个文件装全部会话，形状与 `extras.override` 那套一样
// （键是 `group:<群号>` / `private:<QQ号>`，值是模式名）。**只有非缺省的模式才写进去** ——
// 缺省是 `dm`，所以一份没切过模式的配置里这个文件可以压根不存在。
//
// ── 缓存：按 **mtime**，不是"读一次就永远记着"（2026-10-19 改）──
//
// 原先这里刻意不缓存（"每次现读这个小文件"），理由是"缓存的代价是手改了文件不生效"。
// 那条理由对**无失效条件的缓存**成立，而对 mtime 缓存不成立 —— 手改了文件 mtime 就变，
// 下一次读立刻看到新的一版（`ScenarioStore` 用的就是这一套，它那句"改了文件不重启也生效"
// 的承诺正是靠这个）。
//
// 改的原因是**它跑在入站热路径上**：`impl.intercept()` 问的第一件事就是 `read(chatKey)`，
// 而那跑在**每一条**入站消息上（`extra/types.ts` 要求它同步、无 I/O）。不缓存的话，
// 每条消息都要 readFileSync + JSON.parse + 归一化一遍。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../core/paths.js';
import { DEFAULT_MODE, isChatKey, isMode, normalizeModes } from '../model/mode.js';
import type { TrpgMode } from '../model/mode.js';

export class TrpgModeStore {
  readonly file: string;
  /**
   * 上一次读到的内容 + 那个文件的"签名"（mtime + size）。
   *
   * ⚠️ **加上 `size` 不是洁癖**：mtime 的分辨率在某些文件系统上粗到秒（Windows 上还有
   * "同一毫秒内两次写入拿到同一个 mtime"的实测），而"手改了这个几百字节的小文件"最容易
   * 命中的就是那种情况 —— 表现是"改完还是旧的"。`size` 一变就说明内容一定变了，能挡住
   * 绝大多数同 tick 修改（同 size 同 tick 的改动仍然测不出来，那是这套手法的已知边界，
   * 与 `ScenarioStore` 的 mtime 缓存同一档）。
   */
  #cache: { signature: string; modes: Record<string, TrpgMode> } | null = null;

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
    let signature = 'missing';
    try {
      const stat = fs.statSync(this.file);
      signature = `${stat.mtimeMs}|${stat.size}`;
    } catch {
      signature = 'missing';   // 文件不存在（还没人切过模式）
    }
    if (this.#cache && this.#cache.signature === signature) return this.#cache.modes;
    let modes: Record<string, TrpgMode> = {};
    try {
      modes = normalizeModes(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      modes = {};   // 坏 JSON 与"没有文件"同一条路：缺省模式
    }
    this.#cache = { signature, modes };
    return modes;
  }

  /** 切模式。传缺省那一档 = **删掉这条记录**（见文件头）。返回落盘后的值。 */
  write(chatKey: string, mode: TrpgMode): TrpgMode {
    const key = String(chatKey ?? '');
    if (!isChatKey(key) || !isMode(mode)) return this.read(key);
    const next = { ...this.all() };
    if (mode === DEFAULT_MODE) delete next[key];
    else next[key] = mode;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 1), 'utf8');
    fs.renameSync(tmp, this.file);
    // ⚠️ **显式作废缓存**：mtime 的分辨率在某些文件系统上粗到秒，同一秒内写完再读会
    // 命中旧的那一份 —— 表现是"切了模式，这一轮没生效"（而那正是这条命令唯一的承诺）。
    this.#cache = null;
    return this.read(key);
  }
}
