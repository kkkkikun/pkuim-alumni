import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, login, markVerified, resetDatabase, setProfile } from '../helpers';

/**
 * 越权探测（水平 + 垂直）。
 *
 * 背景：本项目的核心承诺是隐私硬规则 —— 联系方式只在四重条件同时成立时才可见，
 *       任何「谁的资源谁才能改」的边界一旦失守，隐私承诺就形同虚设。
 *       现有验收流程（acceptance.e2e-spec.ts）验证的是**正常路径**上的可见性，
 *       但没有系统性地**主动攻击**：拿 A 的令牌去碰 B 的数据，看服务端是否真的拒绝。
 *
 * 本套件用三个用户构造攻击面：
 *   alice —— 关系发起方（与 bob 已建立连接对并授权联系方式）
 *   bob   —— 关系对方（持有资源、收到通知）
 *   carol —— 第三方（与 alice / bob 均无关系）
 *
 * 每个用例都断言「被拒绝」，任何一条返回 2xx 都视为安全缺陷。
 *
 * 设计约束：只走公开 HTTP 接口（除少量必要的数据库断言外），与生产同构。
 */

const API = '/api/v1';

describe('越权探测 · 水平与垂直', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const ctx: {
    aliceToken?: string;
    aliceUserId?: number;
    bobToken?: string;
    bobUserId?: number;
    carolToken?: string;
    carolUserId?: number;
    connectionRequestId?: number;
    connectionPairId?: number;
    resourceId?: number;
    bobNotificationId?: number;
    verificationId?: number;
  } = {};

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
    await resetDatabase(dataSource);

    const server = () => request(app.getHttpServer());

    /* ---------- 三个用户：均已认证并开启隐私开关 ---------- */
    const alice = await login(app, 'authz-alice', '越权甲');
    const bob = await login(app, 'authz-bob', '越权乙');
    const carol = await login(app, 'authz-carol', '越权丙');
    ctx.aliceToken = alice.accessToken;
    ctx.aliceUserId = alice.userId;
    ctx.bobToken = bob.accessToken;
    ctx.bobUserId = bob.userId;
    ctx.carolToken = carol.accessToken;
    ctx.carolUserId = carol.userId;

    for (const [session, wechat] of [
      [alice, 'authz_alice'],
      [bob, 'authz_bob'],
      [carol, 'authz_carol'],
    ] as const) {
      await markVerified(dataSource, session.userId);
      await setProfile(dataSource, session.userId, {
        display_name: session === alice ? '越权甲' : session === bob ? '越权乙' : '越权丙',
        show_in_directory: 1,
        accept_contact_requests: 1,
        allow_contact_share: 1,
      });
      await server()
        .put(`${API}/me/contacts`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({
          contactPhone: `1380000${String(session.userId).padStart(4, '0')}`,
          contactWechat: wechat,
          contactEmail: `${wechat}@example.com`,
        })
        .expect(200);
    }

    /* ---------- alice 向 bob 发起联系申请并被接受 ---------- */
    const request_ = await server()
      .post(`${API}/connections/requests`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({ targetUserId: ctx.bobUserId, message: '越权探测用联系申请' })
      .expect(201);
    ctx.connectionRequestId = request_.body.data.id;

    await server()
      .post(`${API}/connections/requests/${ctx.connectionRequestId}/accept`)
      .set('Authorization', `Bearer ${ctx.bobToken}`)
      .expect(201);

    // 连接对 id 从连接列表取（pair.id）
    const pairList = await server()
      .get(`${API}/connections`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(200);
    ctx.connectionPairId = pairList.body.data.items?.[0]?.id;
    expect(ctx.connectionPairId).toBeDefined();

    // **双方**授权才满足可见性四重条件之一
    await server()
      .put(`${API}/connections/${ctx.connectionPairId}/contact-grant`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({ allow: true })
      .expect(200);
    await server()
      .put(`${API}/connections/${ctx.connectionPairId}/contact-grant`)
      .set('Authorization', `Bearer ${ctx.bobToken}`)
      .send({ allow: true })
      .expect(200);

    /* ---------- bob 发布一条资源 ---------- */
    const resource = await server()
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${ctx.bobToken}`)
      .send({
        type: 'resource',
        title: '越权探测用资源条目',
        body: '这是一段用于越权探测的资源描述正文，内容长度满足最小校验要求。',
        industryCode: 'ENER',
        regionCode: 'HHS',
      })
      .expect(201);
    ctx.resourceId = resource.body.data.id;

    /* ---------- bob 因收到联系申请而收到通知 ---------- */
    const notifications = await server()
      .get(`${API}/notifications`)
      .set('Authorization', `Bearer ${ctx.bobToken}`)
      .expect(200);
    ctx.bobNotificationId = notifications.body.data.items[0]?.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => request(app.getHttpServer());

  /* ================= 水平越权：第三方 carol 触碰 alice ↔ bob 的关系 ================= */

  it('第三方读取他人连接关系详情 → 拒绝', async () => {
    await server()
      .get(`${API}/connections/${ctx.connectionPairId}`)
      .set('Authorization', `Bearer ${ctx.carolToken}`)
      .expect(403);
  });

  it('第三方解除他人连接关系 → 拒绝且关系仍在', async () => {
    await server()
      .delete(`${API}/connections/${ctx.connectionPairId}`)
      .set('Authorization', `Bearer ${ctx.carolToken}`)
      .expect(403);

    const rows = await dataSource.query('SELECT status FROM connection_pairs WHERE id = ?', [
      ctx.connectionPairId,
    ]);
    expect(rows[0]?.status).toBe('active');
  });

  it('第三方替他人授权 / 撤回联系方式 → 拒绝且授权状态不变', async () => {
    await server()
      .put(`${API}/connections/${ctx.connectionPairId}/contact-grant`)
      .set('Authorization', `Bearer ${ctx.carolToken}`)
      .send({ allow: false })
      .expect(403);

    const rows = await dataSource.query(
      'SELECT allow FROM contact_share_grants WHERE pair_id = ? AND user_id = ?',
      [ctx.connectionPairId, ctx.aliceUserId],
    );
    expect(Number(rows[0]?.allow)).toBe(1);
  });

  it('第三方查看他人的联系申请详情 → 拒绝', async () => {
    await server()
      .get(`${API}/connections/requests/${ctx.connectionRequestId}`)
      .set('Authorization', `Bearer ${ctx.carolToken}`)
      .expect(403);
  });

  it('发起方替对方接受自己的申请 → 拒绝', async () => {
    // alice 另发一条给 carol 的申请，尝试由 alice 自行接受
    const created = await server()
      .post(`${API}/connections/requests`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({ targetUserId: ctx.carolUserId, message: '自accept尝试' })
      .expect(201);

    await server()
      .post(`${API}/connections/requests/${created.body.data.id}/accept`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(403);
  });

  /* ================= 水平越权：alice 触碰 bob 的私有数据 ================= */

  it('读取他人的通知详情 → 拒绝', async () => {
    expect(ctx.bobNotificationId).toBeDefined();
    await server()
      .get(`${API}/notifications/${ctx.bobNotificationId}`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(404);
  });

  it('标记他人通知为已读 → 不生效（对方仍为未读）', async () => {
    expect(ctx.bobNotificationId).toBeDefined();
    // 语义变更（缺陷 #124）：不是自己的通知 → **404**，
    // 与 `GET /notifications/:id`（对别人的通知也是 404）保持一致，
    // 既不生效、也不泄露「这条通知存在」。
    await server()
      .post(`${API}/notifications/${ctx.bobNotificationId}/read`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(404);

    const rows = await dataSource.query('SELECT read_at FROM notifications WHERE id = ?', [
      ctx.bobNotificationId,
    ]);
    expect(rows[0]?.read_at ?? null).toBeNull();
  });

  it('修改他人发布的资源 → 拒绝', async () => {
    await server()
      .patch(`${API}/resources/${ctx.resourceId}`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({ title: '被越权修改的标题' })
      .expect(403);
  });

  it('提交他人资源进入审核 → 拒绝', async () => {
    await server()
      .post(`${API}/resources/${ctx.resourceId}/submit`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(403);
  });

  it('撤回他人资源 → 拒绝', async () => {
    await server()
      .post(`${API}/resources/${ctx.resourceId}/withdraw`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(403);
  });

  it('查看他人的认证申请详情 → 拒绝', async () => {
    // 直接在库里插入一条认证申请：走 HTTP 提交会把提交人的 stage 改成
    // pending_review，导致后续用例被「校友身份认证」守卫拦下（自伤）。
    const profiles = await dataSource.query(
      'SELECT real_name, display_name, college, graduation_year, degree FROM alumni_profiles WHERE user_id = ?',
      [ctx.carolUserId],
    );
    const profile = profiles[0] ?? {};
    await dataSource.query(
      `INSERT INTO verification_applications
         (user_id, real_name, college, graduation_year, degree, student_id_masked, remark,
          status, submitted_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NOW(3), 0, NOW(3), NOW(3))`,
      [
        ctx.carolUserId,
        profile.real_name ?? profile.display_name ?? '越权丙',
        profile.college ?? '未填写',
        profile.graduation_year ?? 2015,
        profile.degree ?? null,
        '****8888',
        '【越权探测】测试用认证申请。',
      ],
    );
    const idRows = await dataSource.query('SELECT LAST_INSERT_ID() AS id');
    ctx.verificationId = Number((idRows[0] as { id?: number | string } | undefined)?.id ?? 0);
    expect(ctx.verificationId).toBeGreaterThan(0);

    await server()
      .get(`${API}/alumni/verification/${ctx.verificationId}`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(403);
  });

  it('查看他人的认证审核历史 → 拒绝', async () => {
    await server()
      .get(`${API}/alumni/verification/${ctx.verificationId}/history`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(403);
  });

  /* ================= 隐私：第三方看不到联系方式 ================= */

  it('第三方查看校友公开名片 → 不含联系方式', async () => {
    const profile = await server()
      .get(`${API}/alumni/${ctx.bobUserId}`)
      .set('Authorization', `Bearer ${ctx.carolToken}`)
      .expect(200);

    const serialized = JSON.stringify(profile.body);
    expect(serialized).not.toContain('authz_bob');
    expect(serialized).not.toContain(`1380000${String(ctx.bobUserId).padStart(4, '0')}`);
  });

  it('关系方在双方授权后可见联系方式', async () => {
    // 对照组：授权成立时应当可见，确保上面的「不可见」不是因为字段根本没返回
    const connections = await server()
      .get(`${API}/connections`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(200);

    const peer = connections.body.data.items?.find(
      (item: { peerUserId?: number }) => item.peerUserId === ctx.bobUserId,
    );
    expect(peer).toBeDefined();
    expect(peer.peerContact).not.toBeNull();
    expect(peer.peerContact.wechat).toBe('authz_bob');
  });

  /* ================= 垂直越权：普通校友触碰管理端 ================= */

  it('普通校友访问管理端总览 → 拒绝', async () => {
    await server()
      .get(`${API}/admin/stats`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(403);
  });

  it('普通校友访问管理端用户列表 → 拒绝', async () => {
    await server()
      .get(`${API}/admin/users`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(403);
  });

  it('普通校友尝试修改他人账号状态 → 拒绝', async () => {
    // 管理端路由已收敛到 /admin 命名空间（缺陷 #52）
    await server()
      .patch(`${API}/admin/users/${ctx.bobUserId}/status`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({ status: 'disabled' })
      .expect(403);
  });

  it('未登录访问本人资料 → 拒绝', async () => {
    await server().get(`${API}/me`).expect(401);
  });

  /* ================= 边界：非法与不存在的 id ================= */

  it('非法 id（非数字）→ 400 参数错误', async () => {
    await server()
      .get(`${API}/connections/not-a-number`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(400);
  });

  it('不存在的连接关系 id → 404（不返回 403 以免区分「存在但无权限」）', async () => {
    await server()
      .get(`${API}/connections/999999999`)
      .set('Authorization', `Bearer ${ctx.carolToken}`)
      .expect(404);
  });
});
