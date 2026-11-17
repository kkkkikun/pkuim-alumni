import {
  acceptConnectionRequest,
  cancelConnectionRequest,
  getConnectionRequest,
  rejectConnectionRequest,
} from '../../../services';
import { getState } from '../../../store';
import type { ConnectionRequestDto } from '../../../types';
import { closeDialog, initialDialogState, openDialog } from '../../../utils/dialog';
import { connectionRequestStatusLabel } from '../../../utils/format';
import { showSuccess } from '../../../utils/feedback';
import { navigateTo } from '../../../utils/navigate';

interface RequestView extends ConnectionRequestDto {
  statusLabel: string;
  isIncoming: boolean;
  canAccept: boolean;
  canCancel: boolean;
}

Page({
  data: {
    loading: true,
    error: '',
    request: null as RequestView | null,
    actionError: '',
    ...initialDialogState(),
  },

  onLoad(options: Record<string, string | undefined>): void {
    const id = Number(options.id);
    if (!Number.isFinite(id) || id <= 0) {
      this.setData({ loading: false, error: '参数错误' });
      return;
    }
    void this.load(id);
  },

  async load(id: number): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const request = await getConnectionRequest(id);
      const myId = getState().user ? getState().user!.id : 0;
      const isIncoming = request.toUserId === myId;
      this.setData({
        request: {
          ...request,
          statusLabel: connectionRequestStatusLabel(request.status),
          isIncoming,
          canAccept: isIncoming && request.status === 'pending',
          canCancel: !isIncoming && request.status === 'pending',
        },
        loading: false,
      });
    } catch (error) {
      this.setData({ loading: false, error: '连接申请加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    const request = this.data.request;
    void this.load(request ? request.id : 0);
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

  async onAccept(): Promise<void> {
    const request = this.data.request;
    if (!request) {
      return;
    }
    const confirmed = await this.showConfirmDialog({
      title: '接受联系申请',
      content: `接受后，你与${request.fromName}将建立联系。双方仍需分别开启联系方式共享，才能看到彼此的联系方式。`,
      confirmText: '接受',
    });
    if (!confirmed) {
      return;
    }
    try {
      await acceptConnectionRequest(request.id);
      showSuccess('已接受');
      await this.load(request.id);
    } catch (error) {
      this.setData({ actionError: '操作失败，请稍后重试' });
    }
  },

  async onReject(): Promise<void> {
    const request = this.data.request;
    if (!request) {
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
      await rejectConnectionRequest(request.id);
      showSuccess('已拒绝');
      await this.load(request.id);
    } catch (error) {
      this.setData({ actionError: '操作失败，请稍后重试' });
    }
  },

  async onCancel(): Promise<void> {
    const request = this.data.request;
    if (!request) {
      return;
    }
    const confirmed = await this.showConfirmDialog({
      title: '取消联系申请',
      content: '取消后对方将不再看到这条待处理的申请。',
      confirmText: '取消申请',
    });
    if (!confirmed) {
      return;
    }
    try {
      await cancelConnectionRequest(request.id);
      showSuccess('已取消');
      await this.load(request.id);
    } catch (error) {
      this.setData({ actionError: '操作失败，请稍后重试' });
    }
  },

  onContactShareTap(): void {
    const request = this.data.request;
    if (request && request.pairId) {
      navigateTo(`/pages/me/contact-share/index?id=${request.pairId}`);
    } else {
      navigateTo('/pages/me/connections/index');
    }
  },
});
