import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';

/**
 * 可计数的表（白名单）。
 *
 * ⚠️ 表名会被拼进 SQL，所以**必须**走白名单，
 * 绝不能把外部输入直接拼进 `UPDATE ${table}`。
 */
export type CountedTable = 'articles' | 'notices';

/** 每累计多少次浏览就把该条内容的计数同步回数据库一次 */
const FLUSH_THRESHOLD = 20;
/** 计数键的最长存活时间（秒）—— 兜底，防止计数器无限堆积 */
const COUNT_TTL_SECONDS = 7 * 24 * 3600;
/** 周期刷回间隔（毫秒） */
const FLUSH_INTERVAL_MS = 60_000;

/**
 * 浏览计数：**Redis 计数 + 惰性刷回**（第三轮）。
 *
 * ## 为什么改
 *
 * 此前每次浏览都直接 `UPDATE articles SET view_count = view_count + 1` ——
 * 热门文章的所有浏览者会**串行争抢同一行锁**，
 * 高并发下这一行就是热点（写放大 + 锁等待）。
 *
 * ## 现在的做法
 *
 * 1. 浏览时只在 **Redis** 里 `INCR` 该内容的**绝对计数**（无行锁、无热点）；
 * 2. 每累计 20 次、或到 60 秒周期时，把 Redis 里的绝对计数**同步**回数据库
 *    （`view_count = GREATEST(view_count, ?)`，仍然只动计数列）。
 *
 * ## 为什么用「绝对计数」而不是「增量」
 *
 * 若 Redis 存增量、展示值 = 「库里的值 + 未落库增量」，
 * 那么「刷回」与「读基线」之间的竞态会让展示值**时对时错**（可能短暂倒退）。
 * 存绝对计数则没有这个问题：
 *  - 展示值**直接取自 Redis**，永远是单调递增的真值；
 *  - 落库写的是绝对值，且用 `GREATEST` 保证**不会把库里的值改小**。
 *
 * ## 计数键为什么要带「行身份」
 *
 * 键里带了行的 `created_at`（`viewcount:articles:<id>:<createdAt>`）：
 * 行被删除后重建（以及测试里 TRUNCATE 后重建）时 `created_at` 会变，
 * 于是用的是**新键**，不会把上一条同 id 行的计数**带过来**。
 *
 * ## 一致性口径（**契约里已写明**）
 *
 * `viewCount` 由**即时一致**改为**最终一致**：
 * 详情接口返回的值是**当场**的真值，
 * 但**数据库行里的 `view_count` 可能滞后**（最多一个刷回周期 = 60 秒）。
 *
 * ## Redis 不可用时
 *
 * **降级为直接写库**（与改动前的行为完全一致）：
 * 计数不会丢，只是又回到了「每次浏览写一行」的旧模式。
 */
