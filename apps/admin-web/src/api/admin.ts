import type {
  AdminActionLogDto,
  AdminPermissionDto,
  AdminRoleDto,
  AdminStats,
  AdminUserDto,
  AlumniProfileDto,
  ArticleCategoryDto,
  ArticleDto,
  CreateArticleBody,
  CreateCategoryBody,
  CreateEventBody,
  CreateNoticeBody,
  EventDto,
  EventRegistrationDto,
  NoticeDto,
  PageResult,
  ResourceDecisionBody,
  ResourcePostDto,
  ResourceStatus,
  ResourceType,
  SystemSettingDto,
  UpdateAdminUserBody,
  UpdateEventBody,
  UploadUrlResponse,
  UpsertSettingBody,
  UserStatus,
  VerificationApplicationDto,
  VerificationDecisionBody,
  VerificationStatus,
} from '@nmg/contracts';
import { ApiPaths } from '@nmg/contracts';
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from './http';
import { readPageResult } from './page-result';

/* ------------------------------ 查询参数 ------------------------------ */

export interface PagedQuery {
  page?: number;
  pageSize?: number;
}

export interface AdminAlumniQuery extends PagedQuery {
  keyword?: string;
  college?: string;
  verified?: boolean;
  status?: UserStatus;
  regionCode?: string;
  industryCode?: string;
  graduationYear?: number;
}

export interface AdminVerificationQuery extends PagedQuery {
  keyword?: string;
  status?: VerificationStatus;
}

export interface AdminResourceQuery extends PagedQuery {
  keyword?: string;
  status?: ResourceStatus;
  type?: ResourceType;
}

export interface AdminEventQuery extends PagedQuery {
  keyword?: string;
  status?: EventDto['status'];
}

export interface AdminArticleQuery extends PagedQuery {
  keyword?: string;
  status?: ArticleDto['status'];
  categoryId?: number;
}

export interface AdminNoticeQuery extends PagedQuery {
  keyword?: string;
  status?: NoticeDto['status'];
}

export interface AdminUserQuery extends PagedQuery {
  keyword?: string;
  status?: UserStatus;
}

export interface AdminActionLogQuery extends PagedQuery {
  adminId?: number;
  action?: string;
  startDate?: string;
  endDate?: string;
}

/* ------------------------------ 本地补充类型 ------------------------------ */

/**
 * 契约中未定义、但管理端需要的补充结构（不使用 any）。
 * 校友列表行：契约 AlumniProfileDto + 账号状态 + 身份阶段。
 */
export interface AdminAlumniListItem extends AlumniProfileDto {
  userStatus: UserStatus;
  stage: string;
}

/** 校友详情：档案 + 身份审核历史 */
export interface AdminAlumniDetail extends AdminAlumniListItem {
  verifications: VerificationApplicationDto[];
}

/** 新建管理员（契约仅提供 UpdateAdminUserBody，POST 使用同形状扩展） */
export interface CreateAdminUserBody {
  username: string;
  displayName: string;
  password: string;
  /** 角色代码（角色是目录表 → 开放集合，见 KNOWN-ISSUES #182） */
  roles: string[];
}

export type UpdateArticleBody = Partial<Omit<CreateArticleBody, 'status'>> & {
  status?: ArticleDto['status'];
};
export type UpdateNoticeBody = Partial<Omit<CreateNoticeBody, 'status'>> & {
  status?: NoticeDto['status'];
};
export type UpdateCategoryBody = Partial<CreateCategoryBody>;

/* ------------------------------ 数据总览 ------------------------------ */

export function fetchStats(): Promise<AdminStats> {
  return apiGet<AdminStats>(ApiPaths.adminStats);
}

/* ------------------------------ 校友管理 ------------------------------ */

export function fetchAlumni(query: AdminAlumniQuery): Promise<PageResult<AdminAlumniListItem>> {
  return apiGet<PageResult<AdminAlumniListItem>>(ApiPaths.adminAlumni, query);
}

export function fetchAlumniDetail(id: number): Promise<AdminAlumniDetail> {
  return apiGet<AdminAlumniDetail>(ApiPaths.adminAlumniItem(id));
}

/**
 * 修改账号状态。
 *
 * 管理端路由统一在 `/admin` 命名空间下（契约 `ApiPaths.adminUserStatus`），
 * 服务端同时提供 PATCH 别名。
 */
export function updateUserStatus(
  id: number,
  body: { status: UserStatus; reason?: string },
): Promise<void> {
  return apiPost<void>(ApiPaths.adminUserStatus(id), body);
}

/* ------------------------------ 身份审核 ------------------------------ */

