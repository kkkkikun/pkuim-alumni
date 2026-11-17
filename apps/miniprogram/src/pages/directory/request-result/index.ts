import { listMyConnectionRequests } from '../../../services';
import { getState } from '../../../store';
import type { ConnectionRequestDto } from '../../../types';
import { connectionRequestStatusLabel } from '../../../utils/format';

Page({
  data: {
    loading: true,
    error: '',
    targetId: 0,
    statusText: '申请已提交',
    statusDesc: '申请已发送给对方，等待对方确认。对方接受后，双方可以协商是否共享联系方式。',
    tone: 'pending',
  },

  onLoad(options: Record<string, string | undefined>): void {
    const id = Number(options.id);
    this.setData({ targetId: Number.isFinite(id) && id > 0 ? id : 0 });
    void this.load();
  },

  async load(): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const result = await listMyConnectionRequests({ page: 1, pageSize: 50 });
      const items = result.items || [];
      const myId = getState().user ? getState().user!.id : 0;
      const target = this.data.targetId
        ? items.find((item) => item.toUserId === this.data.targetId)
        : undefined;
      const latest: ConnectionRequestDto | undefined = target || items.find((item) => item.fromUserId === myId);
      if (latest) {
        this.setData({
          statusText: connectionRequestStatusLabel(latest.status),
          statusDesc: this.describe(latest.status),
          tone: latest.status,
          loading: false,
        });
      } else {
        this.setData({ loading: false });
      }
    } catch (error) {
      this.setData({ loading: false, error: '申请状态加载失败，请稍后重试' });
    }
  },

  describe(status: ConnectionRequestDto['status']): string {
    switch (status) {
      case 'accepted':
        return '对方已接受你的联系申请。双方可以分别开启联系方式共享，共享后彼此才能看到联系方式。';
      case 'rejected':
        return '对方暂未接受这次联系申请。你仍可在通讯录中了解对方的公开资料。';
      case 'cancelled':
        return '这次联系申请已取消。';
      case 'expired':
        return '这次联系申请已过期，如仍需联系可重新发起。';
      default:
        return '申请已发送给对方，等待对方确认。对方接受后，双方可以协商是否共享联系方式。';
    }
  },

  onRetry(): void {
    void this.load();
  },

  onBackToDirectory(): void {
    wx.switchTab({ url: '/pages/directory/index/index' });
  },

  onViewSent(): void {
    wx.navigateTo({ url: '/pages/me/sent-requests/index' });
  },
});
