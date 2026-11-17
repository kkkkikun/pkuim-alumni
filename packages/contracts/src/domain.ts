/**
 * 领域实体契约（DTO）。
 * 与后端 TypeORM 实体一一对应，但**不含**数据库内部字段与任何敏感值。
 */

/* ------------------------------ 枚举 ------------------------------ */

/** 用户身份阶段（前端据此控制可用功能，后端同样强制校验） */
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

/** 管理后台角色（RBAC） */
export type AdminRole =
  | 'super_admin'
  | 'alumni_reviewer'
  | 'content_admin'
  | 'event_admin'
  | 'resource_reviewer';

/** 管理端权限点 */
export type AdminPermission =
  | 'dashboard:view'
  | 'alumni:view'
  | 'alumni:manage'
  | 'verification:review'
  | 'resource:review'
  | 'resource:manage'
  | 'event:manage'
  | 'content:manage'
  | 'notification:broadcast'
  | 'admin:manage'
  | 'audit:view'
  | 'settings:manage';

/* ------------------------------ 用户 ------------------------------ */

export interface UserProfile {
  id: number;
  openid: string;
  nickname: string;
  avatarUrl: string | null;
  /**
   * 角色：普通校友是 `'alumni'`，管理端会话才是 AdminRole 之一。
   *
   * 这里原先写的是 `AdminRole | null` —— 与实现不符：
   * 普通用户的 role 恒为 `'alumni'`，并不在 AdminRole 联合里，
   * 服务端内部类型也一直是 `string | null`。
   * 详见 docs/KNOWN-ISSUES.md #64。
   */
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
  /** 「公开我的方向」开关（缺陷 #106：此前服务端会据此裁掉 direction，但用户无从修改） */
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

export interface AdminLoginResult extends TokenPair {
  admin: AdminUserDto;
  permissions: AdminPermission[];
}

export interface AdminUserDto {
  id: number;
  username: string;
  displayName: string;
  roles: AdminRole[];
  /**
   * 管理员账号状态。
   *
   * ⚠️ 这里**不是** `UserStatus`：`admin_users.status` 的 ENUM 只有
   * ('active','disabled')（见 DATABASE-DESIGN.md §8），
   * 管理员账号**没有** 'locked' 这个状态（普通校友账号才有）。
   * 契约写成 UserStatus 等于承诺了一个服务端永远给不出的值（缺陷 #114）。
   */
  status: 'active' | 'disabled';
  lastLoginAt: string | null;
  createdAt: string;
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
  /** 该分类下**已发布**文章数（草稿不计入，公开列表不泄露内部信息） */
  articleCount: number;
}

/* ------------------------------ 认证审核 ------------------------------ */

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

/** 规范化连接对：userId 永远按升序存储 */
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

export interface PeerContact {
  name: string;
  phone: string | null;
  wechat: string | null;
  email: string | null;
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
  /**
   * 附件列表。
   *
   * ⚠️ 这里**不是** `MediaAssetDto` —— 那是媒体资产本体（含 bucket / objectKey /
   * visibility 等内部存储细节），不该随资源内容对外公布。
   * 附件只需要「是哪份文件、多大、什么类型」，与 `VerificationAttachmentDto` 同构。
   * 详见 docs/KNOWN-ISSUES.md #75。
   */
  attachments: ResourceAttachmentDto[];
  reviews: ResourceReviewDto[];
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 资源 / 需求的附件（只暴露文件本身的信息，不含内部存储细节） */
export interface ResourceAttachmentDto {
  id: number;
  mediaId: number;
  fileName: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
}

export interface ResourceReviewDto {
  id: number;
  adminId: number;
  adminName: string;
  action: ReviewAction;
  note: string | null;
  snapshotVersion: number;
  createdAt: string;
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

/* ------------------------------ 管理后台 ------------------------------ */

export interface AdminStats {
  alumniTotal: number;
  alumniVerified: number;
  verificationPending: number;
  resourceTotal: number;
  resourcePending: number;
  eventTotal: number;
  eventRegistrations: number;
  connectionTotal: number;
  connectionPending: number;
  userTotal: number;
  articleTotal: number;
  noticeTotal: number;
}

export interface AdminActionLogDto {
  id: number;
  adminId: number;
  adminName: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

export interface SystemSettingDto {
  key: string;
  value: string;
  description: string | null;
  updatedAt: string;
}
