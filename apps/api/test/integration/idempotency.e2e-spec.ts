import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, login, markVerified, resetDatabase, setProfile } from '../helpers';

/**
 * 幂等接口（`Idempotency-Key`）行为验证。
 *
 * 背景：写接口携带 `Idempotency-Key` 时，同一 (scope, key) 只应执行一次，
 *       后续请求回放首次响应。拦截器把 scope 定义为 `METHOD:route.path`，
 *       唯一索引为 `(scope, idem_key)` —— **scope 里没有用户维度**。
 *       这意味着：两个不同用户使用**同一个幂等键**时，第二个用户会拿到
 *       第一个用户的响应回放（若请求体相同），从而看到对方响应里的数据。
 *
 * 用例：
 *   1. 同用户同键同体 → 回放首次响应（200 + Idempotent-Replay 头），业务只产生一条记录
 *   2. 同用户同键**不同体** → 409（幂等键已用于不同的请求内容）
 *   3. 同用户不同键 → 两次都真正执行，产生两条记录
 *   4. **不同用户同键** → 各自独立执行，不得回放对方的响应
 */

const API = '/api/v1';

describe('幂等接口 · Idempotency-Key', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const ctx: {
    aliceToken?: string;
    aliceUserId?: number;
    bobToken?: string;
    bobUserId?: number;
  } = {};

  const RESOURCE_BODY = {
    type: 'resource',
    title: '幂等探测用资源条目',
    body: '这是一段用于幂等行为验证的资源描述正文，内容长度满足最小校验要求。',
    industryCode: 'ENER',
    regionCode: 'HHS',
  };

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
    await resetDatabase(dataSource);

    const server = () => request(app.getHttpServer());

    const alice = await login(app, 'idem-alice', '幂等甲');
    const bob = await login(app, 'idem-bob', '幂等乙');
    ctx.aliceToken = alice.accessToken;
    ctx.aliceUserId = alice.userId;
    ctx.bobToken = bob.accessToken;
    ctx.bobUserId = bob.userId;

    for (const session of [alice, bob]) {
      await markVerified(dataSource, session.userId);
      await setProfile(dataSource, session.userId, {
        display_name: session === alice ? '幂等甲' : '幂等乙',
        show_in_directory: 1,
        accept_contact_requests: 1,
        allow_contact_share: 1,
      });
    }
    void server;
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => request(app.getHttpServer());

  it('同用户同键同体 → 回放首次响应，且只产生一条记录', async () => {
    const key = `idem-replay-${Date.now()}`;

    const first = await server()
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .set('Idempotency-Key', key)
      .send(RESOURCE_BODY)
      .expect(201);

    const second = await server()
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .set('Idempotency-Key', key)
      .send(RESOURCE_BODY)
      .expect(200);

    // 回放必须带明确标记，且响应体与首次一致
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body.data.id).toBe(first.body.data.id);

    const rows = await dataSource.query(
      'SELECT COUNT(*) AS c FROM resource_posts WHERE title = ?',
      [RESOURCE_BODY.title],
    );
    expect(Number(rows[0]?.c)).toBe(1);
  });

  it('同用户同键不同体 → 409（幂等键已用于不同的请求内容）', async () => {
    const key = `idem-conflict-${Date.now()}`;

    await server()
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .set('Idempotency-Key', key)
      .send(RESOURCE_BODY)
      .expect(201);

    await server()
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .set('Idempotency-Key', key)
      .send({ ...RESOURCE_BODY, title: '内容不同的资源标题' })
      .expect(409);
  });

  it('同用户不同键 → 两次都真正执行，产生两条记录', async () => {
    const title = `幂等不同键资源-${Date.now()}`;

    const first = await server()
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .set('Idempotency-Key', `idem-a-${Date.now()}`)
      .send({ ...RESOURCE_BODY, title })
      .expect(201);

    const second = await server()
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .set('Idempotency-Key', `idem-b-${Date.now()}`)
      .send({ ...RESOURCE_BODY, title })
      .expect(201);

    expect(second.body.data.id).not.toBe(first.body.data.id);

    const rows = await dataSource.query('SELECT COUNT(*) AS c FROM resource_posts WHERE title = ?', [title]);
    expect(Number(rows[0]?.c)).toBe(2);
  });

  it('不同用户使用同一幂等键 → 各自独立执行，不得回放对方响应', async () => {
    const key = `idem-shared-${Date.now()}`;
    const title = `幂等跨用户资源-${Date.now()}`;

    const aliceRes = await server()
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .set('Idempotency-Key', key)
      .send({ ...RESOURCE_BODY, title })
      .expect(201);

    const bobRes = await server()
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${ctx.bobToken}`)
      .set('Idempotency-Key', key)
      .send({ ...RESOURCE_BODY, title })
      .expect(201);

    // 关键断言：乙拿到的必须是**自己的**资源，而不是甲的响应回放
    expect(bobRes.headers['idempotent-replay']).toBeUndefined();
    expect(bobRes.body.data.id).not.toBe(aliceRes.body.data.id);

    const rows = await dataSource.query(
      'SELECT COUNT(*) AS c FROM resource_posts WHERE title = ?',
      [title],
    );
    expect(Number(rows[0]?.c)).toBe(2);
  });

  it('跨用户的联系方式请求必须真正执行，不得回放对方的响应', async () => {
    // /me/contacts 的响应含**解密后的联系方式明文**。
    // 若幂等键跨用户串号，乙拿到的会是甲的明文联系方式 —— 直接违反隐私硬规则。
    const key = `idem-contact-${Date.now()}`;
    const payload = {
      contactPhone: '13800001111',
      contactWechat: 'idem_shared_value',
      contactEmail: 'idem_shared_value@example.com',
    };

    await server()
      .put(`${API}/me/contacts`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(200);

    const bobRes = await server()
      .put(`${API}/me/contacts`)
      .set('Authorization', `Bearer ${ctx.bobToken}`)
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(200);

    // 乙的请求必须**真正执行**（而不是拿到甲的响应回放）
    expect(bobRes.headers['idempotent-replay']).toBeUndefined();

    // 乙名下的联系方式记录必须存在（说明写的是乙自己的行，而非甲的行）
    // 注意：mock 登录的 openid 带 `mock_` 前缀，直接按 user_id 查询更稳妥
    const bobRows = await dataSource.query(
      'SELECT COUNT(*) AS c FROM private_contacts WHERE user_id = ?',
      [ctx.bobUserId],
    );
    expect(Number(bobRows[0]?.c)).toBe(1);
  });

  it('匿名写接口不启用幂等（登录接口不得回放他人令牌）', async () => {
    const key = `idem-anon-${Date.now()}`;

    const first = await server()
      .post(`${API}/auth/mock/login`)
      .set('Idempotency-Key', key)
      .send({ mockOpenid: 'idem-anon-user-1', nickname: '匿名甲' })
      .expect(200);

    const second = await server()
      .post(`${API}/auth/mock/login`)
      .set('Idempotency-Key', key)
      .send({ mockOpenid: 'idem-anon-user-2', nickname: '匿名乙' })
      .expect(200);

    // 两个不同用户的令牌必须不同
    expect(second.body.data.accessToken).not.toBe(first.body.data.accessToken);
    expect(second.body.data.user.id).not.toBe(first.body.data.user.id);
  });
});
