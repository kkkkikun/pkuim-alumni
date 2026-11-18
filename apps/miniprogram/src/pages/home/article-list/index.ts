import { listArticles } from '../../../services/index';
import { getState } from '../../../store/index';
import type { ArticleCategoryDto } from '../../../types/index';
import { toArticleView } from '../../../utils/view';
import type { ArticleView } from '../../../utils/view';
import { articleDetailUrl, navigateTo } from '../../../utils/navigate';
import { resetPageScroll, restorePageScroll, trackPageScroll } from '../../../utils/scroll';

const PAGE_SIZE = 10;

Page({
  data: {
    loading: true,
    error: '',
    articles: [] as ReturnType<typeof toArticleView>[],
    categories: [] as ArticleCategoryDto[],
    categoryId: 0,
    page: 1,
    total: 0,
    hasMore: false,
  },

  onLoad(): void {
    this.setData({ categories: getState().categories });
    void this.load(1);
  },

  onShow(): void {
    restorePageScroll('article-list');
  },

  onPageScroll: trackPageScroll('article-list'),

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

  async load(page: number): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const result = await listArticles({
        page,
        pageSize: PAGE_SIZE,
        categoryId: this.data.categoryId || undefined,
      });
      const items = (result.items || []).map(toArticleView);
      const merged = page === 1 ? items : this.data.articles.concat(items);
      this.setData({
        articles: merged,
        page,
        total: result.meta ? result.meta.total : merged.length,
        hasMore: result.meta ? page < result.meta.totalPages : false,
        loading: false,
      });
      if (page === 1) {
        resetPageScroll('article-list');
      }
    } catch (error) {
      this.setData({ loading: false, error: '资讯加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    void this.load(1);
  },

  onCategoryTap(event: WechatMiniprogram.BaseEvent): void {
    const id = Number(event.currentTarget.dataset.id) || 0;
    if (id === this.data.categoryId) {
      return;
    }
    this.setData({ categoryId: id });
    void this.load(1);
  },

  onArticleTap(event: WechatMiniprogram.CustomEvent<{ article: ArticleView }>): void {
    navigateTo(articleDetailUrl(event.detail.article.id));
  },
});
