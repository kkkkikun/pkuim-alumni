/**
 * 「我的」页首屏计数的展示模型（`src/utils/summary.ts`）单元测试。
 *
 * ## 这一层锁住什么
 *
 * 第三轮把「我的」页首屏从 **5 个请求**（`GET /me` + 4 个只为拿数字的列表请求）
 * 收敛到 **2 个**（`GET /me` + 新的聚合接口 `GET /me/summary`）。
 *
 * 代价是：四个数字现在**全部**来自同一个响应 ——
 * 服务端少给一个字段、或给了非法值，页面就会显示 `undefined` / `NaN`
 * （WXML 绑定 `undefined` 渲染成空字符串，但参与运算会得到 `NaN`，
 *  页面上就会出现「NaN 次」这种怪东西）。
 *
 * 所以这里断言：
 *   1. 正常响应**原样透出**四个计数；
 *   2. 缺字段 / 非法值 / 负数 → **兜底为 0**（不是 `undefined`、不是 `NaN`）。
 *
 * 被测对象是**生产代码本体**（`src/utils/summary.ts`）。
 */

import { toSummaryView } from '../src/utils/summary';

describe('toSummaryView（我的页首屏计数）', () => {
  it('正常响应：四个计数原样透出', () => {
    const view = toSummaryView({
      eventCount: 3,
      requestCount: 1,
      postCount: 12,
      unreadCount: 5,
    });
    expect(view).toEqual({
      eventCount: 3,
      requestCount: 1,
      postCount: 12,
      unreadCount: 5,
    });
  });

  it('整体缺失（响应为空）：四个计数都是 0', () => {
    expect(toSummaryView(null)).toEqual({
      eventCount: 0,
      requestCount: 0,
      postCount: 0,
      unreadCount: 0,
    });
    expect(toSummaryView(undefined)).toEqual({
      eventCount: 0,
      requestCount: 0,
      postCount: 0,
      unreadCount: 0,
    });
  });

  it('缺个别字段：缺的补 0，有的保留', () => {
    const view = toSummaryView({ eventCount: 2 } as never);
    expect(view.eventCount).toBe(2);
    expect(view.requestCount).toBe(0);
    expect(view.postCount).toBe(0);
    expect(view.unreadCount).toBe(0);
  });

  it('非法值：负数 / NaN / 非数字 / 小数 → 兜底为整数 0 或向下取整', () => {
    const view = toSummaryView({
      eventCount: -5,
      requestCount: Number.NaN,
      postCount: 'abc' as never,
      unreadCount: 2.7,
    } as never);
    expect(view.eventCount).toBe(0);
    expect(view.requestCount).toBe(0);
    expect(view.postCount).toBe(0);
    expect(view.unreadCount).toBe(2);
  });
});
