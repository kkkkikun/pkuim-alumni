import { getVerificationStatus, listVerifications } from '../../../services/index';
import type { VerificationApplicationDto, VerificationStatus } from '../../../types/index';
import { verificationStatusLabel } from '../../../utils/format';
import { navigateTo } from '../../../utils/navigate';
import { settle } from '../../../utils/async';

interface ProgressView {
  status: VerificationStatus;
  statusLabel: string;
  stepText: string;
  submittedAt: string;
  decidedAt: string;
  note: string;
}

const STEP_TEXT: Record<VerificationStatus, string> = {
  pending: '申请已提交，校友会正在审核',
  needs_more_material: '审核人员认为材料不足，请补充后重新提交',
  approved: '认证已通过，你已获得正式校友权限',
  rejected: '认证未通过，可查看审核记录后重新提交',
  resubmitted: '已重新提交，等待审核',
};

Page({
  data: {
    loading: true,
    error: '',
    progress: null as ProgressView | null,
    latest: null as VerificationApplicationDto | null,
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
      const statusResult = await settle(getVerificationStatus());
      const listResult = await settle(listVerifications({ page: 1, pageSize: 1 }));
      let status: VerificationStatus = 'pending';
      if (statusResult.ok && statusResult.value) {
        status = statusResult.value.status;
      } else if (listResult.ok && listResult.value) {
        const items = listResult.value.items || [];
        if (items.length) {
          status = items[0].status;
        }
      }
      const latest =
        listResult.ok && listResult.value && listResult.value.items && listResult.value.items.length
          ? listResult.value.items[0]
          : null;
      this.setData({
        progress: {
          status,
          statusLabel: verificationStatusLabel(status),
          stepText: STEP_TEXT[status],
          submittedAt: latest ? latest.submittedAt : '',
          decidedAt: latest && latest.decidedAt ? latest.decidedAt : '',
          note: latest && latest.reviews && latest.reviews.length ? latest.reviews[latest.reviews.length - 1].note || '' : '',
        },
        latest,
        loading: false,
      });
    } catch (error) {
      this.setData({ loading: false, error: '认证进度加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    void this.load();
  },

  onHistoryTap(): void {
    navigateTo('/pages/me/verify-history/index');
  },

  onRestartTap(): void {
    navigateTo('/pages/me/verify-form/index');
  },
});
