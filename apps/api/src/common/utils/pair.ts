/**
 * 连接对规范化：user_a_id < user_b_id，保证同一对用户只有唯一索引命中。
 */
export function normalizePair(a: number, b: number): [number, number] {
  // 统一转成 number：不同数据源（BIGINT 字符串 / number）混用时也能得到一致的 pair_key
  const left = Number(a);
  const right = Number(b);
  return left < right ? [left, right] : [right, left];
}

export function pairKey(a: number, b: number): string {
  const [low, high] = normalizePair(a, b);
  return `${low}:${high}`;
}
