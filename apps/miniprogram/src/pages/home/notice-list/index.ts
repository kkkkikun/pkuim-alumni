import { listNotices } from '../../../services/index';
import type { NoticeDto } from '../../../types/index';
import { navigateTo, noticeDetailUrl } from '../../../utils/navigate';
import { resetPageScroll, restorePageScroll, trackPageScroll } from '../../../utils/scroll';
import { toNoticeView } from '../../../utils/view';
import type { NoticeView } from '../../../utils/view';

const PAGE_SIZE = 10;

Page({
  data: {
    loading: true,
    error: '',
    notices: [] as NoticeView[],
    page: 1,
    hasMore: false,
  },

  onLoad(): void {
    void this.load(1);
  },

  onShow(): void {
    restorePageScroll('notice-list');
  },

  onPageScroll: trackPageScroll('notice-list'),

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
      const result = await listNotices({ page, pageSize: PAGE_SIZE });
      const items = (result.items || []).map(toNoticeView);
      const merged = page === 1 ? items : this.data.notices.concat(items);
      this.setData({
        notices: merged,
        page,
        hasMore: result.meta ? page < result.meta.totalPages : false,
        loading: false,
      });
      if (page === 1) {
        resetPageScroll('notice-list');
      }
    } catch (error) {
      this.setData({ loading: false, error: '公告加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    void this.load(1);
  },

  onNoticeTap(event: WechatMiniprogram.CustomEvent<{ notice: NoticeDto }>): void {
    navigateTo(noticeDetailUrl(event.detail.notice.id));
  },
});
