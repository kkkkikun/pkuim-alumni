import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, ensureAdmin, login, resetDatabase } from '../helpers';
import { AdminUsersController } from '../../src/modules/admin/admin-users.controller';

/**
 * 管理端**账号与角色**的写入完整性（缺陷 #112 ~ #116）。
 *
 * 这一组缺陷都出在同一个地方 —— `admin-users.controller.ts`：
 *
 *   #112 登录名重复（唯一索引冲突）直接以 **500** 抛给前端。
 *        这是**客户端可修正**的输入问题（换个登录名就行），不是服务端故障。
 *   #113 对象不存在时返回 **200 + `{error:'NOT_FOUND'}`**，
 *        全仓库其它模块一律 `NotFoundException` → 404。
 *        更糟的是 `{error:...}` 会被统一包装成 `code:'OK'` 的成功响应，
 *        客户端按 code 判定成功 → **把「不存在」当成了成功**。
 *   #114 管理员账号**没有** 'locked' 状态（`admin_users.status` 的 ENUM 只有
 *        ('active','disabled')），但列表筛选项放行了 'locked'，
 *        后台「账号状态 = 已锁定」**永远筛不出任何行**；契约 `AdminUserDto.status`
 *        也借用了 `UserStatus`，承诺了一个服务端永远给不出的值。
 *   #115 建账号 / 改账号 / 停用账号是**多步写**，但没有事务：
 *        「先删角色再插角色」「先改资料再写审计」中途失败会留下半成品状态，
 *        而且接口已经 500，管理员无从得知发生了什么。
 *   #116 没有任何保护，管理员可以把自己停用、或把最后一个能管管理员的人降权 ——
 *        结果是**再没有人能登录后台**。
 *
 * 反过来也要防误伤：只改显示名、停用普通账号、动别人的账号都必须照常成功。
 */
const API = '/api/v1';

