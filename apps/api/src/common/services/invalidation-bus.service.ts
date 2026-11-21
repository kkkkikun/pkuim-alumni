import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { DEFAULT_INVALIDATION_CHANNEL, resolveInvalidationChannel } from '../../config/configuration';
import { CacheKeys } from '../constants';
import { TtlCacheService } from './ttl-cache.service';

/**
 * 总线上流动的**失效事件**。
 *
 * ⚠️ 这里**只有「谁的缓存该作废」**，没有任何权限内容：
 *    - `admin`：某个管理员的 RBAC 缓存作废（停用 / 降权）；
 *    - `rbac-all`：全部管理员的 RBAC 缓存作废（角色目录整体变更时用）。
 *    权限点、角色名、联系方式等**一律不上总线** ——
 *    权限点仍然由每个实例自己从库里算（口径见 docs/SECURITY.md 第 2.1.5 节）。
 */
export type InvalidationEvent =
  | { kind: 'admin'; adminId: number }
  | { kind: 'rbac-all' };

/** 订阅失败后的重试间隔（毫秒）。 */
const SUBSCRIBE_RETRY_MS = 5_000;

/**
 * 发布事件时的**超时上限**（毫秒）。
 *
 * ⚠️ 为什么需要：Redis「连得上但很慢」时，`PUBLISH` 会挂在命令队列里。
 *    失效总线是**优化**，不是业务依赖 —— 它不能把管理端的写操作拖住。
 *    超时即视为「总线不可用」，撤权延迟回落到 TTL 上界（≤60 秒）。
 */
const PUBLISH_TIMEOUT_MS = 500;

/** 判断解析出来的东西是不是一条**已知**的失效事件（白名单，不认未知字段）。 */
function isInvalidationEvent(value: unknown): value is InvalidationEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as { kind?: unknown; adminId?: unknown };
  if (event.kind === 'rbac-all') return true;
  if (event.kind !== 'admin') return false;
  return (
    typeof event.adminId === 'number' &&
    Number.isInteger(event.adminId) &&
    event.adminId > 0
  );
}

/**
 * 共享失效总线（第五轮引入；Redis pub/sub）。
 *
 * ## 目的
 *
 * 进程内 TTL 缓存的「主动失效」只能清**发起写操作的那一个实例**的缓存，
 * 多实例部署时其余实例最多要等 TTL（≤60 秒）才生效（第三轮的口径）。
 * 本服务把「**谁的缓存该作废**」这条消息广播到所有实例，
 * 于是「停用 / 降权」在**任何实例**上都立刻生效。
 *
 * ## 口径（先定口径、再写代码；见 docs/SECURITY.md 第 2.1.4 / 2.1.5 节）
 *
 * | 部署形态 | 总线状态 | 撤权延迟上界 |
 * |---|---|---:|
 * | 单实例 | 不适用 | 0 |
 * | 多实例 | 总线可用 | 0 |
 * | 多实例 | 总线不可用 | ≤ TTL（≤60 秒） |
 *
 * ## 降级路径是硬要求
 *
 * Redis 不可用 / 订阅断开时：
 *   - **管理端写操作照常成功**（不抛错、不回滚业务写）；
 *   - 撤权延迟回落到 **TTL 上界**，**不是永久放行**；
 *   - 总线恢复后自动重新订阅（不重启进程）。
 *
 * ## 不缓存需要实时性的数据
 *
 * 总线**只传失效事件**：未读通知数等需要实时性的数据既不进缓存、也不进总线
 * （`GET /me/summary` 每次实时 COUNT）。
 */
