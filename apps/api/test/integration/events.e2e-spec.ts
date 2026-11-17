import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTestApp, ensureAdmin, login, markVerified, resetDatabase } from '../helpers';

describe('活动报名 · 容量并发 (e2e)', () => {
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

  async function createEvent(capacity: number): Promise<number> {
    await dataSource.query(
      `INSERT INTO events (title, kind, capacity, registered_count, status, created_at, updated_at)
       VALUES ('测试活动', '校友交流', ?, 0, 'published', NOW(3), NOW(3))`,
      [capacity],
    );
    const [row] = await dataSource.query('SELECT id FROM events ORDER BY id DESC LIMIT 1');
    return Number(row.id);
  }

  async function verifiedUser(openid: string) {
    const session = await login(app, openid);
    await markVerified(dataSource, session.userId);
    return session;
  }

  it('并发争抢最后一个名额：成功数恰好等于剩余名额，且不超卖', async () => {
    const eventId = await createEvent(3);
    const users = await Promise.all(
      Array.from({ length: 10 }, (_, index) => verifiedUser(`race-${index}`)),
    );

    const responses = await Promise.all(
      users.map((user) =>
        request(app.getHttpServer())
          .post(`/api/v1/events/${eventId}/registrations`)
          .set('Authorization', `Bearer ${user.accessToken}`)
          .send({}),
      ),
    );

    const created = responses.filter((res) => res.status === 201).length;
    const conflict = responses.filter((res) => res.status === 409).length;
    expect(created).toBe(3);
    expect(created + conflict).toBe(10);

    const [event] = await dataSource.query('SELECT registered_count, capacity FROM events WHERE id = ?', [eventId]);
    const [rows] = await dataSource.query("SELECT COUNT(*) AS c FROM event_registrations WHERE event_id = ? AND status = 'registered'", [eventId]);
    expect(Number(event.registered_count)).toBe(3);
    expect(Number(event.registered_count)).toBeLessThanOrEqual(Number(event.capacity));
    expect(Number(rows.c)).toBe(3);
  });

  it('同一用户重复报名幂等，只产生一条记录', async () => {
    const eventId = await createEvent(5);
    const user = await verifiedUser('dup-1');

    await request(app.getHttpServer())
      .post(`/api/v1/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({})
      .expect(201);

    const second = await request(app.getHttpServer())
      .post(`/api/v1/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({})
      .expect(200);
    expect(second.body.data.idempotent).toBe(true);

    const [rows] = await dataSource.query('SELECT COUNT(*) AS c FROM event_registrations WHERE event_id = ?', [eventId]);
    expect(Number(rows.c)).toBe(1);
    const [event] = await dataSource.query('SELECT registered_count FROM events WHERE id = ?', [eventId]);
    expect(Number(event.registered_count)).toBe(1);
  });

  it('取消报名后名额被回收', async () => {
    const eventId = await createEvent(2);
    const user = await verifiedUser('cancel-1');

    await request(app.getHttpServer())
      .post(`/api/v1/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({})
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/api/v1/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    const [event] = await dataSource.query('SELECT registered_count FROM events WHERE id = ?', [eventId]);
    expect(Number(event.registered_count)).toBe(0);

    // 名额回收后其他人可以报名
    const other = await verifiedUser('cancel-2');
    await request(app.getHttpServer())
      .post(`/api/v1/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .send({})
      .expect(201);
  });

  it('已关闭的活动不能再报名', async () => {
    const eventId = await createEvent(5);
    await dataSource.query("UPDATE events SET status = 'closed' WHERE id = ?", [eventId]);
    const user = await verifiedUser('closed-1');

    await request(app.getHttpServer())
      .post(`/api/v1/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({})
      .expect(409);
  });

  it('管理员可以读取单个活动详情', async () => {
    await ensureAdmin(dataSource, {
      roleCode: 'super_admin',
      permissionCode: 'event:manage',
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/admin/login')
      .send({ username: 'admin-test', password: 'Admin@2026' })
      .expect(200);
    const token = response.body.data.accessToken;

    const created = await request(app.getHttpServer())
      .post('/api/v1/admin/events')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: '管理员新建的校友沙龙',
        kind: '行业沙龙',
        capacity: 30,
        status: 'published',
        startsAt: '2026-12-25T02:00:00.000Z',
        endsAt: '2026-12-25T09:00:00.000Z',
        place: '呼和浩特',
      })
      .expect(201);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/admin/events/${created.body.data.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(detail.body.data.id).toBe(created.body.data.id);
    expect(detail.body.data.title).toBe('管理员新建的校友沙龙');
    expect(detail.body.data.capacity).toBe(30);
  });

  it('未认证校友不能报名', async () => {
    const eventId = await createEvent(5);
    const user = await login(app, 'unverified-1');

    await request(app.getHttpServer())
      .post(`/api/v1/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({})
      .expect(403);
  });
});
