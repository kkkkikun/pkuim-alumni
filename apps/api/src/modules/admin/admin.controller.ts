import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository, In } from 'typeorm';
import { PaginationQueryDto, paginate } from '../../common/dto/pagination.dto';
import {
  AdminActionLogQueryDto,
  AdminAlumniListQueryDto,
  AdminArticleListQueryDto,
  AdminEventListQueryDto,
  AdminNoticeListQueryDto,
  AdminResourceListQueryDto,
  AdminUserListQueryDto,
  AdminVerificationListQueryDto,
} from '../../common/dto/list-query.dto';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import type { RequestUser } from '../../common/decorators';
import {
  AdminActionLog,
  AdminUser,
  AdminUserRole,
  Permission,
  Role,
} from '../../database/entities/admin.entity';
import { SystemSetting } from '../../database/entities/system.entity';
import { ConnectionRequestHistory } from '../../database/entities/connection.entity';
import { Event, EventRegistration } from '../../database/entities/event.entity';
import { ResourcePost } from '../../database/entities/resource.entity';
import { Article, Notice } from '../../database/entities/content.entity';
import { VerificationApplication } from '../../database/entities/verification.entity';
import { User } from '../../database/entities/user.entity';
import { AlumniVerificationService } from '../alumni/alumni.service';
import { ContentService } from '../content/content.service';
import { DirectoryService } from '../directory/directory.service';
import { EventsService } from '../events/events.service';
import { ResourcesService } from '../resources/resources.service';
import { UploadsService } from '../uploads/uploads.service';
import { ResourceDecisionDto } from '../resources/dto/resource.dto';
import { VerificationDecisionDto } from '../alumni/dto/verification.dto';
import {
  CreateArticleBodyDto,
  CreateNoticeBodyDto,
  UpdateArticleBodyDto,
  UpdateNoticeBodyDto,
} from '../content/dto/content.dto';
import { CreateEventBodyDto, UpdateEventBodyDto } from '../events/dto/event.dto';

