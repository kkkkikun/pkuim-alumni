import type { ArticleDto } from '../../types/index';

Component({
  properties: {
    article: {
      type: Object,
      value: null as unknown as ArticleDto,
    },
  },
  methods: {
    onTap(): void {
      this.triggerEvent('tap', { article: this.properties.article });
    },
  },
});
