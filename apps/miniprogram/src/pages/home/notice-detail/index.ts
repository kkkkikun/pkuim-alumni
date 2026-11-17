import { getNotice } from '../../../services';
import type { NoticeDto } from '../../../types';

Page({
  data: {
    loading: true,
    error: '',
    notice: null as NoticeDto | null,
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
      const notice = await getNotice(id);
      this.setData({ notice, loading: false });
      wx.setNavigationBarTitle({ title: '公告详情' });
    } catch (error) {
      this.setData({ loading: false, error: '公告加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    const notice = this.data.notice;
    void this.load(notice ? notice.id : 0);
  },
});