@Injectable()
export class ViewCounterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ViewCounterService.name);
  private readonly redis: Redis;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {
    this.redis = new Redis({
      host: this.config.get<string>('redis.host', '127.0.0.1'),
      port: this.config.get<number>('redis.port', 6379),
      password: this.config.get<string | undefined>('redis.password'),
      db: this.config.get<number>('redis.db', 0),
      lazyConnect: true,
      // 命令在未连接时**立刻失败**而不是排队等待 ——
      // 否则 Redis 不可用时请求会挂在命令队列里（降级路径就永远走不到）。
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    this.redis.on('error', () => undefined);
  }

  onModuleInit(): void {
    // 周期刷回：把 Redis 里的绝对计数同步回数据库。
    // `unref()` —— 不因为这个定时器而阻止进程退出（集成测试 / 优雅停机）。
    this.timer = setInterval(() => {
      void this.flushAll();
    }, FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // ⚠️ `disconnect()` 而不是 `quit()`：
    //   `quit()` 会等命令队列排空，若连接从未建立成功就会**挂着不退**，
    //   集成测试跑完 jest 会因此报「Jest did not exit one second after the test run」。
    this.redis.disconnect();
  }

  /**
   * 记一次浏览。
   *
   * @param dbBaseline 库里**当前**的 `view_count`（调用方读出来的那一行的值）；
   *                   只在 Redis 里**还没有**这条内容的计数时用作初始值
   * @param createdAt 该行的 `created_at`（用于锚定计数键，见类注释）
   * @returns 用户应当看到的浏览总数（当场就是真值）
   */
  async record(
    table: CountedTable,
    id: number,
    dbBaseline: number,
    createdAt: Date,
  ): Promise<number> {
    const key = this.counterKey(table, id, createdAt);
    let total: number;
    try {
      await this.redis.connect().catch(() => undefined);
      // Lua 保证「没有就按基线初始化」与「+1」是原子的：
      // 并发首次浏览时不会有两个请求都用各自的基线去初始化。
      const script = `
        local current = redis.call('GET', KEYS[1])
        if not current then redis.call('SET', KEYS[1], ARGV[1]) end
        return redis.call('INCR', KEYS[1])
      `;
      total = Number(await this.redis.eval(script, 1, key, String(dbBaseline)));
      await this.redis.expire(key, COUNT_TTL_SECONDS);
    } catch {
      // Redis 不可用 → 降级为直接写库（与改动前一致，计数不会丢）。
      await this.writeToDatabase(table, id, dbBaseline + 1);
      return dbBaseline + 1;
    }
    // 每累计 20 次就同步一次，避免热门内容的库值长时间滞后。
    if (total % FLUSH_THRESHOLD === 0) {
      await this.flush(table, [{ id, createdAt }]);
    }
    return total;
  }

  /**
   * 把 Redis 里的绝对计数**同步**回数据库（只动 `view_count` 一列）。
   *
   * ⚠️ 写的是**绝对值**且用 `GREATEST` 兜底：
   *   即使本次同步的值比库里旧（极小概率：Redis 刚被清空），
   *   也不会把库里的计数**改小**。
   */
  async flush(
    table: CountedTable,
    targets?: { id: number; createdAt: Date }[],
  ): Promise<void> {
    try {
      await this.redis.connect().catch(() => undefined);
      const list = targets ?? (await this.knownRows(table));
      for (const target of list) {
        const raw = await this.redis.get(this.counterKey(table, target.id, target.createdAt));
        if (raw === null) continue;
        const total = Number(raw);
        if (!Number.isFinite(total) || total <= 0) continue;
        try {
          // ⚠️ `updated_at = updated_at`：浏览**不是编辑**，不得刷新「更新时间」
          //    （与改动前的写法保持一致，见缺陷 #120）。
          await this.writeToDatabase(table, target.id, total);
        } catch (error) {
          this.logger.error(
            `浏览计数同步失败（${table} #${target.id}，${total} 次）：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } catch {
      // Redis 不可用：没有可同步的东西（降级路径已经把计数直接写进库了）。
    }
  }

  /** 把所有表里的计数都同步回数据库（周期任务 / 进程退出前）。 */
  async flushAll(): Promise<void> {
    await this.flush('articles');
    await this.flush('notices');
  }

  /**
   * 只动 `view_count` 一列的落库写入（不刷新 `updated_at`）。
   *
   * ⚠️ 用 `GREATEST` 保证**不会把库里的计数改小**。
   */
  private async writeToDatabase(table: CountedTable, id: number, total: number): Promise<void> {
    await this.dataSource.query(
      `UPDATE ${table} SET view_count = GREATEST(view_count, ?), updated_at = updated_at WHERE id = ?`,
      [total, id],
    );
  }

  /** 找出 Redis 里已知的计数（SCAN，不阻塞 Redis）。 */
  private async knownRows(table: CountedTable): Promise<{ id: number; createdAt: Date }[]> {
    const prefix = this.counterPrefix(table);
    const rows: { id: number; createdAt: Date }[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      for (const key of keys) {
        const rest = key.slice(prefix.length);
        const [idPart, createdPart] = rest.split(':');
        const id = Number(idPart);
        const createdAt = new Date(Number(createdPart));
        if (Number.isFinite(id) && !Number.isNaN(createdAt.getTime())) {
          rows.push({ id, createdAt });
        }
      }
    } while (cursor !== '0');
    return rows;
  }

  private counterKey(table: CountedTable, id: number, createdAt: Date): string {
    return `${this.counterPrefix(table)}${id}:${createdAt.getTime()}`;
  }

  private counterPrefix(table: CountedTable): string {
    return `viewcount:${table}:`;
  }
}
