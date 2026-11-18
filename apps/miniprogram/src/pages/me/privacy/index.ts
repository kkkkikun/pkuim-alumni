import { fetchPrivacy, updatePrivacy } from '../../../services/index';
import type { PrivacySettings } from '../../../types/index';
import { showSuccess } from '../../../utils/feedback';

Page({
  data: {
    showInDirectory: false,
    showCollege: false,
    showIndustry: false,
    showRegion: false,
    showDirection: false,
    acceptContactRequests: true,
    allowContactShare: false,
    loading: true,
    saving: false,
    error: '',
  },

  onLoad(): void {
    void this.load();
  },

  onShow(): void {
    void this.load();
  },

  async load(): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const privacy = await fetchPrivacy();
      this.setData({
        showInDirectory: privacy.showInDirectory,
        showCollege: privacy.showCollege,
        showIndustry: privacy.showIndustry,
        showRegion: privacy.showRegion,
        showDirection: privacy.showDirection,
        acceptContactRequests: privacy.acceptContactRequests,
        allowContactShare: privacy.allowContactShare,
        loading: false,
      });
    } catch (error) {
      this.setData({ loading: false, error: '隐私设置加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    void this.load();
  },

  async onToggle(event: WechatMiniprogram.SwitchChange): Promise<void> {
    const field = event.currentTarget.dataset.field as string;
    const value = event.detail.value;
    if (this.data.saving) {
      return;
    }
    const payload: Partial<PrivacySettings> = {};
    switch (field) {
      case 'showInDirectory':
        payload.showInDirectory = value;
        break;
      case 'showCollege':
        payload.showCollege = value;
        break;
      case 'showIndustry':
        payload.showIndustry = value;
        break;
      case 'showRegion':
        payload.showRegion = value;
        break;
      case 'showDirection':
        payload.showDirection = value;
        break;
      case 'acceptContactRequests':
        payload.acceptContactRequests = value;
        break;
      case 'allowContactShare':
        payload.allowContactShare = value;
        break;
      default:
        break;
    }
    this.setData({ saving: true, error: '' });
    try {
      await updatePrivacy(payload);
      this.setData({ saving: false });
      showSuccess('设置已更新');
      await this.load();
    } catch (error) {
      this.setData({ saving: false, error: '保存失败，请稍后重试' });
    }
  },
});
