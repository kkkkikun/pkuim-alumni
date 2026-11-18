import { fetchMe, updateProfile } from '../../../services/index';
import { getState } from '../../../store/index';
import type { IndustryDto, RegionDto } from '../../../types/index';
import { showSuccess } from '../../../utils/feedback';

Page({
  data: {
    loading: true,
    error: '',
    industries: [] as IndustryDto[],
    regions: [] as RegionDto[],
    displayName: '',
    realName: '',
    college: '',
    degree: '',
    graduationYear: '',
    regionIndex: -1,
    industryIndex: -1,
    direction: '',
    intro: '',
    contactPhone: '',
    contactWechat: '',
    contactEmail: '',
    submitting: false,
    submitError: '',
  },

  onLoad(): void {
    const state = getState();
    this.setData({ industries: state.industries, regions: state.regions });
    void this.load();
  },

  async load(): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const result = await fetchMe();
      const profile = result.alumniProfile;
      if (!profile) {
        this.setData({ loading: false, error: '尚未建立校友资料，请先完成身份认证' });
        return;
      }
      this.setData({
        displayName: profile.displayName || '',
        realName: profile.realName || '',
        college: profile.college || '',
        degree: profile.degree || '',
        graduationYear: profile.graduationYear ? String(profile.graduationYear) : '',
        direction: profile.direction || '',
        intro: profile.intro || '',
        contactPhone: profile.contactPhone || '',
        contactWechat: profile.contactWechat || '',
        contactEmail: profile.contactEmail || '',
        regionIndex: this.data.regions.findIndex((item) => item.code === profile.regionCode),
        industryIndex: this.data.industries.findIndex((item) => item.code === profile.industryCode),
        loading: false,
      });
    } catch (error) {
      this.setData({ loading: false, error: '资料加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    void this.load();
  },

  onInput(event: WechatMiniprogram.Input): void {
    const field = event.currentTarget.dataset.field as string;
    const value = event.detail.value;
    switch (field) {
      case 'displayName':
        this.setData({ displayName: value });
        break;
      case 'realName':
        this.setData({ realName: value });
        break;
      case 'college':
        this.setData({ college: value });
        break;
      case 'degree':
        this.setData({ degree: value });
        break;
      case 'graduationYear':
        this.setData({ graduationYear: value });
        break;
      case 'direction':
        this.setData({ direction: value });
        break;
      case 'intro':
        this.setData({ intro: value });
        break;
      case 'contactPhone':
        this.setData({ contactPhone: value });
        break;
      case 'contactWechat':
        this.setData({ contactWechat: value });
        break;
      case 'contactEmail':
        this.setData({ contactEmail: value });
        break;
      default:
        break;
    }
    this.setData({ submitError: '' });
  },

  onRegionChange(event: WechatMiniprogram.PickerChange): void {
    this.setData({ regionIndex: Number(event.detail.value) });
  },

  onIndustryChange(event: WechatMiniprogram.PickerChange): void {
    this.setData({ industryIndex: Number(event.detail.value) });
  },

  async onSubmit(): Promise<void> {
    if (this.data.submitting) {
      return;
    }
    const displayName = this.data.displayName.trim();
    if (!displayName) {
      this.setData({ submitError: '请填写展示名称' });
      return;
    }
    const graduationYear = this.data.graduationYear.trim() ? Number(this.data.graduationYear) : undefined;
    if (graduationYear !== undefined && (!Number.isInteger(graduationYear) || graduationYear < 1949 || graduationYear > 2100)) {
      this.setData({ submitError: '请填写正确的毕业年份' });
      return;
    }
    const email = this.data.contactEmail.trim();
    if (email && email.indexOf('@') === -1) {
      this.setData({ submitError: '请填写正确的邮箱地址' });
      return;
    }
    const region = this.data.regionIndex >= 0 ? this.data.regions[this.data.regionIndex] : undefined;
    const industry = this.data.industryIndex >= 0 ? this.data.industries[this.data.industryIndex] : undefined;

    this.setData({ submitting: true, submitError: '' });
    try {
      await updateProfile({
        displayName,
        realName: this.data.realName.trim() || undefined,
        college: this.data.college.trim() || undefined,
        degree: this.data.degree.trim() || undefined,
        graduationYear,
        regionCode: region ? region.code : undefined,
        industryCode: industry ? industry.code : undefined,
        direction: this.data.direction.trim() || undefined,
        intro: this.data.intro.trim() || undefined,
        contactPhone: this.data.contactPhone.trim() || undefined,
        contactWechat: this.data.contactWechat.trim() || undefined,
        contactEmail: email || undefined,
      });
      this.setData({ submitting: false });
      showSuccess('资料已更新');
      setTimeout(() => {
        wx.navigateBack({ delta: 1 });
      }, 600);
    } catch (error) {
      this.setData({ submitting: false, submitError: '保存失败，请稍后重试' });
    }
  },
});
