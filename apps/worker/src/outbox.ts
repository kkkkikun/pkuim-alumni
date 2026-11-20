
/**
 * Outbox 派发与投递的核心逻辑（可单测）。
 *
 * 与 `index.ts` 的区别：这里不碰 Redis 连接、不起定时器、不打日志，
 * 只做「该做什么」，因此可以在**测试库 + 测试队列**里被完整执行一遍。
 *
 * 本文件修掉的三个静默失败（见 docs/KNOWN-ISSUES.md #95 ~ #97）：
 *   #95 失败后重投被 BullMQ 的 jobId 去重吞掉 → 通知**永远**投不出去；
 *   #96 投递记录没更新（0 行）也照样标记 done → 消息静默丢失；
 *   #97 payload 里没有 notificationId 的事件永远卡在 pending，
 *        被 dispatcher 每 2 秒重复扫描一次。
 */

/** 单个事件最多重试次数（超过则标记为 failed，不再无限重试） */
export const MAX_DELIVERY_ATTEMPTS = 10;

/* ------------------------------ 类型 ------------------------------ */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 说明：这里的接口刻意用 `any` 描述 SQL 返回值 ——
 * mysql2 的 `execute` 有多组重载（ResultSetHeader / OkPacket / RowDataPacket[]），
 * 一旦在接口里写死具体形状，真实连接对象反而**不满足**这个接口。
 * 真正用到的字段只有两个：`affectedRows`（受影响行数）与 `insertId`（自增主键），
 * 取用处一律显式收窄类型。
 */
export interface ConnLike {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
  execute(sql: string, values?: any): Promise<[any, any]>;
}

export interface PoolLike {
  query(sql: string, values?: any): Promise<[any, any]>;
  execute(sql: string, values?: any): Promise<[any, any]>;
  getConnection(): Promise<ConnLike>;
}

export interface QueueLike {
  add(
    name: string,
    data: unknown,
    opts?: { jobId?: string; removeOnComplete?: number; removeOnFail?: number },
  ): Promise<unknown>;
}

export interface OutboxRow {
  id: number;
  attempts: number;
  payload: { notificationId?: number } | null;
}

/** 派发结果 */
export type RetryOutcome = 'retry' | 'failed' | 'terminal';

/* ------------------------------ 核心逻辑 ------------------------------ */

/**
 * 任务 id：**必须带 attempts**。
 *
 * ⚠️ BullMQ 对**相同 jobId** 的 `add` 会**直接忽略**（实测：任务失败后，
 * 队列里 failed 计数不变，第二次 add 什么都没发生）。
 * 如果 jobId 只用 outboxId，失败后 dispatcher 再投一次时会被去重吞掉
 * → 该通知**永远**不会再投递，而且控制台不会报任何错。
 *
 * 带上 attempts 之后：同一 attempts 的重复投递仍被去重（防重复消费），
 * 失败后 attempts 递增 → jobId 变化 → 重投能真正进队列。
 */
export function buildJobId(outboxId: number, attempts: number): string {
  return `outbox-${outboxId}-a${attempts}`;
}

/**
 * 扫描待派发事件并投递到队列。
 *
 * @returns enqueued = 入队数；skipped = 标记为 failed 的无效事件数
 */
