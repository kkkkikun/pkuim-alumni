/**
 * 离线演示路由（后端不可达时的兜底数据源）。
 *
 * 职责：把「接口调用」映射成「本地演示数据」，返回的就是**真实接口 `data` 部分**
 * （不含 `{ code, message, data, requestId }` 信封 —— 信封由 `services/request.ts` 包）。
 *
 * 三条铁律：
 *  1. **找不到的路由必须抛错**，绝不静默返回空对象 —— 静默兜底会把「接口没实现」
 *     伪装成「查无数据」，比报错更难查。
 *  2. **写操作只返回成功结果，不持久化**（内存里的模拟状态重启即失效）。
 *  3. **不得出现任何真实联系方式 / 真实校友姓名**。
 *
 * 路径与查询参数都来自 `services/paths.ts`（契约的运行时镜像），
 * 字段形状以 `src/types/index.ts`（契约镜像）为准。
 */

import { DEFAULT_PAGE_SIZE } from '../config/index';
import { dataset } from './dataset';
import { demoDirectory } from './directory';
import {
  buildDemoContacts,
  buildDemoLoginResult,
  buildDemoMe,
  buildDemoMyProfile,
  buildDemoPrivacy,
  buildDemoSessionUser,
} from './session';
import type {
  ArticleCategoryDto,
  ArticleDto,
  ConnectionRequestDto,
  DirectoryEntry,
  EventDto,
  EventRegistrationDto,
  MediaAssetDto,
  NoticeDto,
  NotificationDto,
  PageResult,
  ResourcePostDto,
  VerificationApplicationDto,
} from '../types/index';

/* ------------------------------ 基础工具 ------------------------------ */

/** 演示路由错误（由请求层转换成 `ApiError`） */
export class DemoRouteError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 404) {
    super(message);
    this.name = 'DemoRouteError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

type Query = Record<string, unknown>;

/** 取字符串值 */
function text(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
}

/** 取正整数（非法值回退到默认值） */
function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(text(value));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

/** 真分页（真的切片 + 正确的 meta） */
function paginate<T>(items: T[], query: Query): PageResult<T> {
  const page = positiveInt(query.page, 1);
  const pageSize = positiveInt(query.pageSize, DEFAULT_PAGE_SIZE);
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    meta: { page, pageSize, total, totalPages },
  };
}

/** 空分页结果 */
function emptyPage<T>(query: Query): PageResult<T> {
  return paginate<T>([], query);
}

/** 包含匹配（大小写不敏感） */
function includes(haystack: string | null | undefined, needle: string): boolean {
  if (!needle) {
    return true;
  }
  return (haystack || '').toLowerCase().indexOf(needle.toLowerCase()) >= 0;
}

/** 规范化路径：去掉首尾斜杠，保证以 `/` 开头 */
function normalizePath(path: string): string {
  const trimmed = (path || '').replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed ? `/${trimmed}` : '/';
}

/** 拆分路径与查询串（不依赖 URLSearchParams，小程序运行时不一定有） */
function splitPath(path: string): { pathname: string; query: Query } {
  const raw = path || '';
  const mark = raw.indexOf('?');
  if (mark < 0) {
    return { pathname: normalizePath(raw), query: {} };
  }
  const pathname = normalizePath(raw.slice(0, mark));
  const query: Query = {};
  raw
    .slice(mark + 1)
    .split('&')
    .forEach((pair) => {
      if (!pair) {
        return;
      }
      const eq = pair.indexOf('=');
      const key = eq < 0 ? pair : pair.slice(0, eq);
      const value = eq < 0 ? '' : pair.slice(eq + 1);
      if (!key) {
        return;
      }
      try {
        query[decodeURIComponent(key)] = decodeURIComponent(value);
      } catch (error) {
        query[key] = value;
      }
    });
  return { pathname, query };
}

/** 路径参数匹配（`:id` 形态） */
function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  const expected = pattern.split('/').filter(Boolean);
  const actual = pathname.split('/').filter(Boolean);
  if (expected.length !== actual.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i].charAt(0) === ':') {
      params[expected[i].slice(1)] = decodeURIComponent(actual[i]);
    } else if (expected[i] !== actual[i]) {
      return null;
    }
  }
  return params;
}

/* ------------------------------ 数据查找 ------------------------------ */

