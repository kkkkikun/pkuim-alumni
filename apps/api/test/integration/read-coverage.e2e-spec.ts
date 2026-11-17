import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import {
  createTestApp,
  DICT,
  ensureAdmin,
  login,
  markVerified,
  resetDatabase,
  setProfile,
} from '../helpers';

/**
 * 读端点覆盖补测：把**从未被集成测试调用过**的读路径全部跑一遍。
 *
 * 背景：端点覆盖分析推进到「写操作 0 条未覆盖」之后，
 *       剩下 20 条全是读端点。读端点风险低于写端点，
 *       但**从未被调用过**同样意味着：
 *       没人知道它返回的到底是不是承诺的结构 —— 契约写了，代码也写了，
 *       中间却没有一次真实往返。
 *
 * 本套件的断言策略：
 *   - 分页类端点：断言 `items` 是数组、`meta` 存在且页码自洽；
 *   - 详情类端点：断言关键标识字段与请求的目标一致；
 *   - 字典 / 健康检查：断言字段结构与依赖状态。
 */

const API = '/api/v1';

/** 兼容「直接返回数组」与「返回 PageResult」两种列表形态 */
function expectListPayload(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const items = (data as { items?: unknown[] } | null)?.items;
  expect(Array.isArray(items)).toBe(true);
  return items ?? [];
}

