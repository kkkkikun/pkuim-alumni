/**
 * 「我的」页首屏计数的**展示模型**。
 *
 * ## 为什么要有这一层
 *
 * 第三轮之前，「我的」页首屏要打 **5 个请求**：
 * `GET /me` + 4 个**只为拿一个数字**的列表请求
 * （我的活动 / 我的联系申请 / 我的发布 / 未读通知数）。
 * 那四个列表接口每次都把整页数据查出来、分页、组装视图 ——
 * 首屏只需要数字，却付出了 5 次往返 + 4 次列表查询的代价。
 *
 * 现在这四个数字由**一个聚合接口** `GET /me/summary` 给出（首屏 2 个请求）。
 * 本模块把聚合响应转成页面直接可用的展示字段，
 * 并**对缺失 / 非法字段做兜底** —— 服务端少给一个字段时，
 * 页面显示 0 而不是 `undefined`（WXML 绑定 `undefined` 会渲染成空字符串，
 * 但 `undefined` 参与运算会得到 `NaN`）。
 */

import type { MeSummaryResponse } from '../types/index';

/** 「我的」页展示用的四个计数 */
export interface MeSummaryView {
  /** 我的活动报名数 */
  eventCount: number;
  /** 我收到的联系申请数 */
  requestCount: number;
  /** 我发布的资源 / 需求数 */
  postCount: number;
  /** 未读通知数 */
  unreadCount: number;
}

/** 把任意输入转成四个**非负整数**计数（缺失 / 非法 → 0）。 */
export function toSummaryView(summary: Partial<MeSummaryResponse> | null | undefined): MeSummaryView {
  return {
    eventCount: toCount(summary?.eventCount),
    requestCount: toCount(summary?.requestCount),
    postCount: toCount(summary?.postCount),
    unreadCount: toCount(summary?.unreadCount),
  };
}

/** 把任意值转成非负整数（`NaN` / 负数 / 非数 → 0）。 */
function toCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}
