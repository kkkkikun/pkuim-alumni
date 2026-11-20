/**
 * 分页响应读取（`src/api/page-result.ts`）的单元测试。
 *
 * ## 这一层锁住什么
 *
 * 第三轮把三个管理端端点从「裸数组」改成了 `{items, meta}`。
 * 契约变了，客户端就**必须**能发现自己拿到的东西形状不对 ——
 * 否则服务端漏改一个端点，页面就在渲染时抛
 * `Cannot read properties of undefined (reading 'length')`（缺陷 #58 的形态），
 * 而且报错点在渲染里，看不出是响应结构的问题。
 *
 * 所以这里断言：
 *   1. 形状正确时**原样透出**（items / meta 都不改）；
 *   2. 形状不对时（裸数组、缺 items、不是对象）**立刻抛出点名端点的错误**，
 *      而不是让 `undefined` 流到渲染层。
 *
 * 被测对象是**生产代码本体**（`src/api/page-result.ts`）。
 */
import { readPageResult } from '../src/api/page-result';

describe('readPageResult（管理后台分页响应）', () => {
  const endpoint = '/admin/roles';

  it('形状正确：原样透出 items 与 meta', () => {
    const raw = {
      items: [{ id: 1, code: 'super_admin' }],
      meta: { page: 2, pageSize: 20, total: 41, totalPages: 3 },
    };
    const result = readPageResult<{ id: number; code: string }>(raw, endpoint);
    expect(result.items).toEqual(raw.items);
    expect(result.meta).toEqual(raw.meta);
  });

  it('形状正确但 meta 缺字段：补上自洽的默认值（不报错）', () => {
    const result = readPageResult<number>({ items: [1, 2, 3] }, endpoint);
    expect(result.items).toHaveLength(3);
    expect(result.meta.page).toBe(1);
    expect(result.meta.pageSize).toBe(3);
    expect(result.meta.total).toBe(3);
    expect(result.meta.totalPages).toBe(1);
  });

  it('服务端漏改、仍返回裸数组：立刻抛出点名端点的错误', () => {
    // ⚠️ 这是**第三轮之前**那三个端点的真实形状。
    expect(() => readPageResult([{ id: 1 }], endpoint)).toThrow(/items/);
    expect(() => readPageResult([{ id: 1 }], endpoint)).toThrow(endpoint);
  });

  it('响应不是对象：抛出点名端点的错误', () => {
    expect(() => readPageResult(null, endpoint)).toThrow(endpoint);
    expect(() => readPageResult(undefined, endpoint)).toThrow(endpoint);
    expect(() => readPageResult('oops', endpoint)).toThrow(endpoint);
  });

  it('items 不是数组：抛出点名端点的错误', () => {
    expect(() => readPageResult({ items: { a: 1 } }, endpoint)).toThrow(/items/);
  });
});
