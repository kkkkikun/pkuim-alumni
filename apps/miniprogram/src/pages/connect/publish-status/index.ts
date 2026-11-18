import { getResource, submitResource, withdrawResource } from '../../../services/index';
import type { ResourcePostDto } from '../../../types/index';
import { resourceStatusLabel } from '../../../utils/format';
import { closeDialog, initialDialogState, openDialog } from '../../../utils/dialog';
import { showSuccess } from '../../../utils/feedback';

interface ReviewView {
  actionLabel: string;
  note: string;
  createdAt: string;
}

interface PostView extends ResourcePostDto {
  typeLabel: string;
  statusLabel: string;
  canSubmit: boolean;
  canWithdraw: boolean;
}

const ACTION_LABELS: Record<string, string> = {
  approve: '通过审核',
  reject: '审核未通过',
  request_changes: '要求修改',
  offline: '管理员下架',
};

function toView(post: ResourcePostDto): PostView {
  return {
    ...post,
    typeLabel: post.type === 'resource' ? '校友资源' : '合作需求',
    statusLabel: resourceStatusLabel(post.status),
    canSubmit: post.status === 'draft' || post.status === 'rejected',
    canWithdraw: post.status === 'pending' || post.status === 'published',
  };
}

Page({
  data: {
    loading: true,
    error: '',
    post: null as PostView | null,
    reviews: [] as ReviewView[],
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
      const post = await getResource(id);
      const reviews = (post.reviews || []).map((review) => ({
        actionLabel: ACTION_LABELS[review.action] || review.action,
        note: review.note || '—',
        createdAt: review.createdAt,
      }));
      this.setData({ post: toView(post), reviews, loading: false });
    } catch (error) {
      this.setData({ loading: false, error: '审核状态加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    const post = this.data.post;
    void this.load(post ? post.id : 0);
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

  async onSubmitReview(): Promise<void> {
    const post = this.data.post;
    if (!post) {
      return;
    }
    const confirmed = await this.showConfirmDialog({
      title: '提交审核',
      content: '提交后校友会将开始审核，审核期间内容不会公开展示。',
      confirmText: '提交',
    });
    if (!confirmed) {
      return;
    }
    try {
      await submitResource(post.id);
      showSuccess('已提交审核');
      await this.load(post.id);
    } catch (error) {
      this.setData({ actionError: '提交失败，请稍后重试' });
    }
  },

  async onWithdraw(): Promise<void> {
    const post = this.data.post;
    if (!post) {
      return;
    }
    const confirmed = await this.showConfirmDialog({
      title: '撤回发布',
      content: '撤回后该内容将从连接广场移除，你可以重新编辑并再次提交。',
      confirmText: '撤回',
    });
    if (!confirmed) {
      return;
    }
    try {
      await withdrawResource(post.id);
      showSuccess('已撤回');
      await this.load(post.id);
    } catch (error) {
      this.setData({ actionError: '撤回失败，请稍后重试' });
    }
  },
});
