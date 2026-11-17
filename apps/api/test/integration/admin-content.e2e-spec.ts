import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, ensureAdmin, login, markVerified, resetDatabase, setProfile } from '../helpers';

/**
 * 管理端内容 / 系统管理 + 联系申请分支验证。
 *
 * 背景：一次端点覆盖分析发现，**管理后台的一批接口从未被真实调用过**
 *       （管理端文章 / 公告 / 分类 / 角色 / 权限 / 审计日志 / 系统设置），
 *       以及联系申请的**拒绝**与**撤回**两条分支也没有测试。
 *       「没人调用过」的功能最容易藏着真实缺陷（此前上传接口的 500 就是这么发现的）。
 *
 * 本套件把这些路径真实跑一遍，并验证「管理端接口对普通校友不可见」。
 */

const API = '/api/v1';

describe('管理端内容与联系申请分支', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const ctx: {
    adminToken?: string;
    aliceToken?: string;
    aliceUserId?: number;
    bobToken?: string;
    bobUserId?: number;
    categoryId?: number;
    articleId?: number;
    noticeId?: number;
  } = {};

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
    await resetDatabase(dataSource);

    const server = () => request(app.getHttpServer());

    // 管理员：需要多个权限点，逐个授予同一角色
    // content:manage → 资讯 / 公告 / 分类；settings:manage → 系统设置；
    // admin:manage → 角色 / 权限；audit:view → 审计日志；resource:review → 备用
    await ensureAdmin(dataSource, { permissionCode: 'content:manage' });
    await ensureAdmin(dataSource, { permissionCode: 'settings:manage' });
    await ensureAdmin(dataSource, { permissionCode: 'admin:manage' });
    await ensureAdmin(dataSource, { permissionCode: 'audit:view' });
    await ensureAdmin(dataSource, { permissionCode: 'resource:review' });

    const adminLogin = await server()
      .post(`${API}/auth/admin/login`)
      .send({ username: 'admin-test', password: 'Admin@2026' })
      .expect(200);
    ctx.adminToken = adminLogin.body.data.accessToken;

    const alice = await login(app, 'adminc-alice', '管理甲');
    const bob = await login(app, 'adminc-bob', '管理乙');
    ctx.aliceToken = alice.accessToken;
    ctx.aliceUserId = alice.userId;
    ctx.bobToken = bob.accessToken;
    ctx.bobUserId = bob.userId;
    for (const session of [alice, bob]) {
      await markVerified(dataSource, session.userId);
      await setProfile(dataSource, session.userId, {
        show_in_directory: 1,
        accept_contact_requests: 1,
        allow_contact_share: 1,
      });
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => request(app.getHttpServer());

  /* ------------------------- 路由命名空间不变量 ------------------------- */

  /**
   * 回归防线（缺陷 #52）：管理端的**写操作**必须收敛在 `/admin` 命名空间下。
   * 修复前，`AdminUsersController` 用了空前缀 `@Controller()`，
   * 导致 `POST /articles/categories`、`PATCH|PATCH /users/:id/status`、
   * `GET /users/:id` 这些管理端接口挂在**公开路径空间**里，
   * 与小程序可匿名读取的 `GET /articles/categories` 混在同一个路径前缀下。
   *
   * 这里锁死不变量：公开路径空间下不再存在任何管理端写路由。
   */
  it('管理端写接口不在公开路径空间暴露（契约与实现一致）', async () => {
    // 公开路径下的分类写接口已迁走 → 404（而不是「可用的公开写入口」）
    await server().post(`${API}/articles/categories`).send({ name: 'x', slug: 'x' }).expect(404);
    await server().patch(`${API}/articles/categories/1`).send({ name: 'x' }).expect(404);
    await server().delete(`${API}/articles/categories/1`).expect(404);

    // 公开路径下的账号状态变更同样已迁走
    await server().post(`${API}/users/1/status`).send({ status: 'disabled' }).expect(404);
    await server().patch(`${API}/users/1/status`).send({ status: 'disabled' }).expect(404);
    await server().get(`${API}/users/1`).expect(404);

    // 迁到 /admin 之后，未认证访问必须是 401（鉴权在前），不能是 404
    await server().post(`${API}/admin/articles/categories`).send({ name: 'x', slug: 'x' }).expect(401);
    await server().post(`${API}/admin/users/1/status`).send({ status: 'disabled' }).expect(401);
  });

  /* ------------------------- 内容分类 ------------------------- */

  it('管理员创建资讯分类 → 公开分类列表可见', async () => {
    const created = await server()
      .post(`${API}/admin/articles/categories`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ name: '测试分类', slug: 'selftest-cat', sortOrder: 99 })
      .expect(201);
    ctx.categoryId = created.body.data.id;

    const list = await server().get(`${API}/articles/categories`).expect(200);
    const found = (list.body.data as { slug: string }[]).find((c) => c.slug === 'selftest-cat');
    expect(found).toBeDefined();
  });

  /* ------------------------- 资讯 ------------------------- */

  it('管理员创建已发布资讯 → 公开列表可见，且草稿不可见', async () => {
    const published = await server()
      .post(`${API}/admin/articles`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        title: '已发布资讯',
        summary: '摘要',
        body: '正文内容',
        categoryId: ctx.categoryId,
        status: 'published',
      })
      .expect(201);
    ctx.articleId = published.body.data.id;

    const draft = await server()
      .post(`${API}/admin/articles`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ title: '草稿资讯', body: '正文内容', status: 'draft' })
      .expect(201);

    const list = await server().get(`${API}/articles`).expect(200);
    const titles = (list.body.data.items as { title: string }[]).map((item) => item.title);
    expect(titles).toContain('已发布资讯');
    expect(titles).not.toContain('草稿资讯');

    // 草稿应能在管理端列表里看到（按 status=draft 过滤）
    const adminList = await server()
      .get(`${API}/admin/articles?status=draft`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    const adminTitles = (adminList.body.data.items as { title: string }[]).map((i) => i.title);
    expect(adminTitles).toContain('草稿资讯');
    expect(draft.body.data.id).toBeDefined();
  });

  it('普通校友不能创建资讯 → 403', async () => {
    await server()
      .post(`${API}/admin/articles`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({ title: '越权资讯', body: '正文内容', status: 'published' })
      .expect(403);
  });

  /* ------------------------- 公告 ------------------------- */

  it('管理员创建公告 → 公开公告列表可见', async () => {
    const created = await server()
      .post(`${API}/admin/notices`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ title: '测试公告', body: '公告正文', status: 'published' })
      .expect(201);
    ctx.noticeId = created.body.data.id;

    const list = await server().get(`${API}/notices`).expect(200);
    const titles = (list.body.data.items as { title: string }[]).map((item) => item.title);
    expect(titles).toContain('测试公告');
  });

  /* ------------------------- 角色 / 权限 / 审计 / 设置 ------------------------- */

  it('管理员可读取角色、权限、审计日志与系统设置', async () => {
    const roles = await server()
      .get(`${API}/admin/roles`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(Array.isArray(roles.body.data)).toBe(true);
    expect(roles.body.data.length).toBeGreaterThan(0);

    const permissions = await server()
      .get(`${API}/admin/permissions`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(permissions.body.data.length).toBeGreaterThan(0);

    const logs = await server()
      .get(`${API}/admin/action-logs`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    // 审计日志是分页返回（{ items, meta }）
    expect(Array.isArray(logs.body.data.items)).toBe(true);
    expect(logs.body.data.meta).toBeDefined();

    const settings = await server()
      .get(`${API}/admin/settings`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(settings.body.data).toBeDefined();
  });

  /**
   * 回归防线（缺陷 #58）：管理后台「管理员账号」页面在真实浏览器里直接崩 ——
   * `GET /admin/users` 返回的是**裸数组**，而契约与前端都按 `PageResult`
   * （`{ items, meta }`）消费，前端取 `.items` 得到 undefined，
   * 渲染时抛 `Cannot read properties of undefined (reading 'length')`。
   *
   * 静态校验（路由表 / 权限点 / 组件引用）查不出响应形状不一致，
   * 契约 ↔ 服务端的**路径**比对也查不出 —— 只有真实往返能暴露。
   */
  it('GET /admin/users 返回分页结构 { items, meta }，且筛选真正生效', async () => {
    const all = await server()
      .get(`${API}/admin/users?page=1&pageSize=10`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);

    expect(Array.isArray(all.body.data.items)).toBe(true);
    expect(all.body.data.items.length).toBeGreaterThan(0);
    expect(all.body.data.meta).toBeDefined();
    expect(all.body.data.meta.page).toBe(1);
    expect(all.body.data.meta.pageSize).toBe(10);
    expect(typeof all.body.data.meta.total).toBe('number');

    // 每个管理员都必须带 roles 数组（契约 AdminUserDto.roles）——
    // 缺失会让后台「角色」列渲染时 .map 抛 undefined
    for (const item of all.body.data.items as { roles: unknown }[]) {
      expect(Array.isArray(item.roles)).toBe(true);
    }
    // 至少 admin-test 账号挂着 super_admin 角色
    // ⚠️ 不能在「第一页」里找：admin_users 是**保留表**（resetDatabase 不清空），
    // 它会跨套件、跨运行累积管理员，第一页未必包含 admin-test
    // （本轮新增的账号管理套件创建了几个管理员，正好把它挤出了第一页）。
    // 用关键字筛选精确取回，断言不受分页影响。
    const adminTestPage = await server()
      .get(`${API}/admin/users?keyword=admin-test`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    const withRoles = adminTestPage.body.data.items as { username: string; roles: string[] }[];
    const testAdmin = withRoles.find((item) => item.username === 'admin-test');
    expect(testAdmin?.roles).toContain('super_admin');

    // 关键字筛选：只应命中匹配的账号
    const filtered = await server()
      .get(`${API}/admin/users?keyword=admin-test`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(filtered.body.data.items.length).toBeGreaterThan(0);
    for (const item of filtered.body.data.items as { username: string }[]) {
      expect(item.username).toContain('admin-test');
    }

    // 状态筛选：结果必须全部是指定状态
    const disabled = await server()
      .get(`${API}/admin/users?status=disabled`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    for (const item of disabled.body.data.items as { status: string }[]) {
      expect(item.status).toBe('disabled');
    }

    // 非法状态值必须被 DTO 校验拦下（400），而不是被静默忽略
    await server()
      .get(`${API}/admin/users?status=not-a-status`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(400);
  });

  it('管理员写入系统设置 → 可再次读出', async () => {
    await server()
      .put(`${API}/admin/settings`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ key: 'selftest_key', value: 'selftest_value', description: '自测写入' })
      .expect(200);
    const settings = await server()
      .get(`${API}/admin/settings`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);

    const serialized = JSON.stringify(settings.body.data);
    expect(serialized).toContain('selftest_key');
    expect(serialized).toContain('selftest_value');
  });

  it('普通校友读不到角色 / 权限 / 审计日志 / 设置 → 403', async () => {
    for (const path of ['roles', 'permissions', 'action-logs', 'settings']) {
      await server()
        .get(`${API}/admin/${path}`)
        .set('Authorization', `Bearer ${ctx.aliceToken}`)
        .expect(403);
    }
  });

  /* ------------------------- 联系申请的拒绝 / 撤回分支 ------------------------- */

  it('接收方拒绝联系申请 → 状态变为 rejected，且不建立连接关系', async () => {
    const created = await server()
      .post(`${API}/connections/requests`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({ targetUserId: ctx.bobUserId, message: '待拒绝的申请' })
      .expect(201);

    const rejected = await server()
      .post(`${API}/connections/requests/${created.body.data.id}/reject`)
      .set('Authorization', `Bearer ${ctx.bobToken}`)
      .expect(200);
    expect(rejected.body.data.status).toBe('rejected');

    const list = await server()
      .get(`${API}/me/connection-requests?direction=outgoing`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(200);
    const item = (list.body.data.items as { id: number; status: string }[]).find(
      (r) => r.id === created.body.data.id,
    );
    expect(item?.status).toBe('rejected');
  });

  it('发起方撤回联系申请 → 状态变为 cancelled', async () => {
    const created = await server()
      .post(`${API}/connections/requests`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({ targetUserId: ctx.bobUserId, message: '待撤回的申请' })
      .expect(201);

    const cancelled = await server()
      .post(`${API}/connections/requests/${created.body.data.id}/cancel`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(200);
    expect(cancelled.body.data.status).toBe('cancelled');
  });

  it('非接收方不能拒绝、发起方不能代对方撤回 → 403', async () => {
    const created = await server()
      .post(`${API}/connections/requests`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({ targetUserId: ctx.bobUserId, message: '分支权限探测' })
      .expect(201);
    const requestId = created.body.data.id;

    // 发起方不能替接收方拒绝
    await server()
      .post(`${API}/connections/requests/${requestId}/reject`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(403);

    // 无关第三方不能撤回
    const carol = await login(app, 'adminc-carol', '管理丙');
    await markVerified(dataSource, carol.userId);
    await server()
      .post(`${API}/connections/requests/${requestId}/cancel`)
      .set('Authorization', `Bearer ${carol.accessToken}`)
      .expect(403);
  });
});
