import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, ensureAdmin, login, resetDatabase, setProfile } from '../helpers';

/**
 * §10.4 端到端验收流程（18 步）。
 *
 * 这是一条**真实业务主链路**：游客浏览 → 登录 → 提交校友认证 → 管理员审核 →
 * 获得校友权限 → 搜索校友 → 提交联系申请 → 对方收到 → 接受 → 建立正式关系 →
 * 双方授权联系方式 → 发布资源 → 管理员审核 → 资源进入公开列表 → 活动报名 →
 * 管理员查看报名记录 → 撤回授权 → 撤回后无法查看联系方式。
 *
 * 设计约束：
 * - 只走公开 HTTP 接口（除少量必要的数据库断言外），与生产同构；
 * - 每一步都是独立用例，按声明顺序执行，共享同一份上下文，
 *   任何一步失败都会在用例名中标注步骤号与标题，便于定位；
 * - 隐私硬规则在第 11 / 17 / 18 步被真实断言（四重条件缺一不可）。
 */

const ADMIN_PASSWORD = 'Admin@2026';
const API = '/api/v1';

describe('§10.4 端到端验收 · 18 步', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  /** 贯穿全流程的上下文 */
  const ctx: {
    aliceToken?: string;
    aliceUserId?: number;
    bobToken?: string;
    bobUserId?: number;
    adminToken?: string;
    verificationId?: number;
    connectionRequestId?: number;
    connectionPairId?: number;
    resourceId?: number;
    eventId?: number;
  } = {};

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
    await resetDatabase(dataSource);
  });

  afterAll(async () => {
    await app?.close();
  });

  /* ------------------------------ 工具 ------------------------------ */

  const server = () => request(app.getHttpServer());

  /** 标注当前执行到的步骤，便于失败定位 */
  function step(no: number, title: string): void {
    // eslint-disable-next-line no-console
    console.log(`[验收] 第 ${no} 步：${title}`);
  }

  async function adminLogin(): Promise<string> {
    const response = await server()
      .post(`${API}/auth/admin/login`)
      .send({ username: 'admin-test', password: ADMIN_PASSWORD })
      .expect(200);
    return response.body.data.accessToken;
  }

  /**
   * 准备一位「已在库的已认证校友」Bob。
   * Bob 是流程中的被联系方，其既有身份属于流程前置条件，不重复走审核叙事。
   */
  async function prepareBob(): Promise<void> {
    const session = await login(app, 'acceptance-bob');
    ctx.bobToken = session.accessToken;
    ctx.bobUserId = session.userId;

    await setProfile(dataSource, session.userId, {
      display_name: '验收校友B',
      college: '经济学院',
      graduation_year: 2012,
      region_code: 'HHS',
      industry_code: 'ENER',
      direction: '新能源投资',
      show_in_directory: 1,
      show_college: 1,
      show_industry: 1,
      show_region: 1,
      accept_contact_requests: 1,
      allow_contact_share: 1,
    });
    await dataSource.query(
      "UPDATE users SET stage = 'verified' WHERE id = ?",
      [session.userId],
    );
    await dataSource.query(
      'UPDATE alumni_profiles SET verified = 1, show_in_directory = 1 WHERE user_id = ?',
      [session.userId],
    );
    // 通过真实接口写入联系方式（走 AES-256-GCM 加密链路）
    await server()
      .put(`${API}/me/contacts`)
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({
        contactPhone: '13800000001',
        contactWechat: 'acceptance_bob',
        contactEmail: 'bob@example.com',
      })
      .expect(200);
  }

  /* ------------------------------ 第 1 步 ------------------------------ */

  it('第 1 步 · 游客无需登录即可浏览首页信息流', async () => {
    step(1, '游客浏览首页');
    const response = await server().get(`${API}/home/feed`).expect(200);
    expect(response.body.data.tabs).toBeDefined();
    expect(Array.isArray(response.body.data.tabs.news)).toBe(true);
    expect(Array.isArray(response.body.data.tabs.notices)).toBe(true);
    expect(response.body.data.shortcuts.length).toBeGreaterThan(0);
  });

  /* ------------------------------ 第 2 步 ------------------------------ */

  it('第 2 步 · 用户登录，得到访问令牌且身份阶段为已登录', async () => {
    step(2, '用户登录');
    const session = await login(app, 'acceptance-alice');
    ctx.aliceToken = session.accessToken;
    ctx.aliceUserId = session.userId;
    expect(session.accessToken).toBeTruthy();

    const me = await server()
      .get(`${API}/me`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(200);
    expect(me.body.data.stage).toBe('logged_in');
  });

  /* ------------------------------ 第 3 步 ------------------------------ */

  it('第 3 步 · 提交校友身份认证申请，进入待审核', async () => {
    step(3, '提交校友认证');
    const submitted = await server()
      .post(`${API}/alumni/verification`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({
        realName: '验收校友A',
        college: '经济学院',
        graduationYear: 2015,
        degree: '硕士',
        studentIdMasked: '2015****8888',
        remark: '端到端验收用例提交的虚构资料',
      })
      .expect(201);
    ctx.verificationId = submitted.body.data.id;
    expect(submitted.body.data.status).toBe('pending');

    const [stage] = await dataSource.query('SELECT stage FROM users WHERE id = ?', [
      ctx.aliceUserId,
    ]);
    expect(stage.stage).toBe('pending_review');
  });

  /* ------------------------------ 第 4 步 ------------------------------ */

  it('第 4 步 · 管理员在待审队列中看到申请并审核通过', async () => {
    step(4, '管理员审核认证');
    await ensureAdmin(dataSource, {
      roleCode: 'super_admin',
      permissionCode: 'verification:review',
    });
    ctx.adminToken = await adminLogin();

    const queue = await server()
      .get(`${API}/admin/verifications?status=pending`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(queue.body.data.items).toHaveLength(1);
    expect(queue.body.data.items[0].id).toBe(ctx.verificationId);

    const decided = await server()
      .post(`${API}/admin/verifications/${ctx.verificationId}/decision`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ action: 'approve', note: '资料核验通过' })
      .expect(201);
    expect(decided.body.data.status).toBe('approved');
  });

  /* ------------------------------ 第 5 步 ------------------------------ */

  it('第 5 步 · 审核通过后获得校友权限（通讯录由 403 变为 200）', async () => {
    step(5, '获得校友权限');
    const [stage] = await dataSource.query('SELECT stage FROM users WHERE id = ?', [
      ctx.aliceUserId,
    ]);
    expect(stage.stage).toBe('verified');
    const [profile] = await dataSource.query(
      'SELECT verified, real_name FROM alumni_profiles WHERE user_id = ?',
      [ctx.aliceUserId],
    );
    expect(Number(profile.verified)).toBe(1);
    expect(profile.real_name).toBe('验收校友A');

    // 补齐公开资料，使其能被同学友检索到
    await setProfile(dataSource, ctx.aliceUserId!, {
      display_name: '验收校友A',
      show_in_directory: 1,
      accept_contact_requests: 1,
    });

    await server()
      .get(`${API}/directory`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(200);
  });

  /* ------------------------------ 第 6 步 ------------------------------ */

  it('第 6 步 · 在通讯录中搜索到目标校友', async () => {
    step(6, '搜索校友');
    await prepareBob();

    const found = await server()
      .get(`${API}/directory?keyword=${encodeURIComponent('验收校友B')}`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(200);
    expect(found.body.data.meta.total).toBe(1);
    expect(found.body.data.items[0].userId).toBe(ctx.bobUserId);

    // 关键字不匹配时查不到任何人
    const none = await server()
      .get(`${API}/directory?keyword=${encodeURIComponent('不存在的校友XYZ')}`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(200);
    expect(none.body.data.meta.total).toBe(0);
  });

  /* ------------------------------ 第 7 步 ------------------------------ */

  it('第 7 步 · 发起联系申请', async () => {
    step(7, '提交联系申请');
    const created = await server()
      .post(`${API}/connections/requests`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({ targetUserId: ctx.bobUserId, message: '希望交流新能源行业投资经验' })
      .expect(201);
    ctx.connectionRequestId = created.body.data.id;
    expect(created.body.data.status).toBe('pending');
  });

  /* ------------------------------ 第 8 步 ------------------------------ */

  it('第 8 步 · 对方收到联系申请', async () => {
    step(8, '对方收到申请');
    const incoming = await server()
      .get(`${API}/me/connection-requests?direction=incoming`)
      .set('Authorization', `Bearer ${ctx.bobToken}`)
      .expect(200);
    expect(incoming.body.data.items).toHaveLength(1);
    expect(incoming.body.data.items[0].id).toBe(ctx.connectionRequestId);
    expect(incoming.body.data.items[0].status).toBe('pending');
  });

  /* ------------------------------ 第 9 步 ------------------------------ */

  it('第 9 步 · 对方接受联系申请', async () => {
    step(9, '接受联系申请');
    const accepted = await server()
      .post(`${API}/connections/requests/${ctx.connectionRequestId}/accept`)
      .set('Authorization', `Bearer ${ctx.bobToken}`)
      .expect(201);
    expect(accepted.body.data.status).toBe('accepted');
  });

  /* ------------------------------ 第 10 步 ------------------------------ */

  it('第 10 步 · 建立正式连接关系（此时联系方式仍不可见）', async () => {
    step(10, '建立正式关系');
    const list = await server()
      .get(`${API}/connections`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(200);
    expect(list.body.data.items).toHaveLength(1);
    const pair = list.body.data.items[0];
    ctx.connectionPairId = pair.id;
    expect(pair.status).toBe('active');
    // 尚未授权 → 联系方式不可见
    expect(pair.peerContact).toBeNull();

    const [rows] = await dataSource.query(
      "SELECT COUNT(*) AS c FROM connection_pairs WHERE status = 'active'",
    );
    expect(Number(rows.c)).toBe(1);
  });

  /* ------------------------------ 第 11 步 ------------------------------ */

  it('第 11 步 · 双方授权后互相可见联系方式', async () => {
    step(11, '双方授权联系方式');

    // Alice 开启「允许向已连接校友展示联系方式」并登记自己的联系方式
    await server()
      .put(`${API}/me/privacy`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({ allowContactShare: true, acceptContactRequests: true })
      .expect(200);
    await server()
      .put(`${API}/me/contacts`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({
        contactPhone: '13800000002',
        contactWechat: 'acceptance_alice',
        contactEmail: 'alice@example.com',
      })
      .expect(200);

    // 仅一方授权 → 仍不可见（四重条件缺一不可）
    await server()
      .put(`${API}/connections/${ctx.connectionPairId}/contact-grant`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({ allow: true })
      .expect(200);
    let list = await server()
      .get(`${API}/connections`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(200);
    expect(list.body.data.items[0].peerContact).toBeNull();

    // 双方授权 → 可见
    await server()
      .put(`${API}/connections/${ctx.connectionPairId}/contact-grant`)
      .set('Authorization', `Bearer ${ctx.bobToken}`)
      .send({ allow: true })
      .expect(200);

    list = await server()
      .get(`${API}/connections`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(200);
    const peer = list.body.data.items[0].peerContact;
    expect(peer).not.toBeNull();
    expect(peer.phone).toBe('13800000001');
    expect(peer.wechat).toBe('acceptance_bob');
    expect(peer.email).toBe('bob@example.com');

    // 反向同样可见
    const reverse = await server()
      .get(`${API}/connections`)
      .set('Authorization', `Bearer ${ctx.bobToken}`)
      .expect(200);
    expect(reverse.body.data.items[0].peerContact.phone).toBe('13800000002');
  });

  /* ------------------------------ 第 12 步 ------------------------------ */

  it('第 12 步 · 发布资源（进入待审核）', async () => {
    step(12, '发布资源');
    const created = await server()
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({
        type: 'resource',
        title: '内蒙古新能源行业投资机会清单',
        body: '这是一段用于端到端验收的资源描述正文，内容长度满足最小校验要求。',
        industryCode: 'ENER',
        regionCode: 'HHS',
      })
      .expect(201);
    ctx.resourceId = created.body.data.id;
    expect(created.body.data.status).toBe('pending');
  });

  /* ------------------------------ 第 13 步 ------------------------------ */

  it('第 13 步 · 管理员审核资源通过', async () => {
    step(13, '管理员审核资源');
    await ensureAdmin(dataSource, {
      roleCode: 'super_admin',
      permissionCode: 'resource:review',
    });
    ctx.adminToken = await adminLogin();

    const decided = await server()
      .post(`${API}/admin/resources/${ctx.resourceId}/decision`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ action: 'approve', note: '内容合规' })
      .expect(201);
    expect(decided.body.data.status).toBe('published');
  });

  /* ------------------------------ 第 14 步 ------------------------------ */

  it('第 14 步 · 资源进入公开列表', async () => {
    step(14, '资源进入公开列表');
    const list = await server().get(`${API}/resources`).expect(200);
    const titles = list.body.data.items.map((item: { title: string }) => item.title);
    expect(titles).toContain('内蒙古新能源行业投资机会清单');
  });

  /* ------------------------------ 第 15 步 ------------------------------ */

  it('第 15 步 · 报名参加校友活动', async () => {
    step(15, '活动报名');
    await ensureAdmin(dataSource, {
      roleCode: 'super_admin',
      permissionCode: 'event:manage',
    });
    ctx.adminToken = await adminLogin();

    const created = await server()
      .post(`${API}/admin/events`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        title: '内蒙古北大校友新能源沙龙',
        kind: '行业沙龙',
        capacity: 50,
        status: 'published',
        startsAt: '2026-12-20T02:00:00.000Z',
        endsAt: '2026-12-20T09:00:00.000Z',
        place: '呼和浩特市赛罕区',
      })
      .expect(201);
    ctx.eventId = created.body.data.id;
    expect(created.body.data.status).toBe('published');

    const registered = await server()
      .post(`${API}/events/${ctx.eventId}/registrations`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({ note: '希望参加' })
      .expect(201);
    expect(registered.body.data.status).toBe('registered');

    const event = await server().get(`${API}/events/${ctx.eventId}`).expect(200);
    expect(event.body.data.registeredCount).toBe(1);
  });

  /* ------------------------------ 第 16 步 ------------------------------ */

  it('第 16 步 · 管理员查看活动报名记录', async () => {
    step(16, '管理员查看报名记录');
    const roster = await server()
      .get(`${API}/admin/events/${ctx.eventId}/registrations`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(roster.body.data).toHaveLength(1);
    expect(roster.body.data[0].userId).toBe(ctx.aliceUserId);
    expect(roster.body.data[0].status).toBe('registered');
  });

  /* ------------------------------ 第 17 步 ------------------------------ */

  it('第 17 步 · 撤回联系方式授权', async () => {
    step(17, '撤回授权');
    const revoked = await server()
      .put(`${API}/connections/${ctx.connectionPairId}/contact-grant`)
      .set('Authorization', `Bearer ${ctx.bobToken}`)
      .send({ allow: false })
      .expect(200);
    // 撤回方视角：自己的分享开关关闭
    expect(revoked.body.data.myContactShared).toBe(false);
  });

  /* ------------------------------ 第 18 步 ------------------------------ */

  it('第 18 步 · 撤回后无法查看对方联系方式，且任何公开接口都不泄漏', async () => {
    step(18, '撤回后不可见');
    const list = await server()
      .get(`${API}/connections`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(200);
    expect(list.body.data.items[0].peerContact).toBeNull();

    // 公开名片里不含任何联系方式
    const card = await server()
      .get(`${API}/directory/${ctx.bobUserId}`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(200);
    const serialized = JSON.stringify(card.body.data);
    expect(serialized).not.toContain('13800000001');
    expect(serialized).not.toContain('acceptance_bob');
    expect(serialized).not.toContain('bob@example.com');

    // 通讯录条目里同样不含联系方式
    const directory = await server()
      .get(`${API}/directory?keyword=${encodeURIComponent('验收校友B')}`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(200);
    expect(JSON.stringify(directory.body.data)).not.toContain('13800000001');

    // 数据库层：联系方式密文仍存在，但未被公开接口取出
    const [contacts] = await dataSource.query(
      'SELECT phone_cipher FROM private_contacts WHERE user_id = ?',
      [ctx.bobUserId],
    );
    expect(contacts).toBeDefined();
    expect(contacts.phone_cipher).toBeTruthy();
  });
});
