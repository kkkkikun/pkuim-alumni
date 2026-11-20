import type { PageMeta, PageResult } from '@nmg/contracts';

/**
 * 读取分页响应（`{items, meta}`）。
 *
 * ## 为什么需要它
 *
 * 契约规定所有列表端点返回 `{items, meta}`。但服务端一旦**漏改**（例如某个端点
 * 还在返回裸数组），客户端按 `PageResult` 消费就会得到 `undefined.items`，
 * 随后在渲染时抛
 * `Cannot read properties of undefined (reading 'length')` —— 页面白屏，
 * 而且报错点在渲染里，**看不出**是响应结构不对（这正是缺陷 #58 的形态）。
 *
 * 这里在**拿到响应的那一刻**就检查结构，
 * 形状不对时抛出**点名端点**的错误 —— 白屏变成一条能定位问题的报错。
 *
 * ⚠️ 校验是**结构**层面的（`items` 是不是数组、`meta` 在不在），
 *    不校验每个字段（那是 `check-response-shape.mjs` 对着**真实响应**做的事）。
 */
export function readPageResult<T>(raw: unknown, endpoint: string): PageResult<T> {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`接口 ${endpoint} 的响应不是对象（收到 ${typeof raw}）`);
  }
  const candidate = raw as { items?: unknown; meta?: unknown };
  if (!Array.isArray(candidate.items)) {
    throw new Error(
      `接口 ${endpoint} 的响应缺少 items 数组（收到 ${JSON.stringify(candidate).slice(0, 120)}）`,
    );
  }
  const meta = candidate.meta as Partial<PageMeta> | undefined;
  const page = Number(meta?.page ?? 1);
  const pageSize = Number(meta?.pageSize ?? candidate.items.length);
  const total = Number(meta?.total ?? candidate.items.length);
  return {
    items: candidate.items as T[],
    meta: {
      page,
      pageSize,
      total,
      totalPages: Number(meta?.totalPages ?? Math.max(1, Math.ceil(total / Math.max(1, pageSize)))),
    },
  };
}
