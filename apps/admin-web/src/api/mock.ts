/**
 * 演示数据适配层。
 *
 * 仅当环境变量 VITE_USE_MOCK=true 时启用（开发自测用）。
 * 生产/联调环境必须保持关闭，所有页面走真实 REST API。
 */
import {
  ApiPaths,
  type AdminActionLogDto,
  type AdminPermission,
  type AdminRole,
  type AdminStats,
  type AdminUserDto,
  type AlumniProfileDto,
  type ArticleCategoryDto,
  type ArticleDto,
  type EventDto,
  type EventRegistrationDto,
  type IndustryDto,
  type NoticeDto,
  type PageMeta,
  type PageResult,
  type RegionDto,
  type ResourcePostDto,
  type SystemSettingDto,
  type UserStatus,
  type VerificationApplicationDto,
} from '@nmg/contracts';

export const mockEnabled = import.meta.env.VITE_USE_MOCK === 'true';

function page<T>(items: T[], requested?: object): PageResult<T> {
  const meta: PageMeta = { page: 1, pageSize: 20, total: items.length, totalPages: 1 };
  const query = (requested || {}) as { page?: number; pageSize?: number };
  if (query.page && query.pageSize) {
    const start = (query.page - 1) * query.pageSize;
    const sliced = items.slice(start, start + query.pageSize);
    meta.page = query.page;
    meta.pageSize = query.pageSize;
    meta.total = items.length;
    meta.totalPages = Math.max(1, Math.ceil(items.length / query.pageSize));
    return { items: sliced, meta };
  }
  return { items, meta };
}

const regions: RegionDto[] = [
  { code: '150000', name: '内蒙古自治区', level: 'city', sortOrder: 1, alumniCount: 128 },
  { code: '150100', name: '呼和浩特市', level: 'city', sortOrder: 2, alumniCount: 76 },
  { code: '150200', name: '包头市', level: 'city', sortOrder: 3, alumniCount: 24 },
  { code: '150300', name: '乌海市', level: 'city', sortOrder: 4, alumniCount: 9 },
  { code: '110000', name: '北京市', level: 'outside', sortOrder: 5, alumniCount: 41 },
  { code: '310000', name: '上海市', level: 'outside', sortOrder: 6, alumniCount: 18 },
];

const industries: IndustryDto[] = [
  { code: 'edu', name: '教育科研', sortOrder: 1, alumniCount: 88 },
  { code: 'gov', name: '政府机关', sortOrder: 2, alumniCount: 35 },
  { code: 'fin', name: '金融', sortOrder: 3, alumniCount: 21 },
  { code: 'tech', name: '信息技术', sortOrder: 4, alumniCount: 19 },
  { code: 'energy', name: '能源化工', sortOrder: 5, alumniCount: 12 },
];

const categories: ArticleCategoryDto[] = [
  { id: 1, name: '校友动态', slug: 'alumni', sortOrder: 1, articleCount: 12 },
  { id: 2, name: '母校新闻', slug: 'school', sortOrder: 2, articleCount: 8 },
  { id: 3, name: '政策解读', slug: 'policy', sortOrder: 3, articleCount: 5 },
];

const admins: AdminUserDto[] = [
  {
    id: 1,
    username: 'super',
    displayName: '超级管理员',
    roles: ['super_admin'],
    status: 'active',
    lastLoginAt: '2026-11-15T02:10:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 2,
    username: 'reviewer',
    displayName: '审核员',
    roles: ['alumni_reviewer'],
    status: 'active',
    lastLoginAt: '2026-11-14T08:30:00.000Z',
    createdAt: '2026-02-11T00:00:00.000Z',
  },
];

/** 管理端校友列表项：契约档案 + 管理端额外字段（与 AdminAlumniListItem 同构） */
type MockAlumniItem = AlumniProfileDto & {
  userStatus: UserStatus;
  stage: string;
};

const alumni: MockAlumniItem[] = Array.from({ length: 8 }).map((_, index) => ({
  userId: 100 + index,
  displayName: `校友${index + 1}`,
  realName: `张${index + 1}`,
  college: ['数学学院', '光华管理学院', '中文系', '计算机学院'][index % 4],
  degree: ['本科', '硕士', '博士'][index % 3],
  graduationYear: 2005 + index,
  regionCode: regions[index % regions.length].code,
  regionName: regions[index % regions.length].name,
  industryCode: industries[index % industries.length].code,
  industryName: industries[index % industries.length].name,
  direction: '教育与管理',
  intro: '这是用于演示的校友简介。',
  verified: index % 2 === 0,
  verifiedAt: index % 2 === 0 ? '2026-06-01T00:00:00.000Z' : null,
  contactVisible: false,
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-01T00:00:00.000Z',
  // 管理端列表额外字段（AdminAlumniListItem）：账号状态 / 认证阶段
  userStatus: 'active',
  stage: index % 2 === 0 ? 'verified' : 'pending_review',
}));

