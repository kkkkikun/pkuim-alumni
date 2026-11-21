import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, HttpStatus, NotFoundException, Param, ParseIntPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { CurrentUser, RequirePermissions } from '../../common/decorators';
import type { RequestUser } from '../../common/decorators';
import { AuthService } from '../../auth/auth.service';
import { AdminUser, AdminUserRole, Role } from '../../database/entities/admin.entity';
import { AdminActionLog } from '../../database/entities/admin.entity';
import { User } from '../../database/entities/user.entity';
import { RequestContextService } from '../../common/services/request-context.service';
import { InvalidationBusService } from '../../common/services/invalidation-bus.service';
import { isDuplicateKeyError } from '../../common/utils/duplicate-key';
import { ContentService } from '../content/content.service';
import {
  CreateAdminUserBodyDto,
  UpdateAdminUserBodyDto,
  UpdateUserStatusBodyDto,
} from './dto/admin-body.dto';
import {
  CreateCategoryBodyDto,
  UpdateCategoryBodyDto,
  UpsertSettingBodyDto,
} from '../content/dto/content.dto';

@ApiTags('管理后台 · 用户与设置')
@Controller('admin')
export class AdminUsersController {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly contentService: ContentService,
    private readonly authService: AuthService,
    private readonly requestContext: RequestContextService,
    private readonly invalidationBus: InvalidationBusService,
  ) {}

  @Post('users')
  @RequirePermissions('admin:manage')
  @ApiOperation({ summary: '创建管理员' })
  async createAdmin(@CurrentUser() actor: RequestUser, @Body() body: CreateAdminUserBodyDto) {
    // ⚠️ 三步写（建账号 → 同步角色 → 写审计）必须同事务（缺陷 #115）：
    // 中途失败若不回滚，账号会以「有账号、没角色」的半成品状态留在库里，
    // 而且接口已经返回 500，管理员无从得知发生了什么。
    // ⚠️ 复核补漏（第二轮）：此前这里是 `body.password ?? 'Admin@2026'` ——
    //    不传初始口令时，新管理员的口令就是**公开在仓库里的常量**
    //    （README / docs / seed 脚本里都有），等于给了一个「谁都能登进后台」的账号。
    //    现在初始口令**必填**（DTO 层校验：缺失或过短直接 400），
    //    仓库里不再有任何「默认管理员口令」的回退路径。
    //
    // ⚠️ 哈希在**事务外**算：bcrypt cost=10 是纯 CPU 运算，单次 60~120ms，
    //    放在事务里会让一条数据库连接 + 行锁被白白占住这么久。
    const passwordHash = await this.hashPassword(body.password);

    const result = await this.dataSource.transaction(async (manager) => {
      const adminUsers = manager.getRepository(AdminUser);
      let admin: AdminUser;
      try {
        admin = await adminUsers.save(
          adminUsers.create({
            username: body.username,
            displayName: body.displayName ?? body.username,
            passwordHash,
            status: body.status ?? 'active',
          }),
        );
      } catch (error) {
        // 登录名唯一索引冲突：这是**客户端可修正**的输入问题，
        // 不能以 500 抛给前端（缺陷 #112）。
        throw this.toDuplicateUsernameError(error);
      }
      const appliedRoles = await this.syncRoles(manager, admin.id, body.roles ?? ['alumni_reviewer']);
      await this.log(manager, actor, 'admin.user.create', 'admin_user', admin.id, {
        username: admin.username,
        roles: appliedRoles,
      });
      return { admin, appliedRoles };
    });

    const { admin, appliedRoles } = result;
    return {
      id: admin.id,
      username: admin.username,
      displayName: admin.displayName,
      status: admin.status,
      roles: appliedRoles,
      lastLoginAt: admin.lastLoginAt,
      createdAt: admin.createdAt,
    };
  }

  @Patch('users/:id')
  @RequirePermissions('admin:manage')
  @ApiOperation({ summary: '更新管理员（角色 / 状态 / 口令）' })
  async updateAdmin(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateAdminUserBodyDto,
  ) {
    // ⚠️ 同上：哈希在事务外算（bcrypt 是纯 CPU 运算，不该占着数据库连接）。
    const passwordHash = body.password ? await this.hashPassword(body.password) : null;

    // 同上：改资料 / 改角色 / 写审计必须同事务（缺陷 #115）
    const { admin, appliedRoles } = await this.dataSource.transaction(async (manager) => {
      const adminUsers = manager.getRepository(AdminUser);
      const admin = await adminUsers.findOne({ where: { id } });
      if (!admin) throw new NotFoundException('管理员不存在');
      if (body.displayName !== undefined) admin.displayName = body.displayName;
      if (body.status !== undefined) admin.status = body.status;
      if (passwordHash) {
        admin.passwordHash = passwordHash;
      }
      await adminUsers.save(admin);
      // 角色：请求里没带就保持原样；带了才同步
      const appliedRoles = body.roles
        ? await this.syncRoles(manager, id, body.roles)
        : await this.roleCodesOf(manager, id);
      // 只在「动了权限」时才校验不变量：单纯改显示名不该被这条规则拦下。
      if (body.status !== undefined || body.roles !== undefined) {
        await this.assertStillHasAdminManager(manager);
      }
      await this.log(manager, actor, 'admin.user.update', 'admin_user', id, {
        displayName: body.displayName,
        status: body.status,
        roles: appliedRoles,
        passwordChanged: body.password !== undefined,
      });
      return { admin, appliedRoles };
    });

    // ⚠️ **主动失效** RBAC 缓存（第三轮）：
    //    停用 / 降权之后，本进程内的权限解析缓存立刻作废 ——
    //    「降权后仍能操作」的窗口在本进程内是 **0**，
    //    TTL（≤30 秒）只是**多实例部署**下的兜底。
    //    口径见 docs/SECURITY.md 第 2.1 节。
    if (body.status !== undefined || body.roles !== undefined) {
      this.authService.invalidateAdminCache(id);
      // ⚠️ **跨实例**失效（第五轮）：把「这个管理员的缓存该作废」广播到共享失效总线，
      //    其它实例收到后立刻清掉本地条目 → 多实例部署时撤权延迟也是 **0**。
      //    - **在事务提交之后**发布：事务回滚了却把事件发出去，会让别的实例白丢缓存；
      //    - **只传失效事件，不传权限内容**（见 2.1.5 节）；
      //    - **Redis 不可用时 publish 不会抛错**：写操作照常成功，
      //      撤权延迟回落到 TTL 上界（≤60 秒），不是永久放行。
      await this.invalidationBus.publish({ kind: 'admin', adminId: id });
    }

    return {
      id: admin.id,
      username: admin.username,
      displayName: admin.displayName,
      status: admin.status,
      roles: appliedRoles,
      lastLoginAt: admin.lastLoginAt,
      createdAt: admin.createdAt,
    };
  }

  /**
   * 普通账号状态变更。
   *
   * 管理端路由统一收敛在 `/admin` 命名空间下（契约 `ApiPaths.adminUserStatus`）。
   * POST 版本作为 PATCH 的兼容别名保留。
   */
  @Patch('users/:id/status')
  @RequirePermissions('alumni:manage')
  @ApiOperation({ summary: '启用 / 停用普通账号' })
  async patchUserStatus(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateUserStatusBodyDto,
  ) {
    return this.setUserStatus(actor, id, body);
  }

  @Post('users/:id/status')
  // ⚠️ 这个 POST **不创建任何资源**（只是改状态）→
  // Nest 对 POST 的默认是 201 Created，而 201 的语义是「本次请求创建了新资源」，
  // 且应当带 Location 头 —— 这里两样都不成立（缺陷 #126）。
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('alumni:manage')
  @ApiOperation({ summary: '启用 / 停用普通账号（兼容路径）' })
  async updateUserStatus(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateUserStatusBodyDto,
  ) {
    return this.setUserStatus(actor, id, body);
  }

  @Get('users/:id')
  @RequirePermissions('alumni:view')
  @ApiOperation({ summary: '普通账号详情' })
  async getUser(@Param('id', ParseIntPipe) id: number) {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException('用户不存在');
    return {
      id: user.id,
      openid: user.openid,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      status: user.status,
      stage: user.stage,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    };
  }

  /**
   * 启用 / 停用普通账号。
   *
   * `reason`（停用原因）必须落进审计日志 ——
   * 后台弹窗里让管理员填写原因，服务端却直接丢弃（缺陷 #83），
   * 等于让管理员白填。
   */
  private async setUserStatus(
    actor: RequestUser,
    id: number,
    body: UpdateUserStatusBodyDto,
  ): Promise<{ id: number; status: string }> {
    // 改状态与写审计日志同事务（缺陷 #115）
    return this.dataSource.transaction(async (manager) => {
      const users = manager.getRepository(User);
      const user = await users.findOne({ where: { id } });
      if (!user) throw new NotFoundException('用户不存在');
      const previous = user.status;
      user.status = body.status;
      await users.save(user);
      await this.log(manager, actor, 'user.status.change', 'user', id, {
        from: previous,
        to: body.status,
        reason: body.reason ?? null,
      });
      return { id: user.id, status: user.status };
    });
  }

  /**
   * 新建资讯分类（**管理端**）。
   *
   * ⚠️ 第三轮：此前这 4 个写端点（分类增删改 + 系统设置写入）**没有**写
   *    `admin_action_logs` —— 而 `docs/SECURITY.md` 第 7 节把「审核、发布、
   *    下架、账号状态」都列为必须留痕的关键操作。现在补齐：
   *    业务写与审计写进**同一事务**（沿用缺陷 #134 的做法），
   *    审计写失败时业务写一起回滚 —— 否则会出现
   *    「内容已改但没有审计痕迹」（事后无法追溯）。
   */
  @Post('articles/categories')
  @RequirePermissions('content:manage')
  @ApiOperation({ summary: '创建资讯分类' })
  async createCategory(
    @CurrentUser() actor: RequestUser,
    @Body() body: CreateCategoryBodyDto,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const result = await this.contentService.createCategory(body, manager);
      await this.log(manager, actor, 'category.create', 'article_category', result.id, {
        name: body.name,
        slug: body.slug,
      });
      return result;
    });
  }

  /** 修改资讯分类（**管理端**，同事务写审计）。 */
  @Patch('articles/categories/:id')
  @RequirePermissions('content:manage')
  async updateCategory(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateCategoryBodyDto,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const result = await this.contentService.updateCategory(id, body, manager);
      await this.log(manager, actor, 'category.update', 'article_category', id, {
        name: body.name,
        slug: body.slug,
        sortOrder: body.sortOrder,
      });
      return result;
    });
  }

  /** 删除资讯分类（**管理端**，同事务写审计）。 */
  @Delete('articles/categories/:id')
  @RequirePermissions('content:manage')
  async deleteCategory(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const result = await this.contentService.deleteCategory(id, manager);
      await this.log(manager, actor, 'category.delete', 'article_category', id, {});
      return result;
    });
  }

  /** 写入系统设置（**管理端**，同事务写审计）。 */
  @Put('settings')
  @RequirePermissions('settings:manage')
  async upsertSetting(
    @CurrentUser() actor: RequestUser,
    @Body() body: UpsertSettingBodyDto,
  ) {
    // ⚠️ **唯一键冲突时重试整个事务**（缺陷 #137）：
    //    两个并发请求都读到「设置行不存在」→ 都去 INSERT → 后到的那个撞唯一键。
    //    重来一次时是**新的快照**，能看到另一个事务刚提交的那一行 → 走「更新」分支。
    //    ⚠️ 重试必须发生在**事务之外**：事务内的一致性读只看到事务开始时的快照，
    //    在同一个事务里补救会看不见刚提交的行（详见 `ContentService.upsertSetting`）。
    return this.withDuplicateKeyRetry(() =>
      this.dataSource.transaction(async (manager) => {
        const result = await this.contentService.upsertSetting(body, manager);
        await this.log(manager, actor, 'setting.update', 'system_setting', 0, {
          key: body.key,
          // ⚠️ 不记 value：系统设置里可能放敏感配置（回调地址、密钥引用等），
          // 审计日志是要长期留痕的表，不该成为泄密面。
          description: body.description ?? null,
        });
        return result;
      }),
    );
  }

  /**
   * 唯一键冲突时**重试整个事务**（最多 3 次）。
   *
   * 适用场景：「先查后插」的并发写（缺陷 #137）——
   * 两个请求同时读到「行不存在」→ 都去 INSERT → 后到的撞唯一键。
   * 重试时是新快照，能看到对方刚提交的行，于是走更新分支。
   */
  private async withDuplicateKeyRetry<T>(run: () => Promise<T>): Promise<T> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        if (!isDuplicateKeyError(error) || attempt === maxAttempts) throw error;
      }
    }
    // 理论上不可达（循环要么 return、要么 throw）
    throw new Error('重试逻辑异常');
  }

  /**
   * 同步管理员的角色，返回**实际生效**的角色编码。
   *
   * 不存在的角色编码会被静默忽略（数据库里没有该 role），
   * 所以响应不能直接回显请求里的列表 ——
   * 否则接口会「声称」给了一个其实没生效的角色（缺陷 #81）。
   *
   * ⚠️ 必须走 `manager.getRepository(...)`：
   * 注入的默认仓储走的是**另一条连接**，在事务里用它写数据会**跳出事务**，
   * 「先删后插」的中间态会被真正提交出去（缺陷 #115）。
   */
  private async syncRoles(
    manager: EntityManager,
    adminId: number,
    roleCodes: string[],
  ): Promise<string[]> {
    const roles = await manager
      .getRepository(Role)
      .find({ where: roleCodes.map((code) => ({ code })) });
    const links = manager.getRepository(AdminUserRole);
    await links.delete({ adminUserId: adminId });
    // 一次批量插入（此前是逐条 await save，每个角色一条 INSERT）。
    if (roles.length > 0) {
      await links.save(
        roles.map((role) => links.create({ adminUserId: adminId, roleId: role.id })),
      );
    }
    return roles.map((role) => role.code);
  }

  /**
   * 守住一条硬不变量：**系统里至少要有一个「活的」能管管理员的人**。
   *
   * 没有这条保护时，一个管理员可以：
   *   - 把自己停用；
   *   - 或把最后一个持有 `admin:manage` 的管理员降权；
   * 结果是**再没有任何人能登录后台**（缺陷 #116），
   * 只能进数据库手工救。因此这里在**事务内、提交前**校验。
   */
  private async assertStillHasAdminManager(manager: EntityManager): Promise<void> {
    const rows = await manager.query(
      `SELECT COUNT(DISTINCT au.id) AS total
         FROM admin_users au
         JOIN admin_user_roles aur ON aur.admin_user_id = au.id
         JOIN role_permissions rp ON rp.role_id = aur.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE au.status = 'active' AND p.code = 'admin:manage'`,
    );
    const total = Number(rows?.[0]?.total ?? 0);
    if (total === 0) {
      throw new BadRequestException(
        '该操作会导致系统里不再有任何可用的管理员（admin:manage），已拒绝执行',
      );
    }
  }

  /** 登录名重复（唯一索引冲突）→ 409，而不是 500（缺陷 #112） */
  private toDuplicateUsernameError(error: unknown): Error {
    const code =
      (error as { code?: string })?.code ??
      (error as { driverError?: { code?: string } })?.driverError?.code;
    if (code === 'ER_DUP_ENTRY') {
      return new ConflictException('登录名已存在');
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  /** 写审计日志（管理端账号类操作此前完全没有留痕，缺陷 #84） */
  private async log(
    manager: EntityManager,
    admin: RequestUser,
    action: string,
    targetType: string,
    targetId: number,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const actionLogs = manager.getRepository(AdminActionLog);
    await actionLogs.save(
      actionLogs.create({
        adminId: admin.id,
        action,
        targetType,
        targetId: String(targetId),
        detail,
        // 来源 IP：这一列此前**从未被写过**（管理端「来源 IP」恒为空）。
        ip: this.requestContext.ip,
      }),
    );
  }

  /** 读取管理员当前实际拥有的角色编码 */
  private async roleCodesOf(manager: EntityManager, adminId: number): Promise<string[]> {
    const links = await manager
      .getRepository(AdminUserRole)
      .find({ where: { adminUserId: adminId } });
    if (!links.length) return [];
    const roles = await manager.getRepository(Role).find({
      where: links.map((link) => ({ id: link.roleId })),
    });
    return roles.map((role) => role.code);
  }

  private async hashPassword(password: string): Promise<string> {
    const bcryptjs = await import('bcryptjs');
    return bcryptjs.hash(password, 10);
  }
}
