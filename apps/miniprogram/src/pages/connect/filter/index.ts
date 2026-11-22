import { getState, setConnectFilter } from '../../../store/index';
import type { IndustryDto, RegionDto } from '../../../types/index';
import { createConnectFilterDraft, toConnectFilterPatch } from '../../../utils/filter';

Page({
  data: {
    regions: [] as RegionDto[],
    industries: [] as IndustryDto[],
    regionCode: '',
    industryCode: '',
  },

  onLoad(): void {
    const state = getState();
    // 草稿一律从 store 里当前生效的条件派生（真机反馈 16:31 的重构点）
    const draft = createConnectFilterDraft(state.connectFilter);
    this.setData({
      regions: state.regions,
      industries: state.industries,
      regionCode: draft.regionCode,
      industryCode: draft.industryCode,
    });
  },

  onRegionTap(event: WechatMiniprogram.BaseEvent): void {
    const code = (event.currentTarget.dataset.code as string) || '';
    this.setData({ regionCode: this.data.regionCode === code ? '' : code });
  },

  onIndustryTap(event: WechatMiniprogram.BaseEvent): void {
    const code = (event.currentTarget.dataset.code as string) || '';
    this.setData({ industryCode: this.data.industryCode === code ? '' : code });
  },

  /** 重置：清空地区与行业（信息类型在列表页即时生效，不归二级页管） */
  onReset(): void {
    this.setData({ regionCode: '', industryCode: '' });
  },

  onConfirm(): void {
    // ⚠️ 只提交地区与行业：类型筛选保留在连接列表页的 chip 上，避免两个入口互相覆盖。
    setConnectFilter(
      toConnectFilterPatch({
        regionCode: this.data.regionCode,
        industryCode: this.data.industryCode,
      })
    );
    wx.navigateBack({ delta: 1 });
  },
});
