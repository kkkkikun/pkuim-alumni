/**
 * 接口路径与写入请求体契约。
 * 路径以服务端实现为准；所有应用必须只通过这里访问后端。
 */
import type { PageResult } from './common';
import type {
  AdminLoginResult,
  AdminPermissionDto,
  AdminRole,
  AdminRoleDto,
  AdminStats,
  AlumniStage,
  ArticleDto,
  ArticleCategoryDto,
  ConnectionPairDto,
  ConnectionRequestDto,
  DirectoryEntry,
  EventDto,
  EventRegistrationDto,
  IndustryDto,
  LoginResult,
  MediaAssetDto,
  MyAlumniProfile,
  NoticeDto,
  NotificationDto,
  PeerContact,
  PrivacySettings,
  RegionDto,
  ResourcePostDto,
  ResourceType,
  ReviewAction,
  SystemSettingDto,
  TokenPair,
  UserProfile,
  VerificationApplicationDto,
  VerificationStatus,
} from './domain';

export const ApiPaths = {
  // Auth
  wechatLogin: '/auth/wechat/login',
  mockLogin: '/auth/mock/login',
  refresh: '/auth/refresh',
  logout: '/auth/logout',
  adminLogin: '/auth/admin/login',
  session: '/auth/session',

  // Me
  me: '/me',
  /** 首屏计数汇总（一次请求给出四个计数；未读数实时取、不缓存） */
  meSummary: '/me/summary',
  meProfile: '/me/profile',
  mePrivacy: '/me/privacy',
  meContacts: '/me/contacts',
  meConnections: '/me/connections',
  meConnectionRequests: '/me/connection-requests',
  meResources: '/me/resources',
  meEvents: '/me/events',
  meVerifications: '/me/verifications',
  meNotifications: '/me/notifications',

  // Users / Alumni
  // 注意：`/alumni` **列表**（管理端）已删除，管理端校友列表统一走 `/admin/alumni`。
  // `/alumni` 命名空间只保留公开名片与认证流程（详见 docs/KNOWN-ISSUES.md #72）。
  alumniItem: (id: number) => `/alumni/${id}`,
  alumniVerification: '/alumni/verification',
  alumniVerificationItem: (id: number) => `/alumni/verification/${id}`,
  alumniVerificationHistory: (id: number) => `/alumni/verification/${id}/history`,
  alumniVerificationMine: '/alumni/verification/mine',
  alumniVerificationResubmit: (id: number) => `/alumni/verification/${id}/resubmit`,

  // Directory
  directory: '/directory',
  directoryItem: (id: number) => `/directory/${id}`,

  // Connections
  connectionRequests: '/connections/requests',
  connectionRequestItem: (id: number) => `/connections/requests/${id}`,
  connectionRequestAccept: (id: number) => `/connections/requests/${id}/accept`,
  connectionRequestReject: (id: number) => `/connections/requests/${id}/reject`,
  connectionRequestCancel: (id: number) => `/connections/requests/${id}/cancel`,
  connections: '/connections',
  connectionItem: (id: number) => `/connections/${id}`,
  connectionContactGrant: (id: number) => `/connections/${id}/contact-grant`,

  // Resources
  resources: '/resources',
  resourceItem: (id: number) => `/resources/${id}`,
  resourceSubmit: (id: number) => `/resources/${id}/submit`,
  resourceWithdraw: (id: number) => `/resources/${id}/withdraw`,

  // Events
  events: '/events',
  eventItem: (id: number) => `/events/${id}`,
  eventRegister: (id: number) => `/events/${id}/registrations`,

  // Content
  articles: '/articles',
  articleItem: (id: number) => `/articles/${id}`,
  /** 公开只读：资讯分类列表（小程序无需登录即可读取） */
  articleCategories: '/articles/categories',
  notices: '/notices',
  noticeItem: (id: number) => `/notices/${id}`,
  homeFeed: '/home/feed',

  // Notifications
  notifications: '/notifications',
  notificationItem: (id: number) => `/notifications/${id}`,
  notificationRead: (id: number) => `/notifications/${id}/read`,
  notificationReadAll: '/notifications/read-all',
  notificationUnreadCount: '/notifications/unread-count',

  // Uploads
  uploads: '/uploads',
  uploadRecords: '/uploads/records',
  uploadContent: (id: number) => `/uploads/${id}/content`,
  uploadUrl: (id: number) => `/uploads/${id}/url`,

  // System
  systemRegions: '/system/regions',
  systemIndustries: '/system/industries',
  systemSettings: '/system/settings',
  systemHealth: '/system/health',

  // Admin
  adminStats: '/admin/stats',
  adminAlumni: '/admin/alumni',
  adminAlumniItem: (id: number) => `/admin/alumni/${id}`,
  adminVerifications: '/admin/verifications',
  adminVerificationItem: (id: number) => `/admin/verifications/${id}`,
  adminVerificationDecision: (id: number) => `/admin/verifications/${id}/decision`,
  /** 认证证明材料预览地址（仅审核员；私有资产按「挂在该申请上」鉴权，见 KNOWN-ISSUES #77） */
  adminVerificationAttachmentUrl: (id: number, mediaId: number) =>
    `/admin/verifications/${id}/attachments/${mediaId}/url`,
  adminResources: '/admin/resources',
  adminResourceItem: (id: number) => `/admin/resources/${id}`,
  adminResourceDecision: (id: number) => `/admin/resources/${id}/decision`,
  /** 资源附件预览地址（仅审核员，见 KNOWN-ISSUES #77） */
  adminResourceAttachmentUrl: (id: number, mediaId: number) =>
    `/admin/resources/${id}/attachments/${mediaId}/url`,
  adminEvents: '/admin/events',
  adminEventItem: (id: number) => `/admin/events/${id}`,
  adminEventRegistrations: (id: number) => `/admin/events/${id}/registrations`,
  adminArticles: '/admin/articles',
  adminArticleItem: (id: number) => `/admin/articles/${id}`,
  adminNotices: '/admin/notices',
  adminNoticeItem: (id: number) => `/admin/notices/${id}`,
  adminUsers: '/admin/users',
  adminUserItem: (id: number) => `/admin/users/${id}`,
  adminUserStatus: (id: number) => `/admin/users/${id}/status`,
  adminArticleCategories: '/admin/articles/categories',
  adminArticleCategoryItem: (id: number) => `/admin/articles/categories/${id}`,
  adminRoles: '/admin/roles',
  adminPermissions: '/admin/permissions',
  adminActionLogs: '/admin/action-logs',
  adminSettings: '/admin/settings',
} as const;

