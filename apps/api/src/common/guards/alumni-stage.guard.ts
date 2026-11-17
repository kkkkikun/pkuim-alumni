import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ResponseCode } from '../constants';
import type { AuthenticatedRequest } from '../decorators';

export const ALUMNI_STAGE_KEY = 'requiredAlumniStage';

/**
 * 标记接口需要达到的校友身份阶段。
 * 游客 / 已登录未认证 / 待审核用户都不能调用这些接口（后端强制，不依赖前端隐藏按钮）。
 */
export const RequireAlumniStage = (stage: 'verified') => (target: object, key: string, descriptor: PropertyDescriptor) => {
  Reflect.defineMetadata(ALUMNI_STAGE_KEY, stage, descriptor.value);
  return descriptor;
};

@Injectable()
export class AlumniStageGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string>(ALUMNI_STAGE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user) {
      throw new HttpException(
        { code: ResponseCode.AUTH_REQUIRED, message: '请先登录' },
        HttpStatus.UNAUTHORIZED,
      );
    }
    // 管理员不受校友身份阶段限制
    if (user.isAdmin) return true;
    if (user.stage !== required) {
      // ⚠️ 缺陷 #109：此前抛的是普通 `ForbiddenException` →
      //    被统一异常过滤器按状态码映射成通用的 `FORBIDDEN`，
      //    契约里专门为「需完成校友身份认证」定义的 `VERIFICATION_REQUIRED`
      //    **从未被服务端返回过**（死码）。
      //    客户端因此无法区分「你没认证 → 去认证页」与「你没权限」——
      //    这是两种完全不同的用户引导。
      //    HTTP 状态码保持 403 不变（用户已登录，只是身份阶段不够），
      //    只把业务错误码换成专用的那一个。
      throw new HttpException(
        {
          code: ResponseCode.VERIFICATION_REQUIRED,
          message:
            required === 'verified'
              ? '需完成校友身份认证后才能使用该功能'
              : '当前身份无法访问该功能',
        },
        HttpStatus.FORBIDDEN,
      );
    }
    return true;
  }
}
