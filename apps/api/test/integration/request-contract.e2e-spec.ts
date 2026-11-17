import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DICT, createTestApp, ensureAdmin, login, markVerified, resetDatabase, setProfile } from '../helpers';

/**
 * 请求契约回归防线（缺陷 #62 / #63）。
 *
 * 背景：
 *   这两类缺陷都**不抛异常** ——
 *     #62 小程序「编辑资料」页把联系方式和资料一起提交，
 *        而服务端 DTO 里没有这三个字段 → ValidationPipe 的 whitelist 直接剥掉 →
 *        接口返回 200、页面提示「资料已更新」，但联系方式**根本没存进去**；
 *     #63 管理端 6 个列表页的关键字 / 状态 / 分类 / 操作人 等 14 个筛选参数，
 *        服务端**一个都没声明** → 请求照发、结果不受影响 → 筛选框全是摆设。
 *
 * 本套件把「客户端发了的，服务端必须真的接住」钉成断言。
 */

const API = '/api/v1';

describe('请求契约回归防线（缺陷 #62 / #63）', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const ctx: {
    adminToken?: string;
    adminId?: number;
    userToken?: string;
    userId?: number;
    categoryId?: number;
    articleId?: number;
    noticeId?: number;
    eventId?: number;
  } = {};

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
    await resetDatabase(dataSource);

    const server = () => request(app.getHttpServer());

    await ensureAdmin(dataSource, { permissionCode: 'alumni:view' });
    await ensureAdmin(dataSource, { permissionCode: 'content:manage' });
    await ensureAdmin(dataSource, { permissionCode: 'event:manage' });
    await ensureAdmin(dataSource, { permissionCode: 'audit:view' });
    await ensureAdmin(dataSource, { permissionCode: 'resource:review' });
    await ensureAdmin(dataSource, { permissionCode: 'verification:review' });
    ctx.adminId = await ensureAdmin(dataSource, { permissionCode: 'dashboard:view' });

    const adminLogin = await server()
      .post(`${API}/auth/admin/login`)
      .send({ username: 'admin-test', password: 'Admin@2026' })
      .expect(200);
    ctx.adminToken = adminLogin.body.data.accessToken;

    // 一位普通校友
    const user = await login(app, 'reqc-user', '契约甲');
    ctx.userToken = user.accessToken;
    ctx.userId = user.userId;
    await markVerified(dataSource, user.userId);
    await setProfile(dataSource, user.userId, {
      display_name: '契约甲',
      college: '契约测试学院',
      graduation_year: 2016,
      region_code: DICT.regions.hohhot,
      industry_code: DICT.industries.energy,
      show_in_directory: 1,
      accept_contact_requests: 1,
      allow_contact_share: 1,
    });

    // 造一批带唯一关键字的业务数据，便于验证筛选真的生效
    const category = await server()
      .post(`${API}/admin/articles/categories`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ name: '契约分类', slug: 'reqc-cat', sortOrder: 91 })
      .expect(201);
    ctx.categoryId = category.body.data.id;

    const article = await server()
      .post(`${API}/admin/articles`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        title: '契约关键字资讯',
        summary: '摘要',
        body: '正文',
        categoryId: ctx.categoryId,
        status: 'published',
      })
      .expect(201);
    ctx.articleId = article.body.data.id;

    const notice = await server()
      .post(`${API}/admin/notices`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ title: '契约关键字公告', body: '公告正文', status: 'published' })
      .expect(201);
    ctx.noticeId = notice.body.data.id;

    const event = await server()
      .post(`${API}/admin/events`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        title: '契约关键字活动',
        kind: '校友交流',
        regionCode: DICT.regions.hohhot,
        startsAt: '2026-12-01T10:00:00.000Z',
        capacity: 50,
        status: 'published',
      })
      .expect(201);
    ctx.eventId = event.body.data.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => request(app.getHttpServer());

  /* ------------------------- #62 联系方式随资料一起提交 ------------------------- */

  it('PATCH /me/profile 携带联系方式 → 真的存进私密切域（密文）', async () => {
    const res = await server()
      .patch(`${API}/me/profile`)
      .set('Authorization', `Bearer ${ctx.userToken}`)
      .send({
        displayName: '契约甲',
        college: '契约测试学院',
        contactPhone: '13800138000',
        contactWechat: 'wx-reqc-001',
        contactEmail: 'reqc@example.com',
      })
      .expect(200);

    // 接口当场回显的就是刚存进去的值
    expect(res.body.data.contactPhone).toBe('13800138000');
    expect(res.body.data.contactWechat).toBe('wx-reqc-001');
    expect(res.body.data.contactEmail).toBe('reqc@example.com');

    // 落库必须是密文，不能是明文
    const rows = await dataSource.query(
      'SELECT phone_cipher, wechat_cipher, email_cipher FROM private_contacts WHERE user_id = ?',
      [ctx.userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].phone_cipher).not.toContain('13800138000');
    expect(rows[0].wechat_cipher).not.toContain('wx-reqc-001');
    expect(rows[0].email_cipher).not.toContain('reqc@example.com');
    expect(String(rows[0].phone_cipher).length).toBeGreaterThan(20);

    // 再读一次资料，联系方式仍在（说明确实落库，而不是只回显了请求体）
    const again = await server()
      .get(`${API}/me/profile`)
      .set('Authorization', `Bearer ${ctx.userToken}`)
      .expect(200);
    expect(again.body.data.contactPhone).toBe('13800138000');
    expect(again.body.data.contactWechat).toBe('wx-reqc-001');
    expect(again.body.data.contactEmail).toBe('reqc@example.com');
  });

  it('PATCH /me/profile 不带联系方式 → 不会清空已存的联系方式', async () => {
    await server()
      .patch(`${API}/me/profile`)
      .set('Authorization', `Bearer ${ctx.userToken}`)
      .send({ intro: '只改简介' })
      .expect(200);

    const res = await server()
      .get(`${API}/me/profile`)
      .set('Authorization', `Bearer ${ctx.userToken}`)
      .expect(200);
    expect(res.body.data.contactPhone).toBe('13800138000');
    expect(res.body.data.intro).toBe('只改简介');
  });

  it('PATCH /me/profile 邮箱格式非法 → 400（不是静默丢弃）', async () => {
    await server()
      .patch(`${API}/me/profile`)
      .set('Authorization', `Bearer ${ctx.userToken}`)
      .send({ contactEmail: 'not-an-email' })
      .expect(400);
  });

  /* ------------------------- #63 管理端筛选参数真的生效 ------------------------- */

  it('GET /admin/articles → keyword / categoryId 筛选生效', async () => {
    const byKeyword = await server()
      .get(`${API}/admin/articles?keyword=${encodeURIComponent('契约关键字资讯')}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(byKeyword.body.data.items.length).toBeGreaterThan(0);
    for (const item of byKeyword.body.data.items as { title: string }[]) {
      expect(item.title).toContain('契约关键字资讯');
    }

    const byCategory = await server()
      .get(`${API}/admin/articles?categoryId=${ctx.categoryId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(byCategory.body.data.items.length).toBeGreaterThan(0);
    for (const item of byCategory.body.data.items as { categoryId: number }[]) {
      expect(item.categoryId).toBe(ctx.categoryId);
    }
  });

  it('GET /admin/notices → keyword 筛选生效', async () => {
    const res = await server()
      .get(`${API}/admin/notices?keyword=${encodeURIComponent('契约关键字公告')}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);
    for (const item of res.body.data.items as { title: string }[]) {
      expect(item.title).toContain('契约关键字公告');
    }
  });

  it('GET /admin/events → keyword / status 筛选生效', async () => {
    const byKeyword = await server()
      .get(`${API}/admin/events?keyword=${encodeURIComponent('契约关键字活动')}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(byKeyword.body.data.items.length).toBeGreaterThan(0);
    for (const item of byKeyword.body.data.items as { title: string }[]) {
      expect(item.title).toContain('契约关键字活动');
    }

    const byStatus = await server()
      .get(`${API}/admin/events?status=published`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(byStatus.body.data.items.length).toBeGreaterThan(0);
    for (const item of byStatus.body.data.items as { status: string }[]) {
      expect(item.status).toBe('published');
    }
  });

  it('GET /admin/action-logs → adminId / action 筛选生效', async () => {
    const byAction = await server()
      .get(`${API}/admin/action-logs?action=article.create`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(byAction.body.data.items.length).toBeGreaterThan(0);
    for (const item of byAction.body.data.items as { action: string }[]) {
      expect(item.action).toBe('article.create');
    }

    const byAdmin = await server()
      .get(`${API}/admin/action-logs?adminId=${ctx.adminId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(byAdmin.body.data.items.length).toBeGreaterThan(0);
    for (const item of byAdmin.body.data.items as { adminId: number }[]) {
      expect(item.adminId).toBe(ctx.adminId);
    }
  });

  it('GET /admin/resources → keyword 筛选生效', async () => {
    const created = await server()
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${ctx.userToken}`)
      .send({
        type: 'resource',
        title: '契约关键字资源',
        body: '这是一段用于验证资源关键字筛选的内容描述，长度满足校验要求。',
        industryCode: DICT.industries.energy,
        regionCode: DICT.regions.hohhot,
      })
      .expect(201);

    await server()
      .post(`${API}/admin/resources/${created.body.data.id}/decision`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ action: 'approve', note: '契约校验' })
      .expect(201);

    const res = await server()
      .get(`${API}/admin/resources?keyword=${encodeURIComponent('契约关键字资源')}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);
    for (const item of res.body.data.items as { title: string }[]) {
      expect(item.title).toContain('契约关键字资源');
    }
  });

  it('GET /articles/categories → 带 articleCount（后台「文章数」列不再恒空）', async () => {
    const res = await server().get(`${API}/articles/categories`).expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const category = (res.body.data as { id: number; name: string; articleCount?: number }[]).find(
      (item) => item.id === ctx.categoryId,
    );
    expect(category).toBeDefined();
    // 契约 ArticleCategoryDto.articleCount —— 之前服务端根本不给，后台该列恒空
    expect(typeof category?.articleCount).toBe('number');
    // 前面已发布一篇挂在这个分类下的资讯
    expect(category?.articleCount).toBeGreaterThanOrEqual(1);
  });

  it('GET /admin/verifications → keyword 筛选生效', async () => {
    const submitted = await server()
      .post(`${API}/alumni/verification`)
      .set('Authorization', `Bearer ${ctx.userToken}`)
      .send({
        realName: '契约甲',
        college: '契约关键字学院',
        graduationYear: 2016,
        degree: '本科',
        studentIdMasked: '201612345678',
        remark: '契约校验用',
      })
      .expect(201);

    const res = await server()
      .get(`${API}/admin/verifications?keyword=${encodeURIComponent('契约关键字学院')}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);
    const hit = (res.body.data.items as { id: number; college: string }[]).find(
      (item) => item.id === submitted.body.data.id,
    );
    expect(hit).toBeDefined();
    expect(hit?.college).toContain('契约关键字学院');
  });
});
