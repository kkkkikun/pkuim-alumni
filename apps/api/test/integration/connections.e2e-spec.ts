import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTestApp, login, markVerified, resetDatabase, setProfile } from '../helpers';

describe('双向连接 · 授权与并发 (e2e)', () => {
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

  async function seedAlumni(openid: string) {
    const session = await login(app, openid);
    await markVerified(dataSource, session.userId);
    await setProfile(dataSource, session.userId, {
      display_name: `校友-${openid}`,
      show_in_directory: 1,
      accept_contact_requests: 1,
      allow_contact_share: 1,
    });
    // 通过真实接口写入联系方式（走 AES-256-GCM 加密链路，避免直接改密文列）
    await request(app.getHttpServer())
      .put('/api/v1/me/contacts')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({
        contactPhone: '13800000000',
        contactWechat: 'pku_test',
        contactEmail: 'alumni@example.com',
      })
      .expect(200);
    return session;
  }

  it('申请 → 接受 → 建立唯一连接关系', async () => {
    const a = await seedAlumni('pair-a');
    const b = await seedAlumni('pair-b');

    const created = await request(app.getHttpServer())
      .post('/api/v1/connections/requests')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ targetUserId: b.userId, message: '希望交流行业经验' })
      .expect(201);
    const requestId = created.body.data.id;

    await request(app.getHttpServer())
      .post(`/api/v1/connections/requests/${requestId}/accept`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(201);

    const [pairs] = await dataSource.query('SELECT COUNT(*) AS c FROM connection_pairs WHERE status = ?', ['active']);
    expect(Number(pairs.c)).toBe(1);
  });

  it('接受前双方都看不到联系方式', async () => {
    const a = await seedAlumni('priv-a');
    const b = await seedAlumni('priv-b');

    const created = await request(app.getHttpServer())
      .post('/api/v1/connections/requests')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ targetUserId: b.userId, message: '希望建立联系' })
      .expect(201);
    const requestId = created.body.data.id;
    await request(app.getHttpServer())
      .post(`/api/v1/connections/requests/${requestId}/accept`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(201);

    // 已建立连接，但双方都未授权 → 仍不可见
    let list = await request(app.getHttpServer())
      .get('/api/v1/connections')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(200);
    expect(list.body.data.items[0].peerContact).toBeNull();

    // 仅一方授权 → 仍不可见
    const pairId = list.body.data.items[0].id;
    await request(app.getHttpServer())
      .put(`/api/v1/connections/${pairId}/contact-grant`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ allow: true })
      .expect(200);

    list = await request(app.getHttpServer())
      .get('/api/v1/connections')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(200);
    expect(list.body.data.items[0].peerContact).toBeNull();

    // 双方都授权 → 可见
    await request(app.getHttpServer())
      .put(`/api/v1/connections/${pairId}/contact-grant`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .send({ allow: true })
      .expect(200);

    list = await request(app.getHttpServer())
      .get('/api/v1/connections')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(200);
    expect(list.body.data.items[0].peerContact).not.toBeNull();
  });

  it('撤回授权后立即不可见', async () => {
    const a = await seedAlumni('revoke-a');
    const b = await seedAlumni('revoke-b');

    const created = await request(app.getHttpServer())
      .post('/api/v1/connections/requests')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ targetUserId: b.userId, message: '希望建立联系' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/connections/requests/${created.body.data.id}/accept`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(201);

    let list = await request(app.getHttpServer())
      .get('/api/v1/connections')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(200);
    const pairId = list.body.data.items[0].id;

    await request(app.getHttpServer())
      .put(`/api/v1/connections/${pairId}/contact-grant`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ allow: true })
      .expect(200);
    await request(app.getHttpServer())
      .put(`/api/v1/connections/${pairId}/contact-grant`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .send({ allow: true })
      .expect(200);

    list = await request(app.getHttpServer())
      .get('/api/v1/connections')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(200);
    expect(list.body.data.items[0].peerContact).not.toBeNull();

    // 对方撤回授权 → A 立即读不到
    await request(app.getHttpServer())
      .put(`/api/v1/connections/${pairId}/contact-grant`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .send({ allow: false })
      .expect(200);

    list = await request(app.getHttpServer())
      .get('/api/v1/connections')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(200);
    expect(list.body.data.items[0].peerContact).toBeNull();
  });

  it('同一对用户并发互申只产生一条待处理申请', async () => {
    const a = await seedAlumni('race-a');
    const b = await seedAlumni('race-b');

    const results = await Promise.allSettled([
      request(app.getHttpServer())
        .post('/api/v1/connections/requests')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({ targetUserId: b.userId, message: 'A 发起的第一条联系申请' }),
      request(app.getHttpServer())
        .post('/api/v1/connections/requests')
        .set('Authorization', `Bearer ${b.accessToken}`)
        .send({ targetUserId: a.userId, message: 'B 发起的第一条联系申请' }),
    ]);

    const okCount = results.filter((item) => item.status === 'fulfilled').length;
    expect(okCount).toBeGreaterThanOrEqual(1);

    const [pending] = await dataSource.query(
      "SELECT COUNT(*) AS c FROM connection_request_history WHERE status = 'pending'",
    );
    expect(Number(pending.c)).toBe(1);
  });

  it('重复提交同一申请是幂等的', async () => {
    const a = await seedAlumni('idem-a');
    const b = await seedAlumni('idem-b');

    const first = await request(app.getHttpServer())
      .post('/api/v1/connections/requests')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ targetUserId: b.userId, message: '希望交流行业经验' })
      .expect(201);

    const second = await request(app.getHttpServer())
      .post('/api/v1/connections/requests')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ targetUserId: b.userId, message: '希望交流行业经验' })
      .expect(200);

    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.idempotent).toBe(true);
    expect(first.body.data.idempotent).toBe(false);

    const [rows] = await dataSource.query(
      'SELECT COUNT(*) AS c FROM connection_request_history',
    );
    expect(Number(rows.c)).toBe(1);
  });

  it('重复点击接受是幂等的，且不会产生第二条连接关系', async () => {
    const a = await seedAlumni('accept-a');
    const b = await seedAlumni('accept-b');

    const created = await request(app.getHttpServer())
      .post('/api/v1/connections/requests')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ targetUserId: b.userId, message: '希望建立联系' })
      .expect(201);
    const id = created.body.data.id;

    await request(app.getHttpServer())
      .post(`/api/v1/connections/requests/${id}/accept`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/connections/requests/${id}/accept`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(201);

    const [pairs] = await dataSource.query('SELECT COUNT(*) AS c FROM connection_pairs');
    expect(Number(pairs.c)).toBe(1);
  });

  it('不能给自己发联系申请', async () => {
    const a = await seedAlumni('self-a');
    await request(app.getHttpServer())
      .post('/api/v1/connections/requests')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ targetUserId: a.userId, message: '给自己发申请' })
      .expect(400);
  });

  it('连接详情仅关系双方可见，且带联系方式授权状态', async () => {
    const a = await seedAlumni('detail-a');
    const b = await seedAlumni('detail-b');
    const outsider = await seedAlumni('detail-outsider');

    const created = await request(app.getHttpServer())
      .post('/api/v1/connections/requests')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ targetUserId: b.userId, message: '希望建立联系' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/connections/requests/${created.body.data.id}/accept`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(201);

    const list = await request(app.getHttpServer())
      .get('/api/v1/connections')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(200);
    const pairId = list.body.data.items[0].id;

    // 关系双方可读
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/connections/${pairId}`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(200);
    expect(detail.body.data.id).toBe(pairId);
    expect(detail.body.data.peerUserId).toBe(b.userId);
    expect(detail.body.data.peerContact).toBeNull();

    // 第三方不可读
    await request(app.getHttpServer())
      .get(`/api/v1/connections/${pairId}`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .expect(403);
  });

  it('对方关闭「接受联系申请」后无法发起申请', async () => {
    const a = await seedAlumni('closed-a');
    const b = await seedAlumni('closed-b');
    await setProfile(dataSource, b.userId, { accept_contact_requests: 0 });

    await request(app.getHttpServer())
      .post('/api/v1/connections/requests')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ targetUserId: b.userId, message: '希望建立联系' })
      .expect(403);
  });

  // ---------------------------------------------------------------------
  // 复核补漏（第二轮）：解除连接之后，详情接口不得再返回对方资料
  //
  // 此前 `getConnection()` **不校验关系状态**：
  //   列表接口只给 status='active' 的关系，详情接口却连已解除（revoked）
  //   的关系也照给 —— 对方的学院 / 地区 / 行业仍然拿得到。
  //   口径不一致 = 「解除连接」之后仍能查到对方资料。
  // ---------------------------------------------------------------------
  it('解除连接后：列表里没有、详情也 404（不得再返回对方资料）', async () => {
    const a = await seedAlumni('revoke-detail-a');
    const b = await seedAlumni('revoke-detail-b');

    const created = await request(app.getHttpServer())
      .post('/api/v1/connections/requests')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ targetUserId: b.userId, message: '希望建立联系' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/connections/requests/${created.body.data.id}/accept`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(201);

    const list = await request(app.getHttpServer())
      .get('/api/v1/connections')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(200);
    const pairId = list.body.data.items[0].id;

    // 解除关系
    await request(app.getHttpServer())
      .delete(`/api/v1/connections/${pairId}`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(200);

    // 列表里已经没有这条关系
    const afterList = await request(app.getHttpServer())
      .get('/api/v1/connections')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(200);
    expect(afterList.body.data.items.some((item: { id: number }) => item.id === pairId)).toBe(false);

    // 详情也必须 404（不得再返回对方的学院 / 地区 / 行业）
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/connections/${pairId}`)
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(detail.status).toBe(404);
    expect(detail.body.data).toBeNull();
  });
});
