import { getState, setConnectFilter } from '../../../store/index';
import type { RegionDto } from '../../../types/index';

Page({
  data: {
    regions: [] as RegionDto[],
    regionCode: '',
    type: 'all' as 'all' | 'resource' | 'demand',
  },

  onLoad(): void {
    const state = getState();
    const filter = state.connectFilter;
    this.setData({
      regions: state.regions,
      regionCode: filter.regionCode,
      type: filter.type,
    });
  },

  onRegionTap(event: WechatMiniprogram.BaseEvent): void {
    const code = (event.currentTarget.dataset.code as string) || '';
    this.setData({ regionCode: this.data.regionCode === code ? '' : code });
  },

  onTypeTap(event: WechatMiniprogram.BaseEvent): void {
    const type = (event.currentTarget.dataset.type as 'all' | 'resource' | 'demand') || 'all';
    this.setData({ type });
  },

  onReset(): void {
    this.setData({ regionCode: '', type: 'all' });
  },

  onConfirm(): void {
    setConnectFilter({ regionCode: this.data.regionCode, type: this.data.type });
    wx.navigateBack({ delta: 1 });
  },
});