function findEvent(id: string): EventDto {
  const hit = dataset.events.find((item) => String(item.id) === id);
  if (!hit) {
    throw new DemoRouteError('NOT_FOUND', `演示数据里没有活动 #${id}`, 404);
  }
  return hit;
}

function findArticle(id: string): ArticleDto {
  const hit = dataset.articles.find((item) => String(item.id) === id);
  if (!hit) {
    throw new DemoRouteError('NOT_FOUND', `演示数据里没有资讯 #${id}`, 404);
  }
  return hit;
}

function findNotice(id: string): NoticeDto {
  const hit = dataset.notices.find((item) => String(item.id) === id);
  if (!hit) {
    throw new DemoRouteError('NOT_FOUND', `演示数据里没有公告 #${id}`, 404);
  }
  return hit;
}

function findResource(id: string): ResourcePostDto {
  const hit = dataset.resources.find((item) => String(item.id) === id);
  if (!hit) {
    throw new DemoRouteError('NOT_FOUND', `演示数据里没有资源 #${id}`, 404);
  }
  return hit;
}

function findDirectoryEntry(id: string): DirectoryEntry {
  const hit = demoDirectory.find((item) => String(item.userId) === id);
  if (!hit) {
    throw new DemoRouteError('NOT_FOUND', `演示数据里没有校友 #${id}`, 404);
  }
  return hit;
}

/** 当前时间（演示数据里的时间戳） */
function now(): string {
  return new Date().toISOString();
}

/* ------------------------------ 路由表 ------------------------------ */

interface DemoContext {
  params: Record<string, string>;
  query: Query;
  body: unknown;
}

interface DemoRoute {
  method: string;
  pattern: string;
  handle: (context: DemoContext) => unknown;
}

/** 请求体里的字符串字段 */
function bodyText(body: unknown, key: string): string {
  if (body && typeof body === 'object') {
    const value = (body as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) {
      return String(value);
    }
  }
  return '';
}

/**
 * 路由表。
 *
 * 顺序有意义：静态路径必须排在同层级的 `:param` 之前
 * （例如 `/articles/categories` 要排在 `/articles/:id` 前面）。
 */
