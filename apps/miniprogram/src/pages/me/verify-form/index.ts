import { getVerificationDraft, setVerificationMediaIds } from '../../../store';
import { submitVerification } from '../../../services';
import { showSuccess } from '../../../utils/feedback';
import { navigateTo } from '../../../utils/navigate';

Page({
  data: {
    realName: '',
    college: '',
    graduationYear: '',
    degree: '',
    studentIdMasked: '',
    remark: '',
    attachmentCount: 0,
    submitting: false,
    submitError: '',
    success: false,
  },

  onLoad(): void {
    this.setData({ attachmentCount: getVerificationDraft().attachmentMediaIds.length });
  },

  onShow(): void {
    this.setData({ attachmentCount: getVerificationDraft().attachmentMediaIds.length });
  },

  onInput(event: WechatMiniprogram.Input): void {
    const field = event.currentTarget.dataset.field as string;
    const value = event.detail.value;
    switch (field) {
      case 'realName':
        this.setData({ realName: value });
        break;
      case 'college':
        this.setData({ college: value });
        break;
      case 'graduationYear':
        this.setData({ graduationYear: value });
        break;
      case 'degree':
        this.setData({ degree: value });
        break;
      case 'studentIdMasked':
        this.setData({ studentIdMasked: value });
        break;
      case 'remark':
        this.setData({ remark: value });
        break;
      default:
        break;
    }
    this.setData({ submitError: '' });
  },

  onUploadTap(): void {
    navigateTo('/pages/me/verify-upload/index');
  },

  async onSubmit(): Promise<void> {
    if (this.data.submitting) {
      return;
    }
    const realName = this.data.realName.trim();
    const college = this.data.college.trim();
    const year = Number(this.data.graduationYear);
    const masked = this.data.studentIdMasked.trim();

    if (!realName) {
      this.setData({ submitError: '请填写真实姓名' });
      return;
    }
    if (!college) {
      this.setData({ submitError: '请填写毕业院系' });
      return;
    }
    if (!Number.isInteger(year) || year < 1949 || year > 2100) {
      this.setData({ submitError: '请填写正确的毕业年份' });
      return;
    }
    if (!masked) {
      this.setData({ submitError: '请填写学号（可隐去中间部分）' });
      return;
    }
    const attachmentMediaIds = getVerificationDraft().attachmentMediaIds;
    if (!attachmentMediaIds.length) {
      this.setData({ submitError: '请先上传至少一份证明材料' });
      return;
    }

    this.setData({ submitting: true, submitError: '' });
    try {
      await submitVerification({
        realName,
        college,
        graduationYear: year,
        degree: this.data.degree.trim() || undefined,
        studentIdMasked: masked,
        remark: this.data.remark.trim() || undefined,
        attachmentMediaIds,
      });
      setVerificationMediaIds([]);
      this.setData({ submitting: false, success: true });
      showSuccess('认证申请已提交');
    } catch (error) {
      this.setData({ submitting: false, submitError: '提交失败，请稍后重试' });
    }
  },

  onViewProgress(): void {
    wx.redirectTo({ url: '/pages/me/verify-progress/index' });
  },
});
