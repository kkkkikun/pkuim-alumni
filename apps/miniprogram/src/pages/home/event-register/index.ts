import { getEvent, registerEvent } from '../../../services/index';
import { showSuccess } from '../../../utils/feedback';
import { navigateTo } from '../../../utils/navigate';
import { toEventView } from '../../../utils/view';
import type { EventView } from '../../../utils/view';

Page({
  data: {
    loading: true,
    error: '',
    submitting: false,
    submitError: '',
    success: false,
    note: '',
    event: null as EventView | null,
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
      const event = await getEvent(id);
      this.setData({ event: toEventView(event), loading: false });
    } catch (error) {
      this.setData({ loading: false, error: '活动加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    const event = this.data.event;
    void this.load(event ? event.id : 0);
  },

  onNoteInput(event: WechatMiniprogram.Input): void {
    this.setData({ note: event.detail.value, submitError: '' });
  },

  async onSubmit(): Promise<void> {
    const event = this.data.event;
    if (!event) {
      return;
    }
    if (this.data.submitting) {
      return;
    }
    const note = this.data.note.trim();
    if (note.length > 200) {
      this.setData({ submitError: '备注请控制在 200 字以内' });
      return;
    }
    this.setData({ submitting: true, submitError: '' });
    try {
      await registerEvent(event.id, note);
      this.setData({ submitting: false, success: true });
      showSuccess('报名已提交');
    } catch (error) {
      this.setData({ submitting: false, submitError: '报名未成功，请稍后重试' });
    }
  },

  onBackToEvent(): void {
    const event = this.data.event;
    if (event) {
      wx.navigateBack({ delta: 1 });
    }
  },

  onMyRegistrationsTap(): void {
    navigateTo('/pages/home/my-registrations/index');
  },
});
