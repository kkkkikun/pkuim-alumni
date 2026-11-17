import { listMyEvents } from '../../../services';
import type { EventDto } from '../../../types';
import { registrationStatusLabel } from '../../../utils/format';
import { navigateTo } from '../../../utils/navigate';
import { restorePageScroll, trackPageScroll } from '../../../utils/scroll';

const PAGE_SIZE = 10;

interface EventView extends EventDto {
  statusLabel: string;
}

function toView(event: EventDto): EventView {
  return {
    ...event,
    statusLabel: event.myRegistration ? registrationStatusLabel(event.myRegistration) : '未报名',
  };
}

Page({
  data: {
    loading: true,
    error: '',
    events: [] as EventView[],
    page: 1,
    hasMore: false,
  },

  onLoad(): void {
    void this.load(1);
  },

  onShow(): void {
    restorePageScroll('me-my-events');
  },

  onPageScroll: trackPageScroll('me-my-events'),

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
      const result = await listMyEvents({ page, pageSize: PAGE_SIZE });
      const items = (result.items || []).map(toView);
      const merged = page === 1 ? items : this.data.events.concat(items);
      this.setData({
        events: merged,
        page,
        hasMore: result.meta ? page < result.meta.totalPages : false,
        loading: false,
      });
    } catch (error) {
      this.setData({ loading: false, error: '我的活动加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    void this.load(1);
  },

  onEventTap(event: WechatMiniprogram.CustomEvent<{ event: EventDto }>): void {
    navigateTo(`/pages/home/event-detail/index?id=${event.detail.event.id}`);
  },
});
