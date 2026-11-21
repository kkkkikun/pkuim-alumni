import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { CacheKeys, ResponseCode } from '../common/constants';
import type { RequestUser } from '../common/decorators';
import { TtlCacheService } from '../common/services/ttl-cache.service';
import { hashToken } from '../common/utils/crypto';
import { duplicateKeyName, isDuplicateKeyError } from '../common/utils/duplicate-key';
import { parseDurationToSeconds } from '../common/utils/duration';
import {
  AdminUser,
  AdminUserRole,
  Permission,
  Role,
  RolePermission,
} from '../database/entities/admin.entity';
import { AlumniProfile, PrivateContact } from '../database/entities/alumni.entity';
import { User } from '../database/entities/user.entity';
import type { AdminLoginDto, MockLoginDto, RefreshTokenDto, WechatLoginDto } from './dto/auth.dto';
import { MOCK_AUTH_PROVIDER, WECHAT_AUTH_PROVIDER } from './providers/auth-provider';
import type { AuthIdentity, AuthProvider } from './providers/auth-provider';
import { WechatAuthError } from './providers/wechat-auth.provider';
import { SessionService } from './session.service';

export interface AccessTokenPayload {
  sub: string;
  kind: 'user' | 'admin';
  typ: 'access';
  jti: string;
  iat: number;
  exp: number;
}

export interface AuthenticatedLoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
  user: {
    id: number;
    openid: string;
    nickname: string;
    avatarUrl: string | null;
    role: string | null;
    status: string;
    stage: string;
    createdAt: Date;
    lastLoginAt: Date | null;
  };
  alumniProfile: {
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
    verifiedAt: Date | null;
    contactVisible: boolean;
    createdAt: Date;
    updatedAt: Date;
  } | null;
  stage: string;
}

/**
 * 管理员身份的缓存条目（RBAC 缓存）。
 *
 * ⚠️ 只存**权限事实**，不存「这个请求是否被允许」——
 *    每次请求仍然要走 `PermissionsGuard` 逐个权限点比对。
 */
interface AdminIdentityCacheEntry {
  id: number;
  username: string;
  displayName: string;
  roleCodes: string[];
  permissions: string[];
}

/**
 * 认证失败（提供了凭据但凭据无效）。
 *
 * ⚠️ 缺陷 #110：此前这些失败一律抛普通 `UnauthorizedException`，
 *    被统一异常过滤器按状态码映射成 `AUTH_REQUIRED` ——
 *    契约里的 `AUTH_FAILED` **从未被服务端返回过**（死码）。
 *    「没带令牌」与「令牌/凭据无效」是两种不同的失败，客户端需要区分：
 *    前者去登录，后者是「登录失败，密码或 code 不对」。
 */
