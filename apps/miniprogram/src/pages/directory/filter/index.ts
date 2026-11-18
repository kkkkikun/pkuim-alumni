import { getState } from '../../../store/index';
import { getDirectoryFilter, resetDirectoryFilter, setDirectoryFilter } from '../../../store/index';
import type { IndustryDto, RegionDto } from '../../../types/index';

function buildYearOptions(): number[] {
  const current = new Date().getFullYear();
  const years: number[] = [];
  for (let year = current; year > current - 6; year -= 1) {
    years.push(year);
  }
  return years;
}

Page({
  data: {
    regions: [] as RegionDto[],
    industries: [] as IndustryDto[],
    years: [] as number[],
    regionCode: '',
    industryCode: '',
    graduationYear: 0,
  },

  onLoad(): void {
    const filter = getDirectoryFilter();
    const state = getState();
    this.setData({
      regions: state.regions,
      industries: state.industries,
      years: buildYearOptions(),
      regionCode: filter.regionCode,
      industryCode: filter.industryCode,
      graduationYear: filter.graduationYear || 0,
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

  onYearTap(event: WechatMiniprogram.BaseEvent): void {
    const year = Number(event.currentTarget.dataset.year) || 0;
    this.setData({ graduationYear: this.data.graduationYear === year ? 0 : year });
  },

  onReset(): void {
    resetDirectoryFilter();
    this.setData({ regionCode: '', industryCode: '', graduationYear: 0 });
  },

  onConfirm(): void {
    setDirectoryFilter({
      regionCode: this.data.regionCode,
      industryCode: this.data.industryCode,
      graduationYear: this.data.graduationYear || null,
    });
    wx.navigateBack({ delta: 1 });
  },
});
