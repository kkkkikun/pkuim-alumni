import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { BUILT_IN_ROLE_CODES, createTestApp, ensureAdmin, login, resetDatabase } from '../helpers';

/**
 * 管理端写接口的请求体校验（缺陷 #79 / #80 / #81）。
 *
 * #79 管理端 12 个写端点的请求体原先写的是 `Record<string, unknown>` 或普通 TS
 *      `interface` —— 运行时 metatype 是 `Object`，**ValidationPipe 完全跳过校验**：
 *        - `title: {}` 会被 `String()` 变成 "[object Object]" 存进库；
 *        - `status: 'bogus'` 一路走到数据库 ENUM 约束 → **500**；
 *        - 未声明的字段也不会被剥掉。
 *      需求基线 §4.3 明确要求「DTO 校验」。
 * #80 草稿也带着发布时间（publishNow 是死参数，契约里没有、客户端也没发过）。
 * #81 角色同步时**不存在的角色编码**被静默忽略，响应却回显请求里的完整列表 ——
 *      接口会「声称」给了一个其实没生效的角色。
 */
const API = '/api/v1';

describe('管理端请求体校验 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let token: string;
  /**
   * `admin_users` 属测试辅助函数里的「保留表」，不会被清空，
   * 所以新建管理员必须用**每次运行都不同**的用户名，否则第二次跑就撞唯一索引。
   */
  const uniq = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  /**
   * 本套件创建的角色编码。
   *
   * ⚠️ `roles` 是**保留表**（`resetDatabase` 不清空），
   *    本套件的角色编码（`role_content_manage` 等）不在契约的 `AdminRole` 联合里 ——
   *    残留会把角色目录撑成几十个编码，并让 `GET /admin/users`
   *    回显出契约不认的角色编码 → 响应形状校验判负。
   *    所以套件结束前必须把它们删掉。
   */
  const createdRoleCodes: string[] = [];

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
  });

  afterAll(async () => {
    // ⚠️ 清理必须在 `app.close()` **之前**做：
    //    `app.close()` 会连带销毁 TypeORM 的 DataSource，
    //    之后再调 `dataSource.query()` 会直接抛「连接已关闭」，
    //    异常又被下面的 catch 吞掉 → 角色编码永远删不掉。
    try {
      for (const code of createdRoleCodes) {
        // ⚠️ 内置角色编码（契约 `AdminRole` 联合类型里的那 5 个）**绝不删除**。
        if (BUILT_IN_ROLE_CODES.has(code)) continue;
        // ⚠️ `role_permissions` / `admin_user_roles` 指向 `roles` 的外键虽是
        //    ON DELETE CASCADE，但这里**显式**先删子表 —— 清理不依赖库的级联行为。
        await dataSource.query(
          `DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE code = ?)`,
          [code],
        );
        await dataSource.query(
          'DELETE FROM admin_user_roles WHERE role_id IN (SELECT id FROM roles WHERE code = ?)',
          [code],
        );
        await dataSource.query('DELETE FROM roles WHERE code = ?', [code]);
      }
    } catch {
      // 清理失败不影响测试结论（测试库每轮都会重建）
    }
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    // 一个拥有全部管理端权限的管理员
    for (const permission of [
      'content:manage',
      'event:manage',
      'admin:manage',
      'alumni:manage',
      'settings:manage',
    ]) {
      // ⚠️ 角色编码在这里被真正建出来（`ensureAdmin` 会 INSERT `roles`），
      //    所以必须**在建的地方**登记，套件结束才能把它删掉。
      const roleCode = `role_${permission.replace(':', '_')}`;
      if (!createdRoleCodes.includes(roleCode)) createdRoleCodes.push(roleCode);
      await ensureAdmin(dataSource, {
        username: 'admin-body',
        roleCode,
        permissionCode: permission,
      });
    }
    // 顺带建一个真实存在的角色 'alumni_reviewer'，
    // 供「角色编码不存在时被静默忽略」的用例做对照
    // ⚠️ 'alumni_reviewer' 是**内置角色编码**，绝不能登记进清理名单。
    await ensureAdmin(dataSource, {
      username: 'admin-body',
      roleCode: 'alumni_reviewer',
      permissionCode: 'dashboard:view',
    });
    const response = await request(app.getHttpServer())
      .post(`${API}/auth/admin/login`)
      .send({ username: 'admin-body', password: 'Admin@2026' })
      .expect(200);
    token = response.body.data.accessToken as string;
  });

  /* ------------------------- #79 畸形请求体一律 400 ------------------------- */

  it('#79 活动：标题不是字符串 / 容量不是数字 / 时间不是 ISO / 状态非法 → 400', async () => {
    const cases: Record<string, unknown>[] = [
      { title: {}, kind: '沙龙', capacity: 10 },
      { title: '活动', kind: '沙龙', capacity: 'abc' },
      { title: '活动', kind: '沙龙', capacity: 10, startsAt: 'not-a-date' },
      { title: '活动', kind: '沙龙', capacity: 10, status: 'bogus' },
      { kind: '沙龙', capacity: 10 },
      { title: '活动', kind: '沙龙' },
    ];
    for (const body of cases) {
      const response = await request(app.getHttpServer())
        .post(`${API}/admin/events`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(response.status).toBe(400);
    }
  });

  it('#79 资讯 / 公告：状态非法 / 标题缺失 → 400', async () => {
    await request(app.getHttpServer())
      .post(`${API}/admin/articles`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '资讯', body: '正文内容', status: 'bogus' })
      .expect(400);

    await request(app.getHttpServer())
      .post(`${API}/admin/articles`)
      .set('Authorization', `Bearer ${token}`)
      .send({ body: '只有正文没有标题' })
      .expect(400);

    await request(app.getHttpServer())
      .post(`${API}/admin/notices`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '公告', body: '正文', status: 'bogus' })
      .expect(400);
  });

  it('#79 账号状态：非法状态值 → 400（不是 500，也不是把脏值写进库）', async () => {
    // 测试库每轮都会被清空，这里先造一个用户
    const target = await login(app, 'att-status-target');
    const userId = target.userId;

    await request(app.getHttpServer())
      .patch(`${API}/admin/users/${userId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'bogus' })
      .expect(400);

    // 库里不能出现非法状态
    const rows = await dataSource.query('SELECT status FROM users WHERE id = ?', [userId]);
    expect(['active', 'disabled', 'locked']).toContain(rows[0].status);
  });

  it('#79 系统设置 / 管理员账号：字段类型非法 → 400', async () => {
    await request(app.getHttpServer())
      .put(`${API}/admin/settings`)
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 123, value: 'x' })
      .expect(400);

    // 登录名太短
    await request(app.getHttpServer())
      .post(`${API}/admin/users`)
      .set('Authorization', `Bearer ${token}`)
      .send({ username: 'ab', displayName: '太短', password: 'Valid@2026', roles: [] })
      .expect(400);

    // 密码太短
    await request(app.getHttpServer())
      .post(`${API}/admin/users`)
      .set('Authorization', `Bearer ${token}`)
      .send({ username: 'goodname', displayName: '正常', password: '123', roles: [] })
      .expect(400);
  });

  it('#79 合法请求仍然通过（DTO 不能把正常流程拦死）', async () => {
    const event = await request(app.getHttpServer())
      .post(`${API}/admin/events`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: '校友新春聚会',
        kind: '聚会',
        place: '呼和浩特',
        description: '这是一段活动介绍',
        startsAt: '2026-02-01T06:00:00.000Z',
        capacity: 100,
        status: 'draft',
      })
      .expect(201);
    expect(event.body.data.title).toBe('校友新春聚会');

    const article = await request(app.getHttpServer())
      .post(`${API}/admin/articles`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '资讯标题', summary: '摘要', body: '正文内容', status: 'published' })
      .expect(201);

    await request(app.getHttpServer())
      .put(`${API}/admin/settings`)
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'site.name', value: '内蒙古北京大学校友会', description: '站点名' })
      .expect(200);

    const created = await request(app.getHttpServer())
      .post(`${API}/admin/users`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        username: `newadmin_${uniq}`,
        displayName: '新管理员',
        password: 'Valid@2026',
        roles: ['alumni_reviewer'],
      });
    if (created.status !== 201) {
      console.log('DEBUG 创建管理员失败:', created.status, JSON.stringify(created.body));
    }
    expect(created.status).toBe(201);
  });

  /* ------------------------- #83 / #84 审计日志 ------------------------- */

  it('#83 停用账号填写的「原因」必须落进审计日志（此前被静默丢弃）', async () => {
    const target = await login(app, 'att-reason-target');
    const response = await request(app.getHttpServer())
      .patch(`${API}/admin/users/${target.userId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'disabled', reason: '违反校友会章程第三条' })
      .expect(200);
    expect(response.body.data.status).toBe('disabled');

    const rows = await dataSource.query(
      `SELECT action, detail FROM admin_action_logs
        WHERE action = 'user.status.change' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows).toHaveLength(1);
    const detail =
      typeof rows[0].detail === 'string' ? JSON.parse(rows[0].detail) : rows[0].detail;
    expect(detail.reason).toBe('违反校友会章程第三条');
    expect(detail.to).toBe('disabled');
  });

  it('#84 管理端账号类操作必须留下审计日志', async () => {
    const created = await request(app.getHttpServer())
      .post(`${API}/admin/users`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        username: `audit_${uniq}`,
        displayName: '审计留痕',
        password: 'Valid@2026',
        roles: ['alumni_reviewer'],
      })
      .expect(201);

    const rows = await dataSource.query(
      `SELECT action FROM admin_action_logs WHERE action = 'admin.user.create' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('admin.user.create');
    expect(created.body.data.username).toBe(`audit_${uniq}`);
  });

  /* ------------------------- #80 草稿不该有发布时间 ------------------------- */

  it('#80 草稿资讯 / 草稿公告的 publishedAt 必须是 null', async () => {
    const draftArticle = await request(app.getHttpServer())
      .post(`${API}/admin/articles`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '草稿资讯', body: '正文内容', status: 'draft' })
      .expect(201);
    expect(draftArticle.body.data.publishedAt).toBeNull();

    const draftNotice = await request(app.getHttpServer())
      .post(`${API}/admin/notices`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '草稿公告', body: '正文内容', status: 'draft' })
      .expect(201);
    expect(draftNotice.body.data.publishedAt).toBeNull();

    const published = await request(app.getHttpServer())
      .post(`${API}/admin/articles`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '已发布资讯', body: '正文内容', status: 'published' })
      .expect(201);
    expect(typeof published.body.data.publishedAt).toBe('string');
  });

  /* ------------------------- #81 角色响应必须诚实 ------------------------- */

  it('#81 角色编码不存在时，响应只回显**实际生效**的角色', async () => {
    const created = await request(app.getHttpServer())
      .post(`${API}/admin/users`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        username: `rolecheck_${uniq}`,
        displayName: '角色校验',
        password: 'Valid@2026',
        roles: ['alumni_reviewer', 'this_role_does_not_exist'],
      })
      .expect(201);

    expect(created.body.data.roles).toEqual(['alumni_reviewer']);

    const rows = await dataSource.query(
      `SELECT r.code FROM admin_user_roles ur
         JOIN roles r ON r.id = ur.role_id
        WHERE ur.admin_user_id = ?`,
      [created.body.data.id],
    );
    expect(rows.map((row: { code: string }) => row.code)).toEqual(['alumni_reviewer']);
  });
});