@Injectable()
export class InvalidationBusService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InvalidationBusService.name);
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly enabled: boolean;
  private readonly channel: string;

  private retryTimer?: NodeJS.Timeout;
  private closed = false;
  private subscribed = false;
  private publishedCount = 0;
  private receivedCount = 0;
  private lastError?: string;

  constructor(
    private readonly config: ConfigService,
    private readonly cache: TtlCacheService,
  ) {
    this.enabled =
      this.config.get<string>('app.rbacInvalidation.enabled', 'true') !== 'false';
    this.channel = resolveInvalidationChannel(
      this.config.get<string>('app.rbacInvalidation.channel', DEFAULT_INVALIDATION_CHANNEL),
      this.config.get<string>('app.env'),
    );

    const options = {
      host: this.config.get<string>('redis.host', '127.0.0.1'),
      port: this.config.get<number>('redis.port', 6379),
      password: this.config.get<string | undefined>('redis.password'),
      db: this.config.get<number>('redis.db', 0),
      lazyConnect: true,
      // ⚠️ 命令在未连接时**立刻失败**而不是排队等待 ——
      //    否则 Redis 不可用时请求会挂在命令队列里（降级路径就永远走不到）。
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      // ⚠️ `disconnect()` 默认会「先 end 再等 2 秒才 destroy」——
      //    那 2 秒里 socket 仍挂在事件循环上，集成测试会看到
      //    「Jest did not exit one second after the test run has completed」。
      //    这里让 socket **立即**销毁，停机干净、不留尾巴。
      disconnectTimeout: 0,
    };
    // 发布端与订阅端必须是**两条连接**：Redis 的订阅模式会独占连接。
    this.publisher = new Redis(options);
    this.subscriber = new Redis(options);
    // 静默连接错误：总线不可用是**降级**，不是崩溃（错误记在 `lastError` 里）。
    this.publisher.on('error', () => undefined);
    this.subscriber.on('error', (error: Error) => {
      this.lastError = error.message;
    });
    this.subscriber.on('ready', () => {
      // 连接恢复（含自动重连）后补一次订阅。
      void this.ensureSubscribed();
    });
    this.subscriber.on('message', (receivedChannel: string, message: string) => {
      if (receivedChannel !== this.channel) return;
      this.applyEvent(message);
    });
  }

  /** 总线是否开启（`RBAC_INVALIDATION_ENABLED=false` 时关闭）。 */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** 生效频道名（已按环境隔离）。 */
  get channelName(): string {
    return this.channel;
  }

  /** 运行状态（测试与排障用）。 */
  get stats(): {
    enabled: boolean;
    channel: string;
    subscribed: boolean;
    published: number;
    received: number;
    lastError?: string;
  } {
    return {
      enabled: this.enabled,
      channel: this.channel,
      subscribed: this.subscribed,
      published: this.publishedCount,
      received: this.receivedCount,
      lastError: this.lastError,
    };
  }

  /** 实例启动时订阅频道。 */
  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn(
        '共享失效总线已关闭（RBAC_INVALIDATION_ENABLED=false）：' +
          '多实例部署时撤权延迟回落到 TTL 上界（≤60 秒）。',
      );
      return;
    }
    await this.ensureSubscribed();
  }

  /** 关闭连接，避免进程无法退出（集成测试 / 优雅停机）。 */
  onModuleDestroy(): void {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    // ⚠️ `disconnect()` 而不是 `quit()`：
    //   `quit()` 会等命令队列排空，若连接从未建立成功就会**挂着不退**。
    this.publisher.disconnect();
    this.subscriber.disconnect();
  }

  /**
   * 发布一条失效事件。
   *
   * ⚠️ **绝不抛错**：Redis 不可用时写操作必须照常成功 ——
   *    失效总线是优化，不是业务依赖（撤权延迟回落到 TTL 上界即可）。
   *
   * @returns 是否真的发出去了（false = 总线不可用，已降级）
   */
  async publish(event: InvalidationEvent): Promise<boolean> {
    if (!this.enabled || this.closed) return false;
    try {
      if (this.publisher.status === 'wait' || this.publisher.status === 'end') {
        await this.publisher.connect();
      }
      await this.withTimeout(
        this.publisher.publish(this.channel, JSON.stringify(event)),
        PUBLISH_TIMEOUT_MS,
      );
      this.publishedCount += 1;
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `失效事件发布失败（${this.channel}）：${this.lastError}。` +
          '已降级：管理端写操作照常成功，撤权延迟回落到 TTL 上界（≤60 秒）。',
      );
      return false;
    }
  }

  /** 订阅频道（幂等）。 */
  private async ensureSubscribed(): Promise<void> {
    if (this.closed || !this.enabled || this.subscribed) return;
    try {
      if (this.subscriber.status === 'wait' || this.subscriber.status === 'end') {
        await this.subscriber.connect();
      }
      // 连接还没就绪 → 等 'ready' 事件再来一次（重连成功会自动触发）。
      if (this.subscriber.status !== 'ready') return;
      await this.subscriber.subscribe(this.channel);
      this.subscribed = true;
      this.logger.log(`已订阅失效频道 ${this.channel}`);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.subscribed = false;
      this.scheduleRetry();
    }
  }

  /** 订阅失败后的定时重试（总线恢复后自动重新订阅）。 */
  private scheduleRetry(): void {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.ensureSubscribed();
    }, SUBSCRIBE_RETRY_MS);
    // `unref()` —— 不因为这个定时器而阻止进程退出（集成测试 / 优雅停机）。
    this.retryTimer.unref?.();
  }

  /**
   * 处理收到的一条失效事件。
   *
   * ⚠️ 只认**白名单**事件：总线是共享通道，
   *    一条畸形的或恶意的消息最多让本实例丢掉缓存（不会放行任何权限）。
   */
  private applyEvent(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isInvalidationEvent(parsed)) return;
    this.receivedCount += 1;
    if (parsed.kind === 'admin') {
      this.cache.delete(CacheKeys.adminRbac(parsed.adminId));
    } else {
      this.cache.deleteByPrefix('rbac:');
    }
  }

  /** 给命令加超时上限：Redis「连得上但很慢」时不能把写操作拖住。 */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`命令超时（${timeoutMs} ms）`)),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
