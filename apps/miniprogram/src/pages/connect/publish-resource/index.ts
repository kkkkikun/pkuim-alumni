import { createResource } from '../../../services';
import { getState } from '../../../store';
import type { IndustryDto, RegionDto } from '../../../types';
import { showSuccess } from '../../../utils/feedback';
import { navigateTo } from '../../../utils/navigate';

const TITLE_MIN = 5;
const TITLE_MAX = 42;
const BODY_MIN = 10;
const BODY_MAX = 400;

Page({
  data: {
    title: '',
    body: '',
    industries: [] as IndustryDto[],
    regions: [] as RegionDto[],
    industryIndex: -1,
    regionIndex: -1,
    submitting: false,
    submitError: '',
    success: false,
    createdId: 0,
  },

  onLoad(): void {
    const state = getState();
    this.setData({ industries: state.industries, regions: state.regions });
  },

  onTitleInput(event: WechatMiniprogram.Input): void {
    this.setData({ title: event.detail.value, submitError: '' });
  },

  onBodyInput(event: WechatMiniprogram.Input): void {
    this.setData({ body: event.detail.value, submitError: '' });
  },

  onIndustryChange(event: WechatMiniprogram.PickerChange): void {
    this.setData({ industryIndex: Number(event.detail.value), submitError: '' });
  },

  onRegionChange(event: WechatMiniprogram.PickerChange): void {
    this.setData({ regionIndex: Number(event.detail.value), submitError: '' });
  },

  async onSubmit(): Promise<void> {
    if (this.data.submitting) {
      return;
    }
    const title = this.data.title.trim();
    const body = this.data.body.trim();
    if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
      this.setData({ submitError: `标题请控制在 ${TITLE_MIN}–${TITLE_MAX} 字` });
      return;
    }
    if (body.length < BODY_MIN || body.length > BODY_MAX) {
      this.setData({ submitError: `详细说明请控制在 ${BODY_MIN}–${BODY_MAX} 字` });
      return;
    }
    if (this.data.industryIndex < 0) {
      this.setData({ submitError: '请选择所属领域' });
      return;
    }
    if (this.data.regionIndex < 0) {
      this.setData({ submitError: '请选择所属盟市' });
      return;
    }
    const industry = this.data.industries[this.data.industryIndex];
    const region = this.data.regions[this.data.regionIndex];
    this.setData({ submitting: true, submitError: '' });
    try {
      const post = await createResource({
        type: 'resource',
        title,
        body,
        industryCode: industry ? industry.code : undefined,
        regionCode: region ? region.code : undefined,
      });
      this.setData({ submitting: false, success: true, createdId: post.id });
      showSuccess('已提交，等待审核');
    } catch (error) {
      this.setData({ submitting: false, submitError: '发布失败，请稍后重试' });
    }
  },

  onViewStatus(): void {
    navigateTo(`/pages/connect/publish-status/index?id=${this.data.createdId}`);
  },

  onBackToList(): void {
    wx.switchTab({ url: '/pages/connect/index/index' });
  },
});
