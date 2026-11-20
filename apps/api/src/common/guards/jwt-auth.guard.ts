import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators';
import type { AuthenticatedRequest, RequestUser } from '../decorators';
import { ResponseCode } from '../constants';
import { RateLimiterService, resolveRateLimitCategory } from '../services/rate-limiter.service';

/** 由 auth 模块实现的用户解析能力 */
export const AUTH_CONTEXT = Symbol('AUTH_CONTEXT');
export interface AuthContext {
  /** 校验 access token 并返回用户；无效返回 null */
  resolveAccessToken(token: string): Promise<RequestUser | null>;
}

/**
 * 全局 JWT 守卫：除 @Public() 标记的接口外一律要求有效 access token。
 *
 * ⚠️ 复核补漏（第二轮）：**鉴权失败的请求此前完全不受限流保护**。
 *    限流守卫（`RateLimitGuard`）排在 JWT 守卫**之后**，
 *    于是「不带头 / 带头但无效」的请求在到达限流之前就被 401 拒掉，
 *    一分钱额度都不消耗 —— 攻击者只要在请求头塞一个垃圾 Bearer 值，
 *    就能对受保护端点无限打（文档第 6 节承诺的「按用户或 IP 计数」对这些请求不成立）。
 *    现在：**认证失败时先按 IP 计一次额度**，超了直接 429；
 *    没超才回原来的 401（客户端拿到的错误语义不变）。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH_CONTEXT) private readonly authContext: AuthContext,
    private readonly limiter: RateLimiterService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractToken(request);
    if (!token) {
      await this.assertNotRateLimited(request, context);
      throw new UnauthorizedException('请先登录');
    }

    const user = await this.authContext.resolveAccessToken(token);
    if (!user) {
      await this.assertNotRateLimited(request, context);
      throw new UnauthorizedException('登录状态已失效，请重新登录');
    }
    request.user = user;
    return true;
  }

  /**
   * 认证失败路径上的限流计额（按 IP）。
   *
   * 超过阈值时抛 429（而不是 401）—— 客户端从此知道「是被限流了」，
   * 而不是继续拿一个 401 去撞。
   */
  private async assertNotRateLimited(
    request: AuthenticatedRequest,
    context: ExecutionContext,
  ): Promise<void> {
    if (!this.limiter.isEnabled) return;
    const { category, limit } = resolveRateLimitCategory(
      request.method,
      context.getHandler().name,
      this.limiter.limits,
    );
    const identity = `ip${request.ip ?? 'unknown'}`;
    const allowed = await this.limiter.consume(identity, category, limit);
    if (allowed) return;
    throw new HttpException(
      {
        code: ResponseCode.RATE_LIMITED,
        message: '操作过于频繁，请稍后再试',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private extractToken(request: AuthenticatedRequest): string | null {
    const header = request.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
      return header.slice(7).trim();
    }
    return null;
  }
}
