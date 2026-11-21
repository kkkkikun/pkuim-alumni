import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, ensureAdmin, resetDatabase } from '../helpers';

/**
 * 管理端**写操作**的错误语义对账（缺陷 #190）。
 *
 * 背景：
 *   错误码是管理端**唯一**的分支依据 —— 前端按 `code` 判断
 *   「是参数写错了 / 对象不存在 / 撞键了 / 服务端炸了」。
 *   一旦某个失败形态返回 **500**（`INTERNAL_ERROR`），
 *   管理端就会把它当成「服务端故障」：
 *   运维去查服务健康度，管理员去刷新页面 —— 而真实原因可能只是
 *   「你填的 slug 重复了」「这个 id 不存在」。
 *
 *   本套件锁死管理端写操作的口径（`docs/API-SPEC.md`
 *   「管理端写操作的错误语义」）：
 *     - 400 参数问题（`VALIDATION_ERROR`）
 *     - 404 对象不存在（`NOT_FOUND`）
 *     - 409 冲突（`CONFLICT`）—— **唯一键冲突必须落到这里**
 *   并明确禁止：把数据库异常直接抛成 500。
 *
 * 覆盖的失败形态：
 *   1) 资讯分类 **slug 重复**（`article_categories.slug` 唯一索引）
 *      —— 修复前是 500（缺陷 #190），修复后必须 409；
 *   2) 改分类 slug 为**别人已占用**的 slug → 409；
 *   3) 改**不存在**的分类 → 404（不是 500，也不是 200 假成功）；
 *   4) 管理员**登录名重复**（`admin_users.username` 唯一索引）→ 409
 *      （缺陷 #112 的既有行为，本套件作为回归防线）；
 *   5) 系统设置 upsert 重复写同一个 key → **成功**（不能被误伤成 409/500）。
 *
 * ⚠️ 冲突用例还要断言**事务回滚**：失败的那次写入不能留下半成品
 *    （多出一行分类、或留下审计日志）—— 否则 409 只是「表面正确」。
 */
const API = '/api/v1';

describe('管理端写操作的错误语义（缺陷 #190）', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
    await resetDatabase(dataSource);

    // content:manage → 资讯分类；settings:manage → 系统设置；admin:manage → 管理员账号
    await ensureAdmin(dataSource, { permissionCode: 'content:manage' });
    await ensureAdmin(dataSource, { permissionCode: 'settings:manage' });
    await ensureAdmin(dataSource, { permissionCode: 'admin:manage' });

    const login = await request(app.getHttpServer())
      .post(`${API}/auth/admin/login`)
      .send({ username: 'admin-test', password: 'Admin@2026' })
      .expect(200);
    adminToken = login.body.data.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => request(app.getHttpServer());

  const countCategories = async (slug: string): Promise<number> => {
    const rows = await dataSource.query(
      'SELECT COUNT(*) AS total FROM article_categories WHERE slug = ?',
      [slug],
    );
    return Number(rows?.[0]?.total ?? 0);
  };

  const countAuditLogs = async (): Promise<number> => {
    const rows = await dataSource.query(
      "SELECT COUNT(*) AS total FROM admin_action_logs WHERE action = 'category.create'",
    );
    return Number(rows?.[0]?.total ?? 0);
  };

  /* ------------------------- 资讯分类：slug 唯一键 ------------------------- */

  it('创建分类：slug 重复 → 409 CONFLICT（不得是 5xx）', async () => {
    const first = await server()
      .post(`${API}/admin/articles/categories`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '校务通知', slug: 'semantics-dup-slug' })
      .expect(201);
    expect(first.body.data.slug).toBe('semantics-dup-slug');

    // ⚠️ 注入冲突数据：同一个 slug 再建一次 → 必须 409
    const conflict = await server()
      .post(`${API}/admin/articles/categories`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '校务通知（重复）', slug: 'semantics-dup-slug' });

    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('CONFLICT');
    expect(conflict.status).toBeLessThan(500);
    expect(conflict.body.message).toContain('slug');
  });

  it('slug 冲突时事务整体回滚：不留下多出来的分类、也不留下审计痕迹', async () => {
    const before = await countCategories('semantics-dup-slug');
    expect(before).toBe(1);
    const auditsBefore = await countAuditLogs();

    await server()
      .post(`${API}/admin/articles/categories`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '再来一次', slug: 'semantics-dup-slug' })
      .expect(409);

    expect(await countCategories('semantics-dup-slug')).toBe(1);
    // 审计与业务写同事务（缺陷 #134）：业务写被拒 → 审计也不该留下
    expect(await countAuditLogs()).toBe(auditsBefore);
  });

  it('改分类 slug 为别人已占用的 slug → 409 CONFLICT（不得是 5xx）', async () => {
    await server()
      .post(`${API}/admin/articles/categories`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '学术活动', slug: 'semantics-other-slug' })
      .expect(201);

    const target = await dataSource.query(
      "SELECT id FROM article_categories WHERE slug = 'semantics-dup-slug'",
    );
    const targetId = Number(target?.[0]?.id);

    const conflict = await server()
      .patch(`${API}/admin/articles/categories/${targetId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ slug: 'semantics-other-slug' });

    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('CONFLICT');

    // 原分类的 slug 不能被改掉（回滚）
    const rows = await dataSource.query('SELECT slug FROM article_categories WHERE id = ?', [
      targetId,
    ]);
    expect(rows?.[0]?.slug).toBe('semantics-dup-slug');
  });

  it('改不存在的分类 → 404 NOT_FOUND（不是 500，也不是 200 假成功）', async () => {
    const missing = await server()
      .patch(`${API}/admin/articles/categories/999999`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '不存在的分类' });

    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
  });

  it('删不存在的分类 → 404 NOT_FOUND', async () => {
    const missing = await server()
      .delete(`${API}/admin/articles/categories/999999`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
  });

  it('分类 slug 缺参数 → 400 VALIDATION_ERROR（不得是 5xx）', async () => {
    const invalid = await server()
      .post(`${API}/admin/articles/categories`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '没有 slug' });

    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('VALIDATION_ERROR');
  });

  /* ------------------------- 管理员账号：登录名唯一键 ------------------------- */

  it('管理员登录名重复 → 409 CONFLICT（缺陷 #112 的回归防线）', async () => {
    const conflict = await server()
      .post(`${API}/admin/users`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        username: 'admin-test',
        displayName: '重名管理员',
        password: 'Semantics@2026',
        roles: ['alumni_reviewer'],
      });

    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('CONFLICT');
  });

  /* ------------------------- 系统设置：upsert 不得被误伤 ------------------------- */

  it('系统设置重复写同一个 key → 成功（upsert 不是冲突）', async () => {
    const first = await server()
      .put(`${API}/admin/settings`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ key: 'semantics_probe', value: 'v1', description: '自测写入' })
      .expect(200);

    const second = await server()
      .put(`${API}/admin/settings`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ key: 'semantics_probe', value: 'v2', description: '自测写入' })
      .expect(200);

    expect(second.body.data.value).toBe('v2');
    expect(first.body.data.key).toBe('semantics_probe');
  });
});
