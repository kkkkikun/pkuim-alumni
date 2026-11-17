import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ContactShareGrant } from '../../src/database/entities/connection.entity';
import { createTestApp, ensureAdmin, login, markVerified, resetDatabase, setProfile } from '../helpers';

/**
 * 「先查后插」的并发撞唯一键（缺陷 #137）。
 *
 * 两处代码都是同一个形态：
 *   const existing = await repo.findOne(...);
 *   if (existing) { 修改并保存 } else { 新建并保存 }
 *
 * - `ConnectionsService.setContactGrant()` → `contact_share_grants` 有
 *   **唯一索引** `uk_contact_grant (pair_id, user_id)`；
 * - `ContentService.upsertSetting()` → `system_settings.key` 是**主键**。
 *
 * 单线程下「只发生一次写」没问题；**并发**下两个请求都读不到既有行，
 * 于是都去 INSERT → 后到的那一个撞唯一键 → 500。
 *
 * 现实场景：同一用户在两台设备同时打开「联系方式授权」开关；
 * 两个管理员同时保存同一条系统设置。
 *
 * 对照用例（防误伤）：单次写必须照常成功，且授权真的生效。
 */
const API = '/api/v1';

/**
 * 探针专用的系统设置 key。
 *
 * `system_settings` 是**保留表**（seed 基座，夹具不清理），所以这里用一把
 * 专属 key，并在用例前后显式删除 —— 既保证「读不到既有行」，
 * 又不给其它套件留残留。
 */
const PROBE_SETTING_KEY = 'concurrency_probe_setting';

