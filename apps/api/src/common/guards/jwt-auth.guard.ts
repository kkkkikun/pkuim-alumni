import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators';
import type { AuthenticatedRequest, RequestUser } from '../decorators';

/** 由 auth 模块实现的用户解析能力 */
export const AUTH_CONTEXT = Symbol('AUTH_CONTEXT');
export interface AuthContext {
  /** 校验 access token 并返回用户；无效返回 null */
  resolveAccessToken(token: string): Promise<RequestUser | null>;
}

/**
 * 全局 JWT 守卫：除 @Public() 标记的接口外一律要求有效 access token。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH_CONTEXT) private readonly authContext: AuthContext,
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
      throw new UnauthorizedException('请先登录');
    }

    const user = await this.authContext.resolveAccessToken(token);
    if (!user) {
      throw new UnauthorizedException('登录状态已失效，请重新登录');
    }
    request.user = user;
    return true;
  }

  private extractToken(request: AuthenticatedRequest): string | null {
    const header = request.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
      return header.slice(7).trim();
    }
    return null;
  }
}
