/**
 * 限流计数服务（从 RateLimitGuard 里抽出来的共用逻辑）。
 *
 * ⚠️ 复核补漏（第二轮）：此前计数逻辑**只**存在于 `RateLimitGuard` 里，
 *    而守卫在 `JwtAuthGuard` **之后**执行（见 app.module.ts 的 APP_GUARD 注册顺序）。
 *    后果：**带伪造 / 过期令牌的请求在到达限流之前就被 401 拒掉**，
 *    根本不消耗任何额度 —— 攻击者只要在请求头塞一个垃圾 Bearer 值，
 *    就能对受保护端点无限打（应用层唯一的约束是 nginx 那条粗粒度的 limit_req）。
 *    文档第 6 节承诺的「按用户或 IP 计数」对这些请求**不成立**。
 *
 * 现在把计数逻辑抽成服务，让**鉴权失败的那条路径**也能计额：
 *   - 认证成功 → 按「用户 id + 接口类别」计（与之前一致）；
 *   - 认证失败 → 按「IP + 接口类别」计（失败请求同样占额度）。
 *
 * Redis 不可用时**降级放行**（限流是保护措施，不是业务依赖）——
 * 与 docs/SECURITY.md 第 6 节的口径一致。
 */
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/** 接口类别与对应阈值。 */
export interface RateLimitCategory {
  /** 'auth' | 'write' | 'read' */
  category: string;
  /** 该类别的阈值（次/窗口） */
  limit: number;
}

/**
 * 按「HTTP 方法 + 路由处理器名」判定接口类别。
 *
 * 与 docs/SECURITY.md 第 6 节一致：
 *   - 登录 / 刷新 → auth 档（20 次/分钟）；
 *   - 写方法（POST/PUT/PATCH/DELETE）→ write 档（30 次/分钟）；
 *   - 其余 → read 档（240 次/分钟）。
 *
 * ⚠️ 判定顺序很重要：**先看 handler 名，再看方法**。
 *    登录 / 刷新端点全是 POST，若先按方法判成 write 档，
 *    「登录 20 次/分钟」这一档就永远不会生效（auth 档成了死代码）。
 *    原来的守卫是「两个 if 顺序执行、后者覆盖前者」，语义与这里一致。
 */
export function resolveRateLimitCategory(
  method: string,
  handlerName: string,
  limits: { default: number; write: number; auth: number },
): RateLimitCategory {
  // 登录 / 刷新单独一档（handler 名里带 login / refresh）。
  if (/login|refresh/i.test(handlerName)) {
    return { category: 'auth', limit: limits.auth };
  }
  const upper = method.toUpperCase();
  if (upper === 'POST' || upper === 'PUT' || upper === 'PATCH' || upper === 'DELETE') {
    return { category: 'write', limit: limits.write };
  }
  return { category: 'read', limit: limits.default };
}

@Injectable()
export class RateLimiterService implements OnModuleDestroy {
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

  /** 阈值（次/窗口）。 */
  get limits(): { default: number; write: number; auth: number; windowSeconds: number } {
    return this.config.get<{
      windowSeconds: number;
      default: number;
      write: number;
      auth: number;
    }>('app.rateLimit', { windowSeconds: 60, default: 240, write: 30, auth: 20 });
  }

  /** 限流是否开启（测试环境用 RATE_LIMIT_ENABLED=false 关掉）。 */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 计一次额度。
   *
   * @param identity 计数主体（用户 id 或 IP）
   * @param category 接口类别
   * @param limit 该类别的阈值
   * @returns true = 放行；false = 超过阈值
   */
  async consume(identity: string, category: string, limit: number): Promise<boolean> {
    if (!this.enabled) return true;
    const { windowSeconds } = this.limits;
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
      // Redis 不可用时降级放行，不阻断业务
      return true;
    }
    return count <= limit;
  }

  /** 关闭 Redis 连接，避免进程无法退出（集成测试 / 优雅停机）。 */
  async onModuleDestroy(): Promise<void> {
    try {
      if (this.redis.status === 'wait' || this.redis.status === 'end') {
        this.redis.disconnect();
        return;
      }
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
