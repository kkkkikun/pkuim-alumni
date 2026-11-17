/**
 * 轻量 Promise 聚合工具。
 *
 * 不使用 `Promise.allSettled`（部分低版本 JS 引擎不支持），
 * 改为「全部成功才算成功、单条失败不影响其它条目」的语义。
 */

export interface Settled<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
}

/** 单个 Promise 的安全执行 */
export async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    const value = await promise;
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  }
}

/** 批量安全执行（允许各条 Promise 返回不同类型） */
export async function settleAll<T extends readonly unknown[]>(
  promises: { readonly [K in keyof T]: Promise<T[K]> },
): Promise<{ [K in keyof T]: Settled<T[K]> }> {
  const results = await Promise.all(
    promises.map((promise) => settle(promise as Promise<T[number]>)),
  );
  return results as { [K in keyof T]: Settled<T[K]> };
}
