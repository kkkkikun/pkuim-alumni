import { listMyEvents } from '../../../services/index';
import type { EventDto } from '../../../types/index';
import { registrationStatusLabel } from '../../../utils/format';
import { eventDetailUrl, navigateTo } from '../../../utils/navigate';
import { restorePageScroll, trackPageScroll } from '../../../utils/scroll';
import { toEventView } from '../../../utils/view';
import type { EventView } from '../../../utils/view';

const PAGE_SIZE = 10;

/** 列表展示模型：预先算好状态文案（WXML 不能调用页面方法） */
interface RegistrationView extends EventView {
  statusLabel: string;
}

function toView(event: EventDto): RegistrationView {
  return {
    ...toEventView(event),
    statusLabel: event.myRegistration ? registrationStatusLabel(event.myRegistration) : '未报名',
  };
}

Page({
  data: {
    loading: true,
    error: '',
    events: [] as RegistrationView[],
    page: 1,
    hasMore: false,
  },

  onLoad(): void {
    void this.load(1);
  },

  onShow(): void {
    restorePageScroll('my-registrations');
  },

  onPageScroll: trackPageScroll('my-registrations'),

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
      this.setData({ loading: false, error: '报名记录加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    void this.load(1);
  },

  onEventTap(event: WechatMiniprogram.CustomEvent<{ event: EventDto }>): void {
    navigateTo(eventDetailUrl(event.detail.event.id));
  },
});
