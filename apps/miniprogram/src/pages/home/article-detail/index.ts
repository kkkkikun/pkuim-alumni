import { getArticle } from '../../../services';
import type { ArticleDto } from '../../../types';
import { formatDate } from '../../../utils/format';

Page({
  data: {
    loading: true,
    error: '',
    article: null as ArticleDto | null,
  },

  onLoad(options: Record<string, string | undefined>): void {
    const id = Number(options.id);
    if (!Number.isFinite(id) || id <= 0) {
      this.setData({ loading: false, error: '参数错误' });
      return;
    }
    void this.load(id);
  },

  async load(id: number): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const article = await getArticle(id);
      this.setData({ article, loading: false });
      wx.setNavigationBarTitle({ title: article.categoryName || '资讯详情' });
    } catch (error) {
      this.setData({ loading: false, error: '资讯加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    const article = this.data.article;
    void this.load(article ? article.id : 0);
  },

  formatDate(value: string): string {
    return formatDate(value);
  },
});
