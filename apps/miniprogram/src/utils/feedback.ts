/**
 * 统一的反馈工具：Toast、确认弹窗、加载提示。
 * 简单的确认交互使用自研 `dialog` 组件（见 components/dialog），
 * 复杂表单与筛选一律使用独立页面（spec §3.2）。
 */

export type ToastIcon = 'none' | 'success' | 'error' | 'loading';

export function showToast(title: string, icon: ToastIcon = 'none', duration = 2200): void {
  wx.showToast({ title, icon, duration, mask: false });
}

export function showSuccess(title: string): void {
  showToast(title, 'success');
}

export function showError(message: string): void {
  showToast(message || '操作失败，请稍后重试', 'none');
}

export function showLoading(title = '加载中'): void {
  wx.showLoading({ title, mask: true });
}

export function hideLoading(): void {
  wx.hideLoading();
}
