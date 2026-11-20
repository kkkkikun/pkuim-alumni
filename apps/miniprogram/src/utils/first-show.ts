/**
 * 「首次进入只加载一次」守卫。
 *
 * 背景：
 *   小程序页面**首次进入**的生命周期顺序是 onLoad → onShow → onReady。
 *   如果 onLoad 与 onShow 都调用同一个数据加载函数，那么首屏的这一批请求
 *   会被完整地发出两遍（一半是纯重复流量），既拖慢首屏，也白白压后端。
 *
 * 语义（本文件只做一件事：回答「本次 onShow 要不要重新加载」）：
 *   - 第一次 onShow（紧跟在 onLoad 之后）：返回 false —— 数据已由 onLoad 加载过，跳过；
 *   - 之后的每次 onShow（从子页面返回、从后台切回前台）：返回 true —— 需要刷新。
 *
 * 为什么状态挂在**页面实例**上（WeakMap 以页面实例为键），而不是模块级变量：
 *   同一个页面可以被多次 navigateTo 打开，模块级标记会让**新实例**的首次展示
 *   也被误判成「不是首次」，于是新页面实例一片空白。
 *   WeakMap 的键是弱引用，页面销毁后条目自动回收，不会泄漏。
 *
 * 用法：
 *   onLoad(): void {
 *     void this.load();          // 首次加载（照旧放在 onLoad）
 *   },
 *   onShow(): void {
 *     if (shouldRefreshOnShow(this)) {
 *       void this.load();        // 返回本页时刷新；首次进入不再重复发请求
 *     }
 *   },
 */

/** 页面实例 → 是否已经经历过一次 onShow */
const shownPages = new WeakMap<object, boolean>();

/**
 * 本次 onShow 是否需要重新加载数据。
 *
 * @param page 页面实例（onShow 里的 `this`）
 * @returns false = 首次展示（onLoad 已加载过，请勿重复发请求）；true = 需要刷新
 */
export function shouldRefreshOnShow(page: object): boolean {
  if (shownPages.get(page)) {
    return true;
  }
  shownPages.set(page, true);
  return false;
}
