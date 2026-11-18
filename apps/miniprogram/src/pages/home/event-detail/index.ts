import { getEvent } from '../../../services/index';
import { registrationStatusLabel } from '../../../utils/format';
import { eventRegisterUrl, navigateTo } from '../../../utils/navigate';
import { requireVerified } from '../../../utils/guard';
import { toEventView } from '../../../utils/view';
import type { EventView } from '../../../utils/view';

Page({
  data: {
    loading: true,
    error: '',
    event: null as EventView | null,
    registered: false,
    registrationText: '',
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
      this.setData({
        event: toEventView(event),
        loading: false,
        registered: event.myRegistration === 'registered' || event.myRegistration === 'attended',
        registrationText: event.myRegistration ? registrationStatusLabel(event.myRegistration) : '',
      });
    } catch (error) {
      this.setData({ loading: false, error: '活动加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    const event = this.data.event;
    void this.load(event ? event.id : 0);
  },

  onRegisterTap(): void {
    const event = this.data.event;
    if (!event) {
      return;
    }
    if (!requireVerified('报名活动')) {
      return;
    }
    navigateTo(eventRegisterUrl(event.id));
  },

  onMyRegistrationsTap(): void {
    navigateTo('/pages/home/my-registrations/index');
  },
});
