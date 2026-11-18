import { listMyResources } from '../../../services/index';
import type { ResourcePostDto } from '../../../types/index';
import { resourceStatusLabel } from '../../../utils/format';
import { navigateTo } from '../../../utils/navigate';
import { restorePageScroll, trackPageScroll } from '../../../utils/scroll';

const PAGE_SIZE = 10;

interface PostView extends ResourcePostDto {
  typeLabel: string;
  statusLabel: string;
}

function toView(post: ResourcePostDto): PostView {
  return {
    ...post,
    typeLabel: post.type === 'resource' ? '我能提供' : '我有需求',
    statusLabel: resourceStatusLabel(post.status),
  };
}

Page({
  data: {
    loading: true,
    error: '',
    posts: [] as PostView[],
    page: 1,
    hasMore: false,
  },

  onLoad(): void {
    void this.load(1);
  },

  onShow(): void {
    restorePageScroll('me-my-posts');
  },

  onPageScroll: trackPageScroll('me-my-posts'),

  onPullDownRefresh(): void {
    void this.load(1).then(() => {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom(): void {
    if (this.data.hasMore && !this.data.loading) {
      void this.load(this.data.page + 1);
    }
  },

  async load(page: number): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const result = await listMyResources({ page, pageSize: PAGE_SIZE });
      const items = (result.items || []).map(toView);
      const merged = page === 1 ? items : this.data.posts.concat(items);
      this.setData({
        posts: merged,
        page,
        hasMore: result.meta ? page < result.meta.totalPages : false,
        loading: false,
      });
    } catch (error) {
      this.setData({ loading: false, error: '我的发布加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    void this.load(1);
  },

  onPostTap(event: WechatMiniprogram.CustomEvent<{ post: ResourcePostDto }>): void {
    navigateTo(`/pages/connect/publish-status/index?id=${event.detail.post.id}`);
  },
});
