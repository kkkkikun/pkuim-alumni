import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export const IS_PUBLIC_KEY = 'isPublic';
/** 标记为公开接口（跳过 JWT 校验） */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const PERMISSIONS_KEY = 'requiredPermissions';
/** 声明访问该接口所需的管理端权限点（任一命中即可） */
export const RequirePermissions = (...permissions: string[]) => SetMetadata(PERMISSIONS_KEY, permissions);

/** 当前请求用户 */
export interface RequestUser {
  id: number;
  openid: string;
  nickname: string;
  role: string;
  stage: 'logged_in' | 'pending_review' | 'verified';
  isAdmin: boolean;
  permissions: string[];
}

export interface AuthenticatedRequest extends Request {
  user?: RequestUser;
  requestId?: string;
}

export const CurrentUser = createParamDecorator(
  (data: keyof RequestUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user) return undefined;
    return data ? user[data] : user;
  },
);
