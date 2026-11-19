/**
 * 展示模型层：把 DTO 的原始字段转成**已经格式化好**的展示字段。
 *
 * 为什么要有这一层：
 *   WXML 的数据绑定只做取值与简单运算，**不能调用 JS 函数**
 *   （所以本项目不在 WXML 里写 `{{formatDate(item.publishedAt)}}`）。
 *   于是就出现了一个很自然、也很容易踩的坑：
 *   直接把 DTO 丢给 WXML → 页面把 `2026-01-08T08:00:00.000Z`
 *   这种**原始 ISO 串**原样显示给用户（缺陷 #154 的另一半）。
 *
 *   这里的约定：**WXML 里出现的每一个时间，都必须是本层预先算好的展示字段**
 *   （`dateText` / `timeText`），不允许直接渲染 `xxxAt` 原始字段。
 *   由第 20 层校验（infra/scripts/check-miniprogram-dates.mjs）强制。
 */

import type {
  ArticleDto,
  ConnectionRequestDto,
  EventDto,
  NoticeDto,
  ResourcePostDto,
} from '../types/index';
import { formatDate, formatDateTime, formatRelativeTime } from './format';

/* ------------------------------ 资讯 ------------------------------ */

export interface ArticleView extends ArticleDto {
  /** 发布日期，形如 `2026-01-08` */
  dateText: string;
}

export function toArticleView(article: ArticleDto): ArticleView {
  return {
    ...article,
    dateText: formatDate(article.publishedAt),
  };
}

/* ------------------------------ 公告 ------------------------------ */

export interface NoticeView extends NoticeDto {
  /** 发布日期，形如 `2026-01-08` */
  dateText: string;
}

export function toNoticeView(notice: NoticeDto): NoticeView {
  return {
    ...notice,
    dateText: formatDate(notice.publishedAt),
  };
}

/* ------------------------------ 活动 ------------------------------ */

export interface EventView extends EventDto {
  /** 活动日期，形如 `2026-01-08` */
  dateText: string;
  /** 活动开始时间，形如 `2026-01-08 19:30` */
  timeText: string;
  /** 活动标记图标（原型 demoEvents 的 icon） */
  iconPath: string;
  /** 活动标记色调：`red` / `olive`（原型 demoEvents 的 tone） */
  tone: string;
}

/**
 * 活动类型 → 图标与色调。
 *
 * 原型把这两项直接写在演示数据里（icon / tone 字段），
 * 而服务端的 EventDto 只有自由文本的 `kind`，没有这两个字段。
 * 这里按 kind 的关键词还原原型的对照关系：
 *   '走进企业 · 产业交流开放日' → building + olive
 *   '北疆同行 · 校友交流沙龙'   → users   + red
 * 注意「企业/产业/参访」必须**先于**「交流」判断 ——
 * 原型第二条同时含「产业」与「交流」，判据顺序反了就会落到 users。
 *
 * ⚠️ 英文枚举兜底（缺陷 #159）：
 *   `kind` 是自由文本，线上库里实际存在过 `charity` / `industry` / `reunion`
 *   这类英文值。旧实现只匹配中文关键词 → 英文值一个都匹配不上，
 *   **全部退化成同一个兜底日历图标** —— 客户看到 4 张一模一样的活动图标。
 *   这里补上英文判据，让「图标没画好」这类问题不再依赖数据是否恰好是中文。
 */
export function eventArt(kind: string): { iconPath: string; tone: string } {
  if (/参访|企业|产业|开放日|industry|enterprise/i.test(kind)) {
    return { iconPath: '/assets/icons/event-building-olive.png', tone: 'olive' };
  }
  if (/交流|沙龙|分享|reunion|salon|sharing/i.test(kind)) {
    return { iconPath: '/assets/icons/event-users.png', tone: 'red' };
  }
  return { iconPath: '/assets/icons/event-calendar.png', tone: 'red' };
}

export function toEventView(event: EventDto): EventView {
  const art = eventArt(event.kind || '');
  return {
    ...event,
    dateText: formatDate(event.startsAt),
    timeText: event.startsAt ? formatDateTime(event.startsAt) : '时间待定',
    iconPath: art.iconPath,
    tone: art.tone,
  };
}

/* ---------------------------- 资源与需求 ---------------------------- */

export interface OpportunityView extends ResourcePostDto {
  /** 发布日期，形如 `2026-01-08`；未发布时为空串 */
  dateText: string;
  /** 最后更新时间，形如 `2026-01-08 19:30` */
  updateText: string;
}

export function toOpportunityView(post: ResourcePostDto): OpportunityView {
  return {
    ...post,
    dateText: post.publishedAt ? formatDate(post.publishedAt) : '待发布',
    updateText: formatDateTime(post.updatedAt),
  };
}

/* ------------------------------ 连接申请 ------------------------------ */

export interface RequestView extends ConnectionRequestDto {
  /** 发起时间（相对），形如 `12分钟前` */
  dateText: string;
  /** 发起时间（绝对），形如 `2026-01-08 19:30` */
  timeText: string;
}

export function toRequestView(request: ConnectionRequestDto): RequestView {
  return {
    ...request,
    dateText: formatRelativeTime(request.createdAt),
    timeText: formatDateTime(request.createdAt),
  };
}
