/** 展示层格式化工具。 */

import type {
  ConnectionRequestStatus,
  RegistrationStatus,
  ResourceStatus,
  VerificationStatus,
} from '../types/index';

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

/**
 * 相对时间：`刚刚` / `12分钟前` / `3小时前` / `昨天 19:30` / `5天前` / `2026-03-05`
 *
 * 为什么列表里要用相对时间：通知、连接申请这类**刚刚发生**的动作，
 * 写「2026-01-08 19:30」需要用户自己换算，写「12分钟前」一眼就知道新鲜程度。
 * 超过 7 天再退回绝对日期，避免「138天前」这种别扭说法。
 *
 * ⚠️ 「昨天」必须按**日历日**判定，不能按「距今不足 48 小时」判定：
 *   昨天 23:50 到今天 00:20 只过了 30 分钟，按时长算会显示「昨天 23:50」，
 *   但它其实是**前天**的 23:50 —— 用户按日历理解会以为是今天的事，
 *   而「刚刚 / N分钟前」分支又先把它截走，结果这段跨零点的信息
 *   永远显示不对。所以这里统一按「本地日历日之差」分级。
 */
export function formatRelativeTime(value: string | null | undefined, now: Date = new Date()): string {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const diff = now.getTime() - date.getTime();
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  if (diff < 0) {
    // 未来时间（活动开始时间等）不适合说「还有 -3 分钟」，直接给绝对时间
    return formatDateTime(value);
  }
  if (diff < MINUTE) {
    return '刚刚';
  }
  if (diff < HOUR) {
    return `${Math.floor(diff / MINUTE)}分钟前`;
  }
  // 今天之内 → 小时前
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (date.getTime() >= startOfToday) {
    return `${Math.floor(diff / HOUR)}小时前`;
  }
  // 今天之前 → 按日历日之差分级
  const startOfThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfThatDay) / DAY);
  if (dayDiff === 1) {
    return `昨天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  if (dayDiff < 7) {
    return `${dayDiff}天前`;
  }
  return formatDate(value);
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

/** 头像占位字（姓名首字；空名或纯空白名回落到「燕」） */
export function avatarText(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  return trimmed ? trimmed.charAt(0) : '燕';
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