const ROUTES: DemoRoute[] = [
  /* ------------------------------ 认证 ------------------------------ */
  {
    method: 'POST',
    pattern: '/auth/mock/login',
    handle: () => buildDemoLoginResult(),
  },
  {
    method: 'POST',
    pattern: '/auth/wechat/login',
    handle: () => buildDemoLoginResult(),
  },
  {
    method: 'POST',
    pattern: '/auth/refresh',
    handle: () => buildDemoLoginResult(),
  },
  {
    method: 'GET',
    pattern: '/auth/session',
    handle: () => ({ user: buildDemoSessionUser(), stage: dataset.me.stage }),
  },
  {
    method: 'POST',
    pattern: '/auth/logout',
    handle: () => ({ success: true }),
  },

  /* ------------------------------ 我 ------------------------------ */
  {
    method: 'GET',
    pattern: '/me',
    handle: () => buildDemoMe(),
  },
  {
    method: 'GET',
    pattern: '/me/profile',
    handle: () => buildDemoMyProfile(),
  },
  {
    method: 'PATCH',
    pattern: '/me/profile',
    handle: () => buildDemoMyProfile(),
  },
  {
    method: 'PUT',
    pattern: '/me/profile',
    handle: () => buildDemoMyProfile(),
  },
  {
    method: 'GET',
    pattern: '/me/privacy',
    handle: () => buildDemoPrivacy(),
  },
  {
    method: 'PUT',
    pattern: '/me/privacy',
    handle: () => buildDemoPrivacy(),
  },
  {
    method: 'GET',
    pattern: '/me/contacts',
    handle: () => buildDemoContacts(),
  },
  {
    method: 'PUT',
    pattern: '/me/contacts',
    handle: () => buildDemoContacts(),
  },
  {
    method: 'GET',
    pattern: '/me/connections',
    handle: (context) => emptyPage<never>(context.query),
  },
  {
    method: 'GET',
    pattern: '/me/connection-requests',
    handle: (context) => emptyPage<never>(context.query),
  },
  {
    method: 'GET',
    pattern: '/me/resources',
    handle: (context) => emptyPage<never>(context.query),
  },
  {
    method: 'GET',
    pattern: '/me/events',
    handle: (context) => emptyPage<never>(context.query),
  },
  {
    method: 'GET',
    pattern: '/me/verifications',
    handle: (context) => emptyPage<never>(context.query),
  },
  {
    method: 'GET',
    pattern: '/me/notifications',
    handle: (context) => emptyPage<never>(context.query),
  },

  /* ------------------------------ 活动 ------------------------------ */
  {
    method: 'GET',
    pattern: '/events',
    handle: (context) => {
      const keyword = text(context.query.keyword);
      const regionCode = text(context.query.regionCode);
      const items = dataset.events.filter((item) => {
        if (regionCode && item.regionCode !== regionCode) {
          return false;
        }
        return includes(item.title, keyword);
      });
      return paginate<EventDto>(items, context.query);
    },
  },
  {
    method: 'GET',
    pattern: '/events/:id',
    handle: (context) => findEvent(context.params.id),
  },
  {
    method: 'POST',
    pattern: '/events/:id/registrations',
    handle: (context) => {
      const event = findEvent(context.params.id);
      // 演示模式不持久化：报名结果只在本次响应里返回。
      const registration: EventRegistrationDto = {
        id: 990000 + event.id,
        eventId: event.id,
        userId: dataset.me.user.id,
        userName: dataset.me.user.nickname,
        status: 'registered',
        note: bodyText(context.body, 'note'),
        createdAt: now(),
      };
      return registration;
    },
  },

  /* ------------------------------ 资讯 ------------------------------ */
  {
    method: 'GET',
    pattern: '/articles/categories',
    handle: () => dataset.articleCategories as ArticleCategoryDto[],
  },
  {
    method: 'GET',
    pattern: '/articles',
    handle: (context) => {
      const keyword = text(context.query.keyword);
      const categoryId = positiveInt(context.query.categoryId, 0);
      const items = dataset.articles.filter((item) => {
        if (categoryId && item.categoryId !== categoryId) {
          return false;
        }
        if (!keyword) {
          return true;
        }
        return includes(item.title, keyword) || includes(item.summary, keyword) || includes(item.body, keyword);
      });
      return paginate<ArticleDto>(items, context.query);
    },
  },
  {
    method: 'GET',
    pattern: '/articles/:id',
    handle: (context) => findArticle(context.params.id),
  },

  /* ------------------------------ 公告 ------------------------------ */
  {
    method: 'GET',
    pattern: '/notices',
    handle: (context) => paginate<NoticeDto>(dataset.notices, context.query),
  },
  {
    method: 'GET',
    pattern: '/notices/:id',
    handle: (context) => findNotice(context.params.id),
  },

  /* ------------------------------ 通讯录（虚构） ------------------------------ */
  {
    method: 'GET',
    pattern: '/directory',
    handle: (context) => {
      const keyword = text(context.query.keyword);
      const regionCode = text(context.query.regionCode);
      const industryCode = text(context.query.industryCode);
      const graduationYear = positiveInt(context.query.graduationYear, 0);
      const items = demoDirectory.filter((item) => {
        if (regionCode && item.regionCode !== regionCode) {
          return false;
        }
        if (industryCode && item.industryCode !== industryCode) {
          return false;
        }
        if (graduationYear && item.graduationYear !== graduationYear) {
          return false;
        }
        if (!keyword) {
          return true;
        }
        return (
          includes(item.displayName, keyword) ||
          includes(item.college, keyword) ||
          includes(item.direction, keyword) ||
          includes(item.industryName, keyword)
        );
      });
      return paginate<DirectoryEntry>(items, context.query);
    },
  },
  {
    method: 'GET',
    pattern: '/directory/:id',
    handle: (context) => findDirectoryEntry(context.params.id),
  },
  {
    method: 'GET',
    pattern: '/alumni/:id',
    handle: (context) => findDirectoryEntry(context.params.id),
  },

  /* ------------------------------ 资源与需求 ------------------------------ */
  {
    method: 'GET',
    pattern: '/resources',
    handle: (context) => {
      const type = text(context.query.type);
      const industryCode = text(context.query.industryCode);
      const regionCode = text(context.query.regionCode);
      const keyword = text(context.query.keyword);
      const items = dataset.resources.filter((item) => {
        if (type && type !== 'all' && item.type !== type) {
          return false;
        }
        if (industryCode && item.industryCode !== industryCode) {
          return false;
        }
        if (regionCode && item.regionCode !== regionCode) {
          return false;
        }
        if (!keyword) {
          return true;
        }
        return includes(item.title, keyword) || includes(item.body, keyword);
      });
      return paginate<ResourcePostDto>(items, context.query);
    },
  },
  {
    method: 'GET',
    pattern: '/resources/:id',
    handle: (context) => findResource(context.params.id),
  },
  {
    method: 'POST',
    pattern: '/resources',
    handle: (context) => {
      // 演示模式不持久化：发布结果只在本次响应里返回。
      const resource: ResourcePostDto = {
        id: 980000,
        authorId: dataset.me.user.id,
        authorName: dataset.me.user.nickname,
        type: (bodyText(context.body, 'type') || 'resource') as ResourcePostDto['type'],
        title: bodyText(context.body, 'title'),
        body: bodyText(context.body, 'body'),
        industryCode: bodyText(context.body, 'industryCode') || null,
        industryName: null,
        regionCode: bodyText(context.body, 'regionCode') || null,
        regionName: null,
        status: 'pending',
        version: 1,
        attachments: [],
        reviews: [],
        publishedAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      return resource;
    },
  },
  {
    method: 'POST',
    pattern: '/resources/:id/submit',
    handle: (context) => ({ ...findResource(context.params.id), status: 'pending' as const }),
  },
  {
    method: 'POST',
    pattern: '/resources/:id/withdraw',
    handle: (context) => ({ ...findResource(context.params.id), status: 'withdrawn' as const }),
  },

  /* ------------------------------ 连接 ------------------------------ */
  {
    method: 'GET',
    pattern: '/connections',
    handle: (context) => emptyPage<never>(context.query),
  },
  {
    method: 'GET',
    pattern: '/connections/requests',
    handle: (context) => emptyPage<never>(context.query),
  },
  {
    method: 'GET',
    pattern: '/connections/requests/:id',
    handle: (context) => buildDemoConnectionRequest(context.params.id, 'pending'),
  },
  {
    method: 'GET',
    pattern: '/connections/:id',
    handle: (context) => {
      throw new DemoRouteError('NOT_FOUND', `演示数据里没有连接 #${context.params.id}`, 404);
    },
  },
  {
    method: 'POST',
    pattern: '/connections/requests',
    handle: (context) => {
      // 演示模式不持久化：申请结果只在本次响应里返回。
      const request: ConnectionRequestDto = {
        id: 970000,
        fromUserId: dataset.me.user.id,
        toUserId: Number(bodyText(context.body, 'targetUserId')) || 0,
        fromName: dataset.me.user.nickname,
        toName: '演示校友',
        message: bodyText(context.body, 'message'),
        status: 'pending',
        createdAt: now(),
        decidedAt: null,
        pairId: null,
      };
      return request;
    },
  },
  {
    method: 'POST',
    pattern: '/connections/requests/:id/accept',
    handle: (context) => buildDemoConnectionRequest(context.params.id, 'accepted'),
  },
  {
    method: 'POST',
    pattern: '/connections/requests/:id/reject',
    handle: (context) => buildDemoConnectionRequest(context.params.id, 'rejected'),
  },
  {
    method: 'POST',
    pattern: '/connections/requests/:id/cancel',
    handle: (context) => buildDemoConnectionRequest(context.params.id, 'cancelled'),
  },
  {
    method: 'PUT',
    pattern: '/connections/:id/contact-grant',
    handle: () => {
      throw new DemoRouteError('NOT_FOUND', '演示模式没有已建立的连接', 404);
    },
  },

  /* ------------------------------ 字典 ------------------------------ */
  {
    method: 'GET',
    pattern: '/system/regions',
    handle: () => dataset.regions,
  },
  {
    method: 'GET',
    pattern: '/system/industries',
    handle: () => dataset.industries,
  },

  /* ------------------------------ 通知 ------------------------------ */
  {
    method: 'GET',
    pattern: '/notifications/unread-count',
    handle: () => ({ unread: 0 }),
  },
  {
    method: 'POST',
    pattern: '/notifications/read-all',
    handle: () => ({ updated: 0 }),
  },
  {
    method: 'POST',
    pattern: '/notifications/:id/read',
    handle: (context) => ({ id: Number(context.params.id) || 0, read: true }),
  },
  {
    method: 'GET',
    pattern: '/notifications/:id',
    handle: (context) => {
      const notification: NotificationDto = {
        id: Number(context.params.id) || 0,
        type: 'system',
        title: '【演示】站内通知',
        body: '演示模式下的通知内容。',
        payload: {},
        read: false,
        createdAt: now(),
      };
      return notification;
    },
  },

  /* ------------------------------ 上传 ------------------------------ */
  {
    method: 'GET',
    pattern: '/uploads',
    handle: () => [] as MediaAssetDto[],
  },
  {
    method: 'GET',
    pattern: '/uploads/records',
    handle: () => [] as MediaAssetDto[],
  },
  {
    method: 'POST',
    pattern: '/uploads/records',
    handle: (context) => {
      // 演示模式不持久化：返回一条假的登记记录（直传地址不可用）。
      const asset: MediaAssetDto & { uploadUrl?: string | null; expiresIn?: number } = {
        id: 960000,
        fileName: bodyText(context.body, 'fileName') || 'demo-file',
        mimeType: bodyText(context.body, 'mimeType') || 'application/octet-stream',
        size: Number(bodyText(context.body, 'size')) || 0,
        bucket: 'demo-bucket',
        objectKey: 'demo/object-key',
        visibility: 'private',
        url: null,
        createdAt: now(),
        uploadUrl: null,
        expiresIn: 0,
      };
      return asset;
    },
  },
  {
    method: 'GET',
    pattern: '/uploads/:id/url',
    handle: () => ({ url: 'demo://upload-not-supported', expiresIn: 0 }),
  },

  /* ------------------------------ 校友认证 ------------------------------ */
  {
    method: 'GET',
    pattern: '/alumni/verification/mine',
    handle: () => [] as VerificationApplicationDto[],
  },
  {
    method: 'GET',
    pattern: '/alumni/verification/:id/history',
    handle: () => [],
  },
  {
    method: 'POST',
    pattern: '/alumni/verification',
    handle: (context) => {
      // 演示模式不持久化：认证申请结果只在本次响应里返回。
      const application: VerificationApplicationDto = {
        id: 950000,
        userId: dataset.me.user.id,
        applicantName: bodyText(context.body, 'realName') || dataset.me.user.nickname,
        college: bodyText(context.body, 'college') || null,
        graduationYear: Number(bodyText(context.body, 'graduationYear')) || null,
        degree: bodyText(context.body, 'degree') || null,
        studentIdMasked: bodyText(context.body, 'studentIdMasked') || null,
        status: 'pending',
        attachments: [],
        reviews: [],
        submittedAt: now(),
        decidedAt: null,
      };
      return application;
    },
  },
];

/** 构造一条「已处理」的连接申请（演示模式不持久化） */
function buildDemoConnectionRequest(id: string, status: ConnectionRequestDto['status']): ConnectionRequestDto {
  return {
    id: Number(id) || 0,
    fromUserId: 0,
    toUserId: dataset.me.user.id,
    fromName: '演示校友',
    toName: dataset.me.user.nickname,
    message: '演示模式下的联系申请。',
    status,
    createdAt: now(),
    decidedAt: now(),
    pairId: null,
  };
}

/* ------------------------------ 对外入口 ------------------------------ */

/**
 * 处理一次「演示请求」。
 *
 * @param method HTTP 方法（不区分大小写）
 * @param path    接口路径，可带查询串（如 `/events?page=1&pageSize=5`）
 * @param query   额外查询参数（与路径里的查询串合并，路径里的优先被覆盖）
 * @param body    请求体（POST/PUT/PATCH）
 * @returns       **接口 `data` 部分**（不含信封）
 * @throws        DemoRouteError（路由未覆盖 / 资源不存在）—— 绝不静默返回空对象
 */
export function handleDemoRequest(
  method: string,
  path: string,
  query?: Record<string, unknown>,
  body?: unknown
): unknown {
  const upper = (method || 'GET').toUpperCase();
  const split = splitPath(path);
  const merged: Query = { ...split.query, ...(query || {}) };

  for (const route of ROUTES) {
    if (route.method !== upper) {
      continue;
    }
    const params = matchPattern(route.pattern, split.pathname);
    if (!params) {
      continue;
    }
    return route.handle({ params, query: merged, body });
  }

  throw new DemoRouteError(
    'DEMO_ROUTE_NOT_FOUND',
    `演示模式未覆盖该接口：${upper} ${split.pathname}`,
    404
  );
}

/** 路由表（供自校验脚本做静态覆盖检查） */
export const DEMO_ROUTE_PATTERNS: string[] = ROUTES.map((route) => `${route.method} ${route.pattern}`);
