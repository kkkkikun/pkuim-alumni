/** 自定义 TabBar 选中态同步。 */

export interface TabBarInstance {
  setData: (data: { selected: number }) => void;
}

/** 设置底部导航选中项 */
export function setTabBarSelected(index: number): void {
  const pages = getCurrentPages();
  const current = pages[pages.length - 1] as unknown as
    | { getTabBar?: () => TabBarInstance }
    | undefined;
  const tabBar = current && typeof current.getTabBar === 'function' ? current.getTabBar() : null;
  if (tabBar) {
    tabBar.setData({ selected: index });
  }
}
