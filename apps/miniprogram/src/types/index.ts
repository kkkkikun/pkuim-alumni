/**
 * 接口契约类型（本地镜像）。
 *
 * 来源：`packages/contracts/src/common.ts`、`packages/contracts/src/domain.ts`、
 * `packages/contracts/src/api.ts`（工作区包 `@nmg/contracts`）。
 *
 * 小程序运行时无法直接引用工作区 TypeScript 包（没有打包步骤），
 * 因此在此按契约镜像一份类型定义，仅作为 `import type` 使用，不产生任何运行时依赖。
 * 契约变更后需同步本文件；如需强一致，可由契约包导出脚本生成本文件。
 */

/* ------------------------------ 通用 ------------------------------ */

/** 统一响应包装 */
export interface ApiResponse<T> {
  code: string;
  message: string;
  data: T;
  requestId?: string;
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PageResult<T> {
  items: T[];
  meta: PageMeta;
}

export interface PageQuery {
  page?: number;
  pageSize?: number;
}

export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_FAILED: 'AUTH_FAILED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  VERIFICATION_REQUIRED: 'VERIFICATION_REQUIRED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiErrorPayload {
  code: ErrorCodeValue | string;
  message: string;
  requestId?: string;
  details?: Record<string, unknown>;
}

/* ------------------------------ 枚举 ------------------------------ */

export type AlumniStage = 'guest' | 'logged_in' | 'pending_review' | 'verified';

export type UserStatus = 'active' | 'disabled' | 'locked';

export type VerificationStatus =
  | 'pending'
  | 'needs_more_material'
  | 'approved'
  | 'rejected'
  | 'resubmitted';

export type ResourceStatus =
  | 'draft'
  | 'pending'
  | 'published'
  | 'rejected'
  | 'offline'
  | 'withdrawn';

export type ResourceType = 'resource' | 'demand';

export type ReviewAction = 'approve' | 'reject' | 'request_changes' | 'offline';

export type ConnectionRequestStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'expired';

export type EventStatus = 'draft' | 'published' | 'closed' | 'cancelled';

export type RegistrationStatus = 'registered' | 'cancelled' | 'attended';

export type NotificationType =
  | 'verification_submitted'
  | 'verification_decision'
  | 'connection_request'
  | 'connection_decision'
  | 'resource_review'
  | 'event_registration'
  | 'event_changed'
  | 'system';

/* ------------------------------ 用户 ------------------------------ */

export interface UserProfile {
  id: number;
  openid: string;
  nickname: string;
  avatarUrl: string | null;
  role: string | null;
  status: UserStatus;
  stage: AlumniStage;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface PrivacySettings {
  showInDirectory: boolean;
  showCollege: boolean;
  showIndustry: boolean;
  showRegion: boolean;
  showDirection: boolean;
  acceptContactRequests: boolean;
  allowContactShare: boolean;
}

export interface AlumniProfileDto {
  userId: number;
  displayName: string;
  realName: string | null;
  college: string | null;
  degree: string | null;
  graduationYear: number | null;
  regionCode: string | null;
  regionName: string | null;
  industryCode: string | null;
  industryName: string | null;
  direction: string | null;
  intro: string | null;
  verified: boolean;
  verifiedAt: string | null;
  contactVisible: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 我方视角：包含隐私开关与联系方式（仅本人或已授权方可见） */
export interface MyAlumniProfile extends AlumniProfileDto {
  privacy: PrivacySettings;
  contactPhone: string | null;
  contactWechat: string | null;
  contactEmail: string | null;
}

/* ------------------------------ 认证 ------------------------------ */

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface LoginResult extends TokenPair {
  user: UserProfile;
  alumniProfile: AlumniProfileDto | null;
  stage: AlumniStage;
}

/* ------------------------------ 字典 ------------------------------ */

export interface RegionDto {
  code: string;
  name: string;
  level: 'city' | 'outside';
  sortOrder: number;
  alumniCount?: number;
}

export interface IndustryDto {
  code: string;
  name: string;
  sortOrder: number;
  alumniCount?: number;
}

export interface ArticleCategoryDto {
  id: number;
  name: string;
  slug: string;
  sortOrder: number;
  articleCount: number;
}

/* ------------------------------ 认证审核 ------------------------------ */

export interface VerificationAttachmentDto {
  id: number;
  mediaId: number;
  fileName: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
}

export interface VerificationReviewDto {
  id: number;
  adminId: number;
  adminName: string;
  action: ReviewAction;
  note: string | null;
  createdAt: string;
}

export interface VerificationApplicationDto {
  id: number;
  userId: number;
  applicantName: string;
  college: string | null;
  graduationYear: number | null;
  degree: string | null;
  studentIdMasked: string | null;
  status: VerificationStatus;
  attachments: VerificationAttachmentDto[];
  reviews: VerificationReviewDto[];
  submittedAt: string;
  decidedAt: string | null;
}

/* ------------------------------ 通讯录 ------------------------------ */

export interface DirectoryQuery {
  keyword?: string;
  regionCode?: string;
  industryCode?: string;
  graduationYear?: number;
  page?: number;
  pageSize?: number;
}

export interface DirectoryEntry {
  userId: number;
  displayName: string;
  college: string | null;
  graduationYear: number | null;
  regionCode: string | null;
  regionName: string | null;
  industryCode: string | null;
  industryName: string | null;
  direction: string | null;
  verified: boolean;
  connectionState: 'none' | 'pending_outgoing' | 'pending_incoming' | 'connected';
}

/* ------------------------------ 连接 ------------------------------ */

export interface PeerContact {
  name: string;
  phone: string | null;
  wechat: string | null;
  email: string | null;
}

export interface ConnectionPairDto {
  id: number;
  userAId: number;
  userBId: number;
  peerUserId: number;
  peerName: string;
  peerCollege: string | null;
  peerRegionName: string | null;
  peerIndustryName: string | null;
  status: 'active' | 'revoked';
  establishedAt: string;
  /** 我是否已授权向对方展示联系方式 */
  myContactShared: boolean;
  /** 对方是否已授权向我展示联系方式 */
  peerContactShared: boolean;
  /** 双方均授权后才有值 */
  peerContact: PeerContact | null;
}

export interface ConnectionRequestDto {
  id: number;
  fromUserId: number;
  toUserId: number;
  fromName: string;
  toName: string;
  message: string;
  status: ConnectionRequestStatus;
  createdAt: string;
  decidedAt: string | null;
  pairId: number | null;
}

/* ------------------------------ 资源与需求 ------------------------------ */

export interface ResourceReviewDto {
  id: number;
  adminId: number;
  adminName: string;
  action: ReviewAction;
  note: string | null;
  snapshotVersion: number;
  createdAt: string;
}

export interface ResourcePostDto {
  id: number;
  authorId: number;
  authorName: string;
  type: ResourceType;
  title: string;
  body: string;
  industryCode: string | null;
  industryName: string | null;
  regionCode: string | null;
  regionName: string | null;
  status: ResourceStatus;
  version: number;
  /** 附件（只含文件本身信息；镜像同步自契约，详见 KNOWN-ISSUES #75） */
  attachments: ResourceAttachmentDto[];
  reviews: ResourceReviewDto[];
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 资源附件（镜像自契约 ResourceAttachmentDto） */
export interface ResourceAttachmentDto {
  id: number;
  mediaId: number;
  fileName: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
}

/* ------------------------------ 活动 ------------------------------ */

export interface EventDto {
  id: number;
  title: string;
  kind: string;
  regionCode: string | null;
  regionName: string | null;
  place: string | null;
  description: string | null;
  startsAt: string | null;
  endsAt: string | null;
  capacity: number;
  registeredCount: number;
  status: EventStatus;
  coverMediaId: number | null;
  myRegistration: RegistrationStatus | null;
  createdAt: string;
}

export interface EventRegistrationDto {
  id: number;
  eventId: number;
  userId: number;
  userName: string;
  status: RegistrationStatus;
  note: string | null;
  createdAt: string;
}

/* ------------------------------ 内容 ------------------------------ */

export interface ArticleDto {
  id: number;
  categoryId: number | null;
  categoryName: string | null;
  title: string;
  summary: string | null;
  body: string;
  coverMediaId: number | null;
  status: 'draft' | 'published' | 'offline';
  publishedAt: string | null;
  viewCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface NoticeDto {
  id: number;
  title: string;
  body: string;
  status: 'draft' | 'published' | 'offline';
  publishedAt: string | null;
  viewCount: number;
  createdAt: string;
}

/* ------------------------------ 通知 ------------------------------ */

export interface NotificationDto {
  id: number;
  type: NotificationType;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

export interface NotificationUnreadCount {
  unread: number;
}

/* ------------------------------ 文件 ------------------------------ */

export interface MediaAssetDto {
  id: number;
  fileName: string;
  mimeType: string;
  size: number;
  bucket: string;
  objectKey: string;
  visibility: 'public' | 'private';
  url: string | null;
  createdAt: string;
}

/* ------------------------------ 请求体 ------------------------------ */

export interface MockLoginBody {
  mockOpenid?: string;
  nickname?: string;
}

export interface WechatLoginBody {
  code: string;
}

export interface RefreshBody {
  refreshToken: string;
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

export interface RegisterEventBody {
  note?: string;
}

/* ------------------------------ 组合响应 ------------------------------ */

/** 会话用户（`GET /auth/session` 的精简投影） */
export interface SessionUser {
  id: number;
  openid: string;
  nickname: string;
  role: string | null;
  stage: string;
  isAdmin: boolean;
  permissions: string[];
}

export type AuthSessionResponse = { user: SessionUser | null; stage: string | null };
export type MeResponse = { user: UserProfile; alumniProfile: MyAlumniProfile | null; stage: AlumniStage };

/**
 * `GET /me/summary` 的响应（契约 `MeSummaryResponse`）。
 *
 * ⚠️ 第三轮新增：小程序「我的」页首屏的四个计数。
 *    此前这四个数字要靠 4 个列表接口各取一页才能拿到（首屏 5 个请求），
 *    现在 1 个请求给全（首屏 2 个请求）。
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
export type ConnectionsResponse = PageResult<ConnectionPairDto>;
export type ConnectionRequestsResponse = PageResult<ConnectionRequestDto>;
export type VerificationsResponse = PageResult<VerificationApplicationDto>;
export type RegionsResponse = RegionDto[];
export type IndustriesResponse = IndustryDto[];
export type CategoriesResponse = ArticleCategoryDto[];
export type MediaAssetResponse = MediaAssetDto;
export type UploadUrlResponse = { url: string; expiresIn: number };
export type PrivacyResponse = PrivacySettings;
export type LoginResponse = LoginResult;
export type RefreshResponse = TokenPair;
/**
 * `GET /admin/events/:id/registrations` 的响应（契约 `EventRegistrationsResponse`）。
 *
 * ⚠️ 第三轮：从「裸数组（全部报名记录）」改为 `{items, meta}` 分页结构。
 */
export type EventRegistrationsResponse = PageResult<EventRegistrationDto>;
export type VerificationStatusResponse = { status: VerificationStatus };
export type VerificationApplicationResponse = VerificationApplicationDto;

/**
 * `GET /alumni/verification/mine` 的响应（契约 `VerificationsMineResponse`）。
 *
 * ⚠️ 第三轮：从「裸数组（全部认证申请）」改为 `{items, meta}` 分页结构。
 */
export type VerificationsMineResponse = PageResult<VerificationApplicationDto>;

/* ------------------------------ 上传（契约未定义，客户端本地约定） ------------------------------ */

/**
 * 创建上传任务的请求体（两步上传的第一步：`POST /uploads/records`）。
 *
 * 契约 `packages/contracts/src/api.ts` 的 `CreateUploadBody` 已给出结构，
 * 此处为镜像副本，字段与契约一一对应。
 */
export interface CreateUploadBody {
  fileName: string;
  mimeType: string;
  size: number;
  visibility?: 'public' | 'private';
}
