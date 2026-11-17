import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DICT, createTestApp, ensureAdmin, login, markVerified, resetDatabase, setProfile } from '../helpers';

/**
 * 管理端 / 公开端的**响应结构**回归防线。
 *
 * 背景（这一套件为什么存在）：
 *   新增的 `infra/scripts/check-response-shape.mjs` 用「客户端声明的泛型返回类型」
 *   去核对服务端真实响应，第一次运行就抓出了 3 个真实缺陷：
 *     #59 GET /admin/alumni  —— 少返回 userStatus / intro / verifiedAt /
 *                               contactVisible / updatedAt，
 *                               且 6 个筛选项里有 5 个被服务端静默忽略；
 *     #60 GET /admin/action-logs —— 少返回 adminName；
 *     #61 资源与认证的审核记录 —— 少返回 adminName。
 *
 *   这三个缺陷都不会抛异常：页面照常渲染，只是**列是空的**、
 *   **筛选框是摆设**。静态校验、路径一致性校验、端点覆盖校验全都查不出。
 *
 * 本套件把「结构必须完整」「筛选必须真的生效」钉成断言，
 * 避免将来再次出现「字段悄悄消失」。
 */

const API = '/api/v1';

describe('响应结构回归防线（缺陷 #59 / #60 / #61）', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const ctx: {
    adminToken?: string;
    authorToken?: string;
    authorUserId?: number;
    resourceId?: number;
  } = {};

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
    await resetDatabase(dataSource);

    const server = () => request(app.getHttpServer());

    await ensureAdmin(dataSource, { permissionCode: 'alumni:view' });
    await ensureAdmin(dataSource, { permissionCode: 'audit:view' });
    await ensureAdmin(dataSource, { permissionCode: 'resource:review' });
    await ensureAdmin(dataSource, { permissionCode: 'verification:review' });
    await ensureAdmin(dataSource, { permissionCode: 'content:manage' });

    const adminLogin = await server()
      .post(`${API}/auth/admin/login`)
      .send({ username: 'admin-test', password: 'Admin@2026' })
      .expect(200);
    ctx.adminToken = adminLogin.body.data.accessToken;

    // 一位已认证校友，档案字段填满，便于验证列表字段与筛选项
    const author = await login(app, 'shape-author', '结构甲');
    ctx.authorToken = author.accessToken;
    ctx.authorUserId = author.userId;
    await markVerified(dataSource, author.userId);
    await setProfile(dataSource, author.userId, {
      display_name: '结构甲',
      college: '结构测试学院',
      graduation_year: 2015,
      region_code: DICT.regions.hohhot,
      industry_code: DICT.industries.energy,
      direction: '结构校验',
      intro: '用于响应结构校验的简介',
      show_in_directory: 1,
      accept_contact_requests: 1,
      allow_contact_share: 1,
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => request(app.getHttpServer());

  /* ------------------------- #59 校友列表字段与筛选 ------------------------- */

  it('GET /admin/alumni → 每个条目都带齐契约声明的必填字段', async () => {
    const res = await server()
      .get(`${API}/admin/alumni?page=1&pageSize=20`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);

    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data.items.length).toBeGreaterThan(0);
    expect(res.body.data.meta).toBeDefined();

    type AlumniItem = Record<string, unknown>;
    for (const item of res.body.data.items as AlumniItem[]) {
      // 后台「账号状态」列渲染的是 userStatus —— 服务端曾返回 status，导致该列恒空
      expect(item.userStatus).toBeDefined();
      expect(['active', 'disabled', 'locked']).toContain(item.userStatus);
      // 契约 AlumniProfileDto 的必填字段
      expect(item).toHaveProperty('intro');
      expect(item).toHaveProperty('verifiedAt');
      expect(item).toHaveProperty('contactVisible');
      expect(item).toHaveProperty('updatedAt');
      expect(typeof item.contactVisible).toBe('boolean');
      expect(item.stage).toBeDefined();
    }
  });

  it('GET /admin/alumni → college / verified / status / industryCode / graduationYear 筛选真正生效', async () => {
    // 学院筛选
    const byCollege = await server()
      .get(`${API}/admin/alumni?college=${encodeURIComponent('结构测试学院')}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(byCollege.body.data.items.length).toBeGreaterThan(0);
    for (const item of byCollege.body.data.items as { college: string }[]) {
      expect(item.college).toContain('结构测试学院');
    }

    // 认证状态筛选
    const byVerified = await server()
      .get(`${API}/admin/alumni?verified=true`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(byVerified.body.data.items.length).toBeGreaterThan(0);
    for (const item of byVerified.body.data.items as { verified: boolean }[]) {
      expect(item.verified).toBe(true);
    }

    // 账号状态筛选
    const byStatus = await server()
      .get(`${API}/admin/alumni?status=active`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(byStatus.body.data.items.length).toBeGreaterThan(0);
    for (const item of byStatus.body.data.items as { userStatus: string }[]) {
      expect(item.userStatus).toBe('active');
    }

    // 行业筛选
    const byIndustry = await server()
      .get(`${API}/admin/alumni?industryCode=${DICT.industries.energy}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(byIndustry.body.data.items.length).toBeGreaterThan(0);
    for (const item of byIndustry.body.data.items as { industryCode: string }[]) {
      expect(item.industryCode).toBe(DICT.industries.energy);
    }

    // 毕业年份筛选
    const byYear = await server()
      .get(`${API}/admin/alumni?graduationYear=2015`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(byYear.body.data.items.length).toBeGreaterThan(0);
    for (const item of byYear.body.data.items as { graduationYear: number }[]) {
      expect(item.graduationYear).toBe(2015);
    }

    // 非法账号状态必须被 DTO 拦下（400），不能静默忽略
    await server()
      .get(`${API}/admin/alumni?status=not-a-status`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(400);
  });

  it('GET /admin/alumni/:id → 详情带 userStatus / verifiedAt / updatedAt / verifications', async () => {
    const res = await server()
      .get(`${API}/admin/alumni/${ctx.authorUserId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);

    expect(res.body.data.userId).toBe(ctx.authorUserId);
    expect(res.body.data.userStatus).toBe('active');
    expect(res.body.data).toHaveProperty('verifiedAt');
    expect(res.body.data).toHaveProperty('updatedAt');
    expect(res.body.data.intro).toBe('用于响应结构校验的简介');
    expect(typeof res.body.data.contactVisible).toBe('boolean');
    // 后台详情抽屉的「身份审核历史」时间线：契约 AdminAlumniDetail.verifications 为必填
    expect(Array.isArray(res.body.data.verifications)).toBe(true);
  });

  /* ------------------------- #60 审计日志操作人 ------------------------- */

  it('GET /admin/action-logs → 每条记录都带 adminName', async () => {
    // 先产生一条审计日志（内容管理的写操作会写审计日志）
    await server()
      .post(`${API}/admin/articles`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ title: '结构校验用资讯', body: '正文内容', status: 'draft' })
      .expect(201);

    const res = await server()
      .get(`${API}/admin/action-logs?page=1&pageSize=20`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);

    expect(res.body.data.items.length).toBeGreaterThan(0);
    for (const item of res.body.data.items as { adminName: string }[]) {
      // 后台「操作人」列直接渲染 adminName —— 缺失时该列恒空
      expect(typeof item.adminName).toBe('string');
      expect(item.adminName.length).toBeGreaterThan(0);
    }
  });

  /* ------------------------- #61 审核记录操作人 ------------------------- */

  it('GET /resources → 审核记录带 adminName（公开内容里的审核人）', async () => {
    const created = await server()
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${ctx.authorToken}`)
      .send({
        type: 'resource',
        title: '结构校验用资源',
        body: '这是一段用于验证审核记录结构的内容描述，长度满足校验要求。',
        industryCode: DICT.industries.energy,
        regionCode: DICT.regions.hohhot,
      })
      .expect(201);
    ctx.resourceId = created.body.data.id;

    await server()
      .post(`${API}/admin/resources/${ctx.resourceId}/decision`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ action: 'approve', note: '结构校验通过' })
      .expect(201);

    const list = await server().get(`${API}/resources`).expect(200);
    const item = (list.body.data.items as { id: number; reviews: { adminName?: string }[] }[]).find(
      (r) => r.id === ctx.resourceId,
    );
    expect(item).toBeDefined();
    expect(Array.isArray(item?.reviews)).toBe(true);
    expect(item?.reviews.length).toBeGreaterThan(0);
    for (const review of item?.reviews ?? []) {
      expect(typeof review.adminName).toBe('string');
      expect((review.adminName ?? '').length).toBeGreaterThan(0);
    }
  });

  it('GET /admin/verifications → 审核记录带 adminName', async () => {
    const res = await server()
      .get(`${API}/admin/verifications?page=1&pageSize=20`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);

    for (const item of res.body.data.items as { reviews?: { adminName?: string }[] }[]) {
      for (const review of item.reviews ?? []) {
        expect(typeof review.adminName).toBe('string');
        expect((review.adminName ?? '').length).toBeGreaterThan(0);
      }
    }
  });
});
