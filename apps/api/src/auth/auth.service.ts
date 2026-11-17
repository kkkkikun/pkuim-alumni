import {
  BadRequestException,
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
import { ResponseCode } from '../common/constants';
import type { RequestUser } from '../common/decorators';
import { hashToken } from '../common/utils/crypto';
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
    @Inject(MOCK_AUTH_PROVIDER) private readonly mockAuthProvider: AuthProvider,
    @Inject(WECHAT_AUTH_PROVIDER) private readonly wechatAuthProvider: AuthProvider,
  ) {}

  /* ------------------------------ 用户登录 ------------------------------ */

  async loginWithMock(dto: MockLoginDto): Promise<AuthenticatedLoginResult> {
    const provider = this.mockProvider;
    if (!provider.available()) {
      throw new BadRequestException('Mock 登录未启用');
    }
    const identity = await provider.exchange(dto.mockOpenid ?? '');
    return this.issueUserLogin(identity, dto.nickname ?? null);
  }

  async loginWithWechat(dto: WechatLoginDto): Promise<AuthenticatedLoginResult> {
    const provider = this.wechatProvider;
    if (!provider.available()) {
      throw new BadRequestException('微信登录尚未配置');
    }
    const identity = await provider.exchange(dto.code);
    return this.issueUserLogin(identity, null);
  }

  /** 用户登录主流程：定位或创建用户 → 确保资料行 → 签发令牌与会话。 */
  async issueUserLogin(
    identity: AuthIdentity,
    nickname: string | null,
  ): Promise<AuthenticatedLoginResult> {
    await this.dataSource.transaction(async (manager) => {
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
        if (identity.unionid && !user.unionid) user.unionid = identity.unionid;
        user.source = identity.source;
        user.lastLoginAt = new Date();
        await manager.save(user);
      }

      // 资料行与联系方式行始终存在，便于后续填写
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
    });

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
      const admin = await this.adminUsers.findOne({ where: { id: Number(payload.sub) } });
      if (!admin || admin.status !== 'active') return null;
      const roleRows = await this.adminUserRoles.find({
        where: { adminUserId: admin.id },
        relations: { role: true },
      });
      const roleCodes = roleRows.map((item) => item.role?.code ?? '').filter(Boolean);
      const permissions = await this.resolvePermissions(roleCodes);
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

  /* ------------------------------ 内部方法 ------------------------------ */

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
    const accessToken = await this.jwtService.signAsync(
      { sub: String(user.id), kind: 'user', typ: 'access', jti: randomUUID() },
      { secret, expiresIn: this.accessTokenTtlSeconds() },
    );
    const refreshToken = await this.jwtService.signAsync(
      { sub: String(user.id), kind: 'user', typ: 'refresh', jti: randomUUID() },
      { secret, expiresIn: this.refreshTokenTtlSeconds() },
    );
    const expiresIn = this.accessTokenTtlSeconds();
    const refreshTtl = this.refreshTokenTtlSeconds();
    await this.sessions.create(
      user.id,
      refreshToken,
      hashToken(refreshToken),
      new Date(Date.now() + refreshTtl * 1000),
    );
    return { accessToken, refreshToken, expiresIn };
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
