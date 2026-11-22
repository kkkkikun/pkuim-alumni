import { listResources } from '../../../services/index';
import { getConnectFilter, getState, resetConnectFilter, setConnectFilter } from '../../../store/index';
import type { ResourcePostDto } from '../../../types/index';
import { connectFilterSignature, isConnectFilterActive } from '../../../utils/filter';
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
    regionLabel: '全部地区',
    industryLabel: '全部行业',
    typeLabel: '全部',
    page: 1,
    total: 0,
    hasMore: false,
    /** 上一次请求时用到的筛选条件签名（真机缺陷 #161） */
    loadedSignature: '',
    /** 当前是否有生效中的筛选条件（空状态提示用） */
    filterActive: false,
  },

  onLoad(): void {
    this.syncFilterLabel();
    void this.load(1);
  },

  onShow(): void {
    setTabBarSelected(2);
    this.syncFilterLabel();
    restorePageScroll('connect');
    // ⚠️ 真机缺陷 #161：从筛选页返回时筛选条件可能已经变了，
    //   必须重新拉数据，否则「标签变了、列表没变、计数也没变」。
    this.reloadIfFilterChanged();
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
      industryLabel: industry ? industry.name : '全部行业',
      typeLabel: filter.type === 'resource' ? '我能提供' : filter.type === 'demand' ? '我有需求' : '全部',
      filterActive: isConnectFilterActive(filter),
    });
  },

  /** 筛选条件变了就重载列表（真机缺陷 #161） */
  reloadIfFilterChanged(): void {
    const loaded = this.data.loadedSignature;
    if (!loaded) {
      // 还没加载过（首次 onShow 紧跟 onLoad），不要重复请求
      return;
    }
    if (connectFilterSignature(getConnectFilter()) !== loaded) {
      void this.load(1);
    }
  },

  async load(page: number): Promise<void> {
    this.setData({ loading: true, error: '' });
    const filter = getConnectFilter();
    const signature = connectFilterSignature(filter);
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
        loadedSignature: signature,
        filterActive: isConnectFilterActive(filter),
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

  /** 信息类型（全部 / 我能提供 / 我有需求）—— 页面上直接给入口，点完立刻生效 */
  onTypeTap(event: WechatMiniprogram.BaseEvent): void {
    const type = (event.currentTarget.dataset.type as 'all' | 'resource' | 'demand') || 'all';
    setConnectFilter({ type });
    this.syncFilterLabel();
    void this.load(1);
  },

  /** 地区 / 行业筛选入口 —— 都进同一个二级筛选页（真机反馈 16:31） */
  onFilterTap(): void {
    navigateTo('/pages/connect/filter/index');
  },

  /** 清空全部筛选条件（空状态里的「清空筛选条件」） */
  onClearFilters(): void {
    resetConnectFilter();
    this.syncFilterLabel();
    void this.load(1);
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
