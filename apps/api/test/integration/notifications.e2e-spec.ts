import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, login, markVerified, resetDatabase } from '../helpers';

/**
 * 站内通知链路：业务动作 → 通知入库 + Outbox 登记 → 未读计数 → 已读状态。
 *
 * 这是 `docs/top.md` §8.2「通知列表 / 通知详情 / 通知已读状态」的服务端契约，
 * 也是小程序「通知中心」的数据来源。
 */
describe('站内通知 (e2e)', () => {
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

  async function twoAlumni(): Promise<{
    a: { accessToken: string; userId: number };
    b: { accessToken: string; userId: number };
  }> {
    const a = await login(app, 'notify-a', '通知甲');
    const b = await login(app, 'notify-b', '通知乙');
    await markVerified(dataSource, a.userId);
    await markVerified(dataSource, b.userId);
    return { a, b };
  }

  it('联系申请会为对方生成站内通知，并登记 Outbox 事件', async () => {
    const { a, b } = await twoAlumni();

    const created = await server()
      .post('/api/v1/connections/requests')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ targetUserId: b.userId, message: '希望建立联系，交流行业经验' })
      .expect(201);

    const list = await server()
      .get('/api/v1/me/notifications')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);

    expect(list.body.data.items).toHaveLength(1);
    const notification = list.body.data.items[0];
    expect(notification.type).toBe('connection_request');
    expect(notification.read).toBe(false);
    expect(notification.title).toBeTruthy();
    expect(notification.payload.requestId).toBe(created.body.data.id);

    // 同一事务里登记了 Outbox 事件，交给 Worker 投递
    const [outbox] = await dataSource.query(
      "SELECT event_type, aggregate_type, aggregate_id, status FROM outbox_events WHERE aggregate_type = 'connection_request' ORDER BY id DESC LIMIT 1",
    );
    expect(outbox.event_type).toBe('connection.request.created');
    expect(outbox.aggregate_id).toBe(String(created.body.data.id));
    expect(outbox.status).toBe('pending');

    // 投递记录也已登记
    const [delivery] = await dataSource.query(
      'SELECT channel, status FROM notification_deliveries WHERE notification_id = ?',
      [notification.id],
    );
    expect(delivery.channel).toBe('inapp');
    expect(delivery.status).toBe('pending');
  });

  it('未读计数随通知产生而增加，标记已读后归零', async () => {
    const { a, b } = await twoAlumni();

    const before = await server()
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);
    expect(before.body.data.unread).toBe(0);

    await server()
      .post('/api/v1/connections/requests')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ targetUserId: b.userId, message: '希望建立联系，交流行业经验' })
      .expect(201);

    const after = await server()
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);
    expect(after.body.data.unread).toBe(1);

    const list = await server()
      .get('/api/v1/me/notifications')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);
    const id = list.body.data.items[0].id;

    const detail = await server()
      .get(`/api/v1/notifications/${id}`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);
    expect(detail.body.data.id).toBe(id);
    expect(detail.body.data.read).toBe(false);

    // 语义（缺陷 #126）：「标记已读」不创建资源 → 200，而不是 POST 默认的 201
    const marked = await server()
      .post(`/api/v1/notifications/${id}/read`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);
    expect(marked.body.data.read).toBe(true);

    const count = await server()
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);
    expect(count.body.data.unread).toBe(0);
  });

  it('通知只属于本人：他人无法读取或标记', async () => {
    const { a, b } = await twoAlumni();

    await server()
      .post('/api/v1/connections/requests')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ targetUserId: b.userId, message: '希望建立联系，交流行业经验' })
      .expect(201);

    const list = await server()
      .get('/api/v1/me/notifications')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);
    const id = list.body.data.items[0].id;

    // 发起方看不到这条通知
    const other = await server()
      .get(`/api/v1/notifications/${id}`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(404);
    expect(other.body.code).toBe('NOT_FOUND');

    // 也不能替对方标记已读。
    // 语义（缺陷 #124）：不是自己的通知 → 404（与 `GET /notifications/:id` 一致，
    // 既不生效、也不泄露「这条通知存在」）。
    await server()
      .post(`/api/v1/notifications/${id}/read`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(404);

    const stillUnread = await server()
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);
    expect(stillUnread.body.data.unread).toBe(1);
  });

  it('全部标记已读只影响本人', async () => {
    const { a, b } = await twoAlumni();

    await server()
      .post('/api/v1/connections/requests')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ targetUserId: b.userId, message: '希望建立联系，交流行业经验' })
      .expect(201);

    // 语义（缺陷 #126）：「全部标记已读」不创建资源 → 200
    const result = await server()
      .post('/api/v1/notifications/read-all')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);
    expect(result.body.data.updated).toBe(1);

    const count = await server()
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);
    expect(count.body.data.unread).toBe(0);

    // 发起方的未读数不受影响
    const otherCount = await server()
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(200);
    expect(otherCount.body.data.unread).toBe(0);
  });
});
