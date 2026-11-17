import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators';
import type { AuthenticatedRequest } from '../decorators';

/**
 * 管理端权限守卫：校验当前管理员是否具备接口声明的权限点（任一命中即可）。
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user || !user.isAdmin) {
      throw new ForbiddenException('需要管理员权限');
    }
    const owned = new Set(user.permissions ?? []);
    const ok = required.some((permission) => owned.has(permission));
    if (!ok) {
      throw new ForbiddenException('缺少所需权限');
    }
    return true;
  }
}
