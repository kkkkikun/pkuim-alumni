/** 页面导航工具：统一构造带参数的页面路径。 */

export interface ArticleDetailQuery {
  id: number;
}

export interface EventDetailQuery {
  id: number;
}

export interface NoticeDetailQuery {
  id: number;
}

export interface DirectoryProfileQuery {
  id: number;
}

export interface ConnectionRequestQuery {
  id: number;
}

export interface ResourceDetailQuery {
  id: number;
}

export interface VerificationQuery {
  id: number;
}

export interface ConnectionQuery {
  id: number;
}

export function articleDetailUrl(id: number): string {
  return `/pages/home/article-detail/index?id=${id}`;
}

export function eventDetailUrl(id: number): string {
  return `/pages/home/event-detail/index?id=${id}`;
}

export function eventRegisterUrl(id: number): string {
  return `/pages/home/event-register/index?id=${id}`;
}

export function noticeDetailUrl(id: number): string {
  return `/pages/home/notice-detail/index?id=${id}`;
}

export function directoryProfileUrl(id: number): string {
  return `/pages/directory/profile/index?id=${id}`;
}

export function connectionRequestUrl(id: number): string {
  return `/pages/connect/request-detail/index?id=${id}`;
}

export function resourceDetailUrl(id: number): string {
  return `/pages/connect/resource-detail/index?id=${id}`;
}

export function demandDetailUrl(id: number): string {
  return `/pages/connect/demand-detail/index?id=${id}`;
}

export function verificationUrl(id: number): string {
  return `/pages/me/verify-progress/index?id=${id}`;
}

export function connectionUrl(id: number): string {
  return `/pages/me/connections/index?id=${id}`;
}

export function navigateTo(url: string): void {
  wx.navigateTo({ url });
}

export function redirectTo(url: string): void {
  wx.redirectTo({ url });
}

export function switchTab(url: string): void {
  wx.switchTab({ url });
}

export function navigateBack(delta = 1): void {
  const pages = getCurrentPages();
  if (pages.length <= 1) {
    wx.switchTab({ url: '/pages/home/index/index' });
    return;
  }
  wx.navigateBack({ delta });
}

/** 从路由参数中安全读取数字 id */
export function readId(options: Record<string, string | undefined>): number | null {
  const raw = options && options.id ? options.id : '';
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}