describe('管理端账号与角色的写入完整性 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let token: string;
  let selfAdminId: number;
  let selfUsername: string;

  /** 每次运行都用不同的用户名 / 角色编码，避免撞唯一索引 */
  const uniq = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  /** 本套件创建的管理员账号（`admin_users` 是保留表，用完必须清理） */
  const createdUsernames: string[] = [];
  /** 本套件创建的角色编码 */
  const createdRoleCodes: string[] = [];

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
  });

  afterAll(async () => {
    await app?.close();
    // ⚠️ `admin_users` / `roles` 属**保留表**（resetDatabase 不清空），
    // 不清理的话本套件创建的管理员会挤进其它套件的分页里
    // （本轮就因此把 admin-content 用例的「第一页含 admin-test」假设挤破了）。
    try {
      if (createdUsernames.length) {
        const placeholders = createdUsernames.map(() => '?').join(',');
        await dataSource.query(
          `DELETE FROM admin_user_roles WHERE admin_user_id IN
             (SELECT id FROM admin_users WHERE username IN (${placeholders}))`,
          createdUsernames,
        );
        await dataSource.query(
          `DELETE FROM admin_users WHERE username IN (${placeholders})`,
          createdUsernames,
        );
      }
      for (const code of createdRoleCodes) {
        await dataSource.query(
          `DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE code = ?)`,
          [code],
        );
        await dataSource.query('DELETE FROM roles WHERE code = ?', [code]);
      }
    } catch {
      // 清理失败不影响测试结论（测试库每轮都会重建）
    }
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    selfUsername = `acct_admin_${uniq}`;
    createdUsernames.push(selfUsername);
    // 一个既管账号、又管校友的管理员
    selfAdminId = await ensureAdmin(dataSource, {
      username: selfUsername,
      roleCode: `role_acct_admin_${uniq}`,
      permissionCode: 'admin:manage',
    });
    createdRoleCodes.push(`role_acct_admin_${uniq}`);
    await ensureAdmin(dataSource, {
      username: selfUsername,
      roleCode: `role_acct_alumni_${uniq}`,
      permissionCode: 'alumni:manage',
    });
    createdRoleCodes.push(`role_acct_alumni_${uniq}`);
    // 查看普通账号详情需要 alumni:view（GET /admin/users/:id）
    await ensureAdmin(dataSource, {
      username: selfUsername,
      roleCode: `role_acct_view_${uniq}`,
      permissionCode: 'alumni:view',
    });
    createdRoleCodes.push(`role_acct_view_${uniq}`);

    const response = await request(app.getHttpServer())
      .post(`${API}/auth/admin/login`)
      .send({ username: selfUsername, password: 'Admin@2026' })
      .expect(200);
    token = response.body.data.accessToken as string;
  });

  const server = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });

  /* ---------------------------- #112 重复登录名 ---------------------------- */

  it('#112 创建管理员：登录名重复 → 409 CONFLICT（此前是 500）', async () => {
    const response = await server()
      .post(`${API}/admin/users`)
      .set(auth())
      .send({ username: selfUsername, displayName: '重名', password: 'Valid@2026' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CONFLICT');
    expect(response.body.data).toBeNull();
  });

  it('#112 对照：换个登录名就能正常创建', async () => {
    createdUsernames.push(`acct_new_${uniq}`);
    const created = await server()
      .post(`${API}/admin/users`)
      .set(auth())
      .send({ username: `acct_new_${uniq}`, displayName: '新账号', password: 'Valid@2026' })
      .expect(201);
    expect(created.body.data.username).toBe(`acct_new_${uniq}`);
  });

  /* ---------------------------- #113 不存在 → 404 ---------------------------- */

  it('#113 管理端取不存在的对象 → 404 NOT_FOUND（此前是 200 + data.error）', async () => {
    const missing = 999999;

    const detail = await server().get(`${API}/admin/users/${missing}`).set(auth());
    expect(detail.status).toBe(404);
    expect(detail.body.code).toBe('NOT_FOUND');
    // 关键：不能再出现「code=OK 却装着 NOT_FOUND」的假成功响应
    expect(detail.body.code).not.toBe('OK');

    const update = await server()
      .patch(`${API}/admin/users/${missing}`)
      .set(auth())
      .send({ displayName: '改谁呢' });
    expect(update.status).toBe(404);
    expect(update.body.code).toBe('NOT_FOUND');

    const status = await server()
      .patch(`${API}/admin/users/${missing}/status`)
      .set(auth())
      .send({ status: 'disabled', reason: '不存在的人' });
    expect(status.status).toBe(404);
    expect(status.body.code).toBe('NOT_FOUND');
  });

  it('#113 对照：真实存在的普通账号仍然能查、能停用', async () => {
    const user = await login(app, `acct-target-${uniq}`);
    const detail = await server().get(`${API}/admin/users/${user.userId}`).set(auth()).expect(200);
    expect(detail.body.data.id).toBe(user.userId);

    const status = await server()
      .patch(`${API}/admin/users/${user.userId}/status`)
      .set(auth())
      .send({ status: 'disabled', reason: '测试' })
      .expect(200);
    expect(status.body.data.status).toBe('disabled');
  });

  /* ---------------------------- #114 'locked' 死值 ---------------------------- */

  it('#114 管理员账号没有「已锁定」状态：筛选 locked 必须被拒（而不是返回空列表）', async () => {
    const response = await server().get(`${API}/admin/users?status=locked`).set(auth());
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('#114 对照：正常的状态筛选照常工作', async () => {
    const response = await server().get(`${API}/admin/users?status=active`).set(auth()).expect(200);
    expect(Array.isArray(response.body.data.items)).toBe(true);
  });

  /* ---------------------------- #115 事务边界 ---------------------------- */

  it('#115 改账号是「多步写」：中途失败必须整体回滚（不得留下半成品）', async () => {
    createdUsernames.push(`acct_atomic_${uniq}`);
    const created = await server()
      .post(`${API}/admin/users`)
      .set(auth())
      .send({ username: `acct_atomic_${uniq}`, displayName: '原名', password: 'Valid@2026' })
      .expect(201);
    const targetId = created.body.data.id as number;

    // 注入故障：角色同步这一步直接抛错
    const controller = app.get(AdminUsersController) as unknown as {
      syncRoles: (...args: unknown[]) => Promise<string[]>;
    };
    const original = controller.syncRoles;
    controller.syncRoles = async () => {
      throw new Error('注入故障：角色同步失败');
    };
    try {
      await server()
        .patch(`${API}/admin/users/${targetId}`)
        .set(auth())
        .send({ displayName: '改成新名字', roles: ['alumni_reviewer'] })
        .expect(500);
    } finally {
      controller.syncRoles = original;
    }

    // 关键断言：资料**不能**被提交（事务回滚）
    const rows = await dataSource.query(
      'SELECT display_name FROM admin_users WHERE id = ?',
      [targetId],
    );
    expect(rows[0].display_name).toBe('原名');

    // 审计日志也不能留下「其实没发生」的记录
    const logs = await dataSource.query(
      "SELECT COUNT(*) AS total FROM admin_action_logs WHERE action = 'admin.user.update' AND target_id = ?",
      [String(targetId)],
    );
    expect(Number(logs[0].total)).toBe(0);
  });

  it('#115 对照：正常改账号照常生效并留痕', async () => {
    createdUsernames.push(`acct_ok_${uniq}`);
    const created = await server()
      .post(`${API}/admin/users`)
      .set(auth())
      .send({ username: `acct_ok_${uniq}`, displayName: '原名', password: 'Valid@2026' })
      .expect(201);
    const targetId = created.body.data.id as number;

    await server()
      .patch(`${API}/admin/users/${targetId}`)
      .set(auth())
      .send({ displayName: '新名字', roles: ['alumni_reviewer'] })
      .expect(200);

    const rows = await dataSource.query(
      'SELECT display_name FROM admin_users WHERE id = ?',
      [targetId],
    );
    expect(rows[0].display_name).toBe('新名字');

    const logs = await dataSource.query(
      "SELECT COUNT(*) AS total FROM admin_action_logs WHERE action = 'admin.user.update' AND target_id = ?",
      [String(targetId)],
    );
    expect(Number(logs[0].total)).toBe(1);
  });

  /* ---------------------------- #116 后台锁死保护 ---------------------------- */

  describe('#116 系统里必须始终留有「能管管理员的人」', () => {
    /** 临时把所有别的管理员停用，制造「只剩我一个」的局面 */
    let snapshot: { id: number; status: string }[] = [];

    beforeEach(async () => {
      snapshot = (await dataSource.query('SELECT id, status FROM admin_users')) as {
        id: number;
        status: string;
      }[];
      await dataSource.query('UPDATE admin_users SET status = ? WHERE id <> ?', [
        'disabled',
        selfAdminId,
      ]);
    });

    afterEach(async () => {
      for (const row of snapshot) {
        await dataSource.query('UPDATE admin_users SET status = ? WHERE id = ?', [
          row.status,
          row.id,
        ]);
      }
    });

    it('#116 把自己停用 → 400（否则再没人能登录后台）', async () => {
      const response = await server()
        .patch(`${API}/admin/users/${selfAdminId}`)
        .set(auth())
        .send({ status: 'disabled' });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');

      const rows = await dataSource.query('SELECT status FROM admin_users WHERE id = ?', [
        selfAdminId,
      ]);
      expect(rows[0].status).toBe('active');
    });

    it('#116 把最后一个能管管理员的人降权 → 400', async () => {
      const response = await server()
        .patch(`${API}/admin/users/${selfAdminId}`)
        .set(auth())
        .send({ roles: ['alumni_reviewer'] });
      expect(response.status).toBe(400);

      const links = await dataSource.query(
        'SELECT COUNT(*) AS total FROM admin_user_roles WHERE admin_user_id = ?',
        [selfAdminId],
      );
      expect(Number(links[0].total)).toBeGreaterThan(0);
    });

    it('#116 对照：只改显示名不受这条规则影响', async () => {
      await server()
        .patch(`${API}/admin/users/${selfAdminId}`)
        .set(auth())
        .send({ displayName: '只是改个名字' })
        .expect(200);
    });
  });

  it('#116 对照：还有别的管理员时，停用自己仍然放行', async () => {
    createdUsernames.push(`acct_other_${uniq}`);
    createdRoleCodes.push(`role_acct_admin2_${uniq}`);
    await ensureAdmin(dataSource, {
      username: `acct_other_${uniq}`,
      roleCode: `role_acct_admin2_${uniq}`,
      permissionCode: 'admin:manage',
    });

    await server()
      .patch(`${API}/admin/users/${selfAdminId}`)
      .set(auth())
      .send({ status: 'disabled' })
      .expect(200);
  });
});
