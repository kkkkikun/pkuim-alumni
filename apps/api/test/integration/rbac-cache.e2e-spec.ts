/**
 * RBAC 缓存的有效性与**撤权延迟**（第三轮引入的进程内 TTL 缓存）。
 *
 * ⚠️ 为什么要有这个套件：
 *    `docs/SECURITY.md` 第 2.1 节承诺了两件事 ——
 *      ① 管理端请求不再每请求重算 RBAC（缓存「这个管理员有哪些权限点」）；
 *      ② 停用 / 降权时**主动失效**，本进程内的「降权后仍能操作」窗口是 **0**。
 *    这两条此前**没有任何用例守着**：把缓存改成「永不失效」或
 *    把主动失效那行注释掉，**整个集成测试套件照样全绿** ——
 *    因为所有用例要么用刚建好的账号（第一次请求，本来就是冷的），
 *    要么在降权之后**重新登录**（换了一张新令牌，缓存里压根没有旧条目）。
 *
 *    这正是「性能优化 / 安全语义一旦回退，既有测试不会变红」的典型土壤，
 *    所以这里补两个方向的守卫：
 *      - 缓存**确实生效**（第二次请求少打 3 条 SQL）；
 *      - 撤权**确实立刻生效**（同一个令牌，降权后立刻 403、停用后立刻 401）。
 */

import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource, Logger } from 'typeorm';
import { BUILT_IN_ROLE_CODES, createTestApp, ensureAdmin, login, resetDatabase } from '../helpers';

const API = '/api/v1';

/** 计数 logger：替换 DataSource 的 logger，统计一条请求里打了多少条 SQL。 */
class QueryCounter {
  private count = 0;
  private original: Logger;
  private counting: Logger;

  constructor(private readonly dataSource: DataSource) {
    this.original = dataSource.logger;
    this.counting = {
      logQuery: () => {
        this.count += 1;
      },
      logQueryError: () => undefined,
      logQuerySlow: () => undefined,
      logSchemaBuild: () => undefined,
      logMigration: () => undefined,
      log: () => undefined,
    };
  }

  start(): void {
    this.count = 0;
    this.dataSource.logger = this.counting;
  }

  stop(): number {
    this.dataSource.logger = this.original;
    return this.count;
  }
}

