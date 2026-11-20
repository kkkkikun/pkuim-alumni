import { fetchMe } from '../../../services/index';
import { getState } from '../../../store/index';
import type { MyAlumniProfile } from '../../../types/index';
import { avatarText } from '../../../utils/format';
import { navigateTo } from '../../../utils/navigate';
import { shouldRefreshOnShow } from '../../../utils/first-show';

interface ProfileView {
  displayName: string;
  avatarText: string;
  college: string;
  yearLabel: string;
  regionLabel: string;
  industryLabel: string;
  direction: string;
  intro: string;
  verified: boolean;
  contactVisible: boolean;
  privacyLabel: string;
}

Page({
  data: {
    loading: true,
    error: '',
    profile: null as ProfileView | null,
  },

  onLoad(): void {
    void this.load();
  },

  onShow(): void {
    // 首次进入时 onLoad 已经加载过，这里不再重复发请求；返回本页时才刷新。
    if (shouldRefreshOnShow(this)) {
      void this.load();
    }
  },

  async load(): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const result = await fetchMe();
      const profile = result.alumniProfile;
      if (!profile) {
        this.setData({ loading: false, profile: null });
        return;
      }
      this.setData({ profile: this.buildView(profile), loading: false });
    } catch (error) {
      this.setData({ loading: false, error: '资料加载失败，请稍后重试' });
    }
  },

  buildView(profile: MyAlumniProfile): ProfileView {
    const privacy = profile.privacy;
    const privacyLabel = !privacy
      ? '未设置'
      : privacy.showInDirectory
        ? '公开我的校友名片'
        : '不在通讯录中公开';
    return {
      displayName: profile.displayName || '校友',
      avatarText: avatarText(profile.displayName),
      college: profile.college || '待填写',
      yearLabel: profile.graduationYear ? `${profile.graduationYear}届` : '待填写',
      regionLabel: profile.regionName || '待填写',
      industryLabel: profile.industryName || '待填写',
      direction: profile.direction || '待填写',
      intro: profile.intro || '还没有填写个人介绍',
      verified: profile.verified,
      contactVisible: profile.contactVisible,
      privacyLabel,
    };
  },

  onRetry(): void {
    void this.load();
  },

  onEditTap(): void {
    navigateTo('/pages/me/profile-edit/index');
  },

  onPrivacyTap(): void {
    navigateTo('/pages/me/privacy/index');
  },

  onVerifyTap(): void {
    const stage = getState().stage;
    navigateTo(stage === 'pending_review' ? '/pages/me/verify-progress/index' : '/pages/me/verify-intro/index');
  },
});
