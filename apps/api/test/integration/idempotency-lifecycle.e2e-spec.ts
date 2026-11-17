import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, login, markVerified, resetDatabase, setProfile } from '../helpers';

/**
 * 幂等键的**生命周期**（缺陷 #101 ~ #103）。
 *
 * 既有测试（idempotency.e2e-spec.ts）覆盖的是「成功之后的行为」：
 * 回放、哈希不一致、跨用户隔离、匿名放行。
 * 但**失败之后**会发生什么、以及**有效期**是否真的生效，从未被验证过 ——
 * 于是三处实现与文档不一致的地方长期存在：
 *
 *   #101 写接口失败后，幂等记录永远停在 `in_progress`
 *        → 客户端用**同一个键重试**（幂等键的本职）反而拿到 409「正在处理中」，
 *          最长 24 小时。失败一次，键就废了。
 *   #102 `idempotency_records.expires_at` **只写不读**
 *        → docs/API-SPEC.md §13 承诺的「在有效期内」没有实现：
 *          过期后仍然回放旧响应，而且记录永不过期（表无限增长）。
 *   #103 幂等冲突返回的是通用 `CONFLICT`
 *        → 而 packages/contracts 与 docs/CONCURRENCY-DESIGN.md §66 都写明
 *          应当返回 `IDEMPOTENCY_CONFLICT`，客户端按契约判断永远匹配不上。
 */
const API = '/api/v1';

describe('幂等键生命周期（缺陷 #101~#103）', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let token = '';

  const RESOURCE_BODY = {
    type: 'resource',
    title: '幂等生命周期探测用资源条目',
    body: '这是一段用于幂等生命周期验证的资源描述正文，内容长度满足最小校验要求。',
    industryCode: 'ENER',
    regionCode: 'HHS',
  };

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    // ⚠️ resetDatabase 会清空 users / user_sessions ——
    //    令牌必须在重置**之后**签发，否则每个用例都是 401。
    const session = await login(app, `idem-lifecycle-${Date.now()}`, '幂等生命周期');
    await markVerified(dataSource, session.userId);
    await setProfile(dataSource, session.userId, {
      display_name: '幂等生命周期',
      show_in_directory: 1,
      accept_contact_requests: 1,
      allow_contact_share: 1,
    });
    token = session.accessToken;
  });

  const server = () => request(app.getHttpServer());

  const post = (key: string, body: Record<string, unknown>) =>
    server()
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(body);

  it('#101 写接口失败后 → 同一个幂等键必须可以重试（不得卡在「处理中」）', async () => {
    const key = `idem-fail-${Date.now()}`;
    // title 长度不足 → 校验失败（400）。
    // ⚠️ ValidationPipe 在拦截器**内层**执行 → 400 发生在幂等键被占用之后。
    const badBody = { ...RESOURCE_BODY, title: '短' };

    const first = await post(key, badBody);
    expect(first.status).toBe(400);

    // 同一个键、同一个请求体再发一次 → 应当**重新执行**并得到同样的 400，
    // 而不是 409「幂等键正在处理中，请稍后重试」。
    const second = await post(key, badBody);
    expect(second.status).toBe(400);
    expect(second.body.code).not.toBe('IDEMPOTENCY_CONFLICT');

    // 失败后不得留下占着键的 in_progress 记录
    const rows = await dataSource.query(
      'SELECT COUNT(*) AS c FROM idempotency_records WHERE idem_key = ?',
      [key],
    );
    expect(Number(rows[0]?.c)).toBe(0);
  });

  it('#102 幂等键过了有效期 → 必须真正重新执行，而不是回放旧响应', async () => {
    const key = `idem-expire-${Date.now()}`;
    const title = `过期后应重新执行-${Date.now()}`;

    const first = await post(key, { ...RESOURCE_BODY, title }).expect(201);

    // 把有效期改成过去（模拟已经超过 24 小时）
    await dataSource.query('UPDATE idempotency_records SET expires_at = ? WHERE idem_key = ?', [
      new Date(Date.now() - 1000),
      key,
    ]);

    const second = await post(key, { ...RESOURCE_BODY, title });
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replay']).toBeUndefined();
    expect(second.body.data.id).not.toBe(first.body.data.id);

    const rows = await dataSource.query('SELECT COUNT(*) AS c FROM resource_posts WHERE title = ?', [
      title,
    ]);
    expect(Number(rows[0]?.c)).toBe(2);
  });

  it('#103 幂等键用于不同请求内容 → 错误码必须是 IDEMPOTENCY_CONFLICT', async () => {
    const key = `idem-code-${Date.now()}`;

    await post(key, { ...RESOURCE_BODY, title: '幂等冲突内容甲' }).expect(201);

    const conflict = await post(key, { ...RESOURCE_BODY, title: '幂等冲突内容乙' }).expect(409);
    // 契约（packages/contracts/src/common.ts）与 docs/CONCURRENCY-DESIGN.md §66
    // 都写明这是 IDEMPOTENCY_CONFLICT，而不是通用的 CONFLICT。
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('正向对照：未过期的成功请求仍然回放首次响应', async () => {
    const key = `idem-replay-ok-${Date.now()}`;
    const title = `正常回放-${Date.now()}`;

    const first = await post(key, { ...RESOURCE_BODY, title }).expect(201);
    const second = await post(key, { ...RESOURCE_BODY, title }).expect(200);

    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body.data.id).toBe(first.body.data.id);

    const rows = await dataSource.query('SELECT COUNT(*) AS c FROM resource_posts WHERE title = ?', [
      title,
    ]);
    expect(Number(rows[0]?.c)).toBe(1);
  });
});
