/**
 * 列表页滚动位置保持（spec §3.2：返回列表应尽量恢复原有筛选与滚动位置）。
 *
 * 用法：
 *   onPageScroll: trackPageScroll('directory')
 *   onShow:        restorePageScroll('directory')
 */

import { getScrollTop, saveScrollTop } from '../store';

export function trackPageScroll(key: string): (event: { scrollTop: number }) => void {
  return (event: { scrollTop: number }): void => {
    saveScrollTop(key, event.scrollTop);
  };
}

/** 恢复到上次滚动位置；数据加载完成后调用效果最好 */
export function restorePageScroll(key: string): void {
  const top = getScrollTop(key);
  if (!top) {
    return;
  }
  wx.nextTick(() => {
    wx.pageScrollTo({ scrollTop: top, duration: 0 });
  });
}

/** 主动重置滚动位置（例如筛选条件变化后回到顶部） */
export function resetPageScroll(key: string): void {
  saveScrollTop(key, 0);
  wx.pageScrollTo({ scrollTop: 0, duration: 0 });
}
