import { isMockLoginMode, logout } from '../../../services/index';
import { getState, isLoggedIn, stageLabel } from '../../../store/index';
import { closeDialog, initialDialogState, openDialog } from '../../../utils/dialog';
import { showSuccess } from '../../../utils/feedback';
import { navigateTo } from '../../../utils/navigate';

Page({
  data: {
    logged: false,
    displayName: '',
    stageText: '游客',
    mockMode: false,
    ...initialDialogState(),
  },

  onLoad(): void {
    this.sync();
  },

  onShow(): void {
    this.sync();
  },

  sync(): void {
    const state = getState();
    this.setData({
      logged: isLoggedIn(),
      displayName: state.user ? state.user.nickname : '',
      stageText: stageLabel(state.stage),
      mockMode: isMockLoginMode(),
    });
  },

  showConfirmDialog(options: { title: string; content?: string; confirmText?: string; cancelText?: string }): Promise<boolean> {
    return openDialog(this, options);
  },

  onDialogConfirm(): void {
    closeDialog(this, true);
  },

  onDialogCancel(): void {
    closeDialog(this, false);
  },

  async onLogoutTap(): Promise<void> {
    const confirmed = await this.showConfirmDialog({
      title: '退出登录',
      content: '退出后需要重新登录才能查看认证状态、连接记录与我的发布。',
      confirmText: '退出',
    });
    if (!confirmed) {
      return;
    }
    await logout();
    showSuccess('已退出登录');
    this.sync();
  },

  onClearCacheTap(): void {
    wx.clearStorageSync();
    showSuccess('本地缓存已清理');
  },

  onAboutTap(): void {
    navigateTo('/pages/home/about/index');
  },

  onPrivacyTap(): void {
    navigateTo('/pages/me/privacy/index');
  },
});