const verifications: VerificationApplicationDto[] = Array.from({ length: 5 }).map((_, index) => ({
  id: 300 + index,
  userId: 100 + index,
  applicantName: `申请人${index + 1}`,
  college: ['数学学院', '光华管理学院', '中文系'][index % 3],
  graduationYear: 2008 + index,
  degree: '本科',
  studentIdMasked: '2018****1234',
  status: index === 0 ? 'pending' : 'approved',
  attachments: [
    {
      id: 900 + index,
      mediaId: 900 + index,
      fileName: 'student-card.jpg',
      mimeType: 'image/jpeg',
      size: 204800,
      uploadedAt: '2026-11-10T00:00:00.000Z',
    },
  ],
  reviews:
    index === 0
      ? []
      : [
          {
            id: 800 + index,
            adminId: 1,
            adminName: '超级管理员',
            action: 'approve',
            note: '材料齐全',
            createdAt: '2026-11-11T00:00:00.000Z',
          },
        ],
  submittedAt: '2026-11-10T00:00:00.000Z',
  decidedAt: index === 0 ? null : '2026-11-11T00:00:00.000Z',
}));

const resources: ResourcePostDto[] = Array.from({ length: 6 }).map((_, index) => ({
  id: 500 + index,
  authorId: 100 + index,
  authorName: `校友${index + 1}`,
  type: index % 3 === 0 ? 'demand' : 'resource',
  title: `资源/需求标题 ${index + 1}`,
  body: '这是用于演示的资源正文内容。',
  industryCode: industries[index % industries.length].code,
  industryName: industries[index % industries.length].name,
  regionCode: regions[index % regions.length].code,
  regionName: regions[index % regions.length].name,
  status: index === 0 ? 'pending' : 'published',
  version: 1,
  attachments: [],
  reviews: [],
  publishedAt: index === 0 ? null : '2026-11-01T00:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
}));

const events: EventDto[] = Array.from({ length: 4 }).map((_, index) => ({
  id: 700 + index,
  title: `校友活动 ${index + 1}`,
  kind: '校友聚会',
  regionCode: regions[index % regions.length].code,
  regionName: regions[index % regions.length].name,
  place: '呼和浩特市',
  description: '活动说明。',
  startsAt: '2026-12-01T02:00:00.000Z',
  endsAt: '2026-12-01T09:00:00.000Z',
  capacity: 50,
  registeredCount: index * 3,
  status: index === 0 ? 'draft' : 'published',
  coverMediaId: null,
  myRegistration: null,
  createdAt: '2026-09-01T00:00:00.000Z',
}));

const registrations: EventRegistrationDto[] = Array.from({ length: 3 }).map((_, index) => ({
  id: 750 + index,
  eventId: 700,
  userId: 100 + index,
  userName: `校友${index + 1}`,
  status: 'registered',
  note: null,
  createdAt: '2026-11-05T00:00:00.000Z',
}));

const articles: ArticleDto[] = Array.from({ length: 5 }).map((_, index) => ({
  id: 850 + index,
  categoryId: categories[index % categories.length].id,
  categoryName: categories[index % categories.length].name,
  title: `资讯标题 ${index + 1}`,
  summary: '摘要',
  body: '正文内容。',
  coverMediaId: null,
  status: index === 0 ? 'draft' : 'published',
  publishedAt: index === 0 ? null : '2026-11-02T00:00:00.000Z',
  viewCount: index * 12,
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
}));

const notices: NoticeDto[] = Array.from({ length: 4 }).map((_, index) => ({
  id: 950 + index,
  title: `公告 ${index + 1}`,
  body: '公告内容。',
  status: index === 0 ? 'draft' : 'published',
  publishedAt: index === 0 ? null : '2026-11-04T00:00:00.000Z',
  viewCount: index * 5,
  createdAt: '2026-09-10T00:00:00.000Z',
}));

const actionLogs: AdminActionLogDto[] = Array.from({ length: 6 }).map((_, index) => ({
  id: 990 + index,
  adminId: 1,
  adminName: '超级管理员',
  action: ['verification.approve', 'resource.approve', 'article.publish'][index % 3],
  targetType: ['verification', 'resource', 'article'][index % 3],
  targetId: String(100 + index),
  detail: { note: '演示日志' },
  ip: '10.0.0.8',
  createdAt: '2026-11-12T00:00:00.000Z',
}));

const settings: SystemSettingDto[] = [
  { key: 'site.name', value: '内蒙古北京大学校友会', description: '站点名称', updatedAt: '2026-01-01T00:00:00.000Z' },
  { key: 'verify.autoPass', value: 'false', description: '认证是否自动通过', updatedAt: '2026-01-01T00:00:00.000Z' },
];

