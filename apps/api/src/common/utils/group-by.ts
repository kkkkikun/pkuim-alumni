/**
 * 按 key 分组（一次查询 → 内存里分桶）。
 *
 * 用于消除列表接口的 **N+1 查询**：
 * 逐行 `findOne` 会让「每页 20 条」的列表打出 60~100 条 SQL，
 * 改成「一次 `In(...)` 批量查 + 内存分桶」后，查询数与页大小**无关**。
 */

/**
 * 把数组按 key 分组。
 *
 * @param items 待分组数据
 * @param keyOf 取 key 的函数
 * @returns key → 该 key 下的全部元素（保持原有顺序）
 */
export function groupBy<T, K>(items: T[], keyOf: (item: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      grouped.set(key, [item]);
    }
  }
  return grouped;
}
