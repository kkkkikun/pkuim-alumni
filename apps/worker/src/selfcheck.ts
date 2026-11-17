/**
 * Worker 自检脚本（容器内运行）。
 *
 * 在**测试库 + 测试 Redis（db=1）+ 独立队列名**下，真实地跑一遍
 * 「派发 → 消费 → 投递 → 重试 → 终态」全链路，把三个静默失败钉死：
 *
 *   #95 BullMQ 对**相同 jobId** 的 add 直接忽略 → 失败后重投被吞掉
 *        → 该通知**永远**投不出去，而且控制台不报任何错；
 *   #96 投递记录没更新（affectedRows = 0）也照样把 outbox 标记 done
 *        → 消息静默丢失；
 *   #97 payload 里没有 notificationId 的事件永远卡在 pending
 *        → 被 dispatcher 每 2 秒重复扫描一次。
 *
 * 安全约束：
 *   1) 库名必须包含 'test'，否则拒绝执行（绝不碰业务库）；
 *   2) 使用独立队列名，不与生产队列 `nmg-outbox` 混用；
 *   3) 自建数据用固定标记（openid / title），结束时清理干净。
 *
 * 运行方式（worker 容器内）：
 *   docker compose exec -T -e DB_NAME=nmg_alumni_test -e REDIS_DB=1 \
 *     worker node dist/selfcheck.js
 */
import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import mysql from 'mysql2/promise';

import {
  MAX_DELIVERY_ATTEMPTS,
  buildJobId,
  dispatchPending,
  markDeliveryFailed,
  markRetry,
  processOutboxJob,
  recordDeliveryFailure,
  type ConnLike,
  type PoolLike,
} from './outbox';

/* ------------------------------ 环境 ------------------------------ */

const DB_NAME = process.env.DB_NAME ?? '';
const REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const REDIS_DB = Number(process.env.REDIS_DB ?? 1);
const QUEUE_NAME = process.env.SELFCHECK_QUEUE ?? 'nmg-outbox-selftest';
const PROBE_QUEUE_NAME = `${QUEUE_NAME}-probe`;
const USER_OPENID = 'nmg_selfcheck_user';
const NOTIFICATION_TITLE = 'worker-selfcheck';

/* ------------------------------ 断言 ------------------------------ */

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    // eslint-disable-next-line no-console
    console.log(`  ✅ ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    failed += 1;
    // eslint-disable-next-line no-console
    console.error(`  ❌ ${name}${detail ? `  (${detail})` : ''}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 15000,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await sleep(intervalMs);
  }
  return false;
}

/* ------------------------------ 主流程 ------------------------------ */

