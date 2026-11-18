import { uploadLocalFile } from '../../../services/index';
import { getVerificationDraft, setVerificationMediaIds } from '../../../store/index';
import { showSuccess, showToast } from '../../../utils/feedback';

interface AttachmentView {
  mediaId: number;
  fileName: string;
}

const MAX_SIZE = 10 * 1024 * 1024;

function guessMime(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf')) {
    return 'application/pdf';
  }
  if (lower.endsWith('.png')) {
    return 'image/png';
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lower.endsWith('.webp')) {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

Page({
  data: {
    attachments: [] as AttachmentView[],
    uploading: false,
    error: '',
  },

  onLoad(): void {
    this.syncAttachments();
  },

  syncAttachments(): void {
    const draft = getVerificationDraft();
    this.setData({
      attachments: draft.attachmentMediaIds.map((mediaId) => ({ mediaId, fileName: `证明材料 ${mediaId}` })),
    });
  },

  onChooseFile(): void {
    if (this.data.uploading) {
      return;
    }
    wx.chooseMessageFile({
      count: 1,
      type: 'all',
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) {
          return;
        }
        if (file.size > MAX_SIZE) {
          showToast('文件不能超过 10MB');
          return;
        }
        void this.upload(file.path, file.name || '证明材料', file.size);
      },
      fail: () => {
        // 用户取消选择
      },
    });
  },

  async upload(path: string, fileName: string, size: number): Promise<void> {
    this.setData({ uploading: true, error: '' });
    try {
      const asset = await uploadLocalFile(path, fileName, guessMime(fileName), size);
      const draft = getVerificationDraft();
      const next = draft.attachmentMediaIds.concat([asset.id]);
      setVerificationMediaIds(next);
      this.syncAttachments();
      showSuccess('材料已上传');
    } catch (error) {
      this.setData({ error: '材料上传失败，请稍后重试' });
    } finally {
      this.setData({ uploading: false });
    }
  },

  onRemove(event: WechatMiniprogram.BaseEvent): void {
    const mediaId = Number(event.currentTarget.dataset.id);
    const draft = getVerificationDraft();
    setVerificationMediaIds(draft.attachmentMediaIds.filter((id) => id !== mediaId));
    this.syncAttachments();
  },
});
