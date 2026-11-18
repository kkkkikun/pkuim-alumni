import { createConnectionRequest, getResource } from '../../../services/index';
import type { ResourcePostDto } from '../../../types/index';
import { showSuccess } from '../../../utils/feedback';
import { navigateTo } from '../../../utils/navigate';

const MIN_LENGTH = 6;
const MAX_LENGTH = 300;

Page({
  data: {
    loading: true,
    error: '',
    postId: 0,
    postTitle: '',
    postAuthor: '',
    authorId: 0,
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
    this.setData({ postId: id });
    void this.load(id);
  },

  async load(id: number): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const post: ResourcePostDto = await getResource(id);
      this.setData({
        postTitle: post.title,
        postAuthor: post.authorName,
        authorId: post.authorId,
        loading: false,
      });
    } catch (error) {
      this.setData({ loading: false, error: '信息加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    void this.load(this.data.postId);
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
    if (!this.data.authorId) {
      this.setData({ submitting: false, submitError: '未能获取发布者信息，请稍后重试' });
      return;
    }
    try {
      const request = await createConnectionRequest({ targetUserId: this.data.authorId, message });
      this.setData({ submitting: false, success: true });
      showSuccess('合作意向已提交');
      wx.redirectTo({ url: `/pages/connect/request-detail/index?id=${request.id}` });
    } catch (error) {
      this.setData({ submitting: false, submitError: '提交失败，请稍后重试' });
    }
  },

  onBack(): void {
    navigateTo('/pages/connect/index/index');
  },
});