export function fetchVerifications(
  query: AdminVerificationQuery,
): Promise<PageResult<VerificationApplicationDto>> {
  return apiGet<PageResult<VerificationApplicationDto>>(ApiPaths.adminVerifications, query);
}

export function fetchVerificationDetail(id: number): Promise<VerificationApplicationDto> {
  return apiGet<VerificationApplicationDto>(ApiPaths.adminVerificationItem(id));
}

export function decideVerification(
  id: number,
  body: VerificationDecisionBody,
): Promise<VerificationApplicationDto> {
  return apiPost<VerificationApplicationDto>(ApiPaths.adminVerificationDecision(id), body);
}

/**
 * 取认证证明材料的预览地址。
 *
 * 不能直接用 `/uploads/{id}/url`：那是**资产归属**语义（私有资产只有上传者本人可取），
 * 审核员取不到 → 审核流程走不通（KNOWN-ISSUES #77）。
 * 这里走「按业务对象鉴权」的管理端端点：附件确实挂在该待审申请上即可。
 */
export function fetchVerificationAttachmentUrl(
  id: number,
  mediaId: number,
): Promise<UploadUrlResponse> {
  return apiGet<UploadUrlResponse>(ApiPaths.adminVerificationAttachmentUrl(id, mediaId));
}

/* ------------------------------ 资源审核 ------------------------------ */

export function fetchResources(
  query: AdminResourceQuery,
): Promise<PageResult<ResourcePostDto>> {
  return apiGet<PageResult<ResourcePostDto>>(ApiPaths.adminResources, query);
}

export function fetchResourceDetail(id: number): Promise<ResourcePostDto> {
  return apiGet<ResourcePostDto>(ApiPaths.adminResourceItem(id));
}

export function decideResource(id: number, body: ResourceDecisionBody): Promise<ResourcePostDto> {
  return apiPost<ResourcePostDto>(ApiPaths.adminResourceDecision(id), body);
}

/** 取资源附件的预览地址（同样按业务对象鉴权，见 KNOWN-ISSUES #77） */
export function fetchResourceAttachmentUrl(
  id: number,
  mediaId: number,
): Promise<UploadUrlResponse> {
  return apiGet<UploadUrlResponse>(ApiPaths.adminResourceAttachmentUrl(id, mediaId));
}

/* ------------------------------ 活动管理 ------------------------------ */

export function fetchEvents(query: AdminEventQuery): Promise<PageResult<EventDto>> {
  return apiGet<PageResult<EventDto>>(ApiPaths.adminEvents, query);
}

export function fetchEventDetail(id: number): Promise<EventDto> {
  return apiGet<EventDto>(ApiPaths.adminEventItem(id));
}

export function createEvent(body: CreateEventBody): Promise<EventDto> {
  return apiPost<EventDto>(ApiPaths.adminEvents, body);
}

export function updateEvent(id: number, body: UpdateEventBody): Promise<EventDto> {
  return apiPatch<EventDto>(ApiPaths.adminEventItem(id), body);
}

export function deleteEvent(id: number): Promise<void> {
  return apiDelete<void>(ApiPaths.adminEventItem(id));
}

export function publishEvent(id: number, published: boolean): Promise<EventDto> {
  return apiPatch<EventDto>(ApiPaths.adminEventItem(id), {
    status: published ? 'published' : 'draft',
  });
}

/**
 * 活动报名名单。
 *
 * ⚠️ 第三轮：该端点从「裸数组（**全部**报名记录）」改为 `{items, meta}` 分页结构 ——
 *    一个 1000 人活动的点名此前是 1000 行全量返回。
 */
export async function fetchEventRegistrations(
  id: number,
  query: PagedQuery = {},
): Promise<PageResult<EventRegistrationDto>> {
  const raw = await apiGet<unknown>(ApiPaths.adminEventRegistrations(id), {
    page: query.page,
    pageSize: query.pageSize,
  });
  return readPageResult<EventRegistrationDto>(raw, ApiPaths.adminEventRegistrations(id));
}

/* ------------------------------ 内容管理 ------------------------------ */

export function fetchArticles(query: AdminArticleQuery): Promise<PageResult<ArticleDto>> {
  return apiGet<PageResult<ArticleDto>>(ApiPaths.adminArticles, query);
}

export function createArticle(body: CreateArticleBody): Promise<ArticleDto> {
  return apiPost<ArticleDto>(ApiPaths.adminArticles, body);
}

export function updateArticle(id: number, body: UpdateArticleBody): Promise<ArticleDto> {
  return apiPatch<ArticleDto>(ApiPaths.adminArticleItem(id), body);
}

export function deleteArticle(id: number): Promise<void> {
  return apiDelete<void>(ApiPaths.adminArticleItem(id));
}

