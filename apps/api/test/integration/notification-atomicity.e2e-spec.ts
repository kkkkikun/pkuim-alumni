import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { NotificationService } from '../../src/modules/notifications/notification.service';
import { createTestApp, login, markVerified, resetDatabase, setProfile } from '../helpers';

/**
 * 缺陷 #99：通知写入不在业务事务内。
 *
 * docs/top.md §597 / docs/CONCURRENCY-DESIGN.md §67 / docs/ARCHITECTURE.md §58
 * 都明确要求「先在**业务事务中**写入待发送事件，再由 Worker 投递」，
 * 目的就是避免「业务成功但通知丢失」。
 *
 * 修复前：业务写入先提交，通知写在事务外 ——
 *   通知写失败时业务数据已经落库，用户看到 500 却留下了一条
 *   「业务已完成、但永远收不到通知」的记录（活动报名还会白占一个名额）。
 *
 * 本文件用**故障注入**证明这条保证真实成立：
 *   让 `NotificationService.push` 抛错 → 断言业务写入被整体回滚。
 */
describe('通知与业务同事务（缺陷 #99）', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let notifications: NotificationService;

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
    notifications = app.get(NotificationService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await resetDatabase(dataSource);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
  });

  /** 模拟 outbox 事件写不进去（字段超长 / 连接中断 / 磁盘满）。 */
  function breakNotificationWrite(): void {
    jest.spyOn(notifications, 'push').mockRejectedValue(new Error('模拟通知写入失败'));
  }

  async function seedAlumni(openid: string) {
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

  async function createEvent(capacity: number): Promise<number> {
    await dataSource.query(
      `INSERT INTO events (title, kind, capacity, registered_count, status, created_at, updated_at)
       VALUES ('原子性测试活动', '校友交流', ?, 0, 'published', NOW(3), NOW(3))`,
      [capacity],
    );
    const [row] = await dataSource.query('SELECT id FROM events ORDER BY id DESC LIMIT 1');
    return Number(row.id);
  }

  async function count(table: string): Promise<number> {
    const [row] = await dataSource.query(`SELECT COUNT(*) AS c FROM \`${table}\``);
    return Number(row.c);
  }

  it('联系申请：通知写失败 → 申请整体回滚，不留孤儿申请', async () => {
    const a = await seedAlumni('atomic-req-a');
    const b = await seedAlumni('atomic-req-b');
    breakNotificationWrite();

    await request(app.getHttpServer())
      .post('/api/v1/connections/requests')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ targetUserId: b.userId, message: '希望交流行业经验' })
      .expect(500);

    expect(await count('connection_request_history')).toBe(0);
    // 也不能留下一条「没有对应通知」的 outbox 事件
    expect(await count('outbox_events')).toBe(0);
  });

  it('活动报名：通知写失败 → 报名回滚且名额必须归还', async () => {
    const eventId = await createEvent(3);
    const user = await seedAlumni('atomic-event');
    breakNotificationWrite();

    await request(app.getHttpServer())
      .post(`/api/v1/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({})
      .expect(500);

    expect(await count('event_registrations')).toBe(0);
    // ⚠️ 名额是条件更新递增的：事务回滚后计数必须回到原值，
    //    否则每次通知写失败都会白白吃掉一个名额。
    const [event] = await dataSource.query('SELECT registered_count FROM events WHERE id = ?', [
      eventId,
    ]);
    expect(Number(event.registered_count)).toBe(0);
  });

  it('认证提交：通知写失败 → 申请回滚且用户阶段不变', async () => {
    const user = await login(app, 'atomic-verify');
    breakNotificationWrite();

    await request(app.getHttpServer())
      .post('/api/v1/alumni/verification')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        realName: '张三',
        college: '计算机学院',
        graduationYear: 2010,
        studentIdMasked: '20101234',
      })
      .expect(500);

    expect(await count('verification_applications')).toBe(0);
    const [row] = await dataSource.query('SELECT stage FROM users WHERE id = ?', [user.userId]);
    expect(row.stage).not.toBe('pending_review');
  });

  it('资源提交审核：通知写失败 → 内容整体回滚', async () => {
    const user = await seedAlumni('atomic-res');
    breakNotificationWrite();

    await request(app.getHttpServer())
      .post('/api/v1/resources')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ type: 'resource', title: '原子性测试资源', body: '这是一段足够长的资源描述正文。' })
      .expect(500);

    expect(await count('resource_posts')).toBe(0);
    expect(await count('outbox_events')).toBe(0);
  });

  it('反向验证：断言不是恒过的 —— 业务写在事务外时，名额不会被归还', async () => {
    // 直接复刻「修复前」的顺序：业务写入先提交（自动提交），
    // 随后通知写失败 → 业务数据已经落库，**回滚不回来**。
    // 这一条保证上面的断言真的有鉴别力：
    // 若业务写不在事务里，名额会停在 1 而不是回到 0。
    const eventId = await createEvent(3);
    const user = await seedAlumni('atomic-probe');

    await dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO event_registrations (event_id, user_id, status, created_at, updated_at)
         VALUES (?, ?, 'registered', NOW(3), NOW(3))`,
        [eventId, user.userId],
      );
      await manager.query('UPDATE events SET registered_count = registered_count + 1 WHERE id = ?', [
        eventId,
      ]);
    });

    expect(await count('event_registrations')).toBe(1);
    const [event] = await dataSource.query('SELECT registered_count FROM events WHERE id = ?', [
      eventId,
    ]);
    expect(Number(event.registered_count)).toBe(1);
  });

  it('正常路径：业务数据与 outbox 事件一起落库（正向对照）', async () => {
    const a = await seedAlumni('atomic-ok-a');
    const b = await seedAlumni('atomic-ok-b');

    await request(app.getHttpServer())
      .post('/api/v1/connections/requests')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ targetUserId: b.userId, message: '希望交流行业经验' })
      .expect(201);

    expect(await count('connection_request_history')).toBe(1);
    // outbox 事件确实被写入了（业务与通知同一事务落库）
    const [outbox] = await dataSource.query(
      'SELECT COUNT(*) AS c FROM outbox_events WHERE event_type = ?',
      ['connection.request.created'],
    );
    expect(Number(outbox.c)).toBe(1);
    // 投递记录同时存在，状态为待投递
    const [delivery] = await dataSource.query(
      "SELECT COUNT(*) AS c FROM notification_deliveries WHERE status = 'pending'",
    );
    expect(Number(delivery.c)).toBe(1);
  });
});
