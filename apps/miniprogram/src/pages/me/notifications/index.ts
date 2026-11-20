import {
  fetchUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../../../services/index';
import type { NotificationDto } from '../../../types/index';
import { formatRelativeTime } from '../../../utils/format';
import { showToast } from '../../../utils/feedback';
import { navigateTo } from '../../../utils/navigate';
import { restorePageScroll, trackPageScroll } from '../../../utils/scroll';
import { shouldRefreshOnShow } from '../../../utils/first-show';

/** 通知类型 → 展示用图标与文案前缀 */
const TYPE_META: Record<string, { icon: string; label: string }> = {
  verification_submitted: { icon: '/assets/icons/notify-shield.png', label: '认证' },
  verification_decision: { icon: '/assets/icons/notify-check.png', label: '认证' },
  connection_request: { icon: '/assets/icons/notify-connect.png', label: '连接' },
  connection_decision: { icon: '/assets/icons/notify-handshake.png', label: '连接' },
  resource_review: { icon: '/assets/icons/notify-file.png', label: '资源' },
  event_registration: { icon: '/assets/icons/notify-calendar.png', label: '活动' },
  event_changed: { icon: '/assets/icons/notify-bell.png', label: '活动' },
  system: { icon: '/assets/icons/notify-info.png', label: '系统' },
};

interface NotificationView extends NotificationDto {
  icon: string;
  typeLabel: string;
  timeText: string;
}

function toView(item: NotificationDto): NotificationView {
  const meta = TYPE_META[item.type] ?? { icon: '/assets/icons/notify-info.png', label: '通知' };
  return {
    ...item,
    icon: meta.icon,
    typeLabel: meta.label,
    timeText: formatRelativeTime(item.createdAt),
  };
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
    // 首次进入时 onLoad 已经加载过，这里不再重复发请求；返回本页时才刷新。
    if (shouldRefreshOnShow(this)) {
      void this.load();
    }
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
