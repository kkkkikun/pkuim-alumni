import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, ensureAdmin, login, markVerified, resetDatabase } from '../helpers';

/**
 * 管理端**写操作**（增 / 删 / 改）补测。
 *
 * 背景：端点覆盖分析（`infra/scripts/check-test-coverage.mjs`）显示管理端有一批
 *       写操作从未被集成测试调用过 —— 分类的改与删、资讯/公告/活动的改与删、
 *       管理员账号的创建与更新。这些接口**副作用最易回归**：
 *       它们写数据库、动状态机、还带审计日志，缺测试等于没有护栏。
 *
 * 本套件把这些路径真实跑一遍，并验证：
 *   1. 改完之后公开侧能观察到变化（改真的落库了）；
 *   2. 删完之后资源确实消失；
 *   3. 普通校友调用管理端写接口一律 403；
 *   4. 操作不存在的资源返回 404 而不是静默成功。
 */

const API = '/api/v1';

describe('管理端写操作（增删改）', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const ctx: {
    adminToken?: string;
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

    // 三个权限点分别覆盖：内容管理 / 活动管理 / 管理员账号管理
    await ensureAdmin(dataSource, { permissionCode: 'content:manage' });
    await ensureAdmin(dataSource, { permissionCode: 'event:manage' });
    await ensureAdmin(dataSource, { permissionCode: 'admin:manage' });

    const adminLogin = await request(app.getHttpServer())
      .post(`${API}/auth/admin/login`)
      .send({ username: 'admin-test', password: 'Admin@2026' })
      .expect(200);
    ctx.adminToken = adminLogin.body.data.accessToken;

    const user = await login(app, 'aw-user', '写操作甲');
    ctx.userToken = user.accessToken;
    ctx.userId = user.userId;
    await markVerified(dataSource, user.userId);
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => request(app.getHttpServer());

  /* ------------------------- 管理员账号 ------------------------- */

  it('创建管理员 → 更新其展示名与状态 → 变更生效', async () => {
    const username = `aw-admin-${Date.now()}`;

    const created = await server()
      .post(`${API}/admin/users`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      // 初始口令**必填**（第二轮收紧）：此前不传口令会用仓库里的公开默认值建号。
      .send({ username, displayName: '待改名', roles: ['super_admin'], password: 'Valid@2026' })
      .expect(201);
    const adminId = created.body.data.id as number;
    expect(created.body.data.username).toBe(username);
    expect(created.body.data.status).toBe('active');

    const updated = await server()
      .patch(`${API}/admin/users/${adminId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ displayName: '改名之后', status: 'disabled' })
      .expect(200);
    expect(updated.body.data.displayName).toBe('改名之后');
    expect(updated.body.data.status).toBe('disabled');

    // 落库校验：不能只看响应体
    const [row] = await dataSource.query(
      'SELECT display_name, status FROM admin_users WHERE id = ?',
      [adminId],
    );
    expect(row.display_name).toBe('改名之后');
    expect(row.status).toBe('disabled');
  });

  it('普通校友不能创建管理员 → 403', async () => {
    await server()
      .post(`${API}/admin/users`)
      .set('Authorization', `Bearer ${ctx.userToken}`)
      .send({ username: `aw-forbidden-${Date.now()}` })
      .expect(403);
  });

  /* ------------------------- 资讯分类 ------------------------- */

  it('修改资讯分类 → 公开列表可见新名称；删除分类 → 公开列表不再包含', async () => {
    const created = await server()
      .post(`${API}/admin/articles/categories`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ name: '待改名分类', slug: `aw-cat-${Date.now()}`, sortOrder: 10 })
      .expect(201);
    ctx.categoryId = created.body.data.id;

    const updated = await server()
      .patch(`${API}/admin/articles/categories/${ctx.categoryId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ name: '改名后分类', sortOrder: 20 })
      .expect(200);
    expect(updated.body.data.name).toBe('改名后分类');
    expect(updated.body.data.sortOrder).toBe(20);

    const list = await server().get(`${API}/articles/categories`).expect(200);
    const names = (list.body.data as { name: string }[]).map((c) => c.name);
    expect(names).toContain('改名后分类');

    const deleted = await server()
      .delete(`${API}/admin/articles/categories/${ctx.categoryId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(deleted.body.data.deleted).toBe(true);

    const after = await server().get(`${API}/articles/categories`).expect(200);
    const afterNames = (after.body.data as { name: string }[]).map((c) => c.name);
    expect(afterNames).not.toContain('改名后分类');
  });

  /* ------------------------- 资讯 ------------------------- */

  it('修改资讯 → 标题变更且版本号自增；删除资讯 → 公开详情 404', async () => {
    const created = await server()
      .post(`${API}/admin/articles`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ title: '待改名资讯', body: '正文', status: 'published' })
      .expect(201);
    ctx.articleId = created.body.data.id;
    const [rowBefore] = await dataSource.query(
      'SELECT version FROM articles WHERE id = ?',
      [ctx.articleId],
    );
    const versionBefore = Number(rowBefore.version);

    const updated = await server()
      .patch(`${API}/admin/articles/${ctx.articleId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ title: '改名后资讯', status: 'published' })
      .expect(200);
    expect(updated.body.data.title).toBe('改名后资讯');

    // 版本号自增（乐观锁语义）—— 响应体不含 version，落库校验
    const [rowAfter] = await dataSource.query(
      'SELECT version, title FROM articles WHERE id = ?',
      [ctx.articleId],
    );
    expect(Number(rowAfter.version)).toBe(versionBefore + 1);
    expect(rowAfter.title).toBe('改名后资讯');

    // 公开侧确实读到了新标题
    const detail = await server().get(`${API}/articles/${ctx.articleId}`).expect(200);
    expect(detail.body.data.title).toBe('改名后资讯');

    const deleted = await server()
      .delete(`${API}/admin/articles/${ctx.articleId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(deleted.body.data.deleted).toBe(true);

    await server().get(`${API}/articles/${ctx.articleId}`).expect(404);
  });

  /* ------------------------- 公告 ------------------------- */

  it('修改公告 → 公开列表可见新标题；删除公告 → 公开列表不再包含', async () => {
    const created = await server()
      .post(`${API}/admin/notices`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ title: '待改名公告', body: '公告正文', status: 'published' })
      .expect(201);
    ctx.noticeId = created.body.data.id;

    const updated = await server()
      .patch(`${API}/admin/notices/${ctx.noticeId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ title: '改名后公告' })
      .expect(200);
    expect(updated.body.data.title).toBe('改名后公告');

    const list = await server().get(`${API}/notices`).expect(200);
    const titles = (list.body.data.items as { title: string }[]).map((n) => n.title);
    expect(titles).toContain('改名后公告');

    const deleted = await server()
      .delete(`${API}/admin/notices/${ctx.noticeId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(deleted.body.data.deleted).toBe(true);

    const after = await server().get(`${API}/notices`).expect(200);
    const afterTitles = (after.body.data.items as { title: string }[]).map((n) => n.title);
    expect(afterTitles).not.toContain('改名后公告');
  });

  /* ------------------------- 活动 ------------------------- */

  it('创建活动 → 修改 → 删除，公开侧同步反映', async () => {
    const created = await server()
      .post(`${API}/admin/events`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        title: '待改名活动',
        kind: '校友交流',
        place: '呼和浩特',
        capacity: 30,
        status: 'published',
      })
      .expect(201);
    ctx.eventId = created.body.data.id;

    const updated = await server()
      .patch(`${API}/admin/events/${ctx.eventId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ title: '改名后活动', capacity: 50 })
      .expect(200);
    expect(updated.body.data.title).toBe('改名后活动');
    expect(updated.body.data.capacity).toBe(50);

    const publicList = await server().get(`${API}/events`).expect(200);
    const items = (publicList.body.data.items as { title: string }[]).map((e) => e.title);
    expect(items).toContain('改名后活动');

    const deleted = await server()
      .delete(`${API}/admin/events/${ctx.eventId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(deleted.body.data.deleted).toBe(true);

    const after = await server().get(`${API}/events`).expect(200);
    const afterItems = (after.body.data.items as { title: string }[]).map((e) => e.title);
    expect(afterItems).not.toContain('改名后活动');
  });

  /* ------------------------- 联系方式的 PATCH 别名 ------------------------- */

  it('PATCH /me/contacts 别名与 PUT 等价 → 返回本人联系方式', async () => {
    const updated = await server()
      .patch(`${API}/me/contacts`)
      .set('Authorization', `Bearer ${ctx.userToken}`)
      .send({ contactPhone: '13800009999', contactEmail: 'alias@example.com' })
      .expect(200);

    expect(updated.body.data).toEqual({
      contactPhone: '13800009999',
      contactWechat: null,
      contactEmail: 'alias@example.com',
    });
  });

  /* ------------------------- 负向断言 ------------------------- */

  it('操作不存在的资源 → 404（不是静默成功）', async () => {
    await server()
      .patch(`${API}/admin/articles/99999999`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      // 载荷必须合法：DTO 校验先于 handler 运行，
      // 载荷不合法会得到 400，测不到「资源不存在 → 404」这条路径
      .send({ title: '不存在的文章' })
      .expect(404);
    await server()
      .delete(`${API}/admin/articles/99999999`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(404);
    await server()
      .delete(`${API}/admin/articles/categories/99999999`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(404);
    await server()
      .patch(`${API}/admin/events/99999999`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ title: '不存在的活动' })
      .expect(404);
    await server()
      .delete(`${API}/admin/events/99999999`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(404);
  });

  it('普通校友调用管理端写接口一律 403', async () => {
    await server()
      .patch(`${API}/admin/articles/${ctx.articleId ?? 1}`)
      .set('Authorization', `Bearer ${ctx.userToken}`)
      .send({ title: '越权改名' })
      .expect(403);
    await server()
      .delete(`${API}/admin/notices/${ctx.noticeId ?? 1}`)
      .set('Authorization', `Bearer ${ctx.userToken}`)
      .expect(403);
    await server()
      .delete(`${API}/admin/events/${ctx.eventId ?? 1}`)
      .set('Authorization', `Bearer ${ctx.userToken}`)
      .expect(403);
  });

  it('管理端写操作会留下审计日志', async () => {
    const logs = await server()
      .get(`${API}/admin/action-logs`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    const actions = (logs.body.data.items as { action: string }[]).map((row) => row.action);
    expect(actions).toContain('article.update');
    expect(actions).toContain('event.delete');
  });
});