describe('RBAC 缓存 · 撤权延迟守卫', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let counter: QueryCounter;

  /**
   * 每次运行都用不同的用户名 / 角色编码，避免撞唯一索引。
   *
   * ⚠️ 角色编码列 `roles.code` 是 **VARCHAR(32)**（见 InitSchema 迁移）——
   *    角色编码超过 32 字符会被数据库**直接拒绝**（`Data too long for column 'code'`），
   *    所以下面的角色编码前缀都很短。
   */
  const uniq = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 10);
  /** 本套件创建的管理员账号（`admin_users` 是保留表，用完必须清理）。 */
  const createdUsernames: string[] = [];
  /** 本套件创建的角色编码。 */
  const createdRoleCodes: string[] = [];

  /** 造一个管理员：用户名 + 角色 + 该角色拥有的权限点。 */
  async function makeAdmin(
    username: string,
    roleCode: string,
    permissionCode: string,
  ): Promise<number> {
    createdUsernames.push(username);
    createdRoleCodes.push(roleCode);
    return ensureAdmin(dataSource, { username, roleCode, permissionCode });
  }

  /** 管理端登录，返回 access token。 */
  async function adminLogin(username: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`${API}/auth/admin/login`)
      .send({ username, password: 'Admin@2026' })
      .expect(200);
    return response.body.data.accessToken as string;
  }

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
    counter = new QueryCounter(dataSource);
  });

  afterAll(async () => {
    // ⚠️ 清理必须在 `app.close()` **之前**做（见 admin-account-management 套件的说明）：
    //    `app.close()` 会连带销毁 DataSource，之后再查库会抛「连接已关闭」。
    try {
      if (createdUsernames.length) {
        const placeholders = createdUsernames.map(() => '?').join(',');
        await dataSource.query(
          `DELETE FROM admin_action_logs WHERE admin_id IN
             (SELECT id FROM admin_users WHERE username IN (${placeholders}))`,
          createdUsernames,
        );
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
        // 内置角色编码绝不删除。
        if (BUILT_IN_ROLE_CODES.has(code)) continue;
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
  });

  it('同一个令牌连续两次请求：第二次少打 RBAC 解析的 3 条 SQL（缓存确实生效）', async () => {
    const username = `rbac_cache_${uniq}`;
    await makeAdmin(username, `role_rbac_cache_${uniq}`, 'alumni:view');
    const token = await adminLogin(username);

    // 第一次：缓存是冷的 → RBAC 解析要打 3 条 SQL
    // （admin_users + admin_user_roles + role_permissions）。
    counter.start();
    await request(app.getHttpServer())
      .get(`${API}/admin/alumni?page=1&pageSize=5`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const cold = counter.stop();

    // 第二次：同一个令牌 → RBAC 直接命中进程内缓存。
    counter.start();
    await request(app.getHttpServer())
      .get(`${API}/admin/alumni?page=1&pageSize=5`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const warm = counter.stop();

    // eslint-disable-next-line no-console
    console.log(`[RBAC 缓存] 冷启动 ${cold} 条 SQL → 命中缓存 ${warm} 条`);
    expect(warm).toBeLessThan(cold);
    // 少掉的正是 RBAC 解析那 3 条（`admin_users` / `admin_user_roles` / `role_permissions`）。
    expect(cold - warm).toBeGreaterThanOrEqual(3);
  });

  it('降权（改角色）后**同一个令牌**立刻 403 —— 撤权延迟在本进程内为 0', async () => {
    const actor = `rbac_actor_${uniq}`;
    const target = `rbac_target_${uniq}`;
    const highRole = `role_rbac_high_${uniq}`;
    const lowRole = `role_rbac_low_${uniq}`;

    // 操盘手：能管管理员（admin:manage）
    await makeAdmin(actor, `role_rbac_actor_${uniq}`, 'admin:manage');
    // 被降权者：先给「看校友」的权限点
    const targetId = await makeAdmin(target, highRole, 'alumni:view');
    // 再给一个**不含** alumni:view 的角色 —— 降权后只剩它
    await makeAdmin(target, lowRole, 'resource:review');

    const targetToken = await adminLogin(target);
    await request(app.getHttpServer())
      .get(`${API}/admin/alumni?page=1&pageSize=5`)
      .set('Authorization', `Bearer ${targetToken}`)
      .expect(200);

    // 操盘手把被降权者的角色改成「只剩 lowRole」—— 即撤掉 alumni:view。
    const actorToken = await adminLogin(actor);
    await request(app.getHttpServer())
      .patch(`${API}/admin/users/${targetId}`)
      .set('Authorization', `Bearer ${actorToken}`)
      .send({ roles: [lowRole] })
      .expect(200);

    // ⚠️ **不重新登录** —— 用的是同一张令牌。
    //    若主动失效失效了，缓存里仍是降权前的权限集 → 这里会放行（200），
    //    也就是「降权后仍能操作」——那正是 SECURITY.md 2.1 承诺为 0 的窗口。
    const after = await request(app.getHttpServer())
      .get(`${API}/admin/alumni?page=1&pageSize=5`)
      .set('Authorization', `Bearer ${targetToken}`)
      .expect(403);
    expect(after.body.code).toBe('FORBIDDEN');
  });

  it('停用账号后**同一个令牌**立刻 401 —— 停用同样走主动失效', async () => {
    const actor = `rbac_actor_off_${uniq}`;
    const target = `rbac_target_off_${uniq}`;
    await makeAdmin(actor, `role_rbac_actor_off_${uniq}`, 'admin:manage');
    const targetId = await makeAdmin(target, `role_rbac_tgt_off_${uniq}`, 'alumni:view');

    const targetToken = await adminLogin(target);
    await request(app.getHttpServer())
      .get(`${API}/admin/alumni?page=1&pageSize=5`)
      .set('Authorization', `Bearer ${targetToken}`)
      .expect(200);

    const actorToken = await adminLogin(actor);
    await request(app.getHttpServer())
      .patch(`${API}/admin/users/${targetId}`)
      .set('Authorization', `Bearer ${actorToken}`)
      .send({ status: 'disabled' })
      .expect(200);

    const after = await request(app.getHttpServer())
      .get(`${API}/admin/alumni?page=1&pageSize=5`)
      .set('Authorization', `Bearer ${targetToken}`)
      .expect(401);
    expect(after.body.code).toBe('AUTH_REQUIRED');
  });

  it('未读通知数**不缓存**：`/me/summary` 的计数当场反映新通知', async () => {
    const { accessToken, userId } = await login(app, `rbac_notify_${uniq}`);
    const before = await request(app.getHttpServer())
      .get(`${API}/me/summary`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    await dataSource.query(
      `INSERT INTO notifications (user_id, type, title, body, created_at)
       VALUES (?, 'system', '缓存守卫通知', '未读数必须实时', NOW(3))`,
      [userId],
    );

    const after = await request(app.getHttpServer())
      .get(`${API}/me/summary`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    // eslint-disable-next-line no-console
    console.log(
      `[RBAC 缓存] /me/summary 未读数 ${before.body.data.unreadCount} → ${after.body.data.unreadCount}`,
    );
    expect(after.body.data.unreadCount).toBe(before.body.data.unreadCount + 1);
  });
});
