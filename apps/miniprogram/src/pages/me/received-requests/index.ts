import {
  acceptConnectionRequest,
  listMyConnectionRequests,
  rejectConnectionRequest,
} from '../../../services/index';
import { getState } from '../../../store/index';
import type { ConnectionRequestDto } from '../../../types/index';
import { closeDialog, initialDialogState, openDialog } from '../../../utils/dialog';
import { connectionRequestStatusLabel } from '../../../utils/format';
import { showSuccess } from '../../../utils/feedback';
import { navigateTo } from '../../../utils/navigate';

interface RequestView extends ConnectionRequestDto {
  statusLabel: string;
  canHandle: boolean;
}

function toView(item: ConnectionRequestDto): RequestView {
  return {
    ...item,
    statusLabel: connectionRequestStatusLabel(item.status),
    canHandle: item.status === 'pending',
  };
}

Page({
  data: {
    loading: true,
    error: '',
    items: [] as RequestView[],
    actionError: '',
    ...initialDialogState(),
  },

  onLoad(): void {
    void this.load();
  },

  onShow(): void {
    void this.load();
  },

  onPullDownRefresh(): void {
    void this.load().then(() => {
      wx.stopPullDownRefresh();
    });
  },

  async load(): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const result = await listMyConnectionRequests({ page: 1, pageSize: 50 });
      const myId = getState().user ? getState().user!.id : 0;
      const incoming = (result.items || []).filter((item) => item.toUserId === myId);
      this.setData({ items: incoming.map(toView), loading: false });
    } catch (error) {
      this.setData({ loading: false, error: '申请列表加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    void this.load();
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

  async onAccept(event: WechatMiniprogram.BaseEvent): Promise<void> {
    const id = Number(event.currentTarget.dataset.id);
    const item = this.data.items.find((row) => row.id === id);
    if (!item) {
      return;
    }
    const confirmed = await this.showConfirmDialog({
      title: '接受联系申请',
      content: `接受后，你与${item.fromName}将建立联系。双方仍需分别开启联系方式共享，才能看到彼此的联系方式。`,
      confirmText: '接受',
    });
    if (!confirmed) {
      return;
    }
    try {
      await acceptConnectionRequest(id);
      showSuccess('已接受');
      await this.load();
    } catch (error) {
      this.setData({ actionError: '操作失败，请稍后重试' });
    }
  },

  async onReject(event: WechatMiniprogram.BaseEvent): Promise<void> {
    const id = Number(event.currentTarget.dataset.id);
    const item = this.data.items.find((row) => row.id === id);
    if (!item) {
      return;
    }
    const confirmed = await this.showConfirmDialog({
      title: '拒绝联系申请',
      content: '拒绝后不会产生正式连接关系，对方也不会收到联系方式。',
      confirmText: '拒绝',
    });
    if (!confirmed) {
      return;
    }
    try {
      await rejectConnectionRequest(id);
      showSuccess('已拒绝');
      await this.load();
    } catch (error) {
      this.setData({ actionError: '操作失败，请稍后重试' });
    }
  },

  onDetailTap(event: WechatMiniprogram.BaseEvent): void {
    const id = Number(event.currentTarget.dataset.id);
    navigateTo(`/pages/connect/request-detail/index?id=${id}`);
  },
});
