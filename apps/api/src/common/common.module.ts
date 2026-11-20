import { Global, Module } from '@nestjs/common';
import { RequestContextService } from './services/request-context.service';
import { RateLimiterService } from './services/rate-limiter.service';

/**
 * 全局基础模块。
 *
 * 目前提供**请求上下文**（来源 IP）与**限流计数**两个跨模块共用的服务：
 *   - 请求上下文要被管理端的审计写入、全局拦截器等多个模块共用，
 *     必须是**同一个实例**（`AsyncLocalStorage` 挂在实例上）；
 *   - 限流计数同时被 `RateLimitGuard` 与 `JwtAuthGuard`（认证失败路径）使用，
 *     必须是**同一个实例**（同一个 Redis 连接、同一个开关）。
 * 所以用 `@Global()` 导出，任何模块都能注入。
 */
@Global()
@Module({
  providers: [RequestContextService, RateLimiterService],
  exports: [RequestContextService, RateLimiterService],
})
export class CommonModule {}
