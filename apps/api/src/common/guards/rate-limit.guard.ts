import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { AuthenticatedRequest } from '../decorators';
import { ResponseCode } from '../constants';

/**
 * 固定窗口限流。按「用户（或 IP）+ 接口类别」计数。
 *
 * ⚠️ 计数维度此前是「用户 + **路由处理器**」，与 docs/SECURITY.md 第 6 节
 *    「登录 / 刷新：20 次/分钟；写接口 30 次/分钟；读接口 240 次/分钟」不一致：
 *    逐路由分桶意味着**每个**写端点各有 30 次/分钟，
 *    攻击者只要把请求分散到多个写端点，总量可以远超文档承诺的阈值。
 *    现在按**类别**分桶：auth / write / read，与文档口径一致（也更严格）。
 *
 * Redis 不可用时降级放行（限流是保护措施，不是业务依赖）。
 * `RATE_LIMIT_ENABLED=false` 时完全关闭（集成测试使用）。
 */
@Injectable()
export class RateLimitGuard implements CanActivate, OnModuleDestroy {
  private readonly redis: Redis;
  private readonly enabled: boolean;

  constructor(private readonly config: ConfigService) {
    this.enabled = this.config.get<string>('app.rateLimit.enabled', 'true') !== 'false';
    this.redis = new Redis({
      host: this.config.get<string>('redis.host', '127.0.0.1'),
      port: this.config.get<number>('redis.port', 6379),
      password: this.config.get<string | undefined>('redis.password'),
      db: this.config.get<number>('redis.db', 0),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    this.redis.on('error', () => undefined);
  }

  /** 关闭 Redis 连接，避免进程无法退出（集成测试 / 优雅停机）。 */
  async onModuleDestroy(): Promise<void> {
    try {
      // lazyConnect 下未建立连接时直接 disconnect，避免 quit 触发一次多余握手
      if (this.redis.status === 'wait' || this.redis.status === 'end') {
        this.redis.disconnect();
        return;
      }
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.enabled) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const method = request.method.toUpperCase();
    const handler = context.getHandler().name;

    const { windowSeconds, default: def, write, auth } = this.config.get<{
      windowSeconds: number;
      default: number;
      write: number;
      auth: number;
    }>('app.rateLimit', { windowSeconds: 60, default: 240, write: 30, auth: 20 });

    let limit = def;
    let category = 'read';
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      limit = write;
      category = 'write';
    }
    // 登录 / 刷新单独一档（文档第 6 节：20 次/分钟）。
    if (/login|refresh/i.test(handler)) {
      limit = auth;
      category = 'auth';
    }

    const identity = request.user?.id
      ? `u${request.user.id}`
      : `ip${request.ip ?? 'unknown'}`;
    const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
    const key = `ratelimit:${identity}:${category}:${bucket}`;

    let count = 1;
    try {
      await this.redis.connect().catch(() => undefined);
      count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, windowSeconds + 5);
      }
    } catch {
      // Redis 不可用时降级放行，不阻断业务（限流是保护措施而非业务依赖）
      return true;
    }

    if (count > limit) {
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