/* ------------------------------ 请求体 ------------------------------ */

export interface MockLoginBody {
  /** 演示用 openid；留空则自动生成 */
  mockOpenid?: string;
  nickname?: string;
}

export interface WechatLoginBody {
  code: string;
}

export interface RefreshBody {
  refreshToken: string;
}

export interface AdminLoginBody {
  username: string;
  password: string;
}

export interface UpdateProfileBody {
  displayName?: string;
  realName?: string;
  college?: string;
  degree?: string;
  graduationYear?: number;
  regionCode?: string;
  industryCode?: string;
  direction?: string;
  intro?: string;
  contactPhone?: string;
  contactWechat?: string;
  contactEmail?: string;
}

export interface UpdatePrivacyBody {
  showInDirectory?: boolean;
  showCollege?: boolean;
  showIndustry?: boolean;
  showRegion?: boolean;
  /** 「公开我的方向」开关（缺陷 #106：此前服务端会据此裁掉 direction，但用户无从修改） */
  showDirection?: boolean;
  acceptContactRequests?: boolean;
  allowContactShare?: boolean;
}

export interface SubmitVerificationBody {
  realName: string;
  college: string;
  graduationYear: number;
  degree?: string;
  studentIdMasked: string;
  remark?: string;
  attachmentMediaIds: number[];
}

export interface VerificationDecisionBody {
  action: ReviewAction;
  note?: string;
}

export interface CreateConnectionRequestBody {
  targetUserId: number;
  message: string;
}

export interface ContactGrantBody {
  allow: boolean;
}

export interface CreateResourceBody {
  type: ResourceType;
  title: string;
  body: string;
  industryCode?: string;
  regionCode?: string;
  attachmentMediaIds?: number[];
}

export interface UpdateResourceBody {
  title?: string;
  body?: string;
  industryCode?: string;
  regionCode?: string;
  attachmentMediaIds?: number[];
}

export interface ResourceDecisionBody {
  action: ReviewAction;
  note?: string;
}

export interface CreateEventBody {
  title: string;
  kind: string;
  regionCode?: string;
  place?: string;
  description?: string;
  startsAt?: string;
  endsAt?: string;
  capacity: number;
  coverMediaId?: number;
  status?: 'draft' | 'published';
}

export type UpdateEventBody = Partial<CreateEventBody>;

export interface RegisterEventBody {
  note?: string;
}

/**
 * 登记媒体资源（小程序两步上传的第一步：`POST /uploads/records`）。
 *
 * 服务端只接受白名单里的 MIME 与扩展名，单文件不超过 10MB；
 * `visibility` 省略时按 `private` 处理（私有资产只允许上传者本人取地址）。
 */
export interface CreateUploadBody {
  fileName: string;
  mimeType: string;
  size: number;
  visibility?: 'public' | 'private';
}

/**
 * 新建资讯 / 公告。
 *
 * ⚠️ **不含 `publishedAt`**：发布时间由服务端按 `status` 推导
 * （只有 `status === 'published'` 才写发布时间，草稿一律为 null，见缺陷 #80）。
 * 客户端传了也会被 ValidationPipe 的 whitelist 剥掉 —— 与其留一个「传了也没用」
 * 的字段，不如在契约里就说清楚。
 */
export interface CreateArticleBody {
  categoryId?: number;
  title: string;
  summary?: string;
  body: string;
  coverMediaId?: number;
  status?: 'draft' | 'published';
}

export interface CreateNoticeBody {
  title: string;
  body: string;
  status?: 'draft' | 'published';
}

export interface CreateCategoryBody {
  name: string;
  slug: string;
  sortOrder?: number;
}

