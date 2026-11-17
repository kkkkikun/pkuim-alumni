/**
 * 轻量确认弹窗控制器（对应 components/dialog）。
 *
 * 页面通过 `showConfirmDialog(options)` 返回 Promise<boolean>，
 * 并在 WXML 中绑定 `dialog` 组件的 confirm / cancel 事件。
 */

export interface DialogOptions {
  title: string;
  content?: string;
  confirmText?: string;
  cancelText?: string;
}

export interface DialogState {
  dialogVisible: boolean;
  dialogTitle: string;
  dialogContent: string;
  dialogConfirmText: string;
  dialogCancelText: string;
}

export interface DialogPage {
  setData: (data: Partial<DialogState>) => void;
}

let resolver: ((value: boolean) => void) | null = null;

/** 初始弹窗状态，供页面 data 使用 */
export function initialDialogState(): DialogState {
  return {
    dialogVisible: false,
    dialogTitle: '提示',
    dialogContent: '',
    dialogConfirmText: '确定',
    dialogCancelText: '取消',
  };
}

/** 打开确认弹窗 */
export function openDialog(page: DialogPage, options: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    resolver = resolve;
    page.setData({
      dialogVisible: true,
      dialogTitle: options.title,
      dialogContent: options.content || '',
      dialogConfirmText: options.confirmText || '确定',
      dialogCancelText: options.cancelText || '取消',
    });
  });
}

/** 关闭确认弹窗并回传结果 */
export function closeDialog(page: DialogPage, confirmed: boolean): void {
  if (resolver) {
    resolver(confirmed);
    resolver = null;
  }
  page.setData({ dialogVisible: false });
}
