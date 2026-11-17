import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import mysql from 'mysql2/promise';

import {
  MAX_DELIVERY_ATTEMPTS,
  dispatchPending,
  markDeliveryFailed,
  markRetry,
  processOutboxJob,
  recordDeliveryFailure,
} from './outbox';

/**
 * Worker 进程：消费 Outbox 事件并投递站内通知。
 * 与 API 同仓库、不同运行进程（top.md §2.2）。
 * 直接使用 SQL，避免与 API 包产生构建期耦合。
 *
 * 真正的业务逻辑放在 `outbox.ts`（可被容器内自检脚本完整执行），
 * 本文件只负责「接线」：Redis 连接、队列、定时扫描、进程生命周期。
 */
const REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const REDIS_DB = Number(process.env.REDIS_DB ?? 0);
const QUEUE_NAME = process.env.OUTBOX_QUEUE ?? 'nmg-outbox';
const DISPATCH_INTERVAL_MS = Number(process.env.DISPATCH_INTERVAL_MS ?? 2000);
const RETRY_BACKOFF_SECONDS = Number(process.env.RETRY_BACKOFF_SECONDS ?? 30);
const MAX_ATTEMPTS = Number(process.env.MAX_DELIVERY_ATTEMPTS ?? MAX_DELIVERY_ATTEMPTS);

async function main(): Promise<void> {
  const connection = new IORedis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASSWORD,
    db: REDIS_DB,
    maxRetriesPerRequest: null,
  });

  const pool = mysql.createPool({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'nmg',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'nmg_pku_alumni',
    connectionLimit: 10,
    timezone: 'Z',
  });

  const queue = new Queue(QUEUE_NAME, { connection });

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const data = job.data as { outboxId: number; notificationId: number };
      const conn = await pool.getConnection();
      try {
        // 投递记录更新不到 1 行时抛错 → 事务回滚 → 事件不会被标记为 done
        await processOutboxJob(conn, data);
      } finally {
        conn.release();
      }
    },
    { connection, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 8) },
  );

  worker.on('completed', (job) => {
    // eslint-disable-next-line no-console
    console.log(`[worker] outbox job ${job.id} done`);
  });

  worker.on('failed', async (job, error) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] outbox job ${job?.id} failed: ${error.message}`);
    const outboxId = job?.data?.outboxId as number | undefined;
    const notificationId = job?.data?.notificationId as number | undefined;
    if (!outboxId) {
      return;
    }
    // ⚠️ 失败必须**留痕**（缺陷 #100）：修复前投递记录一行都没被更新过，
    //    失败多少次、为什么失败，在数据库里完全看不出来。
    if (notificationId) {
      await recordDeliveryFailure(pool, notificationId, error.message);
    }
    // ⚠️ markRetry 会让 attempts 递增 —— jobId 里带着 attempts，
    //    attempts 不变的话 dispatcher 的下一次 add 会被 BullMQ 当成重复任务忽略，
    //    这条通知就**永远**投不出去了（缺陷 #95）。
    const outcome = await markRetry(pool, outboxId, MAX_ATTEMPTS, RETRY_BACKOFF_SECONDS);
    if (outcome === 'failed') {
      // 超过重试上限：投递记录标记为 failed（这个 ENUM 值修复前从未被使用过）
      if (notificationId) {
        await markDeliveryFailed(pool, notificationId, error.message);
      }
      // eslint-disable-next-line no-console
      console.error(`[worker] outbox event ${outboxId} 超过重试上限，标记为 failed`);
    }
  });

  /**
   * Outbox 派发器：把数据库中的待发送事件投递到 Redis 队列。
   * 数据库是唯一事实来源，Redis 只做队列（符合 top.md §6.3）。
   */
  const dispatcher = setInterval(async () => {
    try {
      const { enqueued, skipped } = await dispatchPending(queue, pool);
      if (enqueued > 0 || skipped > 0) {
        // eslint-disable-next-line no-console
        console.log(`[worker] dispatch enqueued=${enqueued} skipped=${skipped}`);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[worker] dispatch failed:', (error as Error).message);
    }
  }, DISPATCH_INTERVAL_MS);

  dispatcher.unref();

  // eslint-disable-next-line no-console
  console.log(`[worker] listening queue=${QUEUE_NAME}`);
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[worker] fatal', error);
  process.exit(1);
});
