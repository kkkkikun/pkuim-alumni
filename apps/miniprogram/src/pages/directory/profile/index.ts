import { getAlumniProfile, getDirectoryEntry } from '../../../services/index';
import { isVerified } from '../../../store/index';
import type { DirectoryEntry } from '../../../types/index';
import { avatarText } from '../../../utils/format';
import { navigateTo } from '../../../utils/navigate';
import { showToast } from '../../../utils/feedback';
import { settle } from '../../../utils/async';

type ConnectionState = DirectoryEntry['connectionState'];

interface ProfileView {
  userId: number;
  displayName: string;
  avatarText: string;
  regionLabel: string;
  college: string;
  yearLabel: string;
  industryLabel: string;
  direction: string;
  intro: string;
  verified: boolean;
  connectionState: ConnectionState;
  actionText: string;
  actionHint: string;
}

Page({
  data: {
    loading: true,
    error: '',
    profile: null as ProfileView | null,
  },

  onLoad(options: Record<string, string | undefined>): void {
    const id = Number(options.id);
    if (!Number.isFinite(id) || id <= 0) {
      this.setData({ loading: false, error: '参数错误' });
      return;
    }
    void this.load(id);
  },

  async load(userId: number): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const profileResult = await settle(getAlumniProfile(userId));
      const entryResult = await settle(getDirectoryEntry(userId));
      const entry = entryResult.ok && entryResult.value ? entryResult.value : null;
      const detail = profileResult.ok && profileResult.value ? profileResult.value : null;
      this.setData({ profile: this.buildView(detail, entry, userId), loading: false });
    } catch (error) {
      this.setData({ loading: false, error: '校友资料加载失败，请稍后重试' });
    }
  },

  buildView(detail: DirectoryEntry | null, entry: DirectoryEntry | null, userId: number): ProfileView {
    const name = (detail && detail.displayName) || (entry && entry.displayName) || '校友';
    const region = (detail && detail.regionName) || (entry && entry.regionName) || '';
    const college = (detail && detail.college) || (entry && entry.college) || '';
    const year = (detail && detail.graduationYear) || (entry && entry.graduationYear) || 0;
    const industry = (detail && detail.industryName) || (entry && entry.industryName) || '';
    const direction = (detail && detail.direction) || (entry && entry.direction) || '';
    // 公开名片不含 intro（私密字段），简介恒为空
    const verified = detail ? detail.verified : entry ? entry.verified : false;
    const connectionState: ConnectionState = entry ? entry.connectionState : 'none';

    let actionText = '申请建立联系';
    let actionHint = '提交后由对方自主决定是否接受';
    if (connectionState === 'connected') {
      actionText = '已建立联系';
      actionHint = '双方均授权后可查看联系方式';
    } else if (connectionState === 'pending_outgoing') {
      actionText = '申请已发送';
      actionHint = '等待对方确认';
    } else if (connectionState === 'pending_incoming') {
      actionText = '处理收到的申请';
      actionHint = '对方已向你发起联系申请';
    }

    return {
      userId,
      displayName: name,
      avatarText: avatarText(name),
      regionLabel: region,
      college,
      yearLabel: year ? `${year}届` : '',
      industryLabel: industry,
      direction,
      intro: '',
      verified,
      connectionState,
      actionText,
      actionHint,
    };
  },

  onRetry(): void {
    const profile = this.data.profile;
    void this.load(profile ? profile.userId : 0);
  },

  onActionTap(): void {
    const profile = this.data.profile;
    if (!profile) {
      return;
    }
    if (profile.connectionState === 'connected') {
      navigateTo('/pages/me/connections/index');
      return;
    }
    if (profile.connectionState === 'pending_outgoing') {
      showToast('申请已发送，请等待对方确认');
      return;
    }
    if (profile.connectionState === 'pending_incoming') {
      navigateTo('/pages/me/received-requests/index');
      return;
    }
    if (!isVerified()) {
      showToast('完成校友认证后即可发起联系申请');
      navigateTo('/pages/me/verify-intro/index');
      return;
    }
    navigateTo(`/pages/directory/request/index?id=${profile.userId}`);
  },
});