export interface UpdateUserStatusBody {
  status: 'active' | 'disabled' | 'locked';
  reason?: string;
}

export interface UpdateAdminUserBody {
  displayName?: string;
  roles?: AdminRole[];
  status?: 'active' | 'disabled';
  password?: string;
}

export interface UpsertSettingBody {
  key: string;
  value: string;
  description?: string;
}

/* ------------------------------ 响应类型 ------------------------------ */

/** 会话用户（`GET /auth/session` 返回的精简投影） */
export interface SessionUser {
  id: number;
  openid: string;
  nickname: string;
  role: string | null;
  stage: string;
  isAdmin: boolean;
  /**
   * 权限代码数组：管理端会话是管理员权限点，普通校友恒为空数组。
   *
   * 原先写的是 `AdminPermission[]` —— 比实现更窄：
   * 会话既可能是管理端也可能是普通校友，服务端内部类型一直是 `string[]`。
   * 详见 docs/KNOWN-ISSUES.md #65。
   */
  permissions: string[];
}

export type AuthSessionResponse = { user: SessionUser | null; stage: string | null };
export type MeResponse = { user: UserProfile; alumniProfile: MyAlumniProfile | null; stage: AlumniStage };

/**
 * `GET /me/summary` 的响应：小程序「我的」页首屏的四个计数。
 *
 * ⚠️ 第三轮新增。此前这四个数字要靠 4 个列表接口各取一页才能拿到，
 *    首屏因此要打 5 个请求；现在 1 个请求给全。
 */
export interface MeSummaryResponse {
  /** 我的活动报名数 */
  eventCount: number;
  /** 我收到的联系申请数 */
  requestCount: number;
  /** 我发布的资源 / 需求数 */
  postCount: number;
  /** 未读通知数（**实时**，服务端不缓存） */
  unreadCount: number;
}
export type DirectoryResponse = PageResult<DirectoryEntry>;
export type ResourcesResponse = PageResult<ResourcePostDto>;
export type EventsResponse = PageResult<EventDto>;
export type ArticlesResponse = PageResult<ArticleDto>;
export type NoticesResponse = PageResult<NoticeDto>;
export type NotificationsResponse = PageResult<NotificationDto>;
export type ConnectionsResponse = PageResult<ConnectionPairDto>;
export type ConnectionPairResponse = ConnectionPairDto;
export type ConnectionRequestsResponse = PageResult<ConnectionRequestDto>;
export type VerificationsResponse = PageResult<VerificationApplicationDto>;
/**
 * `GET /alumni/verification/mine` 返回我的认证申请（按时间倒序，**分页**）。
 *
 * ⚠️ 第三轮起改为 `{items, meta}`：此前返回**全部**申请（裸数组、无上限），
 *    一��提交了上百次认证的用户每次都要把整份历史拉下来。
 *    与其它列表接口口径统一（见 docs/API-SPEC.md 第 3 节）。
 */
export type VerificationsMineResponse = PageResult<VerificationApplicationDto>;
export type RegionsResponse = RegionDto[];
export type IndustriesResponse = IndustryDto[];
export type CategoriesResponse = ArticleCategoryDto[];
export type MediaAssetResponse = MediaAssetDto;
export type UploadUrlResponse = { url: string; expiresIn: number };
export type AdminStatsResponse = AdminStats;
/**
 * `GET /admin/roles` 返回分页后的角色目录。
 *
 * ⚠️ 第三轮起改为 `{items, meta}`：此前返回**全表**（裸数组、无上限）。
 */
export type AdminRolesResponse = PageResult<AdminRoleDto>;
/**
 * `GET /admin/permissions` 返回分页后的权限点目录（同上：无上限裸数组 → 分页）。
 */
export type AdminPermissionsResponse = PageResult<AdminPermissionDto>;
/**
 * `GET /admin/settings` 返回分页后的系统设置项（同上：无上限裸数组 → 分页）。
 */
export type SettingsResponse = PageResult<SystemSettingDto>;
/** 连接详情中对方联系方式字段的类型（整体恒为四重条件成立时才非空） */
export type PeerContactResponse = PeerContact | null;
export type AdminLoginResponse = AdminLoginResult;
export type LoginResponse = LoginResult;
export type RefreshResponse = TokenPair;
export type VerificationApplicationResponse = VerificationApplicationDto;
/** 认证状态由客户端从 `/alumni/verification/mine` 派生 */
export type VerificationStatusResponse = { status: VerificationStatus };
/** `GET /alumni/:id` 返回的是**公开名片投影**，与通讯录条目同构，不含联系方式 */
export type AlumniProfileResponse = DirectoryEntry;
export type PrivacyResponse = PrivacySettings;
/**
 * `GET /admin/events/:id/registrations` 返回该活动的报名名单（**分页**）。
 *
 * ⚠️ 第三轮起改为 `{items, meta}`：此前返回**全部**报名记录（裸数组、无上限），
 *    一个 1000 人活动的点名 = 1000 行全量返回。
 */
export type EventRegistrationsResponse = PageResult<EventRegistrationDto>;
