import type { ResourcePostDto } from '../../types/index';

Component({
  properties: {
    post: {
      type: Object,
      value: null as unknown as ResourcePostDto,
    },
    /** 是否展示审核状态（我的发布场景） */
    showStatus: { type: Boolean, value: false },
  },
  methods: {
    onTap(): void {
      this.triggerEvent('tap', { post: this.properties.post });
    },
  },
});