const stats: AdminStats = {
  alumniTotal: 1286,
  alumniVerified: 942,
  verificationPending: 37,
  resourceTotal: 486,
  resourcePending: 21,
  eventTotal: 38,
  eventRegistrations: 1543,
  connectionTotal: 2681,
  connectionPending: 45,
  userTotal: 3120,
  articleTotal: 96,
  noticeTotal: 24,
};

const roleCatalogue: AdminRole[] = [
  'super_admin',
  'alumni_reviewer',
  'content_admin',
  'event_admin',
  'resource_reviewer',
];

const permissionCatalogue: AdminPermission[] = [
  'dashboard:view',
  'alumni:view',
  'alumni:manage',
  'verification:review',
  'resource:review',
  'resource:manage',
  'event:manage',
  'content:manage',
  'notification:broadcast',
  'admin:manage',
  'audit:view',
  'settings:manage',
];

/** 演示模式下的路径匹配：key = `${METHOD} ${path}` */
export function mockRequest<T>(method: string, url: string, payload?: unknown): Promise<T> {
  const key = `${method.toUpperCase()} ${url}`;
  const data = resolveMock<T>(key, method, url, payload);
  if (data === undefined) {
    return Promise.reject(new Error(`演示数据模式未实现该接口：${key}`));
  }
  return Promise.resolve(data);
}

function resolveMock<T>(
  key: string,
  method: string,
  url: string,
  payload?: unknown,
): T | undefined {
  switch (key) {
    case `POST ${ApiPaths.adminLogin}`:
      return {
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
        admin: admins[0],
        permissions: permissionCatalogue,
      } as unknown as T;
    case `GET ${ApiPaths.session}`:
      return { user: { id: 1, role: 'super_admin' }, stage: 'admin' } as unknown as T;
    case `GET ${ApiPaths.adminStats}`:
      return stats as unknown as T;
    case `GET ${ApiPaths.adminAlumni}`:
      return page(alumni, payload as object) as unknown as T;
    case `GET ${ApiPaths.adminVerifications}`:
      return page(verifications, payload as object) as unknown as T;
    case `GET ${ApiPaths.adminResources}`:
      return page(resources, payload as object) as unknown as T;
    case `GET ${ApiPaths.adminEvents}`:
      return page(events, payload as object) as unknown as T;
    case `GET ${ApiPaths.adminArticles}`:
      return page(articles, payload as object) as unknown as T;
    case `GET ${ApiPaths.adminNotices}`:
      return page(notices, payload as object) as unknown as T;
    case `GET ${ApiPaths.adminUsers}`:
      return page(admins, payload as object) as unknown as T;
    case `GET ${ApiPaths.adminActionLogs}`:
      return page(actionLogs, payload as object) as unknown as T;
    case `GET ${ApiPaths.adminRoles}`:
      return roleCatalogue as unknown as T;
    case `GET ${ApiPaths.adminPermissions}`:
      return permissionCatalogue as unknown as T;
    case `GET ${ApiPaths.adminSettings}`:
      return settings as unknown as T;
    case `GET ${ApiPaths.systemRegions}`:
      return regions as unknown as T;
    case `GET ${ApiPaths.systemIndustries}`:
      return industries as unknown as T;
    case `GET ${ApiPaths.articleCategories}`:
      return categories as unknown as T;
    case `GET ${ApiPaths.uploads}`:
      return undefined;
    default:
      break;
  }

  // 带路径参数的接口
  const alumniMatch = url.match(/^\/admin\/alumni\/(\d+)$/);
  if (method === 'GET' && alumniMatch) {
    const item = alumni.find((entry) => entry.userId === Number(alumniMatch[1]));
    return (item ? { ...item, verifications } : undefined) as unknown as T | undefined;
  }
  const verificationMatch = url.match(/^\/admin\/verifications\/(\d+)$/);
  if (method === 'GET' && verificationMatch) {
    const item = verifications.find((entry) => entry.id === Number(verificationMatch[1]));
    return item as unknown as T | undefined;
  }
  const resourceMatch = url.match(/^\/admin\/resources\/(\d+)$/);
  if (method === 'GET' && resourceMatch) {
    const item = resources.find((entry) => entry.id === Number(resourceMatch[1]));
    return item as unknown as T | undefined;
  }
  const eventMatch = url.match(/^\/admin\/events\/(\d+)$/);
  if (method === 'GET' && eventMatch) {
    const item = events.find((entry) => entry.id === Number(eventMatch[1]));
    return item as unknown as T | undefined;
  }
  const registrationMatch = url.match(/^\/admin\/events\/(\d+)\/registrations$/);
  if (method === 'GET' && registrationMatch) {
    return registrations as unknown as T;
  }
  const userStatusMatch = url.match(/^\/admin\/users\/(\d+)\/status$/);
  if (method === 'POST' && userStatusMatch) {
    return { id: Number(userStatusMatch[1]) } as unknown as T;
  }
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    return (payload ?? { ok: true }) as unknown as T;
  }
  return undefined;
}