describe('「先查后插」的并发撞唯一键（缺陷 #137）', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const server = () => request(app.getHttpServer());

  async function seedAlumni(openid: string) {
    const session = await login(app, openid);
    await markVerified(dataSource, session.userId);
    await setProfile(dataSource, session.userId, {
      display_name: `校友-${openid}`,
      show_in_directory: 1,
      accept_contact_requests: 1,
      allow_contact_share: 1,
    });
    return session;
  }

  /** 建立一条连接关系，返回 pairId 与双方（授权只能由**连接关系的成员**发起） */
  async function establishPair(
    a: string,
    b: string,
  ): Promise<{ pairId: number; userA: { accessToken: string; userId: number }; userB: { accessToken: string; userId: number } }> {
    const userA = await seedAlumni(a);
    const userB = await seedAlumni(b);
    const created = await server()
      .post(`${API}/connections/requests`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ targetUserId: userB.userId, message: '希望交流行业经验' })
      .expect(201);
    await server()
      .post(`${API}/connections/requests/${created.body.data.id}/accept`)
      .set('Authorization', `Bearer ${userB.accessToken}`)
      .expect(201);
    const [pair] = await dataSource.query(
      'SELECT id FROM connection_pairs WHERE status = ? ORDER BY id DESC LIMIT 1',
      ['active'],
    );
    return { pairId: Number(pair.id), userA, userB };
  }

  /**
   * 让 N 个并发请求的「读既有行」这一步**必然同时看到「行不存在」**，
   * 从而把并发窗口放大到必现。
   *
   * 为什么不能只「拖慢」：单纯加固定延时，两个请求仍可能**错开** ——
   * 先到的请求读完直接 INSERT，后到的请求醒来时行已经存在，
   * 于是走了「更新」分支，**撞不出唯一键冲突**（表现为两个 200，假通过）。
   *
   * 为什么不能只「屏障放行」：放行只是让两个请求**同时开始读**，
   * 但先读到的那个可能一路冲到 INSERT 并提交，后一个的 SELECT 就读到了行 ——
   * 同样撞不出冲突。
   *
   * 所以这里用**两段式屏障**：
   *   1) `gate1`：N 个调用**都到达**这一步 → 才允许真正发起 SELECT；
   *   2) `gate2`：N 个 SELECT **都已完成** → 才允许返回结果继续往下走（INSERT）。
   * 于是两个请求读到的都是「行不存在」（此刻谁都还没提交 INSERT），
   * 随后都去 INSERT → 后到的那一个撞唯一键。
   *
   * ⚠️ `Repository` 继承自 `EntityManager`，`findOne` 只存在于**同一个原型**上 ——
   *    所以原型级注入会命中**所有**仓储的 `findOne`（这里是有意的）。
   *    靠**入参条件**精确区分目标读；写后视图查询（toConnectionView）也在
   *    屏障放行之后才会发生，不会被误算成「到达者」。
   */
  function synchronizeFindWhere(
    matches: (where: Record<string, unknown>) => boolean,
    parties = 2,
  ): void {
    const repo = dataSource.getRepository(ContactShareGrant);
    const prototype = Object.getPrototypeOf(repo) as {
      findOne: (...args: unknown[]) => Promise<unknown>;
    };
    const original = prototype.findOne;

    let arrived = 0;
    let completed = 0;
    let openArrivals: () => void = () => undefined;
    let openCompletions: () => void = () => undefined;
    const gateArrivals = new Promise<void>((resolve) => {
      openArrivals = resolve;
    });
    const gateCompletions = new Promise<void>((resolve) => {
      openCompletions = resolve;
    });

    jest
      .spyOn(prototype, 'findOne')
      .mockImplementation(async function (this: unknown, ...args: unknown[]) {
        const criteria = args[0] as { where?: Record<string, unknown> } | undefined;
        if (!criteria?.where || !matches(criteria.where)) {
          return original.apply(this, args);
        }
        // 第 1 段：等所有并发请求都「到达」
        arrived += 1;
        if (arrived >= parties) openArrivals();
        await gateArrivals;
        const result = await original.apply(this, args);
        // 第 2 段：等所有并发请求的「读」都已完成 —— 此刻数据库里还没有任何 INSERT 提交
        completed += 1;
        if (completed >= parties) openCompletions();
        await gateCompletions;
        return result;
      });
  }

  it('#137 两个并发授权请求 → 都必须成功（不得 500）', async () => {
    const { pairId, userA } = await establishPair('conc-a', 'conc-b');

    // 让两个请求的「读授权行」这一步**必然同时**发生 → 两者都读到「行不存在」→ 都去 INSERT
    synchronizeFindWhere((where) => where.pairId === pairId && where.userId === userA.userId);

    const [first, second] = await Promise.all([
      server()
        .put(`${API}/connections/${pairId}/contact-grant`)
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .send({ allow: true }),
      server()
        .put(`${API}/connections/${pairId}/contact-grant`)
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .send({ allow: true }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // 且只能留下一条授权记录（唯一索引兜底，不该有重复）
    const [row] = await dataSource.query(
      'SELECT COUNT(*) AS c FROM contact_share_grants WHERE pair_id = ? AND user_id = ?',
      [pairId, userA.userId],
    );
    expect(Number(row.c)).toBe(1);
  });

  it('#137 两个并发系统设置写入 → 都必须成功（不得 500）', async () => {
    await ensureAdmin(dataSource, { permissionCode: 'settings:manage' });
    const loginResponse = await server()
      .post(`${API}/auth/admin/login`)
      .send({ username: 'admin-test', password: 'Admin@2026' })
      .expect(200);
    const adminToken = loginResponse.body.data.accessToken;

    // ⚠️ `system_settings` 属于**保留表**（seed 基座，不在夹具的清理清单里），
    //    所以这里必须用一把**专属探针 key**，并在用例前后显式清理 ——
    //    否则上一轮遗留的行会让「读」直接命中已有行，永远走不到 INSERT 分支，
    //    缺陷就再也撞不出来了（而且残留还会污染其它套件读到的设置）。
    await dataSource.query('DELETE FROM system_settings WHERE `key` = ?', [PROBE_SETTING_KEY]);

    // 让两个请求的「读设置行」这一步**必然同时**看到「行不存在」→ 都去 INSERT
    synchronizeFindWhere((where) => where.key === PROBE_SETTING_KEY);

    const [first, second] = await Promise.all([
      server()
        .put(`${API}/admin/settings`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ key: PROBE_SETTING_KEY, value: '并发写入的公告' }),
      server()
        .put(`${API}/admin/settings`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ key: PROBE_SETTING_KEY, value: '并发写入的公告' }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const [row] = await dataSource.query(
      'SELECT COUNT(*) AS c FROM system_settings WHERE `key` = ?',
      [PROBE_SETTING_KEY],
    );
    expect(Number(row.c)).toBe(1);

    // 清理探针行，不给其它套件留残留
    await dataSource.query('DELETE FROM system_settings WHERE `key` = ?', [PROBE_SETTING_KEY]);
  });

  it('对照：单次授权 → 成功且授权真的生效', async () => {
    const { pairId, userA } = await establishPair('single-a', 'single-b');

    await server()
      .put(`${API}/connections/${pairId}/contact-grant`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ allow: true })
      .expect(200);

    const [row] = await dataSource.query(
      'SELECT allow FROM contact_share_grants WHERE pair_id = ? AND user_id = ?',
      [pairId, userA.userId],
    );
    expect(Number(row.allow)).toBe(1);
  });
});
