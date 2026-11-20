import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * 进程内 TTL 缓存（第三轮引入）。
 *
 * 口径写在 `docs/SECURITY.md` 第 2.1 节（**先定口径、再写代码**）：
 *  - 缓存 RBAC 解析结果、字典 / 分类 / 系统设置；
 *  - **绝不缓存**需要实时性的数据（未读通知数等）；
 *  - RBAC 的 TTL **硬上限 60 秒**（撤权延迟的上界）；
 *  - 写操作**主动失效**，不等 TTL。
 *
 * ⚠️ 为什么是「进程内」而不是 Redis：
 *   - Redis 只用于限流与队列；加一层 Redis 反而多一次网络往返，
 *     而这些数据本来就是「本实例自己算出来的」；
 *   - 进程内缓存重启即清空，**没有陈旧数据跨重启残留**的问题；
 *   - 代价是「多实例部署时主动失效只清发起写操作的那一个实例」，
 *     其余实例最多等 TTL —— 这个代价已在 SECURITY.md 里写明并限定在 ≤30 秒内。
 */
@Injectable()
export class TtlCacheService {
  private readonly store = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(private readonly config: ConfigService) {}

  /**
   * 读取缓存条目；不存在或已过期返回 `undefined`。
   *
   * 过期条目在**读取时**顺手删掉（惰性清理）——
   * 避免为一条永远不会有人再读的键专门跑一次清理定时器。
   */
  get<T>(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  /** 写入缓存条目；`ttlSeconds <= 0` 表示不缓存（直接跳过写入）。 */
  set(key: string, value: unknown, ttlSeconds: number): void {
    if (ttlSeconds <= 0) return;
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  /** 主动失效：清掉某个键（写操作后立即调用，不等 TTL）。 */
  delete(key: string): void {
    this.store.delete(key);
  }

  /**
   * 按前缀批量失效。
   *
   * 用于「角色目录变了 → 所有管理员的 RBAC 缓存都失效」这类
   * 无法逐个枚举管理员 id 的场景。
   */
  deleteByPrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  /** 清空全部缓存（测试与运维排障用）。 */
  clear(): void {
    this.store.clear();
  }

  /** 当前条目数（测试与指标用）。 */
  get size(): number {
    return this.store.size;
  }

  /**
   * RBAC 缓存的 TTL（秒）。
   *
   * ⚠️ **硬上限 60 秒**：降权后最长 60 秒内仍可操作是安全语义，
   *    必须有明确上界 —— 配置写大了也会被夹回 60（见 docs/SECURITY.md 2.1.2）。
   *    设为 0 = 关闭缓存（回到每请求重算的行为，便于排障与压测对照）。
   */
  get rbacTtlSeconds(): number {
    const raw = Number(this.config.get<string>('app.rbacCacheTtlSeconds', '30'));
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return Math.min(60, Math.floor(raw));
  }

  /**
   * 字典 / 分类 / 系统设置缓存的 TTL（秒）。
   *
   * 上限 300 秒：这些数据写多读少、变更低频，
   * 稍长一点对「刚改完字典，页面还没变」的观感影响更小。
   * 设为 0 = 关闭缓存。
   */
  get dictionaryTtlSeconds(): number {
    const raw = Number(this.config.get<string>('app.dictCacheTtlSeconds', '60'));
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return Math.min(300, Math.floor(raw));
  }
}
