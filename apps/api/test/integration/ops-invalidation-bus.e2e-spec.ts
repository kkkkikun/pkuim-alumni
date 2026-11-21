import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { BUILT_IN_ROLE_CODES, createTestApp, ensureAdmin, login, resetDatabase } from '../helpers';
import { InvalidationBusService } from '../../src/common/services/invalidation-bus.service';

/**
 * 只读运维端点：`GET /admin/ops/invalidation-bus`（第七轮引入）。
 *
 * ⚠️ 为什么要有这个套件：
 *    多实例部署时「跨实例失效到底生效没有」此前只能靠翻日志。
 *    运维端点一旦**没接上**（返回 404 / 500 / 字段不对），
 *    运维就会**误以为**总线是好的 —— 那比没有这个端点更糟。
 *    所以这里把「端点存在、只对管理员开放、字段齐全」钉住。
 *
 * ⚠️ 口径见 `docs/SECURITY.md` 第 2.1.9 节；
 *    契约见 `packages/contracts/src/api.ts`（`adminOpsInvalidationBus`）。
 */

const API = '/api/v1';

describe('只读运维端点 · 共享失效总线状态', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const uniq = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 8);
  const createdUsernames: string[] = [];
  const createdRoleCodes: string[] = [];

  async function makeAdmin(
    username: string,
    roleCode: string,
    permissionCode: string,
  ): Promise<number> {
    createdUsernames.push(username);
    createdRoleCodes.push(roleCode);
    return ensureAdmin(dataSource, { username, roleCode, permissionCode });
  }

  async function adminLogin(username: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`${API}/auth/admin/login`)
      .send({ username, password: 'Admin@2026' })
      .expect(200);
    return response.body.data.accessToken as string;
  }

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
  });

  afterAll(async () => {
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

  it('匿名请求 → 401（**不公开**：频道名与错误信息不对外暴露）', async () => {
    await request(app.getHttpServer()).get(`${API}/admin/ops/invalidation-bus`).expect(401);
  });

  it('普通校友令牌 → 403（只对管理员开放）', async () => {
    const { accessToken } = await login(app, `ops_alumni_${uniq}`);
    const response = await request(app.getHttpServer())
      .get(`${API}/admin/ops/invalidation-bus`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(response.status).toBe(403);
  });

  it('管理员令牌 → 200，字段齐全（enabled / 频道 / subscribed / 计数 / lastError）', async () => {
    const actor = `ops_admin_${uniq}`;
    await makeAdmin(actor, `role_ops_admin_${uniq}`, 'admin:manage');
    const token = await adminLogin(actor);

    const response = await request(app.getHttpServer())
      .get(`${API}/admin/ops/invalidation-bus`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const data = response.body.data as {
      enabled: boolean;
      channel: string;
      subscribed: boolean;
      published: number;
      received: number;
      lastError: string | null;
      degraded: boolean;
    };
    // 字段齐全 —— 少一个字段，运维就少一条判据。
    expect(Object.keys(data).sort()).toEqual(
      ['channel', 'degraded', 'enabled', 'lastError', 'published', 'received', 'subscribed'].sort(),
    );
    expect(typeof data.enabled).toBe('boolean');
    expect(typeof data.channel).toBe('string');
    expect(data.channel.length).toBeGreaterThan(0);
    expect(typeof data.subscribed).toBe('boolean');
    expect(typeof data.published).toBe('number');
    expect(typeof data.received).toBe('number');
    expect(data.lastError === null || typeof data.lastError === 'string').toBe(true);
    expect(typeof data.degraded).toBe('boolean');
    // 「开着但没订阅上」= degraded。
    expect(data.degraded).toBe(data.enabled === true && data.subscribed === false);
  });

  it('端点返回的**就是**总线自己的状态（与 `InvalidationBusService.stats` 同源）', async () => {
    const actor = `ops_admin_src_${uniq}`;
    await makeAdmin(actor, `role_ops_admin_src_${uniq}`, 'admin:manage');
    const token = await adminLogin(actor);

    const response = await request(app.getHttpServer())
      .get(`${API}/admin/ops/invalidation-bus`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const stats = app.get(InvalidationBusService).stats;
    const data = response.body.data as {
      enabled: boolean;
      channel: string;
      subscribed: boolean;
      published: number;
      received: number;
    };
    expect(data.enabled).toBe(stats.enabled);
    expect(data.channel).toBe(stats.channel);
    expect(data.subscribed).toBe(stats.subscribed);
    expect(data.published).toBe(stats.published);
    expect(data.received).toBe(stats.received);
  });

  it('既有对外健康检查端点的**响应形状不变**（本轮没有改对外契约）', async () => {
    // ⚠️ `GET /system/health` 是**公开**端点，也是**对外契约**
    //    （`packages/contracts` + `docs/API-SPEC.md`）。
    //    本轮**没有**往它上面挂总线状态 —— 这里把它的形状钉住，
    //    免得以后有人「顺手」把总线状态加进去（那会对外暴露内部拓扑）。
    const health = await request(app.getHttpServer()).get(`${API}/system/health`).expect(200);
    const data = health.body.data as { checks: Record<string, unknown> };
    expect(Object.keys(data).sort()).toEqual(['checks', 'status', 'timestamp'].sort());
    expect(data.checks).not.toHaveProperty('invalidationBus');

    // 存活探针同理。
    const healthz = await request(app.getHttpServer()).get('/healthz').expect(200);
    expect(Object.keys(healthz.body.data as Record<string, unknown>).sort()).toEqual(
      ['service', 'status', 'timestamp'].sort(),
    );
  });
});
