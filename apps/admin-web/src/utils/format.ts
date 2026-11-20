import dayjs from 'dayjs';
import type {
  ArticleDto,
  EventStatus,
  NoticeDto,
  RegistrationStatus,
  ResourceStatus,
  ResourceType,
  ReviewAction,
  UserStatus,
  VerificationStatus,
} from '@nmg/contracts';

export type TagTheme = 'default' | 'primary' | 'success' | 'warning' | 'danger';

export function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm') : value;
}

export function formatDate(value?: string | null): string {
  if (!value) return '—';
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD') : value;
}

export function formatBytes(size?: number | null): string {
  if (!size && size !== 0) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

/** DatePicker 的字符串 → ISO 时间 */
export function toIso(value?: string | null): string | undefined {
  if (!value) return undefined;
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.toISOString() : undefined;
}

/** ISO 时间 → DatePicker 使用的字符串 */
export function toPickerValue(value?: string | null): string {
  if (!value) return '';
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm:ss') : '';
}

export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  active: '正常',
  disabled: '已禁用',
  locked: '已锁定',
};

export const USER_STATUS_THEMES: Record<UserStatus, TagTheme> = {
  active: 'success',
  disabled: 'default',
  locked: 'danger',
};

export const VERIFICATION_STATUS_LABELS: Record<VerificationStatus, string> = {
  pending: '待审核',
  needs_more_material: '待补充材料',
  approved: '已通过',
  rejected: '已拒绝',
  resubmitted: '已重新提交',
};

export const VERIFICATION_STATUS_THEMES: Record<VerificationStatus, TagTheme> = {
  pending: 'warning',
  needs_more_material: 'warning',
  approved: 'success',
  rejected: 'danger',
  resubmitted: 'primary',
};

export const RESOURCE_STATUS_LABELS: Record<ResourceStatus, string> = {
  draft: '草稿',
  pending: '待审核',
  published: '已发布',
  rejected: '已拒绝',
  offline: '已下架',
  withdrawn: '已撤回',
};

export const RESOURCE_STATUS_THEMES: Record<ResourceStatus, TagTheme> = {
  draft: 'default',
  pending: 'warning',
  published: 'success',
  rejected: 'danger',
  offline: 'default',
  withdrawn: 'default',
};

export const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
  resource: '资源',
  demand: '需求',
};

export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  draft: '草稿',
  published: '已发布',
  closed: '已结束',
  cancelled: '已取消',
};

export const EVENT_STATUS_THEMES: Record<EventStatus, TagTheme> = {
  draft: 'default',
  published: 'success',
  closed: 'primary',
  cancelled: 'danger',
};

export const CONTENT_STATUS_LABELS: Record<ArticleDto['status'] | NoticeDto['status'], string> = {
  draft: '草稿',
  published: '已发布',
  offline: '已下架',
};

export const CONTENT_STATUS_THEMES: Record<ArticleDto['status'] | NoticeDto['status'], TagTheme> = {
  draft: 'default',
  published: 'success',
  offline: 'warning',
};

export const REVIEW_ACTION_LABELS: Record<ReviewAction, string> = {
  approve: '通过',
  reject: '拒绝',
  request_changes: '要求补充 / 退回修改',
  offline: '下架',
};

export const REGISTRATION_STATUS_LABELS: Record<RegistrationStatus, string> = {
  registered: '已报名',
  cancelled: '已取消',
  attended: '已出席',
};

export const EVENT_KIND_OPTIONS = [
  { label: '校友聚会', value: '校友聚会' },
  { label: '学术讲座', value: '学术讲座' },
  { label: '行业沙龙', value: '行业沙龙' },
  { label: '校企对接', value: '校企对接' },
  { label: '公益活动', value: '公益活动' },
  { label: '其他', value: '其他' },
];