@ApiTags('管理后台')
@Controller('admin')
export class AdminController {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(AdminUser) private readonly adminUsers: Repository<AdminUser>,
    @InjectRepository(AdminUserRole)
    private readonly adminUserRoles: Repository<AdminUserRole>,
    @InjectRepository(AdminActionLog) private readonly actionLogs: Repository<AdminActionLog>,
    @InjectRepository(Role) private readonly roles: Repository<Role>,
    @InjectRepository(Permission) private readonly permissions: Repository<Permission>,
    @InjectRepository(SystemSetting) private readonly settings: Repository<SystemSetting>,
    @InjectRepository(ResourcePost) private readonly resources: Repository<ResourcePost>,
    @InjectRepository(VerificationApplication)
    private readonly verifications: Repository<VerificationApplication>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventRegistration)
    private readonly registrations: Repository<EventRegistration>,
    @InjectRepository(ConnectionRequestHistory)
    private readonly connectionRequests: Repository<ConnectionRequestHistory>,
    @InjectRepository(Article) private readonly articles: Repository<Article>,
    @InjectRepository(Notice) private readonly notices: Repository<Notice>,
    private readonly alumniService: AlumniVerificationService,
    private readonly directoryService: DirectoryService,
    private readonly resourcesService: ResourcesService,
    private readonly eventsService: EventsService,
    private readonly contentService: ContentService,
    private readonly uploadsService: UploadsService,
    private readonly dataSource: DataSource,
  ) {}

  @Get('stats')
  @RequirePermissions('dashboard:view')
  @ApiOperation({ summary: '数据总览' })
  async stats() {
    const [
      userStats,
      verificationPending,
      resourceStats,
      eventTotal,
      eventRegistrations,
      connectionStats,
      articleTotal,
      noticeTotal,
    ] = await Promise.all([
      // ⚠️ 此前是 12 条独立 COUNT（其中 `this.users.count()` 还重复算了两次），
      //    后台首屏每次都打满 12 次数据库往返。
      //    现在把「同表的多口径」合并成**一条条件聚合**（SUM(CASE WHEN ...)），
      //    查询数 12 → 8，统计口径与返回结构一字未改。
      this.users
        .createQueryBuilder('u')
        .select('COUNT(*)', 'total')
        .addSelect('SUM(CASE WHEN u.stage = :verified THEN 1 ELSE 0 END)', 'verified')
        .setParameter('verified', 'verified')
        .getRawOne<{ total: string; verified: string | null }>()
        .then((row) => ({
          total: Number(row?.total ?? 0),
          verified: Number(row?.verified ?? 0),
        })),
      this.verifications
        .createQueryBuilder('v')
        .where('v.status IN (:...statuses)', { statuses: ['pending', 'resubmitted'] })
        .getCount(),
      this.resources
        .createQueryBuilder('r')
        .select('COUNT(*)', 'total')
        .addSelect('SUM(CASE WHEN r.status = :pending THEN 1 ELSE 0 END)', 'pending')
        .setParameter('pending', 'pending')
        .getRawOne<{ total: string; pending: string | null }>()
        .then((row) => ({
          total: Number(row?.total ?? 0),
          pending: Number(row?.pending ?? 0),
        })),
      this.events.count(),
      this.registrations.count(),
      this.connectionRequests
        .createQueryBuilder('c')
        .select('COUNT(*)', 'total')
        .addSelect('SUM(CASE WHEN c.status = :pending THEN 1 ELSE 0 END)', 'pending')
        .setParameter('pending', 'pending')
        .getRawOne<{ total: string; pending: string | null }>()
        .then((row) => ({
          total: Number(row?.total ?? 0),
          pending: Number(row?.pending ?? 0),
        })),
      this.articles.count(),
      this.notices.count(),
    ]);

    // 统计口径与返回结构保持不变（字段名、含义、类型全部照旧）。
    const alumniTotal = userStats.total;
    const alumniVerified = userStats.verified;
    const resourceTotal = resourceStats.total;
    const resourcePending = resourceStats.pending;
    const connectionTotal = connectionStats.total;
    const connectionPending = connectionStats.pending;
    // userTotal 与 alumniTotal 同源（都是 users 表总数），保持原有语义。
    const userTotal = userStats.total;

    return {
      alumniTotal,
      alumniVerified,
      verificationPending,
      resourceTotal,
      resourcePending,
      eventTotal,
      eventRegistrations,
      connectionTotal,
      connectionPending,
      userTotal,
      articleTotal,
      noticeTotal,
    };
  }

  @Get('alumni')
  @RequirePermissions('alumni:view')
  @ApiOperation({ summary: '校友列表' })
  alumni(@Query() query: AdminAlumniListQueryDto) {
    return this.directoryService.adminList({
      keyword: query.keyword,
      stage: query.stage,
      regionCode: query.regionCode,
      college: query.college,
      verified: query.verified,
      status: query.status,
      industryCode: query.industryCode,
      graduationYear: query.graduationYear,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Get('alumni/:id')
  @RequirePermissions('alumni:view')
  @ApiOperation({ summary: '校友详情（含联系方式解密视图，仅管理端）' })
  async alumniDetail(@Param('id', ParseIntPipe) id: number) {
    const detail = await this.directoryService.adminDetail(id);
    // 后台详情抽屉要展示「身份审核历史」，契约 AdminAlumniDetail.verifications 为必填，
    // 之前服务端没返回该字段，时间线恒为空。详见 KNOWN-ISSUES #59。
    const verifications = await this.alumniService.mine(id);
    return { ...detail, verifications };
  }

  @Get('verifications')
  @RequirePermissions('verification:review')
  @ApiOperation({ summary: '认证审核队列' })
  verificationsList(@Query() query: AdminVerificationListQueryDto) {
    return this.alumniService.adminList({
      page: query.page,
      pageSize: query.pageSize,
      status: query.status,
      keyword: query.keyword,
    });
  }

  @Get('verifications/:id')
  @RequirePermissions('verification:review')
  verificationDetail(@Param('id', ParseIntPipe) id: number) {
    return this.alumniService.detail(id, 0, true);
  }

  /**
   * 认证审核：取证明材料的预签名预览地址。
   *
   * 私有资产默认**只允许上传者本人**取地址（UploadsService.assertOwnership），
   * 但审核必须能看到证明材料 —— 否则审核流程根本走不通（缺陷 #77）。
   * 因此这里不按「归属」鉴权，而按「该附件确实挂在被审核的那个申请上」鉴权，
   * 再叠加管理端权限点。附件不存在或不属于该申请一律 404（不泄露存在性）。
   */
  @Get('verifications/:id/attachments/:mediaId/url')
  @RequirePermissions('verification:review')
  @ApiOperation({ summary: '取认证证明材料的预览地址（仅审核员）' })
  async verificationAttachmentUrl(
    @Param('id', ParseIntPipe) id: number,
    @Param('mediaId', ParseIntPipe) mediaId: number,
  ) {
    const owned = await this.alumniService.ownsAttachment(id, mediaId);
    if (!owned) throw new NotFoundException('附件不存在');
    // requesterId 不传 = 内部调用（归属已由上面的业务校验保证）
    return this.uploadsService.getUploadTarget(mediaId, 'download', undefined);
  }

  @Post('verifications/:id/decision')
  @RequirePermissions('verification:review')
  async verificationDecision(
    @CurrentUser() admin: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: VerificationDecisionDto,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const result = await this.alumniService.decide(id, admin.id, dto, manager);
      await this.log(admin, 'verification.decision', 'verification', id, dto, manager);
      return result;
    });
  }

  @Get('resources')
  @RequirePermissions('resource:review')
  resourcesList(@Query() query: AdminResourceListQueryDto) {
    return this.resourcesService.adminList({
      page: query.page,
      pageSize: query.pageSize,
      status: query.status,
      type: query.type,
      keyword: query.keyword,
    });
  }

  @Get('resources/:id')
  @RequirePermissions('resource:review')
  resourceDetail(@Param('id', ParseIntPipe) id: number) {
    return this.resourcesService.detail(id, undefined, true);
  }

  /**
   * 资源审核：取附件的预签名预览地址。
   *
   * 鉴权逻辑与「认证证明材料」一致：按「附件确实挂在被审核的那条内容上」鉴权，
   * 再叠加 `resource:review` 权限点（详见缺陷 #77 的说明）。
   */
  @Get('resources/:id/attachments/:mediaId/url')
  @RequirePermissions('resource:review')
  @ApiOperation({ summary: '取资源附件的预览地址（仅审核员）' })
  async resourceAttachmentUrl(
    @Param('id', ParseIntPipe) id: number,
    @Param('mediaId', ParseIntPipe) mediaId: number,
  ) {
    const owned = await this.resourcesService.ownsAttachment(id, mediaId);
    if (!owned) throw new NotFoundException('附件不存在');
    return this.uploadsService.getUploadTarget(mediaId, 'download', undefined);
  }

  @Post('resources/:id/decision')
  @RequirePermissions('resource:review')
  async resourceDecision(
    @CurrentUser() admin: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResourceDecisionDto,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const result = await this.resourcesService.decide(id, admin.id, dto, manager);
      await this.log(admin, 'resource.decision', 'resource_post', id, dto, manager);
      return result;
    });
  }

  @Get('events')
  @RequirePermissions('event:manage')
  eventsList(@Query() query: AdminEventListQueryDto) {
    return this.eventsService.adminAll({
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword,
      status: query.status,
    });
  }

  @Post('events')
  @RequirePermissions('event:manage')
  async createEvent(@CurrentUser() admin: RequestUser, @Body() body: CreateEventBodyDto) {
    return this.dataSource.transaction(async (manager) => {
      const result = await this.eventsService.create(body, admin.id, manager);
      await this.log(admin, 'event.create', 'event', result.id, body, manager);
      return result;
    });
  }

  @Get('events/:id')
  @RequirePermissions('event:manage')
  async eventDetail(@Param('id', ParseIntPipe) id: number) {
    return this.eventsService.detail(id);
  }

  @Patch('events/:id')
  @RequirePermissions('event:manage')
  async updateEvent(
    @CurrentUser() admin: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateEventBodyDto,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const result = await this.eventsService.update(id, body, manager);
      await this.log(admin, 'event.update', 'event', id, body, manager);
      return result;
    });
  }

  @Delete('events/:id')
  @RequirePermissions('event:manage')
  async deleteEvent(
    @CurrentUser() admin: RequestUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const result = await this.eventsService.remove(id, manager);
      await this.log(admin, 'event.delete', 'event', id, {}, manager);
      return result;
    });
  }

  @Get('events/:id/registrations')
  @RequirePermissions('event:manage')
  eventRegistrations(@Param('id', ParseIntPipe) id: number) {
    return this.eventsService.registrationRoster(id);
  }

  @Get('articles')
  @RequirePermissions('content:manage')
  adminArticles(@Query() query: AdminArticleListQueryDto) {
    return this.contentService.listArticles({
      page: query.page,
      pageSize: query.pageSize,
      status: query.status ?? 'published',
      categoryId: query.categoryId,
      keyword: query.keyword,
    });
  }

  @Post('articles')
  @RequirePermissions('content:manage')
  async createArticle(@CurrentUser() admin: RequestUser, @Body() body: CreateArticleBodyDto) {
    return this.dataSource.transaction(async (manager) => {
      const result = await this.contentService.adminCreateArticle(body, admin.id, manager);
      await this.log(admin, 'article.create', 'article', result.id, body, manager);
      return result;
    });
  }

  @Patch('articles/:id')
  @RequirePermissions('content:manage')
  async updateArticle(
    @CurrentUser() admin: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateArticleBodyDto,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const result = await this.contentService.adminUpdateArticle(id, body, manager);
      await this.log(admin, 'article.update', 'article', id, body, manager);
      return result;
    });
  }

  @Delete('articles/:id')
  @RequirePermissions('content:manage')
  async deleteArticle(@CurrentUser() admin: RequestUser, @Param('id', ParseIntPipe) id: number) {
    return this.dataSource.transaction(async (manager) => {
      const result = await this.contentService.adminDeleteArticle(id, manager);
      await this.log(admin, 'article.delete', 'article', id, {}, manager);
      return result;
    });
  }

  @Get('notices')
  @RequirePermissions('content:manage')
  adminNotices(@Query() query: AdminNoticeListQueryDto) {
    return this.contentService.listNotices({
      page: query.page,
      pageSize: query.pageSize,
      status: query.status ?? 'published',
      keyword: query.keyword,
    });
  }

  @Post('notices')
  @RequirePermissions('content:manage')
  async createNotice(@CurrentUser() admin: RequestUser, @Body() body: CreateNoticeBodyDto) {
    return this.dataSource.transaction(async (manager) => {
      const result = await this.contentService.adminCreateNotice(body, admin.id, manager);
      await this.log(admin, 'notice.create', 'notice', result.id, body, manager);
      return result;
    });
  }

  @Patch('notices/:id')
  @RequirePermissions('content:manage')
  async updateNotice(
    @CurrentUser() admin: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateNoticeBodyDto,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const result = await this.contentService.adminUpdateNotice(id, body, manager);
      await this.log(admin, 'notice.update', 'notice', id, body, manager);
      return result;
    });
  }

  @Delete('notices/:id')
  @RequirePermissions('content:manage')
  async deleteNotice(@CurrentUser() admin: RequestUser, @Param('id', ParseIntPipe) id: number) {
    return this.dataSource.transaction(async (manager) => {
      const result = await this.contentService.adminDeleteNotice(id, manager);
      await this.log(admin, 'notice.delete', 'notice', id, {}, manager);
      return result;
    });
  }

  @Get('users')
  @RequirePermissions('admin:manage')
  @ApiOperation({ summary: '管理员账号列表' })
  async listAdminUsers(@Query() query: AdminUserListQueryDto) {
    // 注意：必须返回 PageResult —— 契约与前端都按 { items, meta } 消费
    // （管理后台「管理员账号」页面用 usePagedList 渲染，取 .items 拿列表）。
    // 此前这里返回的是**裸数组**，前端取 .items 得到 undefined，
    // 页面在真实浏览器里直接抛 `Cannot read properties of undefined (reading 'length')`。
    const qb = this.adminUsers.createQueryBuilder('adminUser').orderBy('adminUser.id', 'ASC');
    const keyword = (query.keyword ?? '').trim();
    if (keyword) {
      qb.andWhere('adminUser.username LIKE :kw OR adminUser.displayName LIKE :kw', {
        kw: `%${keyword}%`,
      });
    }
    if (query.status) {
      qb.andWhere('adminUser.status = :status', { status: query.status });
    }
    qb.skip((query.page - 1) * query.pageSize).take(query.pageSize);
    const [rows, total] = await qb.getManyAndCount();

    // 角色：批量取出，避免 N+1
    const rolesByAdmin = await this.rolesOf(rows.map((row) => row.id));

    const items = rows.map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      // 契约 AdminUserDto.roles 是角色代码数组；
      // 缺失会让管理后台「角色」列渲染时 .map 抛 undefined（缺陷 #58）
      roles: rolesByAdmin.get(row.id) ?? [],
      status: row.status,
      lastLoginAt: row.lastLoginAt,
      createdAt: row.createdAt,
    }));
    return paginate(items, total, query.page, query.pageSize);
  }

  /** 批量取管理员的角色代码：管理员 id → 角色代码数组 */
  private async rolesOf(
    adminIds: number[],
  ): Promise<Map<number, string[]>> {
    const result = new Map<number, string[]>();
    if (adminIds.length === 0) return result;
    const links = await this.adminUserRoles.find({
      where: { adminUserId: In(adminIds) },
    });
    if (links.length === 0) return result;
    const roleIds = [...new Set(links.map((link) => link.roleId))];
    const roleRows = await this.roles.find({ where: { id: In(roleIds) } });
    const codeById = new Map(roleRows.map((role) => [role.id, role.code]));
    for (const link of links) {
      const code = codeById.get(link.roleId);
      if (!code) continue;
      const list = result.get(link.adminUserId) ?? [];
      list.push(code);
      result.set(link.adminUserId, list);
    }
    return result;
  }

  @Get('roles')
  @RequirePermissions('admin:manage')
  async adminRoles() {
    return this.roles.find({ order: { id: 'ASC' } });
  }

  @Get('permissions')
  @RequirePermissions('admin:manage')
  async adminPermissions() {
    return this.permissions.find({ order: { id: 'ASC' } });
  }

  @Get('action-logs')
  @RequirePermissions('audit:view')
  async logs(@Query() query: AdminActionLogQueryDto) {
    const qb = this.actionLogs
      .createQueryBuilder('log')
      // 契约 AdminActionLogDto.adminName 为必填：后台「操作人」列直接渲染它，
      // 之前服务端没带出管理员名称，该列恒为空。详见 KNOWN-ISSUES #60。
      .leftJoinAndSelect('log.admin', 'admin')
      .orderBy('log.id', 'DESC');
    // 后台「审计日志」页的四个筛选条件必须真正生效
    // 详见 KNOWN-ISSUES #63
    if (query.adminId !== undefined) {
      qb.andWhere('log.adminId = :adminId', { adminId: query.adminId });
    }
    if (query.action?.trim()) {
      qb.andWhere('log.action = :action', { action: query.action.trim() });
    }
    if (query.startDate?.trim()) {
      qb.andWhere('log.createdAt >= :startDate', { startDate: `${query.startDate.trim()} 00:00:00` });
    }
    if (query.endDate?.trim()) {
      qb.andWhere('log.createdAt <= :endDate', { endDate: `${query.endDate.trim()} 23:59:59` });
    }
    qb.skip(query.offset).take(query.take);
    const [entities, total] = await qb.getManyAndCount();
    return {
      items: entities.map((item) => ({
        id: item.id,
        adminId: item.adminId,
        adminName: item.admin?.displayName || item.admin?.username || '未知管理员',
        action: item.action,
        targetType: item.targetType,
        targetId: item.targetId,
        detail: item.detail,
        ip: item.ip,
        createdAt: item.createdAt,
      })),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  @Get('settings')
  @RequirePermissions('settings:manage')
  async listSettings() {
    return this.settings.find({ order: { key: 'ASC' } });
  }

  /**
   * 写审计日志。
   *
   * ⚠️ 传入 `manager` 时，日志会写进**调用方的事务**（缺陷 #134）——
   *   管理端所有写接口都是「改业务数据 + 写审计日志」两步，
   *   两步不同事务的话，审计日志写失败时业务改动**已经提交**，
   *   而且这条操作**没有审计记录**（事后无法追溯）。
   */
  private async log(
    admin: RequestUser,
    action: string,
    targetType: string,
    targetId: number,
    detail: unknown,
    manager?: EntityManager,
  ): Promise<void> {
    const actionLogs = manager ? manager.getRepository(AdminActionLog) : this.actionLogs;
    await actionLogs.save(
      actionLogs.create({
        adminId: admin.id,
        action,
        targetType,
        targetId: String(targetId),
        detail: (detail ?? {}) as Record<string, unknown>,
      }),
    );
  }
}
