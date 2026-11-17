import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AdminActionLog } from '../../src/database/entities/admin.entity';
import { createTestApp, ensureAdmin, resetDatabase } from '../helpers';

/**
 * 管理端「业务写 + 审计日志」的原子性（缺陷 #134）。
 *
 * 管理端所有写接口都是两步：
 *   1) 改业务数据（建活动 / 改资讯 / 删公告 / 审核决定 …）
 *   2) 写一条 `admin_action_logs` 审计日志
 *
 * 修复前这两步**各自提交**，后果有两个：
 *   - 审计日志写失败时，业务改动**已经提交**，接口却返回 500 ——
 *     管理端以为操作失败、重试一次，业务数据被改两次；
 *   - 而这一次操作**没有留下审计记录**，事后无法追溯。
 *
 * 修复后：两步放进**同一个事务**，审计写失败 → 业务改动一并回滚。
 *
 * 对照用例（防误伤）：正常写操作必须**既改业务数据、又留审计日志**。
 */
const API = '/api/v1';

describe('管理端「业务写 + 审计日志」的原子性（缺陷 #134）', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    jest.restoreAllMocks();
    await ensureAdmin(dataSource, { permissionCode: 'event:manage' });
    await ensureAdmin(dataSource, { permissionCode: 'content:manage' });
    const login = await request(app.getHttpServer())
      .post(`${API}/auth/admin/login`)
      .send({ username: 'admin-test', password: 'Admin@2026' })
      .expect(200);
    adminToken = login.body.data.accessToken;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const server = () => request(app.getHttpServer());

  async function count(table: string): Promise<number> {
    const [row] = await dataSource.query(`SELECT COUNT(*) AS c FROM \`${table}\``);
    return Number(row.c);
  }

  async function auditActions(): Promise<string[]> {
    const rows = await dataSource.query('SELECT action FROM admin_action_logs ORDER BY id');
    return (rows as { action: string }[]).map((row) => row.action);
  }

  /**
   * 让**审计日志**写失败（其它仓储不受影响）。
   *
   * ⚠️ `Repository` 继承自 `EntityManager`，`save` 只存在于**同一个原型**上 ——
   *    原型级注入会命中所有仓储，必须按实体类型精确拦截。
   */
  function breakAuditLogWrite(): void {
    const logRepo = dataSource.getRepository(AdminActionLog);
    const repositoryPrototype = Object.getPrototypeOf(logRepo) as {
      save: (entity: unknown, options?: unknown) => Promise<unknown>;
    };
    const originalSave = repositoryPrototype.save;
    jest
      .spyOn(repositoryPrototype, 'save')
      .mockImplementation(async function (this: unknown, entity: unknown, options?: unknown) {
        const target = Array.isArray(entity) ? entity[0] : entity;
        if (target instanceof AdminActionLog) {
          throw new Error('注入故障：审计日志写入失败');
        }
        return originalSave.call(this, entity, options);
      });
  }

  it('#134 审计日志写失败 → 业务改动必须整体回滚', async () => {
    breakAuditLogWrite();

    await server()
      .post(`${API}/admin/events`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: '不该留下的活动', kind: '沙龙', capacity: 10 })
      .expect(500);

    // 关键断言：活动**没有被创建**
    expect(await count('events')).toBe(0);
    // 审计日志自然也没有（写失败了）
    expect(await count('admin_action_logs')).toBe(0);
  });

  it('#134 审计日志写失败 → 删除公告也必须整体回滚', async () => {
    const created = await server()
      .post(`${API}/admin/notices`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: '将被删除的公告', body: '公告正文内容，长度满足校验要求。' })
      .expect(201);
    const noticeId = created.body.data.id as number;
    expect(await count('notices')).toBe(1);

    breakAuditLogWrite();

    await server()
      .delete(`${API}/admin/notices/${noticeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(500);

    // 公告必须还在（删除被回滚）
    expect(await count('notices')).toBe(1);
  });

  it('对照：正常创建活动 → 业务数据与审计日志都在', async () => {
    const created = await server()
      .post(`${API}/admin/events`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: '正常的活动', kind: '沙龙', capacity: 10 })
      .expect(201);

    expect(created.body.data.id).toBeDefined();
    expect(await count('events')).toBe(1);
    expect(await auditActions()).toContain('event.create');
  });

  it('对照：正常删除公告 → 公告没了，审计日志还在', async () => {
    const created = await server()
      .post(`${API}/admin/notices`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: '将被删除的公告', body: '公告正文内容，长度满足校验要求。' })
      .expect(201);
    const noticeId = created.body.data.id as number;

    await server()
      .delete(`${API}/admin/notices/${noticeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(await count('notices')).toBe(0);
    expect(await auditActions()).toContain('notice.delete');
  });
});
