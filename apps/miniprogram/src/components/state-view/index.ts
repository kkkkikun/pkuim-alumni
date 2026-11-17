Component({
  properties: {
    /** idle | loading | error | empty */
    status: { type: String, value: 'idle' },
    errorText: { type: String, value: '' },
    emptyText: { type: String, value: '这里还没有内容' },
    emptyDesc: { type: String, value: '' },
    /** 错误状态下是否展示重试按钮 */
    retryable: { type: Boolean, value: true },
  },
  methods: {
    onRetry(): void {
      this.triggerEvent('retry');
    },
  },
});
