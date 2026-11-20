/**
 * 「首次进入只加载一次」守卫（utils/first-show.ts）的单元测试。
 *
 * 这一层锁住两件事：
 *   1) 同一个页面实例：第一次 onShow 返回 false（跳过重复加载），
 *      之后的每次 onShow 返回 true（返回本页时刷新）；
 *   2) 状态是**按页面实例**隔离的 —— 新实例（同一页面被再次打开）
 *      的第一次 onShow 同样返回 false，不会因为上一个实例的残留状态被跳过。
 */

import { shouldRefreshOnShow } from '../src/utils/first-show';

describe('shouldRefreshOnShow', () => {
  it('同一实例：首次 onShow 不刷新，之后每次都刷新', () => {
    const page = {};
    expect(shouldRefreshOnShow(page)).toBe(false);
    expect(shouldRefreshOnShow(page)).toBe(true);
    expect(shouldRefreshOnShow(page)).toBe(true);
  });

  it('不同实例互不影响', () => {
    const first = {};
    const second = {};
    expect(shouldRefreshOnShow(first)).toBe(false);
    expect(shouldRefreshOnShow(second)).toBe(false);
    expect(shouldRefreshOnShow(first)).toBe(true);
  });
});
