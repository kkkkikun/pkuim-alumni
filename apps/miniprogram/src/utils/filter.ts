/**
 * 筛选条件签名（真机缺陷 #161）。
 *
 * ## 为什么需要这个文件
 *
 * 筛选页（`pages/directory/filter`、`pages/connect/filter`）是 `navigateTo`
 * 打开的**独立页面**：用户在筛选页点「确定」→ 写全局 store → `navigateBack`
 * 回到列表页。
 *
 * 原来的列表页 `onShow` **只同步了筛选标签文案，没有重新拉数据**，
 * 于是真机上出现这一串现象（用户一次报了 4 张截图）：
 *   - 选完「数字科技」→ 列表还是全部人、计数还是「共 12 位校友」；
 *   - 选完「我能提供」→ 列表和计数完全不变；
 *   - 选过一次条件后再去掉 → 还是「没有信息」；
 *   - 接着搜索「张」→ 报「没有找到符合条件的校友」（其实是被**残留的年份条件**筛掉了）。
 *
 * 根因只有一个：**筛选条件变了，列表没有跟着重载**。
 *
 * ## 修法
 *
 * 列表页记住**上一次请求时用到的筛选条件签名**，回到页面时比对当前签名：
 * 变了 → 重新加载。这样「标签、列表、计数」三者永远一致。
 *
 * 签名必须是**纯函数**（不依赖 wx / store 实例），才能被单元测试直接覆盖。
 */

import type { ConnectFilter, DirectoryFilter } from '../store/index';

/** 通讯录筛选条件的签名（任何一项变化都会产生不同的签名） */
export function directoryFilterSignature(filter: DirectoryFilter): string {
  // 年份：null / undefined / 0 都表示「不限年份」，必须归一到同一个值，
  // 否则「刚进页面（null）」和「筛选页选过一次又取消（0）」会被误判成条件变了。
  const year = !filter.graduationYear ? '' : String(filter.graduationYear);
  return [filter.keyword || '', filter.regionCode || '', filter.industryCode || '', year].join('|');
}

/** 连接栏目筛选条件的签名 */
export function connectFilterSignature(filter: ConnectFilter): string {
  return [filter.type || 'all', filter.regionCode || '', filter.industryCode || ''].join('|');
}

/** 通讯录当前是否有生效中的筛选条件（空状态用来提示「当前筛选下没有结果」） */
export function isDirectoryFilterActive(filter: DirectoryFilter): boolean {
  return directoryFilterSignature(filter) !== '|||';
}

/** 连接栏目当前是否有生效中的筛选条件 */
export function isConnectFilterActive(filter: ConnectFilter): boolean {
  return connectFilterSignature(filter) !== 'all||';
}

/**
 * 毕业年份选项（由近到远）。
 *
 * ⚠️ 缺陷 #161（真机反馈）：原来只给**最近 6 年**（`current-6 .. current`），
 *   真实校友的毕业年份跨越几十年 —— 选一个选项却得到 0 条结果，
 *   用户会以为「年份筛选坏了」。这里放宽到最近 **21 年**。
 */
export function buildGraduationYearOptions(currentYear?: number): number[] {
  const base = currentYear ?? new Date().getFullYear();
  const years: number[] = [];
  for (let year = base; year > base - 21; year -= 1) {
    years.push(year);
  }
  return years;
}
