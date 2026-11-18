import { getNotification, markNotificationRead } from '../../../services/index';
import type { NotificationDto } from '../../../types/index';
import { formatDateTime } from '../../../utils/format';
import { showToast } from '../../../utils/feedback';
import { readId } from '../../../utils/navigate';

const TYPE_LABEL: Record<string, string> = {
  verification_submitted: '认证申请',
  verification_decision: '认证结果',
  connection_request: '连接申请',
  connection_decision: '连接申请',
  resource_review: '资源审核',
  event_registration: '活动报名',
  event_changed: '活动变更',
  system: '系统通知',
};

Page({
  data: {
    loading: true,
    error: '',
    id: 0,
    typeLabel: '通知',
    title: '',
    body: '',
    read: false,
    /** 通知时间（已格式化，形如 `2026-01-08 19:30`） */
    createdText: '',
  },

  onLoad(options: Record<string, string | undefined>): void {
    const id = readId(options);
    if (!id) {
      this.setData({ loading: false, error: '通知不存在' });
      return;
    }
    this.setData({ id });
    void this.load(id);
  },

  async load(id: number): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const item: NotificationDto = await getNotification(id);
      this.setData({
        typeLabel: TYPE_LABEL[item.type] || '通知',
        title: item.title,
        body: item.body,
        read: item.read,
        createdText: formatDateTime(item.createdAt),
        loading: false,
      });
      // 打开详情即视为已读
      if (!item.read) {
        try {
          await markNotificationRead(id);
          this.setData({ read: true });
        } catch (error) {
          // 忽略：已读状态下次进入时再补
        }
      }
    } catch (error) {
      this.setData({ loading: false, error: '通知详情加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    const id = this.data.id;
    if (id) void this.load(id);
  },

  onCopyTap(): void {
    const body = this.data.body;
    if (!body) return;
    wx.setClipboardData({
      data: body,
      success: () => showToast('已复制'),
    });
  },
});
