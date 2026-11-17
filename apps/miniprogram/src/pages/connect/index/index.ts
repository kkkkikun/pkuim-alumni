import { listResources } from '../../../services';
import { getConnectFilter, getState, setConnectFilter } from '../../../store';
import type { IndustryDto, RegionDto, ResourcePostDto } from '../../../types';
import { navigateTo } from '../../../utils/navigate';
import { resetPageScroll, restorePageScroll, trackPageScroll } from '../../../utils/scroll';
import { setTabBarSelected } from '../../../utils/tabbar';

const PAGE_SIZE = 10;

interface OpportunityView extends ResourcePostDto {
  typeLabel: string;
}

function toView(post: ResourcePostDto): OpportunityView {
  return {
    ...post,
    typeLabel: post.type === 'resource' ? '我能提供' : '我有需求',
  };
}

Page({
  data: {
    loading: true,
    error: '',
    posts: [] as OpportunityView[],
    regions: [] as RegionDto[],
    industries: [] as IndustryDto[],
    regionLabel: '全部地区',
    industryLabel: '全部',
    typeLabel: '全部',
    page: 1,
    total: 0,
    hasMore: false,
  },

  onLoad(): void {
    const state = getState();
    this.setData({ regions: state.regions, industries: state.industries });
    this.syncFilterLabel();
    void this.load(1);
  },

  onShow(): void {
    setTabBarSelected(2);
    this.syncFilterLabel();
    restorePageScroll('connect');
  },

  onPageScroll: trackPageScroll('connect'),

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

  syncFilterLabel(): void {
    const filter = getConnectFilter();
    const state = getState();
    const region = state.regions.find((item) => item.code === filter.regionCode);
    const industry = state.industries.find((item) => item.code === filter.industryCode);
    this.setData({
      regionLabel: region ? region.name : '全部地区',
      industryLabel: industry ? industry.name : '全部',
      typeLabel: filter.type === 'resource' ? '我能提供' : filter.type === 'demand' ? '我有需求' : '全部',
    });
  },

  async load(page: number): Promise<void> {
    this.setData({ loading: true, error: '' });
    const filter = getConnectFilter();
    try {
      const result = await listResources({
        type: filter.type,
        regionCode: filter.regionCode || undefined,
        industryCode: filter.industryCode || undefined,
        page,
        pageSize: PAGE_SIZE,
      });
      const items = (result.items || []).map(toView);
      const merged = page === 1 ? items : this.data.posts.concat(items);
      this.setData({
        posts: merged,
        page,
        total: result.meta ? result.meta.total : merged.length,
        hasMore: result.meta ? page < result.meta.totalPages : false,
        loading: false,
      });
      if (page === 1) {
        resetPageScroll('connect');
      }
    } catch (error) {
      this.setData({ loading: false, error: '连接信息加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    void this.load(1);
  },

  onIndustryTap(event: WechatMiniprogram.BaseEvent): void {
    const code = (event.currentTarget.dataset.code as string) || '';
    setConnectFilter({ industryCode: code });
    this.syncFilterLabel();
    void this.load(1);
  },

  onRegionFilterTap(): void {
    navigateTo('/pages/connect/filter/index');
  },

  onPublishResource(): void {
    navigateTo('/pages/connect/publish-resource/index');
  },

  onPublishDemand(): void {
    navigateTo('/pages/connect/publish-demand/index');
  },

  onPostTap(event: WechatMiniprogram.CustomEvent<{ post: ResourcePostDto }>): void {
    const post = event.detail.post;
    navigateTo(
      post.type === 'resource'
        ? `/pages/connect/resource-detail/index?id=${post.id}`
        : `/pages/connect/demand-detail/index?id=${post.id}`
    );
  },
});