export function setArticleStatus(
  id: number,
  status: ArticleDto['status'],
): Promise<ArticleDto> {
  return apiPatch<ArticleDto>(ApiPaths.adminArticleItem(id), { status });
}

/** 分类列表走公开只读接口（无需管理权限即可获取分类字典） */
export function fetchCategories(): Promise<ArticleCategoryDto[]> {
  return apiGet<ArticleCategoryDto[]>(ApiPaths.articleCategories);
}

/** 分类的增删改走管理端接口（`/admin` 命名空间） */
export function createCategory(body: CreateCategoryBody): Promise<ArticleCategoryDto> {
  return apiPost<ArticleCategoryDto>(ApiPaths.adminArticleCategories, body);
}

export function updateCategory(id: number, body: UpdateCategoryBody): Promise<ArticleCategoryDto> {
  return apiPatch<ArticleCategoryDto>(ApiPaths.adminArticleCategoryItem(id), body);
}

export function deleteCategory(id: number): Promise<void> {
  return apiDelete<void>(ApiPaths.adminArticleCategoryItem(id));
}

export function fetchNotices(query: AdminNoticeQuery): Promise<PageResult<NoticeDto>> {
  return apiGet<PageResult<NoticeDto>>(ApiPaths.adminNotices, query);
}

export function createNotice(body: CreateNoticeBody): Promise<NoticeDto> {
  return apiPost<NoticeDto>(ApiPaths.adminNotices, body);
}

export function updateNotice(id: number, body: UpdateNoticeBody): Promise<NoticeDto> {
  return apiPatch<NoticeDto>(ApiPaths.adminNoticeItem(id), body);
}

export function deleteNotice(id: number): Promise<void> {
  return apiDelete<void>(ApiPaths.adminNoticeItem(id));
}

export function setNoticeStatus(id: number, status: NoticeDto['status']): Promise<NoticeDto> {
  return apiPatch<NoticeDto>(ApiPaths.adminNoticeItem(id), { status });
}

/* ------------------------------ 系统管理 ------------------------------ */

export function fetchAdminUsers(query: AdminUserQuery): Promise<PageResult<AdminUserDto>> {
  return apiGet<PageResult<AdminUserDto>>(ApiPaths.adminUsers, query);
}

export function createAdminUser(body: CreateAdminUserBody): Promise<AdminUserDto> {
  return apiPost<AdminUserDto>(ApiPaths.adminUsers, body);
}

export function updateAdminUser(id: number, body: UpdateAdminUserBody): Promise<AdminUserDto> {
  return apiPatch<AdminUserDto>(ApiPaths.adminUserItem(id), body);
}

/**
 * 角色目录。
 *
 * ⚠️ 第三轮：该端点从「裸数组（**全表**）」改为 `{items, meta}` 分页结构。
 * 目录表很小，但仍必须有上限 —— 与其它列表接口口径统一。
 */
export async function fetchRoles(query: PagedQuery = {}): Promise<PageResult<AdminRoleDto>> {
  const raw = await apiGet<unknown>(ApiPaths.adminRoles, {
    page: query.page,
    pageSize: query.pageSize,
  });
  return readPageResult<AdminRoleDto>(raw, ApiPaths.adminRoles);
}

/**
 * 权限点目录（同上：第三轮起为分页结构）。
 */
export async function fetchPermissions(
  query: PagedQuery = {},
): Promise<PageResult<AdminPermissionDto>> {
  const raw = await apiGet<unknown>(ApiPaths.adminPermissions, {
    page: query.page,
    pageSize: query.pageSize,
  });
  return readPageResult<AdminPermissionDto>(raw, ApiPaths.adminPermissions);
}

export function fetchActionLogs(
  query: AdminActionLogQuery,
): Promise<PageResult<AdminActionLogDto>> {
  return apiGet<PageResult<AdminActionLogDto>>(ApiPaths.adminActionLogs, query);
}

/**
 * 系统设置项列表。
 *
 * ⚠️ 第三轮：该端点从「裸数组（**全表**）」改为 `{items, meta}` 分页结构。
 */
export async function fetchSettings(query: PagedQuery = {}): Promise<PageResult<SystemSettingDto>> {
  const raw = await apiGet<unknown>(ApiPaths.adminSettings, {
    page: query.page,
    pageSize: query.pageSize,
  });
  return readPageResult<SystemSettingDto>(raw, ApiPaths.adminSettings);
}

export function upsertSetting(body: UpsertSettingBody): Promise<SystemSettingDto> {
  return apiPut<SystemSettingDto>(ApiPaths.adminSettings, body);
}
