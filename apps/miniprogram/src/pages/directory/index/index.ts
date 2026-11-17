import { listDirectory } from '../../../services';
import { getDirectoryFilter, getState, setDirectoryFilter } from '../../../store';
import type { DirectoryEntry } from '../../../types';
import { directoryProfileUrl, navigateTo } from '../../../utils/navigate';
import { resetPageScroll, restorePageScroll, trackPageScroll } from '../../../utils/scroll';
import { setTabBarSelected } from '../../../utils/tabbar';

const PAGE_SIZE = 15;

interface DirectoryView extends DirectoryEntry {
  regionLabel: string;
  dimLabel: string;
  displayInitial: string;
}

function toView(entry: DirectoryEntry): DirectoryView {
  const parts: string[] = [];
  if (entry.graduationYear) {
    parts.push(`${entry.graduationYear}届`);
  }
  if (entry.college) {
    parts.push(entry.college);
  }
  if (entry.industryName) {
    parts.push(entry.industryName);
  }
  return {
    ...entry,
    regionLabel: entry.regionName || '地区待完善',
    dimLabel: parts.join(' · '),
    displayInitial: entry.displayName ? entry.displayName.charAt(0) : '燕',
  };
}

Page({
  data: {
    loading: true,
    error: '',
    entries: [] as DirectoryView[],
    keyword: '',
    regionLabel: '全部地区',
    industryLabel: '全部行业',
    page: 1,
    total: 0,
    hasMore: false,
  },

  onLoad(): void {
    this.syncFilterLabel();
    void this.load(1);
  },

  onShow(): void {
    setTabBarSelected(1);
    this.syncFilterLabel();
    restorePageScroll('directory');
  },

  onPageScroll: trackPageScroll('directory'),

  onPullDownRefresh(): void {
    void this.load(1).then(() => {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom(): void {
    if (this.data.hasMore && !this.data.loading) {
      void this.load(this.data.page + 1);
    }
  },

  /** 同步全局筛选条件到页面展示 */
  syncFilterLabel(): void {
    const filter = getDirectoryFilter();
    const state = getState();
    const region = state.regions.find((item) => item.code === filter.regionCode);
    const industry = state.industries.find((item) => item.code === filter.industryCode);
    this.setData({
      keyword: filter.keyword,
      regionLabel: region ? region.name : '全部地区',
      industryLabel: industry ? industry.name : '全部行业',
    });
  },

  async load(page: number): Promise<void> {
    this.setData({ loading: true, error: '' });
    const filter = getDirectoryFilter();
    try {
      const result = await listDirectory({
        keyword: filter.keyword || undefined,
        regionCode: filter.regionCode || undefined,
        industryCode: filter.industryCode || undefined,
        graduationYear: filter.graduationYear || undefined,
        page,
        pageSize: PAGE_SIZE,
      });
      const items = (result.items || []).map(toView);
      const merged = page === 1 ? items : this.data.entries.concat(items);
      this.setData({
        entries: merged,
        page,
        total: result.meta ? result.meta.total : merged.length,
        hasMore: result.meta ? page < result.meta.totalPages : false,
        loading: false,
      });
    } catch (error) {
      this.setData({ loading: false, error: '通讯录加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    void this.load(1);
  },

  onSearchInput(event: WechatMiniprogram.Input): void {
    setDirectoryFilter({ keyword: event.detail.value });
  },

  onSearchConfirm(): void {
    resetPageScroll('directory');
    void this.load(1);
  },

  onClearSearch(): void {
    setDirectoryFilter({ keyword: '' });
    this.setData({ keyword: '' });
    void this.load(1);
  },

  onFilterTap(): void {
    navigateTo('/pages/directory/filter/index');
  },

  onEntryTap(event: WechatMiniprogram.CustomEvent<{ entry: DirectoryEntry }>): void {
    navigateTo(directoryProfileUrl(event.detail.entry.userId));
  },
});
