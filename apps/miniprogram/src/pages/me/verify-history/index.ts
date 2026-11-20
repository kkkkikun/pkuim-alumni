import { listVerifications } from '../../../services/index';
import type { VerificationApplicationDto } from '../../../types/index';
import { formatDateTime, verificationStatusLabel } from '../../../utils/format';
import { shouldRefreshOnShow } from '../../../utils/first-show';

interface HistoryView extends VerificationApplicationDto {
  statusLabel: string;
  reviewText: string;
  /** 提交时间（已格式化，形如 `2026-01-08 19:30`） */
  submittedText: string;
}

const ACTION_LABELS: Record<string, string> = {
  approve: '通过审核',
  reject: '审核未通过',
  request_changes: '要求补充材料',
  offline: '管理员处理',
};

function toView(item: VerificationApplicationDto): HistoryView {
  const reviews = item.reviews || [];
  const last = reviews.length ? reviews[reviews.length - 1] : null;
  const reviewText = last
    ? `${ACTION_LABELS[last.action] || last.action}${last.note ? '：' + last.note : ''}`
    : '暂无审核记录';
  return {
    ...item,
    statusLabel: verificationStatusLabel(item.status),
    reviewText,
    submittedText: formatDateTime(item.submittedAt),
  };
}

Page({
  data: {
    loading: true,
    error: '',
    items: [] as HistoryView[],
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

  onPullDownRefresh(): void {
    void this.load().then(() => {
      wx.stopPullDownRefresh();
    });
  },

  async load(): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const result = await listVerifications({ page: 1, pageSize: 20 });
      this.setData({ items: (result.items || []).map(toView), loading: false });
    } catch (error) {
      this.setData({ loading: false, error: '认证历史加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    void this.load();
  },
});
