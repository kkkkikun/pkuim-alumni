import {
  fetchUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../../../services/index';
import type { NotificationDto } from '../../../types/index';
import { showToast } from '../../../utils/feedback';
import { navigateTo } from '../../../utils/navigate';
import { restorePageScroll, trackPageScroll } from '../../../utils/scroll';

/** 通知类型 → 展示用图标与文案前缀 */
const TYPE_META: Record<string, { icon: string; label: string }> = {
  verification_submitted: { icon: '认', label: '认证' },
  verification_decision: { icon: '认', label: '认证' },
  connection_request: { icon: '连', label: '连接' },
  connection_decision: { icon: '连', label: '连接' },
  resource_review: { icon: '审', label: '资源' },
  event_registration: { icon: '活', label: '活动' },
  event_changed: { icon: '活', label: '活动' },
  system: { icon: '通', label: '系统' },
};

interface NotificationView extends NotificationDto {
  icon: string;
  typeLabel: string;
  timeText: string;
}

function toView(item: NotificationDto): NotificationView {
  const meta = TYPE_META[item.type] ?? { icon: '通', label: '通知' };
  return {
    ...item,
    icon: meta.icon,
    typeLabel: meta.label,
    timeText: formatTime(item.createdAt),
  };
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

Page({
  data: {
    loading: true,
    error: '',
    items: [] as NotificationView[],
    unread: 0,
  },

  onLoad(): void {
    void this.load();
  },

  onShow(): void {
    void this.load();
    restorePageScroll('me-notifications');
  },

  onPageScroll: trackPageScroll('me-notifications'),

  onPullDownRefresh(): void {
    void this.load().then(() => {
      wx.stopPullDownRefresh();
    });
  },

  async load(): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const [list, count] = await Promise.all([
        listNotifications({ page: 1, pageSize: 50 }),
        fetchUnreadCount(),
      ]);
      this.setData({
        items: (list.items || []).map(toView),
        unread: count && typeof count.unread === 'number' ? count.unread : 0,
        loading: false,
      });
    } catch (error) {
      this.setData({ loading: false, error: '通知加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    void this.load();
  },

  onItemTap(event: WechatMiniprogram.BaseEvent): void {
    const id = Number(event.currentTarget.dataset.id);
    if (!id) return;
    navigateTo(`/pages/me/notification-detail/index?id=${id}`);
  },

  async onMarkAllRead(): Promise<void> {
    if (this.data.unread === 0) {
      showToast('没有未读通知');
      return;
    }
    try {
      await markAllNotificationsRead();
      showToast('已全部标记为已读');
      void this.load();
    } catch (error) {
      showToast('操作失败，请稍后重试');
    }
  },

  async onMarkRead(event: WechatMiniprogram.BaseEvent): Promise<void> {
    const id = Number(event.currentTarget.dataset.id);
    if (!id) return;
    try {
      await markNotificationRead(id);
      void this.load();
    } catch (error) {
      // 静默失败：进入详情页会自动标记已读
    }
  },
});
