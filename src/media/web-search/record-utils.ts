// 外部 JSON 的防御性读取。
//
// 这条链上的每个 provider 都在解析**别人给的** JSON（可能是数组、可能是字符串、
// 可能是 `null`，字段名各家还不一样），所以每处 `asRecord(x).y` 都得先确认类型。
// 抽出来是为了让 provider 只写"字段名兜底"，不重复写类型守卫。

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** 只保留对象元素的数组。`recordArray(x).map(...)` 比手写 `Array.isArray(x) ? x.filter(...)` 短。 */
export function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