export async function dispatchPending(
  queue: QueueLike,
  pool: PoolLike,
  limit = 50,
): Promise<{ enqueued: number; skipped: number }> {
  // LIMIT 用**内联整数**而不是占位符：mysql2 的文本协议会把 ? 转义成字符串
  // 字面量（LIMIT '50'），不同 MySQL 版本对这种写法行为不一致。
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 50;
  const [rows] = await pool.query(
    `SELECT id, attempts, payload FROM outbox_events
       WHERE status = 'pending' AND available_at <= NOW(3)
       ORDER BY id ASC LIMIT ${safeLimit}`,
  );
  let enqueued = 0;
  let skipped = 0;
  for (const row of rows as OutboxRow[]) {
    const notificationId = row.payload?.notificationId;
    if (!notificationId) {
      // 没有 notificationId → worker 根本不知道该给谁发，
      // 留在 pending 会被 dispatcher 每 2 秒重复扫描一次（永远卡住）。
      // 明确标记为 failed，让它可见、可查。
      await pool.execute(
        "UPDATE outbox_events SET status = 'failed', processed_at = NOW(3) WHERE id = ? AND status = 'pending'",
        [row.id],
      );
      skipped += 1;
      continue;
    }
    await queue.add(
      'outbox',
      { outboxId: row.id, notificationId },
      {
        jobId: buildJobId(row.id, row.attempts),
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
    enqueued += 1;
  }
  return { enqueued, skipped };
}

/**
 * 消费一个 outbox 事件：标记 processing → 更新投递记录 → 标记 done。
 *
 * ⚠️ 投递记录必须**恰好更新 1 行**：更新 0 行说明记录不存在或已被改过，
 * 此时若继续标记 done，消息就静默丢了（用户永远收不到，也没有任何报错）。
 */
export async function processOutboxJob(
  conn: ConnLike,
  data: { outboxId: number; notificationId: number },
): Promise<void> {
  await conn.beginTransaction();
  try {
    const [claimed] = await conn.execute(
      "UPDATE outbox_events SET status = ?, attempts = attempts + 1 WHERE id = ? AND status = 'pending'",
      ['processing', data.outboxId],
    );
    if (!claimed || claimed.affectedRows !== 1) {
      // 事件已不是 pending（已被别的 worker 处理完 / 已终态）→
      // 绝不能重复投递，否则用户会收到两条一样的通知。
      throw new Error(`Outbox 事件 ${data.outboxId} 已不在 pending 状态，拒绝重复投递`);
    }
    const [result] = await conn.execute(
      "UPDATE notification_deliveries SET status = 'sent', sent_at = NOW(3), attempts = attempts + 1, last_error = NULL WHERE notification_id = ? AND channel = 'inapp'",
      [data.notificationId],
    );
    if (!result || result.affectedRows !== 1) {
      throw new Error(
        `投递记录缺失或已变更（notification_id=${data.notificationId}），拒绝标记为已送达`,
      );
    }
    await conn.execute(
      'UPDATE outbox_events SET status = ?, processed_at = NOW(3) WHERE id = ?',
      ['done', data.outboxId],
    );
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  }
}

/**
 * 记录一次投递失败：递增尝试次数并写下失败原因。
 *
 * ⚠️ 修复前（缺陷 #100）：投递失败时 `notification_deliveries` **一行都没被更新过** ——
 *   `status` 永远是 'pending'、`attempts` 永远是 0、`last_error` 永远是 NULL。
 *   运维看到的只是一条「还在排队中」的投递记录，
 *   完全看不出它已经失败过多少次、为什么失败 —— 失败被彻底吞掉了。
 *
 * 只更新**尚未送达**（status <> 'sent'）的记录：
 * 已经送达的投递不能因为后续的重复投递失败而被改成失败状态。
 *
 * @param notificationId 出错的通知
 * @param errorMessage 失败原因（写入前截断到 500 字符，与列宽一致）
 */
export async function recordDeliveryFailure(
  pool: PoolLike,
  notificationId: number,
  errorMessage: string,
): Promise<void> {
  const message = String(errorMessage ?? '').slice(0, 500);
  await pool.execute(
    `UPDATE notification_deliveries
        SET attempts = attempts + 1, last_error = ?
      WHERE notification_id = ? AND status <> 'sent'`,
    [message, notificationId],
  );
}

/**
 * 投递彻底失败（超过重试上限）：把投递记录标记为 `failed`。
 *
 * `notification_deliveries.status` 的 ENUM 里一直有 'failed' 这个值，
 * 但修复前**整个代码里从未使用过它** —— 投递失败与投递排队中在数据库里长得一模一样。
 *
 * @returns 受影响行数（0 = 该通知没有可标记的投递记录）
 */
export async function markDeliveryFailed(
  pool: PoolLike,
  notificationId: number,
  errorMessage: string,
): Promise<number> {
  const message = String(errorMessage ?? '').slice(0, 500);
  const [result] = await pool.execute(
    `UPDATE notification_deliveries
        SET status = 'failed', last_error = ?
      WHERE notification_id = ? AND status <> 'sent'`,
    [message, notificationId],
  );
  return result?.affectedRows ?? 0;
}

/**
 * 消费失败后的回退：把事件放回 pending，稍后重投。
 *
 * ⚠️ 必须 `attempts + 1`：jobId 里带着 attempts，
 * attempts 不变 → dispatcher 再次 `add` 时 jobId 相同 → BullMQ 直接忽略
 * → **永远不再重试**（缺陷 #95）。
 *
 * ⚠️ 只处理 `status = 'pending'` 的行：已经是 done / failed 的终态事件
 * 不能被这条兜底语句改回 pending（否则会造成「已送达的通知被重复投递」）。
 *
 * @param backoffSeconds 重投前等待的秒数（0 = 立即可被 dispatcher 捞走）
 * @returns 'retry' = 已重新排队；'failed' = 超过重试上限，标记为失败；
 *          'terminal' = 事件已是终态（done / failed），不做任何改动
 */
export async function markRetry(
  pool: PoolLike,
  outboxId: number,
  maxAttempts = MAX_DELIVERY_ATTEMPTS,
  backoffSeconds = 0,
): Promise<RetryOutcome> {
  const delay = Number.isFinite(backoffSeconds) && backoffSeconds > 0 ? Math.floor(backoffSeconds) : 0;
  const [result] = await pool.execute(
    `UPDATE outbox_events
        SET status = 'pending', attempts = attempts + 1, available_at = NOW(3) + INTERVAL ${delay} SECOND
      WHERE id = ? AND status = 'pending' AND attempts < ?`,
    [outboxId, maxAttempts],
  );
  const affected = result?.affectedRows ?? 0;
  if (affected === 1) {
    return 'retry';
  }

  // 没有被更新：要么已超过重试上限，要么事件已是终态。
  const [rows] = await pool.query(
    'SELECT status, attempts FROM outbox_events WHERE id = ?',
    [outboxId],
  );
  const row = (rows as { status?: string; attempts?: number }[])[0];
  if (!row || row.status === 'done' || row.status === 'failed') {
    // 已是终态 → 什么都不做（避免把已送达的事件改回 pending 造成重复投递）
    return 'terminal';
  }
  // 超过重试上限 → 明确标记 failed，让它可见、可查，不再无限重试
  await pool.execute(
    "UPDATE outbox_events SET status = 'failed', processed_at = NOW(3) WHERE id = ? AND status = 'pending'",
    [outboxId],
  );
  return 'failed';
}