export function authFailed(message: string): HttpException {
  return new HttpException(
    { code: ResponseCode.AUTH_FAILED, message },
    HttpStatus.UNAUTHORIZED,
  );
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(AlumniProfile) private readonly profiles: Repository<AlumniProfile>,
    @InjectRepository(PrivateContact) private readonly contacts: Repository<PrivateContact>,
    @InjectRepository(AdminUser) private readonly adminUsers: Repository<AdminUser>,
    @InjectRepository(AdminUserRole) private readonly adminUserRoles: Repository<AdminUserRole>,
    @InjectRepository(RolePermission) private readonly rolePermissions: Repository<RolePermission>,
    @InjectRepository(Permission) private readonly permissions: Repository<Permission>,
    private readonly jwtService: JwtService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly cache: TtlCacheService,
    @Inject(MOCK_AUTH_PROVIDER) private readonly mockAuthProvider: AuthProvider,
    @Inject(WECHAT_AUTH_PROVIDER) private readonly wechatAuthProvider: AuthProvider,
  ) {}

  /* ------------------------------ 用户登录 ------------------------------ */

  async loginWithMock(dto: MockLoginDto): Promise<AuthenticatedLoginResult> {
    if (!this.mockLoginEnabled) {
      throw new HttpException(
        { code: ResponseCode.FORBIDDEN, message: 'Mock 登录未启用' },
        HttpStatus.FORBIDDEN,
      );
    }
    const provider = this.mockProvider;
    if (!provider.available()) {
      throw new BadRequestException('Mock 登录未启用');
    }
    let identity: AuthIdentity;
    try {
      identity = await provider.exchange(dto.mockOpenid ?? '');
    } catch (error) {
      // Mock 提供方的失败是**入参问题**（如 "mock:" 去掉前缀后为空），
      // 不能落到 500 —— 与微信登录同理，缺陷 #148 的同一类问题。
      this.logger.warn(`Mock 登录失败：${error instanceof Error ? error.message : String(error)}`);
      throw new BadRequestException(error instanceof Error ? error.message : 'Mock 登录失败');
    }
    return this.issueUserLogin(identity, dto.nickname ?? null);
  }

  async loginWithWechat(dto: WechatLoginDto): Promise<AuthenticatedLoginResult> {
    if (!this.wechatLoginEnabled) {
      throw new HttpException(
        { code: ResponseCode.FORBIDDEN, message: '微信登录未启用' },
        HttpStatus.FORBIDDEN,
      );
    }
    const provider = this.wechatProvider;
    if (!provider.available()) {
      throw new BadRequestException('微信登录尚未配置');
    }
    let identity: AuthIdentity;
    try {
      identity = await provider.exchange(dto.code);
    } catch (error) {
      throw this.toWechatAuthException(error);
    }
    return this.issueUserLogin(identity, null);
  }

  /**
   * 把微信提供方的失败翻译成正确的 HTTP 状态码与错误码。
   *
   * ⚠️ 缺陷 #148：修复前这里没有任何翻译 —— provider 抛的普通 `Error`
   *    会被统一异常过滤器当成「未处理异常」→ **500 INTERNAL_ERROR**。
   *    用户明明是「登录凭据无效」，看到的却是「服务器内部错误」。
   *
   * 映射规则：
   *   - `invalid_code`（微信拒绝了凭据）→ **401 AUTH_FAILED**：请重新登录；
   *   - `unavailable`（微信接口不可达）→ **502 INTERNAL_ERROR**：稍后再试；
   *   - 其它异常（未预期）→ 500，保持「不掩盖真缺陷」。
   */
  private toWechatAuthException(error: unknown): HttpException {
    if (error instanceof WechatAuthError) {
      if (error.kind === 'invalid_code') {
        this.logger.warn(`微信登录凭据无效：${error.detail ?? error.message}`);
        return authFailed('微信登录失败，请重新登录');
      }
      this.logger.error(`微信登录服务不可用：${error.detail ?? error.message}`);
      return new HttpException(
        { code: ResponseCode.INTERNAL_ERROR, message: '微信登录服务暂时不可用，请稍后再试' },
        HttpStatus.BAD_GATEWAY,
      );
    }
    this.logger.error(
      `微信登录出现未预期异常：${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error.stack : undefined,
    );
    return new HttpException(
      { code: ResponseCode.INTERNAL_ERROR, message: '服务器内部错误' },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  /** 用户登录主流程：定位或创建用户 → 确保资料行 → 签发令牌与会话。 */
  async issueUserLogin(
    identity: AuthIdentity,
    nickname: string | null,
  ): Promise<AuthenticatedLoginResult> {
    // ⚠️ 唯一键冲突的处置（第九轮，扩到用户侧）：
    //   `users.openid` / `users.unionid` / `alumni_profiles.user_id` 上都有唯一索引，
    //   而这里是「先查后插」—— 两个并发首登（同一 openid）必然有一个撞唯一键。
    //   修复前这个 `ER_DUP_ENTRY` 直接冒泡成 **500**（用户看到「服务器内部错误」，
    //   其实只是「另一个请求刚好把账号建好了」）。
    //   现在：**重跑整个事务**（重跑时是新的快照，能看到对方刚提交的行 → 走「已存在」分支）。
    await this.withDuplicateKeyRetry(() =>
      this.dataSource.transaction(async (manager) => {
        // ⚠️ `users.unionid` 也有唯一索引（uk_users_unionid）：
        //   同一个 unionid 已经被**另一个**账号占着时，写上去就是撞键 → 500。
        //   这是**业务冲突**（两个账号指向同一个微信主体），不是「服务端故障」→
        //   先查清楚，给出 409（可预期错误码），而不是等数据库来报错。
        //   ⚠️ 只在 unionid 真的存在时才查（Mock 登录没有 unionid，
        //     不该为此多打一条 SQL）。
        if (identity.unionid) {
          const owner = await manager.findOne(User, { where: { unionid: identity.unionid } });
          if (owner && owner.openid !== identity.openid) {
            throw new ConflictException('该微信账号已绑定其它校友账号，无法合并');
          }
        }
        let user = await manager.findOne(User, { where: { openid: identity.openid } });
        if (!user) {
          user = manager.create(User, {
            openid: identity.openid,
            unionid: identity.unionid,
            nickname: nickname ?? '校友',
            source: identity.source,
            status: 'active',
            stage: 'logged_in',
          });
          user = await manager.save(user);
        } else {
          if (nickname) user.nickname = nickname;
          // ⚠️ unionid 的占用已在上面**统一**查过（两种分支都要拦住）；
          //   这里只在「本账号还没绑 unionid」时补上。
          if (identity.unionid && !user.unionid) {
            user.unionid = identity.unionid;
          }
          user.source = identity.source;
          user.lastLoginAt = new Date();
          await manager.save(user);
        }

        // 资料行与联系方式行始终存在，便于后续填写
        // ⚠️ `alumni_profiles.user_id` 有唯一索引（uk_alumni_profiles_user）：
        //   并发首登时两个请求都会「没找到资料行」→ 都去 INSERT → 一个撞键。
        //   这个撞键由外层的 `withDuplicateKeyRetry` 统一处置（重跑一次即可命中既有行）。
        const profile = await manager.findOne(AlumniProfile, { where: { userId: user.id } });
        if (!profile) {
          await manager.save(
            manager.create(AlumniProfile, {
              userId: user.id,
              displayName: nickname ?? user.nickname,
              showInDirectory: false,
            }),
          );
        }
        const contact = await manager.findOne(PrivateContact, { where: { userId: user.id } });
        if (!contact) {
          await manager.save(manager.create(PrivateContact, { userId: user.id }));
        }
      }),
    );

    const user = await this.users.findOne({ where: { openid: identity.openid } });
    if (!user) throw authFailed('用户创建失败');
    if (user.status !== 'active') throw authFailed('账号已被停用');

    const tokens = await this.signUserTokens(user);
    const alumniProfile = await this.buildAlumniProfile(user.id);
    return {
      ...tokens,
      tokenType: 'Bearer' as const,
      user: {
        id: user.id,
        openid: user.openid,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        role: null,
        status: user.status,
        stage: user.stage,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      },
      alumniProfile,
      stage: user.stage,
    };
  }

  async refresh(dto: RefreshTokenDto): Promise<AuthenticatedLoginResult> {
    const hash = hashToken(dto.refreshToken);
    const session = await this.sessions.findActiveByHash(hash);
    if (!session) {
      throw authFailed('登录状态已失效，请重新登录');
    }
    const user = await this.users.findOne({ where: { id: session.userId } });
    if (!user || user.status !== 'active') {
      throw authFailed('账号不可用');
    }
    // 轮换：旧会话立即吊销
    await this.sessions.revoke(session);
    const tokens = await this.signUserTokens(user);
    const alumniProfile = await this.buildAlumniProfile(user.id);
    return {
      ...tokens,
      tokenType: 'Bearer' as const,
      user: {
        id: user.id,
        openid: user.openid,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        role: null,
        status: user.status,
        stage: user.stage,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      },
      alumniProfile,
      stage: user.stage,
    };
  }

  async logout(refreshToken?: string): Promise<void> {
    if (!refreshToken) return;
    await this.sessions.revokeByHash(hashToken(refreshToken));
  }

  /**
   * 唯一键冲突时**重跑整个事务**（最多 3 次）。
   *
   * 适用场景：登录链路的「先查后插」——
   * 两个并发首登（同一个 openid）都会读到「用户不存在」→ 都去 INSERT →
   * 后到的那个撞 `uk_users_openid`。
   * 重跑时是**新的快照**，能看到另一个事务刚提交的那一行 → 走「已存在」分支，
   * 于是登录照常成功（而不是把数据库异常甩给用户）。
   *
   * ⚠️ 重试耗尽后**不得**把数据库异常抛成 500（缺陷 #190 同款口径）：
   *   连撞 3 次说明此刻确实有别的请求在抢同一行 ——
   *   `uk_users_unionid`（同一微信主体绑了两个账号）是**业务冲突** → 409；
   *   其余情况也一律 409「请重试」，而不是 500。
   */
  private async withDuplicateKeyRetry<T>(run: () => Promise<T>): Promise<T> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        if (attempt === maxAttempts) {
          throw new ConflictException(this.duplicateKeyMessage(duplicateKeyName(error)));
        }
      }
    }
    // 理论上不可达（循环要么 return、要么 throw）
    throw new ConflictException('登录信息冲突，请重试');
  }

  /** 唯一键冲突 → 可预期的错误文案（按**撞的是哪把钥匙**区分）。 */
  private duplicateKeyMessage(indexName: string | null): string {
    switch (indexName) {
      case 'uk_users_unionid':
        return '该微信账号已绑定其它校友账号，无法合并';
      case 'uk_users_openid':
        return '登录信息冲突，请重试';
      case 'uk_alumni_profiles_user':
        return '资料创建冲突，请重试';
      case 'uk_private_contacts_user':
        return '联系方式创建冲突，请重试';
      case 'uk_user_sessions_token':
        return '登录会话创建冲突，请重试';
      default:
        return '登录信息冲突，请重试';
    }
  }

  /* ------------------------------ 管理后台登录 ------------------------------ */

  async adminLogin(dto: AdminLoginDto): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    tokenType: 'Bearer';
    admin: {
      id: number;
      username: string;
      displayName: string;
      roles: string[];
      status: string;
      lastLoginAt: Date | null;
      createdAt: Date;
    };
    permissions: string[];
  }> {
    const admin = await this.adminUsers.findOne({ where: { username: dto.username } });
    if (!admin) {
      // 避免用户名枚举：与密码错误返回同样的错误
      throw authFailed('用户名或密码错误');
    }
    if (admin.status !== 'active') {
      throw authFailed('账号已被停用');
    }
    const matched = await bcrypt.compare(dto.password, admin.passwordHash);
    if (!matched) {
      throw authFailed('用户名或密码错误');
    }

    const roles = await this.adminUserRoles.find({
      where: { adminUserId: admin.id },
      relations: { role: true },
    });
    const roleCodes = roles.map((item) => item.role?.code ?? '').filter(Boolean);
    const permissions = await this.resolvePermissions(roleCodes);

    const accessToken = await this.signAdminAccessToken(admin.id);
    const refreshToken = await this.signAdminRefreshToken(admin.id);
    admin.lastLoginAt = new Date();
    await this.adminUsers.save(admin);

    return {
      accessToken,
      refreshToken,
      expiresIn: this.accessTokenTtlSeconds(),
      tokenType: 'Bearer',
      admin: {
        id: admin.id,
        username: admin.username,
        displayName: admin.displayName,
        roles: roleCodes,
        status: admin.status,
        lastLoginAt: admin.lastLoginAt,
        createdAt: admin.createdAt,
      },
      permissions,
    };
  }

  async resolvePermissions(roleCodes: string[]): Promise<string[]> {
    if (roleCodes.length === 0) return [];
    const rows = await this.rolePermissions
      .createQueryBuilder('rp')
      .innerJoin(Role, 'role', 'role.id = rp.roleId')
      .innerJoin(Permission, 'perm', 'perm.id = rp.permissionId')
      .where('role.code IN (:...codes)', { codes: roleCodes })
      .select('perm.code', 'code')
      .getRawMany<{ code: string }>();
    return Array.from(new Set(rows.map((row) => row.code)));
  }

  /* ------------------------------ 令牌校验 ------------------------------ */

  /** 解析 access token，返回调用方身份；无效返回 null。 */
  async resolveAccessToken(token: string): Promise<RequestUser | null> {
    let payload: AccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.get<string>('app.jwtSecret'),
      });
    } catch {
      return null;
    }
    if (payload.typ !== 'access') return null;

    if (payload.kind === 'admin') {
      return this.resolveAdminIdentity(Number(payload.sub));
    }

    const user = await this.users.findOne({ where: { id: Number(payload.sub) } });
    if (!user || user.status !== 'active') return null;
    return {
      id: user.id,
      openid: user.openid,
      nickname: user.nickname,
      role: 'alumni',
      stage: user.stage,
      isAdmin: false,
      permissions: [],
    };
  }

  /**
   * 解析管理员身份（**带进程内 TTL 缓存**）。
   *
   * ⚠️ 第三轮：此前每个管理端请求都要重算 4 条 SQL
   *    （`admin_users` + `admin_user_roles` + `role_permissions`），
   *    是管理端最大的单点开销。现在缓存「这个管理员有哪些角色 / 权限点」。
   *
   * 口径见 `docs/SECURITY.md` 第 2.1 节（先定口径、再写代码）：
   *  - TTL **≤ 60 秒**（撤权延迟的上界；本进程内写操作会主动失效，延迟 0）；
   *  - 缓存**只存「有哪些权限点」**这一事实，**不缓存「这个请求是否被允许」** ——
   *    每个请求仍然要走 `PermissionsGuard` 逐个权限点比对；
   *  - 停用 / 降权时**主动失效**（见 `invalidateAdminCache`）。
   */
  private async resolveAdminIdentity(adminId: number): Promise<RequestUser | null> {
    const cached = this.cache.get<AdminIdentityCacheEntry>(CacheKeys.adminRbac(adminId));
    if (cached) {
      // 缓存里只存「有效的管理员」；账号被停用会由写操作主动失效掉这条缓存。
      return {
        id: cached.id,
        openid: `admin:${cached.username}`,
        nickname: cached.displayName,
        role: cached.roleCodes[0] ?? 'admin',
        stage: 'verified',
        isAdmin: true,
        permissions: cached.permissions,
      };
    }

    const admin = await this.adminUsers.findOne({ where: { id: adminId } });
    if (!admin || admin.status !== 'active') return null;
    const roleRows = await this.adminUserRoles.find({
      where: { adminUserId: admin.id },
      relations: { role: true },
    });
    const roleCodes = roleRows.map((item) => item.role?.code ?? '').filter(Boolean);
    const permissions = await this.resolvePermissions(roleCodes);

    this.cache.set(
      CacheKeys.adminRbac(adminId),
      {
        id: admin.id,
        username: admin.username,
        displayName: admin.displayName,
        roleCodes,
        permissions,
      },
      this.cache.rbacTtlSeconds,
    );

    return {
      id: admin.id,
      openid: `admin:${admin.username}`,
      nickname: admin.displayName,
      role: roleCodes[0] ?? 'admin',
      stage: 'verified',
      isAdmin: true,
      permissions,
    };
  }

  /**
   * **主动失效**某个管理员的 RBAC 缓存。
   *
   * 停用账号 / 改角色后立刻调用（写事务提交后）——
   * 这样「降权后仍能操作」的窗口在本进程内是 **0**，
   * TTL（≤30 秒）只是多实例部署下的兜底。
   */
  invalidateAdminCache(adminId: number): void {
    this.cache.delete(CacheKeys.adminRbac(adminId));
  }

  /* ------------------------------ 内部方法 ------------------------------ */

  /**
   * 登录方式开关（`AUTH_MODE`）。
   *
   * ⚠️ 这个配置此前是**死配置**：`.env.prod` 里写着 `AUTH_MODE=both`，
   *    但没有任何代码读它 → 无论怎么配，Mock 登录与微信登录**永远同时开着**。
   *    后果：生产环境里 `/auth/mock/login` 是**公开可用的后门**
   *    （任何人都能凭空造一个用户），而运营想「只留微信登录」也做不到。
   *
   * 取值：
   *   - `mock`  ：只开 Mock 登录（小程序尚未注册时的开发态）；
   *   - `wechat`：只开微信登录（正式对外时用，堵掉 Mock 后门）；
   *   - `both`  ：两个都开（联调 / 预览期）。
   *
   * ⚠️ 非法取值此前一律按 `both` 处理 —— **fail-open**：
   *    生产环境里把 `wechat` 拼成 `wechats`，Mock 后门就被**自动重新打开**，
   *    而且没有任何报错。现在改为 **fail-closed**：非法取值一律按 `wechat`
   *    处理（Mock 登录不可用），并把问题喊出来 ——
   *    「配置写错」绝不能等价于「把后门打开」。
   */
  private get authMode(): 'mock' | 'wechat' | 'both' {
    const raw = (this.config.get<string>('app.authMode', 'both') ?? 'both').trim().toLowerCase();
    if (raw === 'mock' || raw === 'wechat' || raw === 'both') return raw;
    this.logger.error(
      `AUTH_MODE 取值非法："${raw}"（只能是 mock / wechat / both）。` +
        '已按最严口径处理：关闭 Mock 登录（只保留微信登录）。',
    );
    return 'wechat';
  }

  private get mockLoginEnabled(): boolean {
    return this.authMode !== 'wechat';
  }

  private get wechatLoginEnabled(): boolean {
    return this.authMode !== 'mock';
  }

  private get mockProvider(): AuthProvider {
    return this.mockAuthProvider;
  }

  private get wechatProvider(): AuthProvider {
    return this.wechatAuthProvider;
  }

  private async signUserTokens(user: User): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> {
    const secret = this.config.get<string>('app.jwtSecret');
    const expiresIn = this.accessTokenTtlSeconds();
    const refreshTtl = this.refreshTokenTtlSeconds();
    // ⚠️ `user_sessions.refresh_token_hash` 有唯一索引（uk_user_sessions_token）：
    //   撞键时**重新签发一枚**令牌再试一次（令牌带随机 jti，重发即换哈希）；
    //   仍撞（几乎不可能）才给 409 —— 绝不把数据库异常抛成 500。
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const accessToken = await this.jwtService.signAsync(
        { sub: String(user.id), kind: 'user', typ: 'access', jti: randomUUID() },
        { secret, expiresIn },
      );
      const refreshToken = await this.jwtService.signAsync(
        { sub: String(user.id), kind: 'user', typ: 'refresh', jti: randomUUID() },
        { secret, expiresIn: refreshTtl },
      );
      try {
        await this.sessions.create(
          user.id,
          refreshToken,
          hashToken(refreshToken),
          new Date(Date.now() + refreshTtl * 1000),
        );
        return { accessToken, refreshToken, expiresIn };
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        if (attempt === 2) {
          throw new ConflictException(this.duplicateKeyMessage(duplicateKeyName(error)));
        }
      }
    }
    throw new ConflictException('登录会话创建冲突，请重试');
  }

  private async signAdminAccessToken(adminId: number): Promise<string> {
    return this.jwtService.signAsync(
      { sub: String(adminId), kind: 'admin', typ: 'access', jti: randomUUID() },
      {
        secret: this.config.get<string>('app.jwtSecret'),
        expiresIn: this.accessTokenTtlSeconds(),
      },
    );
  }

  private async signAdminRefreshToken(adminId: number): Promise<string> {
    return this.jwtService.signAsync(
      { sub: String(adminId), kind: 'admin', typ: 'refresh', jti: randomUUID() },
      {
        secret: this.config.get<string>('app.jwtSecret'),
        expiresIn: this.refreshTokenTtlSeconds(),
      },
    );
  }

  private accessTokenTtlSeconds(): number {
    return parseDurationToSeconds(this.config.get<string>('app.jwtAccessTtl', '2h'));
  }

  private refreshTokenTtlSeconds(): number {
    return parseDurationToSeconds(this.config.get<string>('app.jwtRefreshTtl', '30d'));
  }

  private async buildAlumniProfile(userId: number): Promise<AuthenticatedLoginResult['alumniProfile']> {
    const profile = await this.profiles.findOne({
      where: { userId },
      relations: { region: true, industry: true },
    });
    if (!profile) return null;
    return {
      userId: profile.userId,
      displayName: profile.displayName,
      realName: profile.realName,
      college: profile.college,
      degree: profile.degree,
      graduationYear: profile.graduationYear,
      regionCode: profile.regionCode,
      regionName: profile.region?.name ?? null,
      industryCode: profile.industryCode,
      industryName: profile.industry?.name ?? null,
      direction: profile.direction,
      intro: profile.intro,
      verified: profile.verified,
      verifiedAt: profile.verifiedAt,
      contactVisible: profile.allowContactShare,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }
}
