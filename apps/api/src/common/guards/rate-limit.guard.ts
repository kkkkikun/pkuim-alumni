import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { AuthenticatedRequest } from '../decorators';
import { ResponseCode } from '../constants';
import { RateLimiterService, resolveRateLimitCategory } from '../services/rate-limiter.service';

/**
 * 固定窗口限流。按「用户（或 IP）+ 接口类别」计数。
 *
 * ⚠️ 计数维度此前是「用户 + **路由处理器**」，与 docs/SECURITY.md 第 6 节
 *    「登录 / 刷新：20 次/分钟；写接口 30 次/分钟；读接口 240 次/分钟」不一致：
 *    逐路由分桶意味着**每个**写端点各有 30 次/分钟，
 *    攻击者只要把请求分散到多个写端点，总量可以远超文档承诺的阈值。
 *    现在按**类别**分桶：auth / write / read，与文档口径一致（也更严格）。
 *
 * ⚠️ 复核补漏（第二轮）：计数逻辑已抽到 `RateLimiterService`，
 *    因为**鉴权失败的请求也必须计额** ——
 *    此前本守卫排在 `JwtAuthGuard` 之后，伪造 / 过期令牌的请求
 *    在到达这里之前就被 401 拒掉，等于完全不受限流保护。
 *    现在 `JwtAuthGuard` 的失败路径也会调用同一个服务（按 IP 计）。
 *
 * Redis 不可用时降级放行（限流是保护措施，不是业务依赖）。
 * `RATE_LIMIT_ENABLED=false` 时完全关闭（集成测试使用）。
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly limiter: RateLimiterService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.limiter.isEnabled) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const method = request.method.toUpperCase();
    const handler = context.getHandler().name;

    const { category, limit } = resolveRateLimitCategory(method, handler, this.limiter.limits);
    const identity = request.user?.id ? `u${request.user.id}` : `ip${request.ip ?? 'unknown'}`;

    const allowed = await this.limiter.consume(identity, category, limit);
    if (!allowed) {
      throw new HttpException(
        {
          code: ResponseCode.RATE_LIMITED,
          message: '操作过于频繁，请稍后再试',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
