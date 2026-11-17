import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, login, markVerified, resetDatabase, setProfile } from '../helpers';

/**
 * 幂等键的**作用域**必须落到「具体资源」，而不是「路由模板」（缺陷 #140）。
 *
 * 缺陷形态：
 *   幂等拦截器把 scope 写成 `METHOD:${request.route.path}:u{userId}`，
 *   而 `request.route.path` 是**路由模板**（如 `/connections/:id/contact-grant`），
 *   不是实际路径（`/connections/17/contact-grant`）。
 *   于是「同一把钥匙开两个不同的资源」会落进**同一个 scope**：
 *     - 请求体相同 → 第二个请求被当成**回放**，返回第一个资源的响应；
 *     - 而第二个资源**根本没有被写入** —— 客户端却收到 200，像是成功了。
 *
 *   现实场景：客户端（或网关）用一把全局幂等钥匙串行调用多个接口，
 *   例如「为两条连接关系分别开启联系方式授权」用了同一个 key。
 *   第二个请求会静默地什么都不做 —— **静默的数据丢失**。
 *
 * 契约依据（docs/API-SPEC.md §幂等）：
 *   scope = `METHOD:路径:u{用户ID}` —— 「路径」指的是**这次请求打到的那个路径**，
 *   而不是「这一类端点的路径模板」；且「同一 (scope, key) 只执行一次并回放原响应」
 *   的前提是「同一个 scope 里的确是同一个请求」。
 *
 * 处置：scope 改用**实际路径**（`request.originalUrl` 去查询串），
 * 请求哈希再额外覆盖「方法 + 实际路径 + 查询串 + 请求体」，
 * 保证「同一路径 + 不同查询串/请求体」仍然按契约返回 409 `IDEMPOTENCY_CONFLICT`。
 *
 * 对照用例（防误伤）：既有语义必须不变 ——
 *   同一个键用在**同一个资源**上 → 仍然回放；
 *   同一个键用在同一资源但**请求体不同** → 仍然 409 IDEMPOTENCY_CONFLICT。
 */
const API = '/api/v1';

describe('幂等键的作用域：必须落到具体资源（缺陷 #140）', () => {
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

  async function verifiedAlumni(openid: string) {
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

  /** 建立一条连接关系（发起方 = initiator），返回 pairId */
  async function establishPairWith(
    initiator: { accessToken: string; userId: number },
    otherOpenid: string,
  ): Promise<number> {
    const other = await verifiedAlumni(otherOpenid);
    const created = await server()
      .post(`${API}/connections/requests`)
      .set('Authorization', `Bearer ${initiator.accessToken}`)
      .send({ targetUserId: other.userId, message: '希望交流行业经验' })
      .expect(201);
    await server()
      .post(`${API}/connections/requests/${created.body.data.id}/accept`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .expect(201);
    const [pair] = await dataSource.query(
      "SELECT id FROM connection_pairs WHERE status = 'active' ORDER BY id DESC LIMIT 1",
    );
    return Number(pair.id);
  }

  it('#140 同一把幂等钥匙用在两个不同资源上 → 两个资源都必须真正被写入', async () => {
    // ⚠️ 同一个用户与**两个**对方建立关系 ——
    //    授权只能由关系双方发起，所以发起方必须同时是两个关系的成员。
    const owner = await verifiedAlumni('scope-owner');
    const firstPair = await establishPairWith(owner, 'scope-q1');
    const secondPair = await establishPairWith(owner, 'scope-q2');
    expect(secondPair).not.toBe(firstPair);

    // ⚠️ 同一个 key、同一个请求体，但打的是**两个不同的资源**
    const key = `idem-scope-${Date.now()}`;
    const firstResponse = await server()
      .put(`${API}/connections/${firstPair}/contact-grant`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .set('Idempotency-Key', key)
      .send({ allow: true })
      .expect(200);

    const secondResponse = await server()
      .put(`${API}/connections/${secondPair}/contact-grant`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .set('Idempotency-Key', key)
      .send({ allow: true })
      .expect(200);

    // 响应必须对应当前资源（回放第一个的响应 = 串扰）
    expect(firstResponse.body.data.id).toBe(firstPair);
    expect(secondResponse.body.data.id).toBe(secondPair);

    // ⚠️ 核心断言：两个资源都真的被写入了（不能只写一个）
    const rows = await dataSource.query(
      'SELECT pair_id, allow FROM contact_share_grants WHERE user_id = ? ORDER BY pair_id',
      [owner.userId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row: { pair_id: number }) => Number(row.pair_id)).sort()).toEqual(
      [firstPair, secondPair].sort(),
    );
    for (const row of rows) {
      expect(Number(row.allow)).toBe(1);
    }
  });

  it('对照：同一把钥匙用在**同一个资源**上 → 仍然回放首次响应', async () => {
    const member = await verifiedAlumni('replay-owner');
    const pairId = await establishPairWith(member, 'replay-q1');
    const key = `idem-replay-same-${Date.now()}`;

    const first = await server()
      .put(`${API}/connections/${pairId}/contact-grant`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .set('Idempotency-Key', key)
      .send({ allow: true })
      .expect(200);

    const second = await server()
      .put(`${API}/connections/${pairId}/contact-grant`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .set('Idempotency-Key', key)
      .send({ allow: true })
      .expect(200);

    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body.data.id).toBe(first.body.data.id);

    // 业务只产生一条记录
    const [row] = await dataSource.query(
      'SELECT COUNT(*) AS c FROM contact_share_grants WHERE pair_id = ? AND user_id = ?',
      [pairId, member.userId],
    );
    expect(Number(row.c)).toBe(1);
  });

  it('对照：同一把钥匙、同一资源、请求体不同 → 仍是 409 IDEMPOTENCY_CONFLICT', async () => {
    const member = await verifiedAlumni('conflict-owner');
    const pairId = await establishPairWith(member, 'conflict-q1');
    const key = `idem-conflict-${Date.now()}`;

    await server()
      .put(`${API}/connections/${pairId}/contact-grant`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .set('Idempotency-Key', key)
      .send({ allow: true })
      .expect(200);

    const conflict = await server()
      .put(`${API}/connections/${pairId}/contact-grant`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .set('Idempotency-Key', key)
      .send({ allow: false })
      .expect(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});