describe('读端点覆盖补测', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const ctx: {
    adminToken?: string;
    aliceToken?: string;
    aliceUserId?: number;
    resourceId?: number;
    verificationId?: number;
    noticeId?: number;
    eventId?: number;
  } = {};

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
    await resetDatabase(dataSource);

    // 读端点覆盖到的五类管理权限
    for (const permissionCode of [
      'alumni:view',
      'verification:review',
      'resource:review',
      'event:manage',
      'content:manage',
    ]) {
      await ensureAdmin(dataSource, { permissionCode });
    }

    const adminLogin = await request(app.getHttpServer())
      .post(`${API}/auth/admin/login`)
      .send({ username: 'admin-test', password: 'Admin@2026' })
      .expect(200);
    ctx.adminToken = adminLogin.body.data.accessToken;

    // 已认证且公开档案的校友
    const alice = await login(app, 'rc-alice', '读覆盖甲');
    ctx.aliceToken = alice.accessToken;
    ctx.aliceUserId = alice.userId;
    await markVerified(dataSource, alice.userId);
    await setProfile(dataSource, alice.userId, {
      show_in_directory: 1,
      region_code: DICT.regions.hohhot,
      industry_code: DICT.industries.energy,
    });

    // 未认证用户：用来造一条在途认证申请
    const carol = await login(app, 'rc-carol', '读覆盖丙');
    const submitted = await request(app.getHttpServer())
      .post(`${API}/alumni/verification`)
      .set('Authorization', `Bearer ${carol.accessToken}`)
      .send({
        realName: '读覆盖校友',
        college: '经济学院',
        graduationYear: 2015,
        degree: '学士',
        studentIdMasked: '2015****1234',
        remark: '测试用虚构资料',
      })
      .expect(201);
    ctx.verificationId = submitted.body.data.id;

    // 已发布资源
    const created = await request(app.getHttpServer())
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({
        type: 'resource',
        title: '读覆盖用资源',
        body: '这是一段用于测试的资源描述内容，长度满足校验要求。',
        industryCode: DICT.industries.energy,
        regionCode: DICT.regions.hohhot,
      })
      .expect(201);
    ctx.resourceId = created.body.data.id;
    await request(app.getHttpServer())
      .post(`${API}/admin/resources/${ctx.resourceId}/decision`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ action: 'approve', note: '内容合规' })
      .expect(201);

    // 已发布公告
    const notice = await request(app.getHttpServer())
      .post(`${API}/admin/notices`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ title: '读覆盖用公告', body: '公告正文', status: 'published' })
      .expect(201);
    ctx.noticeId = notice.body.data.id;

    // 活动 + 报名
    const event = await request(app.getHttpServer())
      .post(`${API}/admin/events`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ title: '读覆盖用活动', kind: '校友聚会', capacity: 10, status: 'published' })
      .expect(201);
    ctx.eventId = event.body.data.id;
    await request(app.getHttpServer())
      .post(`${API}/events/${ctx.eventId}/registrations`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({})
      .expect(201);
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => request(app.getHttpServer());

  /* ------------------------- 管理端读端点 ------------------------- */

  it('GET /admin/users/:id → 返回该普通账号的详情', async () => {
    const res = await server()
      .get(`${API}/admin/users/${ctx.aliceUserId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(res.body.data.id).toBe(ctx.aliceUserId);
    expect(res.body.data.nickname).toBe('读覆盖甲');
    expect(res.body.data.stage).toBe('verified');
  });

  it('GET /admin/alumni → 校友管理列表分页自洽', async () => {
    const res = await server()
      .get(`${API}/admin/alumni?page=1&pageSize=10`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    const items = expectListPayload(res.body.data);
    expect(items.length).toBeGreaterThan(0);
    expect(res.body.data.meta.page).toBe(1);
    expect(res.body.data.meta.pageSize).toBe(10);
  });

  it('GET /admin/alumni/:id → 管理端校友详情', async () => {
    const res = await server()
      .get(`${API}/admin/alumni/${ctx.aliceUserId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(res.body.data).toBeDefined();
  });

  it('GET /admin/verifications/:id → 认证申请详情', async () => {
    const res = await server()
      .get(`${API}/admin/verifications/${ctx.verificationId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(res.body.data.id).toBe(ctx.verificationId);
  });

  it('GET /admin/resources → 资源审核列表分页自洽', async () => {
    const res = await server()
      .get(`${API}/admin/resources?page=1&pageSize=10`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    const items = expectListPayload(res.body.data);
    expect(items.length).toBeGreaterThan(0);
    expect(res.body.data.meta.page).toBe(1);
  });

  it('GET /admin/resources/:id → 资源详情', async () => {
    const res = await server()
      .get(`${API}/admin/resources/${ctx.resourceId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(res.body.data.id).toBe(ctx.resourceId);
  });

  it('GET /admin/events → 活动管理列表分页自洽', async () => {
    const res = await server()
      .get(`${API}/admin/events?page=1&pageSize=10`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    const items = expectListPayload(res.body.data);
    expect(items.length).toBeGreaterThan(0);
    expect(res.body.data.meta.page).toBe(1);
  });

  it('GET /admin/notices → 公告管理列表分页自洽', async () => {
    const res = await server()
      .get(`${API}/admin/notices?page=1&pageSize=10`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    const items = expectListPayload(res.body.data);
    expect(items.length).toBeGreaterThan(0);
    expect(res.body.data.meta.page).toBe(1);
  });

  /* ------------------------- 公共与本人读端点 ------------------------- */

  // 说明：原「GET /alumni → 校友列表（管理权限可见）」用例已随端点删除一并移除 ——
  // 管理端校友列表统一走 `GET /admin/alumni`（见上方用例与 docs/KNOWN-ISSUES.md #72）。

  it('GET /connections/requests → 我收到 / 发出的联系申请', async () => {
    const res = await server()
      .get(`${API}/connections/requests?direction=incoming`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(200);
    expect(expectListPayload(res.body.data)).toBeDefined();
  });

  it('GET /notices/:id → 公开公告详情', async () => {
    const res = await server().get(`${API}/notices/${ctx.noticeId}`).expect(200);
    expect(res.body.data.title).toBe('读覆盖用公告');
  });

  it('GET /resources/:id → 公开资源详情', async () => {
    const res = await server().get(`${API}/resources/${ctx.resourceId}`).expect(200);
    expect(res.body.data.title).toBe('读覆盖用资源');
  });

  /**
   * 回归防线（缺陷 #69）：`GET /me/events` 必须返回**分页的活动列表**
   * （契约 `EventDto.myRegistration` 表示「我的报名状态」），
   * 而不是「报名记录数组」。
   * 之前返回裸数组 → 小程序「我的活动」页取 `result.items` 得 undefined → 恒空。
   */
  it('GET /me/events → 分页的活动列表，每条带 myRegistration', async () => {
    const res = await server()
      .get(`${API}/me/events?page=1&pageSize=10`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data.meta).toBeDefined();
    expect(res.body.data.meta.page).toBe(1);
    const items = res.body.data.items as { title: string; myRegistration: string | null }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].title).toContain('读覆盖用活动');
    expect(items[0].myRegistration).toBe('registered');
  });

  it('GET /me/resources → 我发布的资源分页自洽', async () => {
    const res = await server()
      .get(`${API}/me/resources?page=1&pageSize=10`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(200);
    const items = expectListPayload(res.body.data);
    expect(items.length).toBeGreaterThan(0);
    expect(res.body.data.meta.page).toBe(1);
  });

  it('GET /me/connections → 已建立的连接列表', async () => {
    const res = await server()
      .get(`${API}/me/connections?page=1&pageSize=10`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(200);
    expect(expectListPayload(res.body.data)).toBeDefined();
  });

  /**
   * 回归防线（缺陷 #70）：`GET /me/verifications` 必须返回**分页结构**
   * （契约与小程序都按 `PageResult<VerificationApplicationDto>` 消费）。
   * 之前返回裸数组 → 小程序「认证历史」页取 `result.items` 得 undefined → 恒空。
   */
  it('GET /me/verifications → 分页结构自洽', async () => {
    const res = await server()
      .get(`${API}/me/verifications?page=1&pageSize=10`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data.meta).toBeDefined();
    expect(res.body.data.meta.page).toBe(1);
    expect(typeof res.body.data.meta.total).toBe('number');
  });

  /* ------------------------- 字典与健康检查 ------------------------- */

  it('GET /system/regions → 盟市字典含已公开校友计数', async () => {
    const res = await server().get(`${API}/system/regions`).expect(200);
    const rows = res.body.data as { code: string; name: string; alumniCount: number }[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    expect(typeof rows[0].code).toBe('string');
    expect(typeof rows[0].alumniCount).toBe('number');
    // 呼和浩特有 1 位已公开档案的已认证校友
    const hohhot = rows.find((r) => r.code === DICT.regions.hohhot);
    expect(hohhot?.alumniCount).toBe(1);
  });

  it('GET /system/industries → 行业字典含已公开校友计数', async () => {
    const res = await server().get(`${API}/system/industries`).expect(200);
    const rows = res.body.data as { code: string; name: string; alumniCount: number }[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    const energy = rows.find((r) => r.code === DICT.industries.energy);
    expect(energy?.alumniCount).toBe(1);
  });

  it('GET /system/settings → 公开系统配置项', async () => {
    const res = await server().get(`${API}/system/settings`).expect(200);
    const rows = res.body.data as { key: string; value: string }[];
    expect(Array.isArray(rows)).toBe(true);
    for (const row of rows) {
      expect(typeof row.key).toBe('string');
      expect(typeof row.value).toBe('string');
    }
  });

  it('GET /system/health → 依赖连通性正常', async () => {
    const res = await server().get(`${API}/system/health`).expect(200);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.checks.database).toBe('ok');
  });
});
