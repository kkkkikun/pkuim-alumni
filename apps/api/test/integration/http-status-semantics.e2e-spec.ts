import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, ensureAdmin, login, markVerified, resetDatabase, setProfile } from '../helpers';

/**
 * HTTP 状态码的**语义**（缺陷 #126）。
 *
 * HTTP 规范里 **201 Created** 的含义是「本次请求**创建了**新资源」，
 * 并且**应当**带 `Location` 头指向它。
 * 而仓库里有一批 POST 端点**根本不创建任何资源** ——
 * 它们只是「改一个状态」：
 *   标记通知已读 / 全部已读、拒绝联系申请、撤回联系申请、
 *   提交审核、撤回发布、启用停用账号（PATCH 的兼容别名）。
 * 这些端点却都返回了 **201**（Nest 对 POST 的默认值，从没人改过）。
 *
 * 最刺眼的一处是 `POST /admin/users/:id/status`：
 * 它是 `PATCH /admin/users/:id/status` 的**兼容别名**（API-SPEC 明写「建议改用 PATCH」），
 * 却和 PATCH 版本返回**不同的状态码**（POST 201 / PATCH 200）——
 * 同一个操作、两条路径、两种答案。
 *
 * 仓库自己已经有正确做法：活动报名**第一次** 201、**幂等命中** 200，
 * 是显式设置的 —— 说明「只有真的创建了资源才 201」是本仓库的既定约定。
 *
 * 对照组同样重要：真的创建了资源的 POST 端点**必须仍然是 201**。
 */
const API = '/api/v1';

describe('HTTP 状态码的语义 (e2e)', () => {
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

  async function verifiedUser(openid: string) {
    const session = await login(app, openid);
    await markVerified(dataSource, session.userId);
    // 接受联系申请（否则发起联系申请会被 403）
    await setProfile(dataSource, session.userId, { accept_contact_requests: 1 });
    return session;
  }

  /* ---------------- 不创建资源的 POST → 200 ---------------- */

  it('#126 标记通知已读 / 全部已读 → 200（不创建任何资源）', async () => {
    const user = await verifiedUser('status-notif');
    await dataSource.query(
      `INSERT INTO notifications (user_id, type, title, body, payload, read_at, created_at)
       VALUES (?, 'system', '状态码用例通知', '正文', NULL, NULL, NOW(3))`,
      [user.userId],
    );
    const [row] = await dataSource.query('SELECT id FROM notifications LIMIT 1');

    await server()
      .post(`${API}/notifications/${row.id}/read`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    await server()
      .post(`${API}/notifications/read-all`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
  });

  it('#126 启用/停用账号：POST 兼容别名与 PATCH 必须返回相同的状态码', async () => {
    const user = await verifiedUser('status-alias');

    const patched = await server()
      .patch(`${API}/admin/users/${user.userId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'disabled', reason: '状态码用例' });
    const posted = await server()
      .post(`${API}/admin/users/${user.userId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'active', reason: '状态码用例' });

    expect(patched.status).toBe(200);
    expect(posted.status).toBe(patched.status);
  });

  it('#126 拒绝 / 撤回联系申请 → 200（只是改状态，不创建资源）', async () => {
    const from = await verifiedUser('status-req-from');
    const to = await verifiedUser('status-req-to');

    const created = await server()
      .post(`${API}/connections/requests`)
      .set('Authorization', `Bearer ${from.accessToken}`)
      .send({ targetUserId: to.userId, message: '状态码用例的申请' })
      .expect(201);

    await server()
      .post(`${API}/connections/requests/${created.body.data.id}/reject`)
      .set('Authorization', `Bearer ${to.accessToken}`)
      .expect(200);
  });

  it('#126 提交审核 / 撤回发布 → 200（只是改状态，不创建资源）', async () => {
    const user = await verifiedUser('status-resource');
    const created = await server()
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        type: 'resource',
        title: '状态码用例的资源条目',
        body: '这是一段用于状态码用例的资源描述正文，内容长度满足最小校验要求。',
        industryCode: 'ENER',
        regionCode: 'HHS',
      })
      .expect(201);
    const resourceId = created.body.data.id as number;

    await server()
      .post(`${API}/resources/${resourceId}/withdraw`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    await server()
      .post(`${API}/resources/${resourceId}/submit`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
  });

  /* ---------------- 真的创建资源的 POST → 仍然 201 ---------------- */

  it('#126 对照：真的创建了资源的 POST 端点必须仍然是 201', async () => {
    // ⚠️ 每个用例用**不同的用户**：
    //   提交认证申请会把用户阶段改成「待审核」，
    //   之后它就发不了联系申请、也报不了名了（需要 verified 身份）。
    const verifier = await verifiedUser('status-created-verify');
    const requester = await verifiedUser('status-created-req');
    const target = await verifiedUser('status-created-target');
    const attendee = await verifiedUser('status-created-attend');

    // 认证申请 → 创建了申请记录
    await server()
      .post(`${API}/alumni/verification`)
      .set('Authorization', `Bearer ${verifier.accessToken}`)
      .send({
        realName: '状态码用例校友',
        college: '经济学院',
        graduationYear: 2015,
        studentIdMasked: '2015****1234',
      })
      .expect(201);

    // 联系申请 → 创建了申请记录
    await server()
      .post(`${API}/connections/requests`)
      .set('Authorization', `Bearer ${requester.accessToken}`)
      .send({ targetUserId: target.userId, message: '状态码对照组' })
      .expect(201);

    // 活动报名 → 创建了报名记录
    await dataSource.query(
      `INSERT INTO events (title, kind, capacity, registered_count, status, created_at, updated_at)
       VALUES ('状态码用例活动', '校友交流', 5, 0, 'published', NOW(3), NOW(3))`,
    );
    const [event] = await dataSource.query('SELECT id FROM events ORDER BY id DESC LIMIT 1');
    await server()
      .post(`${API}/events/${event.id}/registrations`)
      .set('Authorization', `Bearer ${attendee.accessToken}`)
      .send({})
      .expect(201);

    // 管理端创建活动 → 创建了活动
    await server()
      .post(`${API}/admin/events`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: '状态码用例的管理端活动', kind: '沙龙', capacity: 10 })
      .expect(201);
  });
});
