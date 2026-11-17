import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, ensureAdmin, login, markVerified, resetDatabase } from '../helpers';
import { EventsService } from '../../src/modules/events/events.service';

/**
 * 活动名额计数的**守恒性**（缺陷 #122 / #123）。
 *
 * 需求基线（docs/top.md §活动报名）明确要求处理：
 *   - 同一用户重复报名；
 *   - 多人同时争抢最后一个名额；
 *   - **取消报名与其他报名请求竞争**；
 * 并「采用……事务及条件更新解决」。
 *
 * 名额的真相只有一个：**`events.registered_count` 必须等于
 * 「当前 status='registered' 的报名记录条数」**。
 * 一旦两者不等，容量判定（`registered_count < capacity`）就会失真，
 * 于是「看起来还有名额、实际已超卖」或「名额凭空多出来」。
 *
 *   #122 取消报名时，两个条件更新的**影响行数都没有检查**：
 *         `UPDATE ... WHERE status='registered'` 若影响 0 行
 *         （说明这条报名**已经被别人取消**了），
 *         代码却仍然继续回收名额 → 计数被**重复扣减** → 名额凭空多出来。
 *   #123 管理端把活动容量改成**小于当前报名人数**：
 *         服务端不校验 → 活动进入「报名人数 > 容量」的不可能状态。
 */
const API = '/api/v1';

describe('活动名额计数的守恒性 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    await ensureAdmin(dataSource, {
      roleCode: 'event_admin',
      permissionCode: 'event:manage',
    });
    const res = await request(app.getHttpServer())
      .post(`${API}/auth/admin/login`)
      .send({ username: 'admin-test', password: 'Admin@2026' })
      .expect(200);
    adminToken = res.body.data.accessToken as string;
  });

  const server = () => request(app.getHttpServer());

  async function createEvent(capacity: number): Promise<number> {
    await dataSource.query(
      `INSERT INTO events (title, kind, capacity, registered_count, status, created_at, updated_at)
       VALUES ('名额守恒测试活动', '校友交流', ?, 0, 'published', NOW(3), NOW(3))`,
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

  async function registeredCountOf(eventId: number): Promise<number> {
    const [row] = await dataSource.query(
      'SELECT registered_count FROM events WHERE id = ?',
      [eventId],
    );
    return Number(row.registered_count);
  }

  async function activeRegistrationCount(eventId: number): Promise<number> {
    const [row] = await dataSource.query(
      "SELECT COUNT(*) AS c FROM event_registrations WHERE event_id = ? AND status = 'registered'",
      [eventId],
    );
    return Number(row.c);
  }

  /* ---------------------------- #122 取消的名额守恒 ---------------------------- */

  it('#122 取消时若报名已被他人取消，不得再回收名额（否则名额凭空多出来）', async () => {
    const eventId = await createEvent(5);
    const user = await verifiedUser('capacity-race-1');
    const other = await verifiedUser('capacity-race-2');

    await server()
      .post(`${API}/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({})
      .expect(201);
    await server()
      .post(`${API}/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .send({})
      .expect(201);
    expect(await registeredCountOf(eventId)).toBe(2);

    // 模拟并发：本次请求读到「已报名」之后，另一个请求**已经完整地**取消了这条报名
    // （既改了状态，也回收了名额）—— 此时计数与有效报名数仍然是一致的。
    const service = app.get(EventsService) as unknown as {
      registrations: { findOne: (...args: unknown[]) => Promise<unknown> };
    };
    const repo = service.registrations;
    const original = repo.findOne.bind(repo);
    let injected = false;
    repo.findOne = async (...args: unknown[]) => {
      const result = (await original(...args)) as { id?: number } | null;
      if (!injected && result && result.id) {
        injected = true;
        await dataSource.query(
          "UPDATE event_registrations SET status = 'cancelled' WHERE id = ?",
          [result.id],
        );
        await dataSource.query(
          'UPDATE events SET registered_count = GREATEST(registered_count - 1, 0) WHERE id = ?',
          [eventId],
        );
      }
      return result;
    };
    try {
      const response = await server()
        .delete(`${API}/events/${eventId}/registrations`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      // 这次取消**没有真正生效**（报名早已被取消）→ 必须报幂等
      expect(response.body.data.idempotent).toBe(true);
    } finally {
      repo.findOne = original;
    }

    // 关键断言：名额不得被**重复**回收 —— 另一位校友仍然在名单里，
    // 计数必须仍然等于有效报名条数
    expect(await activeRegistrationCount(eventId)).toBe(1);
    expect(await registeredCountOf(eventId)).toBe(1);
    expect(await registeredCountOf(eventId)).toBe(await activeRegistrationCount(eventId));
  });

  it('#122 对照：正常取消回收一次名额', async () => {
    const eventId = await createEvent(5);
    const user = await verifiedUser('capacity-normal-1');

    await server()
      .post(`${API}/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({})
      .expect(201);

    const response = await server()
      .delete(`${API}/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    expect(response.body.data.idempotent).toBe(false);
    expect(response.body.data.cancelled).toBe(true);

    expect(await registeredCountOf(eventId)).toBe(0);
    expect(await activeRegistrationCount(eventId)).toBe(0);
  });

  it('#122 对照：连续取消两次只回收一次名额', async () => {
    const eventId = await createEvent(5);
    const user = await verifiedUser('capacity-twice-1');

    await server()
      .post(`${API}/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({})
      .expect(201);

    await server()
      .delete(`${API}/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    const second = await server()
      .delete(`${API}/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    expect(second.body.data.idempotent).toBe(true);

    expect(await registeredCountOf(eventId)).toBe(0);
  });

  /* ---------------------------- #123 容量不得低于已报名人数 ---------------------------- */

  it('#123 管理端把容量改到小于已报名人数 → 必须被拒（否则活动进入不可能状态）', async () => {
    const eventId = await createEvent(10);
    const user = await verifiedUser('capacity-shrink-1');

    await server()
      .post(`${API}/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({})
      .expect(201);
    await server()
      .post(`${API}/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${(await verifiedUser('capacity-shrink-2')).accessToken}`)
      .send({})
      .expect(201);
    expect(await registeredCountOf(eventId)).toBe(2);

    const response = await server()
      .patch(`${API}/admin/events/${eventId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ capacity: 1 });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');

    // 容量不得被改小
    const [row] = await dataSource.query('SELECT capacity FROM events WHERE id = ?', [eventId]);
    expect(Number(row.capacity)).toBe(10);
  });

  it('#123 对照：把容量改成大于等于已报名人数 → 放行', async () => {
    const eventId = await createEvent(10);
    const user = await verifiedUser('capacity-grow-1');

    await server()
      .post(`${API}/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({})
      .expect(201);

    await server()
      .patch(`${API}/admin/events/${eventId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ capacity: 3 })
      .expect(200);

    const [row] = await dataSource.query('SELECT capacity FROM events WHERE id = ?', [eventId]);
    expect(Number(row.capacity)).toBe(3);
  });

  it('#123 对照：把容量改成 0（不限）→ 放行', async () => {
    const eventId = await createEvent(10);
    const user = await verifiedUser('capacity-unlimited-1');

    await server()
      .post(`${API}/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({})
      .expect(201);

    await server()
      .patch(`${API}/admin/events/${eventId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ capacity: 0 })
      .expect(200);

    const [row] = await dataSource.query('SELECT capacity FROM events WHERE id = ?', [eventId]);
    expect(Number(row.capacity)).toBe(0);
  });
});
