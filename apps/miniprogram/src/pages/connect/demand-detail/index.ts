import { getResource } from '../../../services';
import { getState } from '../../../store';
import type { ResourcePostDto } from '../../../types';
import { resourceStatusLabel } from '../../../utils/format';
import { navigateTo } from '../../../utils/navigate';

interface PostView extends ResourcePostDto {
  typeLabel: string;
  statusLabel: string;
  isMine: boolean;
}

function toView(post: ResourcePostDto): PostView {
  const myId = getState().user ? getState().user!.id : 0;
  return {
    ...post,
    typeLabel: '我有需求',
    statusLabel: resourceStatusLabel(post.status),
    isMine: post.authorId === myId,
  };
}

Page({
  data: {
    loading: true,
    error: '',
    post: null as PostView | null,
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
      this.setData({ post: toView(post), loading: false });
    } catch (error) {
      this.setData({ loading: false, error: '需求详情加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    const post = this.data.post;
    void this.load(post ? post.id : 0);
  },

  onIntentTap(): void {
    const post = this.data.post;
    if (!post) {
      return;
    }
    navigateTo(`/pages/connect/intent/index?id=${post.id}`);
  },

  onStatusTap(): void {
    const post = this.data.post;
    if (!post) {
      return;
    }
    navigateTo(`/pages/connect/publish-status/index?id=${post.id}`);
  },
});
