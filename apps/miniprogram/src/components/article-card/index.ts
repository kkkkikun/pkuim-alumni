import type { ArticleView } from '../../utils/view';

Component({
  properties: {
    article: {
      type: Object,
      value: null as unknown as ArticleView,
    },
  },
  methods: {
    onTap(): void {
      this.triggerEvent('tap', { article: this.properties.article });
    },
  },
});
