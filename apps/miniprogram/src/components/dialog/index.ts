Component({
  properties: {
    visible: { type: Boolean, value: false },
    title: { type: String, value: '提示' },
    content: { type: String, value: '' },
    confirmText: { type: String, value: '确定' },
    cancelText: { type: String, value: '取消' },
    /** 是否隐藏取消按钮（仅一个主操作） */
    single: { type: Boolean, value: false },
  },
  methods: {
    onConfirm(): void {
      this.triggerEvent('confirm');
    },
    onCancel(): void {
      this.triggerEvent('cancel');
    },
    onMaskTap(): void {
      this.triggerEvent('cancel');
    },
  },
});