async function main(): Promise<void> {
  if (!/test/i.test(DB_NAME)) {
    // eslint-disable-next-line no-console
    console.error(`[selfcheck] 拒绝执行：库名必须包含 'test'，当前为 '${DB_NAME}'`);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(`[selfcheck] db=${DB_NAME} redis_db=${REDIS_DB} queue=${QUEUE_NAME}`);

  const queueConnection = new IORedis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASSWORD,
    db: REDIS_DB,
    maxRetriesPerRequest: null,
  });
  const workerConnection = new IORedis({
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
    database: DB_NAME,
    connectionLimit: 4,
    timezone: 'Z',
  });
  const poolLike = pool as unknown as PoolLike;

  const queue = new Queue(QUEUE_NAME, { connection: queueConnection });
  await queue.obliterate({ force: true });

  // 记录 worker 的每一次消费 —— 「重投有没有真的发生」只能靠它证明
  const consumed: number[] = [];
  const failedJobs: number[] = [];

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const data = job.data as { outboxId: number; notificationId: number };
      consumed.push(data.outboxId);
      const conn = await pool.getConnection();
      try {
        await processOutboxJob(conn as unknown as ConnLike, data);
      } finally {
        conn.release();
      }
    },
    { connection: workerConnection, concurrency: 1 },
  );

  worker.on('failed', async (job, error) => {
    const outboxId = job?.data?.outboxId as number | undefined;
    const notificationId = job?.data?.notificationId as number | undefined;
    // eslint-disable-next-line no-console
    console.error(`[selfcheck] job ${job?.id} failed: ${error.message}`);
    if (outboxId) {
      failedJobs.push(outboxId);
      // 与生产一致：失败必须留痕（缺陷 #100）
      if (notificationId) {
        await recordDeliveryFailure(poolLike, notificationId, error.message);
      }
      const outcome = await markRetry(poolLike, outboxId, MAX_DELIVERY_ATTEMPTS, 0);
      if (outcome === 'failed' && notificationId) {
        await markDeliveryFailed(poolLike, notificationId, error.message);
      }
    }
  });

  const conn = await pool.getConnection();

  /* ---------- 数据准备辅助 ---------- */

  const cleanup = async (): Promise<void> => {
    await conn.execute(
      "DELETE FROM outbox_events WHERE aggregate_type = 'notification' AND aggregate_id = 'selfcheck'",
    );
    await conn.execute(
      `DELETE FROM notification_deliveries
        WHERE notification_id IN (SELECT id FROM notifications WHERE title = ?)`,
      [NOTIFICATION_TITLE],
    );
    await conn.execute('DELETE FROM notifications WHERE title = ?', [NOTIFICATION_TITLE]);
    await conn.execute('DELETE FROM users WHERE openid = ?', [USER_OPENID]);
  };

  const ensureUser = async (): Promise<number> => {
    await conn.execute(
      'INSERT INTO users (openid, nickname) VALUES (?, ?) ON DUPLICATE KEY UPDATE nickname = VALUES(nickname)',
      [USER_OPENID, 'worker-selfcheck'],
    );
    const [rows] = await conn.query('SELECT id FROM users WHERE openid = ?', [USER_OPENID]);
    return (rows as { id: number }[])[0].id;
  };

  const createNotification = async (userId: number): Promise<number> => {
    const [raw] = await conn.execute(
      `INSERT INTO notifications (user_id, type, title, body, payload)
       VALUES (?, 'system', ?, ?, ?)`,
      [userId, NOTIFICATION_TITLE, 'selfcheck', JSON.stringify({ probe: 'selfcheck' })],
    );
    return (raw as unknown as { insertId: number }).insertId;
  };

  const createDelivery = async (notificationId: number): Promise<void> => {
    await conn.execute(
      "INSERT INTO notification_deliveries (notification_id, channel, status) VALUES (?, 'inapp', 'pending')",
      [notificationId],
    );
  };

  const createOutbox = async (options: {
    notificationId?: number;
    payload?: unknown;
    attempts?: number;
  }): Promise<number> => {
    const payload =
      options.payload !== undefined
        ? options.payload
        : options.notificationId !== undefined
          ? { notificationId: options.notificationId }
          : {};
    const [raw] = await conn.execute(
      `INSERT INTO outbox_events
         (aggregate_type, aggregate_id, event_type, payload, status, attempts, available_at)
       VALUES ('notification', 'selfcheck', 'notification.selfcheck', ?, 'pending', ?, NOW(3))`,
      [JSON.stringify(payload), options.attempts ?? 0],
    );
    return (raw as unknown as { insertId: number }).insertId;
  };

  const outboxState = async (
    id: number,
  ): Promise<{ status: string; attempts: number } | undefined> => {
    const [rows] = await conn.query(
      'SELECT status, attempts FROM outbox_events WHERE id = ?',
      [id],
    );
    return (rows as { status: string; attempts: number }[])[0];
  };

  const deliveryState = async (
    notificationId: number,
  ): Promise<{ status: string; attempts: number; lastError: string | null } | undefined> => {
    const [rows] = await conn.query(
      `SELECT status, attempts, last_error FROM notification_deliveries
        WHERE notification_id = ? AND channel = 'inapp'`,
      [notificationId],
    );
    const row = (rows as { status: string; attempts: number; last_error: string | null }[])[0];
    return row
      ? { status: row.status, attempts: Number(row.attempts), lastError: row.last_error }
      : undefined;
  };

  /** 任意通道的投递记录（用于「只有 wechat 通道」的边界场景）。 */
  const deliveryStateAnyChannel = async (
    notificationId: number,
  ): Promise<{ status: string; attempts: number; lastError: string | null } | undefined> => {
    const [rows] = await conn.query(
      `SELECT status, attempts, last_error FROM notification_deliveries
        WHERE notification_id = ? ORDER BY id ASC LIMIT 1`,
      [notificationId],
    );
    const row = (rows as { status: string; attempts: number; last_error: string | null }[])[0];
    return row
      ? { status: row.status, attempts: Number(row.attempts), lastError: row.last_error }
      : undefined;
  };

  const deliveryCount = async (notificationId: number): Promise<number> => {
    const [rows] = await conn.query(
      'SELECT COUNT(*) AS c FROM notification_deliveries WHERE notification_id = ?',
      [notificationId],
    );
    return Number((rows as { c: number }[])[0].c);
  };

  try {
    await cleanup();
    const userId = await ensureUser();

    /* ---------- T0 元自检：BullMQ 同 jobId 的第二次 add 确实会被忽略 ---------- */
    // 这是缺陷 #95 的成因。先证明它成立，后面的断言才有意义 ——
    // 否则「重投能成功」可能只是因为 BullMQ 恰好不���重。
    // eslint-disable-next-line no-console
    console.log('\n[T0] 元自检：BullMQ jobId 去重行为');
    const probe = new Queue(PROBE_QUEUE_NAME, { connection: queueConnection });
    await probe.obliterate({ force: true });
    await probe.add('probe', { n: 1 }, { jobId: 'dedup-probe' });
    const count1 = await probe.getWaitingCount();
    await probe.add('probe', { n: 1 }, { jobId: 'dedup-probe' });
    const count2 = await probe.getWaitingCount();
    check(
      '同 jobId 的第二次 add 被 BullMQ 忽略（缺陷 #95 的成因确实存在）',
      count1 === 1 && count2 === 1,
      `第一次后=${count1} 第二次后=${count2}`,
    );
    await probe.obliterate({ force: true });
    await probe.close();

    /* ---------- T1 正常路径：pending → 派发 → 消费 → sent + done ---------- */
    // eslint-disable-next-line no-console
    console.log('\n[T1] 正常路径');
    const nid1 = await createNotification(userId);
    await createDelivery(nid1);
    const oid1 = await createOutbox({ notificationId: nid1 });
    const dispatched = await dispatchPending(queue, poolLike);
    check('dispatchPending 把 pending 事件投进队列', dispatched.enqueued >= 1, `enqueued=${dispatched.enqueued}`);
    const doneOk = await waitFor(async () => (await outboxState(oid1))?.status === 'done');
    check('正常路径：outbox 最终为 done', doneOk, `status=${(await outboxState(oid1))?.status}`);
    check(
      '正常路径：投递记录为 sent',
      (await deliveryState(nid1))?.status === 'sent',
      `status=${(await deliveryState(nid1))?.status}`,
    );
    check('正常路径：worker 确实消费了该事件', consumed.includes(oid1));

    /* ---------- T2 缺陷 #96：投递记录缺失 → 必须失败，不得标记 done ---------- */
    // eslint-disable-next-line no-console
    console.log('\n[T2] 缺陷 #96：投递记录缺失不得被静默标记为已送达');
    const nid2 = await createNotification(userId);
    // 故意不创建 notification_deliveries 行
    const oid2 = await createOutbox({ notificationId: nid2 });
    await dispatchPending(queue, poolLike);
    const failedSeen = await waitFor(async () => failedJobs.includes(oid2));
    check('投递记录缺失 → 任务被判定为失败', failedSeen);
    const state2 = await outboxState(oid2);
    check('失败的事件不得被标记为 done', state2?.status !== 'done', `status=${state2?.status}`);
    check('投递记录条数仍为 0（没有被凭空标记 sent）', (await deliveryCount(nid2)) === 0);
    check('失败后 attempts 已递增（重试状态在推进）', (state2?.attempts ?? 0) >= 1, `attempts=${state2?.attempts}`);

    /* ---------- T2b 缺陷 #100：投递失败必须在投递记录上留痕 ---------- */
    // 修复前：投递失败时 `notification_deliveries` 一行都没被更新过 ——
    //   status 永远 'pending'、attempts 永远 0、last_error 永远 NULL。
    //   运维看到的是一条「还在排队中」的记录，完全看不出它失败过。
    // eslint-disable-next-line no-console
    console.log('\n[T2b] 缺陷 #100：投递失败必须在投递记录上留痕');
    const nidDup = await createNotification(userId);
    await createDelivery(nidDup);
    const oidDup = await createOutbox({ notificationId: nidDup });
    // 事件已被处理过（模拟重复投递 / 迟到的 job）→ 认领必然失败
    await conn.execute("UPDATE outbox_events SET status = 'done' WHERE id = ?", [oidDup]);
    await queue.add(
      'outbox',
      { outboxId: oidDup, notificationId: nidDup },
      { jobId: buildJobId(oidDup, 0) },
    );
    const dupFailed = await waitFor(async () => failedJobs.includes(oidDup));
    check('事件已是终态 → 该次投递被判定为失败', dupFailed);
    const dupDelivery = await deliveryState(nidDup);
    check(
      '投递失败 → 投递记录的 attempts 递增（不再是永远的 0）',
      (dupDelivery?.attempts ?? 0) >= 1,
      `attempts=${dupDelivery?.attempts}`,
    );
    check(
      '投递失败 → 投递记录写下失败原因（last_error 不再是 NULL）',
      Boolean(dupDelivery?.lastError),
      `last_error=${dupDelivery?.lastError ?? 'null'}`,
    );
    check(
      '投递失败 → 未送达的投递不得被标成 sent',
      dupDelivery?.status !== 'sent',
      `status=${dupDelivery?.status}`,
    );
    check(
      '终态事件未被回退成 pending',
      (await outboxState(oidDup))?.status === 'done',
      `status=${(await outboxState(oidDup))?.status}`,
    );

    /* ---------- T3 缺陷 #95：失败后重投必须真的进队列并被消费 ---------- */
    // eslint-disable-next-line no-console
    console.log('\n[T3] 缺陷 #95：失败后重投不能被 jobId 去重吞掉');
    const consumedBefore = consumed.filter((id) => id === oid2).length;
    check('第一轮：失败事件只被消费过 1 次', consumedBefore === 1, `count=${consumedBefore}`);
    const jobId1 = buildJobId(oid2, 0);
    const jobId2 = buildJobId(oid2, 1);
    check('重投的 jobId 与首次不同（attempts 参与 jobId）', jobId1 !== jobId2, `${jobId1} → ${jobId2}`);
    await dispatchPending(queue, poolLike);
    const retried = await waitFor(
      async () => consumed.filter((id) => id === oid2).length >= 2,
      15000,
    );
    check(
      '失败后重投真的再次进入队列并被消费（不再被去重吞掉）',
      retried,
      `consumed=${consumed.filter((id) => id === oid2).length}`,
    );
    const state3 = await outboxState(oid2);
    check('重投后 attempts 继续递增', (state3?.attempts ?? 0) >= 2, `attempts=${state3?.attempts}`);

    /* ---------- T4 缺陷 #97：无 notificationId 的事件不得永远卡在 pending ---------- */
    // eslint-disable-next-line no-console
    console.log('\n[T4] 缺陷 #97：payload 缺 notificationId 的事件');
    const oid3 = await createOutbox({ payload: { foo: 'bar' } });
    const dispatched4 = await dispatchPending(queue, poolLike);
    check('无效 payload 的事件被跳过（不计入入队）', dispatched4.skipped >= 1, `skipped=${dispatched4.skipped}`);
    check(
      '无效 payload 的事件被标记为 failed（不再永远卡在 pending）',
      (await outboxState(oid3))?.status === 'failed',
      `status=${(await outboxState(oid3))?.status}`,
    );
    check('无效 payload 的事件从未被投递', !consumed.includes(oid3));

    /* ---------- T5 重试上限 ---------- */
    // eslint-disable-next-line no-console
    console.log('\n[T5] 重试上限');
    const oid4 = await createOutbox({ notificationId: nid1, attempts: MAX_DELIVERY_ATTEMPTS });
    const outcome5 = await markRetry(poolLike, oid4, MAX_DELIVERY_ATTEMPTS, 0);
    check('超过重试上限 → 不再重试', outcome5 === 'failed', `outcome=${outcome5}`);
    check(
      '超过重试上限 → 事件被标记为 failed（可见、可查）',
      (await outboxState(oid4))?.status === 'failed',
      `status=${(await outboxState(oid4))?.status}`,
    );

    /* ---------- T5b 缺陷 #100：超过重试上限 → 投递记录必须标 failed ---------- */
    // eslint-disable-next-line no-console
    console.log('\n[T5b] 缺陷 #100：超过重试上限后投递记录标记为 failed');
    const nidGave = await createNotification(userId);
    // 只有 wechat 通道的投递记录 → inapp 投递必然更新不到 → 触发失败
    await conn.execute(
      "INSERT INTO notification_deliveries (notification_id, channel, status) VALUES (?, 'wechat', 'pending')",
      [nidGave],
    );
    const oidGave = await createOutbox({
      notificationId: nidGave,
      attempts: MAX_DELIVERY_ATTEMPTS,
    });
    await queue.add(
      'outbox',
      { outboxId: oidGave, notificationId: nidGave },
      { jobId: buildJobId(oidGave, MAX_DELIVERY_ATTEMPTS) },
    );
    const gaveFailed = await waitFor(
      async () => (await outboxState(oidGave))?.status === 'failed',
    );
    check('超过重试上限 → 事件被标记为 failed', gaveFailed);
    const gaveDelivery = await deliveryStateAnyChannel(nidGave);
    check(
      "超过重试上限 → 投递记录的 status='failed'（这个枚举值修复前从未被使用过）",
      gaveDelivery?.status === 'failed',
      `status=${gaveDelivery?.status}`,
    );
    check(
      '超过重试上限 → 投递记录留下失败原因',
      Boolean(gaveDelivery?.lastError),
      `last_error=${gaveDelivery?.lastError ?? 'null'}`,
    );

    /* ---------- T6 终态保护：已 done 的事件不得被回退成 pending ---------- */
    // eslint-disable-next-line no-console
    console.log('\n[T6] 终态保护');
    const outcome6 = await markRetry(poolLike, oid1, MAX_DELIVERY_ATTEMPTS, 0);
    check('已 done 的事件走回退路径时不做任何改动', outcome6 === 'terminal', `outcome=${outcome6}`);
    check(
      '已 done 的事件没有被改回 pending（防重复投递）',
      (await outboxState(oid1))?.status === 'done',
      `status=${(await outboxState(oid1))?.status}`,
    );

    /* ---------- T7 反向验证：旧实现确实会静默失败 --------------------------- */
    // 这里**复刻修复前**的实现，用同一份测试数据再跑一遍，
    // 断言「旧实现会失败、新实现会拦住」。
    // 少了这一段，就无法区分「我们修好了」和「这个场景本来就不会出事」。
    // eslint-disable-next-line no-console
    console.log('\n[T7] 反向验证：修复前的实现确实会静默失败');

    const legacyProcess = async (
      c: ConnLike,
      outboxId: number,
      notificationId: number,
    ): Promise<void> => {
      await c.beginTransaction();
      try {
        await c.execute(
          'UPDATE outbox_events SET status = ?, attempts = attempts + 1 WHERE id = ?',
          ['processing', outboxId],
        );
        // ⚠️ 修复前：不检查 affectedRows —— 更新 0 行也照样标记 done
        await c.execute(
          "UPDATE notification_deliveries SET status = 'sent', sent_at = NOW(3) WHERE notification_id = ? AND channel = 'inapp'",
          [notificationId],
        );
        await c.execute(
          'UPDATE outbox_events SET status = ?, processed_at = NOW(3) WHERE id = ?',
          ['done', outboxId],
        );
        await c.commit();
      } catch (error) {
        await c.rollback();
        throw error;
      }
    };

    const legacyMarkRetry = async (p: PoolLike, outboxId: number): Promise<void> => {
      // ⚠️ 修复前：不递增 attempts（→ jobId 不变 → 重投被去重吞掉），
      //    而且 available_at 推后 1 分钟
      await p.execute(
        "UPDATE outbox_events SET status = 'pending', available_at = NOW(3) + INTERVAL 1 MINUTE WHERE id = ?",
        [outboxId],
      );
    };

    // --- #96 的成对对比 ---
    const nidOld = await createNotification(userId);
    const oidOld = await createOutbox({ notificationId: nidOld });
    await legacyProcess(conn as unknown as ConnLike, oidOld, nidOld);
    check(
      '反向验证（#96）：修复前 —— 投递记录不存在，事件仍被标记为 done（消息静默丢失）',
      (await outboxState(oidOld))?.status === 'done',
      `status=${(await outboxState(oidOld))?.status}`,
    );
    check(
      '反向验证（#96）：修复前 —— 既没有送达记录，也没有任何报错',
      (await deliveryCount(nidOld)) === 0,
    );

    const nidNew = await createNotification(userId);
    const oidNew = await createOutbox({ notificationId: nidNew });
    let newThrew = false;
    try {
      await processOutboxJob(conn as unknown as ConnLike, {
        outboxId: oidNew,
        notificationId: nidNew,
      });
    } catch {
      newThrew = true;
    }
    check(
      '反向验证（#96）：修复后 —— 同样场景抛错回滚，事件不被标记为 done',
      newThrew && (await outboxState(oidNew))?.status !== 'done',
      `threw=${newThrew} status=${(await outboxState(oidNew))?.status}`,
    );

    // --- #95 的成对对比 ---
    const oidLegacy = await createOutbox({ notificationId: nid1 });
    await legacyMarkRetry(poolLike, oidLegacy);
    check(
      '反向验证（#95）：修复前 —— 回退不递增 attempts → jobId 不变 → 重投必被去重',
      (await outboxState(oidLegacy))?.attempts === 0,
      `attempts=${(await outboxState(oidLegacy))?.attempts}`,
    );

    const legacyProbe = new Queue(PROBE_QUEUE_NAME, { connection: queueConnection });
    await legacyProbe.obliterate({ force: true });
    const legacyJobId = `outbox-${oidLegacy}`;
    await legacyProbe.add('legacy', { outboxId: oidLegacy }, { jobId: legacyJobId });
    const legacyWaiting1 = await legacyProbe.getWaitingCount();
    await legacyProbe.add('legacy', { outboxId: oidLegacy }, { jobId: legacyJobId });
    const legacyWaiting2 = await legacyProbe.getWaitingCount();
    check(
      '反向验证（#95）：修复前 —— 重投的 jobId 与首次相同，第二次 add 被 BullMQ 吞掉',
      legacyWaiting2 === legacyWaiting1,
      `等待数 ${legacyWaiting1} → ${legacyWaiting2}`,
    );
    await legacyProbe.obliterate({ force: true });
    await legacyProbe.close();
  } finally {
    await cleanup().catch(() => undefined);
    conn.release();
    await worker.close();
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await queueConnection.quit();
    await workerConnection.quit();
    await pool.end();
  }

  // eslint-disable-next-line no-console
  console.log(`\n[selfcheck] 通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    process.exit(1);
  }
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[selfcheck] fatal', error);
  process.exit(1);
});
