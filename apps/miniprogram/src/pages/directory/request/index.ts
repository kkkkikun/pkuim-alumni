import { createConnectionRequest, getAlumniProfile } from '../../../services';
import { showSuccess } from '../../../utils/feedback';

const MIN_LENGTH = 6;
const MAX_LENGTH = 300;

Page({
  data: {
    loading: true,
    error: '',
    targetId: 0,
    targetName: '该校友',
    targetMeta: '',
    message: '',
    submitting: false,
    submitError: '',
    success: false,
  },

  onLoad(options: Record<string, string | undefined>): void {
    const id = Number(options.id);
    if (!Number.isFinite(id) || id <= 0) {
      this.setData({ loading: false, error: '参数错误' });
      return;
    }
    this.setData({ targetId: id });
    void this.load(id);
  },

  async load(id: number): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      // 公开名片投影，与通讯录条目同构
      const detail = await getAlumniProfile(id);
      const meta = [detail.graduationYear ? `${detail.graduationYear}届` : '', detail.regionName || '']
        .filter(Boolean)
        .join(' · ');
      this.setData({
        targetName: detail.displayName || '该校友',
        targetMeta: meta,
        loading: false,
      });
    } catch (error) {
      this.setData({ loading: false, error: '校友资料加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    void this.load(this.data.targetId);
  },

  onMessageInput(event: WechatMiniprogram.Input): void {
    this.setData({ message: event.detail.value, submitError: '' });
  },

  async onSubmit(): Promise<void> {
    if (this.data.submitting) {
      return;
    }
    const message = this.data.message.trim();
    if (message.length < MIN_LENGTH) {
      this.setData({ submitError: `请至少填写 ${MIN_LENGTH} 个字的交流说明` });
      return;
    }
    if (message.length > MAX_LENGTH) {
      this.setData({ submitError: `交流说明请控制在 ${MAX_LENGTH} 字以内` });
      return;
    }
    this.setData({ submitting: true, submitError: '' });
    try {
      await createConnectionRequest({ targetUserId: this.data.targetId, message });
      this.setData({ submitting: false, success: true });
      showSuccess('联系申请已提交');
    } catch (error) {
      this.setData({ submitting: false, submitError: '提交失败，请稍后重试' });
    }
  },

  onViewResult(): void {
    wx.redirectTo({ url: `/pages/directory/request-result/index?id=${this.data.targetId}` });
  },
});
