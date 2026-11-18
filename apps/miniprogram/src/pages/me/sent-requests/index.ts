import { cancelConnectionRequest, listMyConnectionRequests } from '../../../services/index';
import { getState } from '../../../store/index';
import type { ConnectionRequestDto } from '../../../types/index';
import { closeDialog, initialDialogState, openDialog } from '../../../utils/dialog';
import { connectionRequestStatusLabel } from '../../../utils/format';
import { showSuccess } from '../../../utils/feedback';
import { navigateTo } from '../../../utils/navigate';
import { toRequestView } from '../../../utils/view';
import type { RequestView as RequestViewModel } from '../../../utils/view';

interface RequestView extends RequestViewModel {
  statusLabel: string;
  canCancel: boolean;
}

function toView(item: ConnectionRequestDto): RequestView {
  return {
    ...toRequestView(item),
    statusLabel: connectionRequestStatusLabel(item.status),
    canCancel: item.status === 'pending',
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
      const outgoing = (result.items || []).filter((item) => item.fromUserId === myId);
      this.setData({ items: outgoing.map(toView), loading: false });
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

  async onCancel(event: WechatMiniprogram.BaseEvent): Promise<void> {
    const id = Number(event.currentTarget.dataset.id);
    const confirmed = await this.showConfirmDialog({
      title: '取消联系申请',
      content: '取消后对方将不再看到这条待处理的申请。',
      confirmText: '取消申请',
    });
    if (!confirmed) {
      return;
    }
    try {
      await cancelConnectionRequest(id);
      showSuccess('已取消');
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
