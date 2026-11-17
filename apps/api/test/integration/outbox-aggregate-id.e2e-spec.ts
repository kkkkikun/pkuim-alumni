import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { NotificationService } from '../../src/modules/notifications/notification.service';
import { DICT, createTestApp, login, markVerified, resetDatabase, setProfile } from '../helpers';

/**
 * Outbox 事件的 `aggregate_id` 必须指向**聚合根本身**（缺陷 #139）。
 *
 * 缺陷形态：
 *   `notification.service.ts` 的 `push()` 接收 `options.aggregateId`
 *   （调用方给的是「这个事件所指向的聚合根 id」，如联系申请 id、活动 id），
 *   但写库时写死成 `String(notification.id)` → 调用方传的 `aggregateId`
 *   被**静默丢弃**。于是库里出现自相矛盾的一行：
 *
 *     event_type    = 'connection.request.created'
 *     aggregate_type= 'connection_request'
 *     aggregate_id  = <通知自己的 id>     ← 指向了一个通知，不是联系申请
 *
 * 后果：「按聚合根查这个事件」永远查不到；审计/对账按 aggregate_id 关联会连错对象。
 *
 * ⚠️ 为什么这个 bug 长期没被发现：
 *   老夹具用 **TRUNCATE** 重置数据库 → **每张表的自增计数器都从 1 重新开始** →
 *   于是「通知 id」恰好等于「聚合根 id」（都是 1、2、3…）→
 *   `expect(outbox.aggregate_id).toBe(String(created.body.data.id))`
 *   **靠巧合通过**。它其实一直在断言一个错误的值。
 *   夹具改用 DELETE 重置（缺陷 #138）后，两个计数器不再同步，断言立刻变红 ——
 *   这才把真缺陷挖出来。
 *
 * 所以本用例**必须**自己把「通知 id」与「聚合根 id」拉开距离，
 * 否则换成 TRUNCATE 重置就会重新变成「靠巧合通过」。
 */
describe('Outbox 事件的 aggregate_id 必须指向聚合根本身（缺陷 #139）', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  const server = () => request(app.getHttpServer());

  async function verifiedUser(openid: string) {
    const session = await login(app, openid);
    await markVerified(dataSource, session.userId);
    await setProfile(dataSource, session.userId, {
      display_name: `校友-${openid}`,
      show_in_directory: 1,
      accept_contact_requests: 1,
      allow_contact_share: 1,
    });
    return session;
  }

  /**
   * 把**通知表**的自增计数器顶到 900000。
   *
   * 显式指定一个很大的 id → InnoDB 会把计数器抬到它之后 →
   * 之后所有通知的 id 都是 900001、900002…，
   * 与任何聚合根表（联系申请 / 资源帖 / 活动）的 id **不可能相等**。
   *
   * 这样断言就是「真的在检查 aggregate_id 指向了聚合根」，
   * 而不是「通知 id 恰好等于聚合根 id」的巧合。
   */
  async function pushNotificationCounterFarAhead(userId: number): Promise<void> {
    await dataSource.query(
      `INSERT INTO notifications (id, user_id, type, title, body, payload, created_at)
       VALUES (900000, ?, 'system', '占位通知', '仅用于把自增计数器顶到远处', JSON_OBJECT(), NOW(3))`,
      [userId],
    );
  }

  /** 取出最近一条某类型事件的 outbox 行 */
  async function latestOutbox(eventType: string) {
    const rows = await dataSource.query(
      'SELECT event_type, aggregate_type, aggregate_id, payload FROM outbox_events WHERE event_type = ? ORDER BY id DESC LIMIT 1',
      [eventType],
    );
    return rows[0];
  }

  it('联系申请事件：aggregate_id 是联系申请 id，不是通知 id', async () => {
    const a = await verifiedUser('agg-req-a');
    const b = await verifiedUser('agg-req-b');
    await pushNotificationCounterFarAhead(b.userId);

    const created = await server()
      .post('/api/v1/connections/requests')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ targetUserId: b.userId, message: '希望交流行业经验' })
      .expect(201);

    const outbox = await latestOutbox('connection.request.created');
    expect(outbox).toBeTruthy();
    expect(outbox.aggregate_type).toBe('connection_request');
    expect(outbox.aggregate_id).toBe(String(created.body.data.id));
    // 明确排除「指向通知 id」的可能（这正是缺陷 #139 的表现）
    const payload = typeof outbox.payload === 'string' ? JSON.parse(outbox.payload) : outbox.payload;
    expect(String(outbox.aggregate_id)).not.toBe(String(payload.notificationId));
  });

  it('资源投稿事件：aggregate_id 是资源帖 id', async () => {
    const author = await verifiedUser('agg-res');
    await pushNotificationCounterFarAhead(author.userId);

    const created = await server()
      .post('/api/v1/resources')
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({
        type: 'resource',
        title: '可共享的新能源行业经验',
        body: '这是一段用于测试的资源描述内容，长度满足校验要求。',
        industryCode: DICT.industries.energy,
        regionCode: DICT.regions.hohhot,
      })
      .expect(201);

    const outbox = await latestOutbox('resource.submitted');
    expect(outbox).toBeTruthy();
    expect(outbox.aggregate_type).toBe('resource_post');
    expect(outbox.aggregate_id).toBe(String(created.body.data.id));
    const payload = typeof outbox.payload === 'string' ? JSON.parse(outbox.payload) : outbox.payload;
    expect(String(outbox.aggregate_id)).not.toBe(String(payload.notificationId));
  });

  it('活动报名事件：aggregate_id 是活动 id', async () => {
    await dataSource.query(
      `INSERT INTO events (title, kind, capacity, registered_count, status, created_at, updated_at)
       VALUES ('Outbox 聚合根校验活动', '校友交流', 10, 0, 'published', NOW(3), NOW(3))`,
    );
    const [eventRow] = await dataSource.query('SELECT id FROM events ORDER BY id DESC LIMIT 1');
    const eventId = Number(eventRow.id);

    const user = await verifiedUser('agg-evt');
    await pushNotificationCounterFarAhead(user.userId);

    await server()
      .post(`/api/v1/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({})
      .expect(201);

    const outbox = await latestOutbox('event.registration.created');
    expect(outbox).toBeTruthy();
    expect(outbox.aggregate_type).toBe('event');
    expect(outbox.aggregate_id).toBe(String(eventId));
    const payload = typeof outbox.payload === 'string' ? JSON.parse(outbox.payload) : outbox.payload;
    expect(String(outbox.aggregate_id)).not.toBe(String(payload.notificationId));
  });

  it('对照：不传 aggregateId 时，默认仍指向通知 id（默认语义没被改坏）', async () => {
    // ⚠️ 生产里 8 个调用点**全都**传了 aggregateId，
    //    所以「不传时退回通知 id」这条默认语义只能**直接调服务**来验。
    //    这条对照的作用：保证修复没有把默认行为一起改掉。
    const service = app.get(NotificationService);
    const user = await verifiedUser('agg-default');

    const notification = await service.push(user.userId, 'system', '默认语义校验', '正文');

    const [row] = await dataSource.query(
      "SELECT aggregate_type, aggregate_id FROM outbox_events WHERE event_type = 'notification.system' ORDER BY id DESC LIMIT 1",
    );
    expect(row.aggregate_type).toBe('notification');
    expect(row.aggregate_id).toBe(String(notification.id));
  });
});
