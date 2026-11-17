/** 展示层格式化工具。 */

import type {
  ConnectionRequestStatus,
  RegistrationStatus,
  ResourceStatus,
  VerificationStatus,
} from '../types';

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** `2026-03-05` */
export function formatDate(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `2026-03-05 19:30` */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return `${formatDate(value)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `3月5日` */
export function formatMonthDay(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 活动时间段描述 */
export function formatEventTime(startsAt: string | null, endsAt: string | null): string {
  const start = formatDateTime(startsAt);
  if (!start) {
    return '时间待定';
  }
  const end = formatDateTime(endsAt);
  return end && end !== start ? `${start} — ${end}` : start;
}

/** 手机号脱敏 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) {
    return '';
  }
  if (phone.length < 7) {
    return phone;
  }
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

/** 姓名脱敏（保留姓氏） */
export function maskName(name: string | null | undefined): string {
  if (!name) {
    return '';
  }
  return name.length <= 1 ? name : `${name.charAt(0)}*`;
}

/** 截断长文本 */
export function truncate(text: string | null | undefined, max: number): string {
  if (!text) {
    return '';
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 头像占位字 */
export function avatarText(name: string | null | undefined): string {
  if (!name) {
    return '燕';
  }
  return name.trim().charAt(0);
}

/* ------------------------------ 状态文案 ------------------------------ */

export function resourceStatusLabel(status: ResourceStatus): string {
  switch (status) {
    case 'draft':
      return '草稿';
    case 'pending':
      return '待审核';
    case 'published':
      return '已发布';
    case 'rejected':
      return '未通过';
    case 'offline':
      return '已下架';
    case 'withdrawn':
      return '已撤回';
    default:
      return '';
  }
}

export function verificationStatusLabel(status: VerificationStatus): string {
  switch (status) {
    case 'pending':
      return '审核中';
    case 'needs_more_material':
      return '待补充材料';
    case 'approved':
      return '已通过';
    case 'rejected':
      return '未通过';
    case 'resubmitted':
      return '已重新提交';
    default:
      return '';
  }
}

export function connectionRequestStatusLabel(status: ConnectionRequestStatus): string {
  switch (status) {
    case 'pending':
      return '待对方确认';
    case 'accepted':
      return '已接受';
    case 'rejected':
      return '已拒绝';
    case 'cancelled':
      return '已取消';
    case 'expired':
      return '已过期';
    default:
      return '';
  }
}

export function registrationStatusLabel(status: RegistrationStatus): string {
  switch (status) {
    case 'registered':
      return '已报名';
    case 'cancelled':
      return '已取消';
    case 'attended':
      return '已参加';
    default:
      return '';
  }
}

/** 资源类型文案 */
export function resourceTypeLabel(type: 'resource' | 'demand'): string {
  return type === 'resource' ? '我能提供' : '我有需求';
}
