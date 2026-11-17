import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { AuthenticatedRequest } from '../decorators';
import { ResponseCode } from '../constants';

/**
 * 固定窗口限流。按「用户 + 路由」计数，写接口与登录接口使用更严格的阈值。
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
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      limit = write;
    }
    if (handler.toLowerCase().includes('login') || handler.toLowerCase().includes('refresh')) {
      limit = auth;
    }

    const identity = request.user?.id
      ? `u${request.user.id}`
      : `ip${request.ip ?? 'unknown'}`;
    const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
    const key = `ratelimit:${identity}:${handler}:${bucket}`;

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
