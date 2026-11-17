import { listEvents } from '../../../services';
import type { EventDto } from '../../../types';
import { eventDetailUrl, navigateTo } from '../../../utils/navigate';
import { resetPageScroll, restorePageScroll, trackPageScroll } from '../../../utils/scroll';

const PAGE_SIZE = 10;

Page({
  data: {
    loading: true,
    error: '',
    events: [] as EventDto[],
    page: 1,
    hasMore: false,
  },

  onLoad(): void {
    void this.load(1);
  },

  onShow(): void {
    restorePageScroll('event-list');
  },

  onPageScroll: trackPageScroll('event-list'),

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
      const result = await listEvents({ page, pageSize: PAGE_SIZE });
      const items = result.items || [];
      const merged = page === 1 ? items : this.data.events.concat(items);
      this.setData({
        events: merged,
        page,
        hasMore: result.meta ? page < result.meta.totalPages : false,
        loading: false,
      });
      if (page === 1) {
        resetPageScroll('event-list');
      }
    } catch (error) {
      this.setData({ loading: false, error: '活动加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    void this.load(1);
  },

  onEventTap(event: WechatMiniprogram.CustomEvent<{ event: EventDto }>): void {
    navigateTo(eventDetailUrl(event.detail.event.id));
  },
});
