import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { BUILT_IN_ROLE_CODES, createTestApp, ensureAdmin, resetDatabase } from '../helpers';
import { InvalidationBusService } from '../../src/common/services/invalidation-bus.service';

/**
 * 共享失效总线（第六轮扩展）· 字典 / 分类 / 系统设置的**跨实例**失效。
 *
 * ⚠️ 为什么要有这个套件：
 *    第五轮把「撤权」的跨实例失效补上了（`docs/SECURITY.md` 第 2.1.4 / 2.1.5 节），
 *    但**字典 / 分类 / 系统设置**在别的实例上仍要等各自的 TTL（≤300 秒）才变。
 *    本轮把**同一套总线、同一套降级路径**扩展到这一类，口径写在
 *    `docs/SECURITY.md` 第 2.1.6 节。
 *
 *    这里用**同一个进程内的两个应用实例 + 一个 Redis**把这条语义钉住：
 *      ① 实例 A 改分类 / 写设置 → 实例 B 的字典缓存**立刻**失效（**不等 TTL**）；
 *      ② 总线不可用时 → 写操作**仍 200**，陈旧延迟**回落到 TTL 上界**（不是永久陈旧）；
 *      ③ 总线上**只有失效事件**，字典内容一个字都不带；
 *      ④ **同一个频道**同时承载 RBAC 与字典类失效事件（一条总线，不是两条）。
 *
 *    TTL 在本套件里被调成 **5 秒**（`DICT_CACHE_TTL_SECONDS=5`）：
 *    「不等 TTL 就失效」与「回落到 TTL 上界」这两条都能在几秒内验证完。
 *
 *    ⚠️ 频道名用**独立的** `nmg:test:dict:invalidate`（第五轮那个套件用的是
 *    `nmg:test:rbac:invalidate`）：两个套件各自裸连 Redis 监听频道，
 *    共用一个频道会在「并行跑测试文件」时互相串消息（第五轮那条用例断言
 *    「总线上只有失效事件」，串进一条字典事件就会误判）。
 *    「一条总线承载多种 kind」由本套件的第四条用例在**同一个频道**上证明。
 */

const API = '/api/v1';

/**
 * 本套件要改的环境变量。
 *
 * ⚠️ 顶层改 `process.env` 有副作用：`jest --runInBand` 会在同一进程内顺序执行
 *    多个测试文件，TTL=5 会**泄漏到后续文件** → 因此在 `afterAll` 里原样恢复
 *    （与 `rbac-invalidation-bus.e2e-spec.ts` 同一套做法）。
 */
const ENV_KEYS = [
  'DICT_CACHE_TTL_SECONDS',
  'RBAC_INVALIDATION_ENABLED',
  'RBAC_INVALIDATION_CHANNEL',
  'REDIS_PORT',
] as const;

const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

process.env.DICT_CACHE_TTL_SECONDS = '5';
process.env.RBAC_INVALIDATION_ENABLED = 'true';
process.env.RBAC_INVALIDATION_CHANNEL = 'nmg:test:dict:invalidate';

/** 一个**肯定连不上**的端口：用来模拟「Redis 挂了 / 订阅断开」。 */
const DEAD_REDIS_PORT = '1';

describe('共享失效总线 · 字典 / 分类 / 设置的跨实例失效', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let dataSource: DataSource;

  const uniq = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 8);
  const createdUsernames: string[] = [];
  const createdRoleCodes: string[] = [];
  const createdSettingKeys: string[] = [];

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
  async function adminLogin(app: INestApplication, username: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`${API}/auth/admin/login`)
      .send({ username, password: 'Admin@2026' })
      .expect(200);
    return response.body.data.accessToken as string;
  }

  /** 拿某个实例上的总线服务。 */
  function busOf(app: INestApplication): InvalidationBusService {
    return app.get(InvalidationBusService);
  }

  /**
   * 等某个实例**订阅上**频道。
   *
   * ⚠️ 为什么要等：订阅是在 `onModuleInit` 里发起的，
   *    Redis 慢一点时第一次尝试可能失败（此时靠 5 秒后的重试补上）——
   *    不等就会让用例「偶发失败」，而失败原因与被测行为无关。
   */
  async function waitForSubscription(app: INestApplication): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (busOf(app).stats.subscribed) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      '失效总线未能在 15 秒内订阅上频道 —— 本机没有可用的 Redis？' +
        `（频道 ${busOf(app).stats.channel}，最后错误：${busOf(app).stats.lastError ?? '无'}）`,
    );
  }

  /** 读某个实例上的公开分类字典（会填充 / 读取该实例的字典缓存）。 */
  function listCategories(app: INestApplication) {
    return request(app.getHttpServer()).get(`${API}/articles/categories`);
  }

  /** 读某个实例上的公开系统设置字典。 */
  function listSettings(app: INestApplication) {
    return request(app.getHttpServer()).get(`${API}/system/settings`);
  }

  /** 分类名是否在某次响应里。 */
  function hasCategory(response: { body: { data?: unknown } }, name: string): boolean {
    const data = response.body.data;
    return Array.isArray(data) && data.some((item) => (item as { name?: string }).name === name);
  }

  /** 某个设置项在响应里的值。 */
  function settingValue(
    response: { body: { data?: unknown } },
    key: string,
  ): string | undefined {
    const data = response.body.data;
    if (!Array.isArray(data)) return undefined;
    const row = data.find((item) => (item as { key?: string }).key === key) as
      | { value?: string }
      | undefined;
    return row?.value;
  }

  beforeAll(async () => {
    ({ app: appA, dataSource } = await createTestApp());
    ({ app: appB } = await createTestApp());
    await waitForSubscription(appA);
    await waitForSubscription(appB);
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
      // ⚠️ `system_settings` 是**保留表**（`resetDatabase` 不清空），
      //    本套件写入的设置项必须自己删掉，否则会残留给后续套件。
      for (const key of createdSettingKeys) {
        await dataSource.query('DELETE FROM system_settings WHERE `key` = ?', [key]);
      }
    } catch {
      // 清理失败不影响测试结论（测试库每轮都会重建）
    }
    await appA?.close();
    await appB?.close();

    for (const key of ENV_KEYS) {
      const original = originalEnv[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  it('频道名走配置，并按环境隔离（字典类事件复用同一条总线）', () => {
    // 本套件订阅的频道 = 配置里写的那个（未被改写，因为已带环境段）。
    expect(busOf(appA).stats.channel).toBe('nmg:test:dict:invalidate');
    expect(busOf(appB).stats.channel).toBe('nmg:test:dict:invalidate');
    // 两个实例连的是**同一个频道** → 事件能从 A 走到 B。
    expect(busOf(appA).stats.channel).toBe(busOf(appB).stats.channel);
  });

  it('总线上只有**失效事件**，没有任何字典内容', async () => {
    const actor = `dict_actor_msg_${uniq}`;
    await makeAdmin(actor, `r_dict_msg_${uniq}`, 'admin:manage');
    await makeAdmin(actor, `r_dict_msg2_${uniq}`, 'content:manage');
    await makeAdmin(actor, `r_dict_msg3_${uniq}`, 'settings:manage');
    const actorToken = await adminLogin(appA, actor);

    const secretCategoryName = `机密分类名-${uniq}`;
    const secretSettingKey = `dict_probe_${uniq}`;
    const secretSettingValue = `机密设置值-${uniq}`;
    createdSettingKeys.push(secretSettingKey);

    // 用一个「裸」的 Redis 连接监听频道，亲自看看总线上到底流过什么。
    const listener = new Redis({
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      db: Number(process.env.REDIS_DB ?? 0),
    });
    const received: string[] = [];
    await listener.subscribe(busOf(appA).stats.channel);
    listener.on('message', (_channel: string, message: string) => {
      received.push(message);
    });

    try {
      await request(appA.getHttpServer())
        .post(`${API}/admin/articles/categories`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send({ name: secretCategoryName, slug: `secret-${uniq}` })
        .expect(201);
      await request(appA.getHttpServer())
        .put(`${API}/admin/settings`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send({ key: secretSettingKey, value: secretSettingValue })
        .expect(200);

      // 等消息送到（本地 Redis 通常是毫秒级）。
      const deadline = Date.now() + 5_000;
      while (received.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(received.length).toBeGreaterThanOrEqual(2);

      const payloads = received.map((raw) => JSON.parse(raw) as Record<string, unknown>);
      // 只有「哪个字典该作废」。
      expect(payloads).toContainEqual({ kind: 'dict', dict: 'categories' });
      expect(payloads).toContainEqual({ kind: 'dict', dict: 'settings' });

      // 明确断言：**不含**任何字典内容（分类名 / 设置项的 key 与 value）。
      const serialized = JSON.stringify(payloads);
      expect(serialized).not.toContain(secretCategoryName);
      expect(serialized).not.toContain(secretSettingKey);
      expect(serialized).not.toContain(secretSettingValue);
      for (const forbidden of ['name', 'value', 'slug', 'description', 'content']) {
        expect(serialized.toLowerCase()).not.toContain(`"${forbidden.toLowerCase()}"`);
      }
    } finally {
      await listener.quit();
    }
  });

  it('实例 A 改分类 → 实例 B 的分类缓存**立刻**失效（不等 TTL）', async () => {
    const actor = `dict_actor_cat_${uniq}`;
    await makeAdmin(actor, `r_dict_cat_${uniq}`, 'admin:manage');
    await makeAdmin(actor, `r_dict_cat2_${uniq}`, 'content:manage');
    const actorToken = await adminLogin(appA, actor);

    const categoryName = `跨实例分类-${uniq}`;

    // 实例 B 先读一次 → B 的进程内缓存里有当时的分类列表。
    const before = await listCategories(appB).expect(200);
    expect(hasCategory(before, categoryName)).toBe(false);
    const cachedAt = Date.now();
    const receivedBefore = busOf(appB).stats.received;

    // 实例 A 上新建分类 → 事务提交后向总线发布字典类失效事件。
    const startedAt = Date.now();
    await request(appA.getHttpServer())
      .post(`${API}/admin/articles/categories`)
      .set('Authorization', `Bearer ${actorToken}`)
      .send({ name: categoryName, slug: `cross-${uniq}` })
      .expect(201);

    // 实例 B：**不等 TTL**，应当立刻看到新分类。
    // ⚠️ TTL 是 5 秒：若总线没生效，B 会一直返回旧列表到 TTL 过期为止，
    //    所以「2 秒内就看到」这件事本身就是「总线生效」的证据。
    let visible = false;
    const deadline = startedAt + 2_000;
    while (Date.now() < deadline) {
      const response = await listCategories(appB).expect(200);
      if (hasCategory(response, categoryName)) {
        visible = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // eslint-disable-next-line no-console
    console.log(
      `[字典失效总线] 实例 A 改分类 → 实例 B 在 ${Date.now() - startedAt} ms 内看到新分类`,
    );
    expect(visible).toBe(true);
    // 「看到」的时刻必须**早于 TTL 到期**（5 秒）—— 否则就分不清是总线还是 TTL。
    expect(Date.now() - cachedAt).toBeLessThan(5_000);

    // 实例 B 确实收到了这条失效事件（不是「碰巧」读到了数据库）。
    expect(busOf(appB).stats.received - receivedBefore).toBeGreaterThan(0);
  });

  it('实例 A 写系统设置 → 实例 B 的设置缓存**立刻**失效（不等 TTL）', async () => {
    const actor = `dict_actor_set_${uniq}`;
    await makeAdmin(actor, `r_dict_set_${uniq}`, 'admin:manage');
    await makeAdmin(actor, `r_dict_set2_${uniq}`, 'settings:manage');
    const actorToken = await adminLogin(appA, actor);

    const settingKey = `dict_probe_set_${uniq}`;
    createdSettingKeys.push(settingKey);

    // 先建一个设置项 → 实例 B 读一次（缓存里是旧值）。
    await request(appA.getHttpServer())
      .put(`${API}/admin/settings`)
      .set('Authorization', `Bearer ${actorToken}`)
      .send({ key: settingKey, value: 'v1' })
      .expect(200);
    const before = await listSettings(appB).expect(200);
    expect(settingValue(before, settingKey)).toBe('v1');
    const cachedAt = Date.now();
    const receivedBefore = busOf(appB).stats.received;

    // 改成 v2 → 事务提交后发布字典类失效事件。
    const startedAt = Date.now();
    await request(appA.getHttpServer())
      .put(`${API}/admin/settings`)
      .set('Authorization', `Bearer ${actorToken}`)
      .send({ key: settingKey, value: 'v2' })
      .expect(200);

    // 实例 B：应当立刻看到 v2（不等 TTL）。
    let value = 'v1';
    const deadline = startedAt + 2_000;
    while (Date.now() < deadline) {
      const response = await listSettings(appB).expect(200);
      value = settingValue(response, settingKey) ?? 'v1';
      if (value === 'v2') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // eslint-disable-next-line no-console
    console.log(
      `[字典失效总线] 实例 A 写设置 → 实例 B 在 ${Date.now() - startedAt} ms 内看到新值`,
    );
    expect(value).toBe('v2');
    expect(Date.now() - cachedAt).toBeLessThan(5_000);
    expect(busOf(appB).stats.received - receivedBefore).toBeGreaterThan(0);
  });

  it('**同一个频道**同时承载 RBAC 与字典类失效事件（一条总线，不是两条）', async () => {
    const actor = `dict_actor_mix_${uniq}`;
    const target = `dict_target_mix_${uniq}`;
    const lowRole = `r_dict_low_${uniq}`;
    await makeAdmin(actor, `r_dict_mix_${uniq}`, 'admin:manage');
    await makeAdmin(actor, `r_dict_mix2_${uniq}`, 'content:manage');
    const targetId = await makeAdmin(target, `r_dict_high_${uniq}`, 'alumni:view');
    await makeAdmin(target, lowRole, 'resource:review');

    // 目标账号先在**实例 B** 上用一次 → B 的 RBAC 缓存里有他的权限集。
    const targetToken = await adminLogin(appB, target);
    await request(appB.getHttpServer())
      .get(`${API}/admin/alumni?page=1&pageSize=5`)
      .set('Authorization', `Bearer ${targetToken}`)
      .expect(200);
    const receivedBefore = busOf(appB).stats.received;

    // 实例 A 上：既降权（RBAC 类事件），又改分类（字典类事件）。
    const actorToken = await adminLogin(appA, actor);
    await request(appA.getHttpServer())
      .patch(`${API}/admin/users/${targetId}`)
      .set('Authorization', `Bearer ${actorToken}`)
      .send({ roles: [lowRole] })
      .expect(200);
    await request(appA.getHttpServer())
      .post(`${API}/admin/articles/categories`)
      .set('Authorization', `Bearer ${actorToken}`)
      .send({ name: `混合分类-${uniq}`, slug: `mixed-${uniq}` })
      .expect(201);

    // 两条事件走的是**同一个频道**：B 收到了至少两条（RBAC + 字典）。
    const deadline = Date.now() + 3_000;
    while (busOf(appB).stats.received - receivedBefore < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(busOf(appB).stats.received - receivedBefore).toBeGreaterThanOrEqual(2);

    // RBAC 那一半也照样立刻生效：同一张令牌在 B 上不再放行。
    const response = await request(appB.getHttpServer())
      .get(`${API}/admin/alumni?page=1&pageSize=5`)
      .set('Authorization', `Bearer ${targetToken}`);
    expect(response.status).toBe(403);
  });

  it('总线不可用：写操作**仍 200**，陈旧回落到 TTL 上界（**不是永久陈旧**）', async () => {
    const actor = `dict_actor_deg_${uniq}`;
    await makeAdmin(actor, `r_dict_deg_${uniq}`, 'admin:manage');
    await makeAdmin(actor, `r_dict_deg2_${uniq}`, 'content:manage');
    const actorToken = await adminLogin(appA, actor);

    const categoryName = `降级分类-${uniq}`;

    // 实例 B 先读一次 → B 的进程内缓存里有当时的分类列表。
    const before = await listCategories(appB).expect(200);
    expect(hasCategory(before, categoryName)).toBe(false);
    const cachedAt = Date.now();

    // 起一个**连不上 Redis** 的实例（模拟 Redis 挂了 / 订阅断开）。
    process.env.REDIS_PORT = DEAD_REDIS_PORT;
    let appC: INestApplication | undefined;
    try {
      const context = await createTestApp();
      appC = context.app;
    } finally {
      const original = originalEnv.REDIS_PORT;
      if (original === undefined) delete process.env.REDIS_PORT;
      else process.env.REDIS_PORT = original;
    }

    try {
      // 写操作走**实例 C**（它的总线连不上 Redis）→ 必须照常成功。
      await request(appC.getHttpServer())
        .post(`${API}/admin/articles/categories`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send({ name: categoryName, slug: `deg-${uniq}` })
        .expect(201);

      // 实例 C 的总线确实**没能**把事件发出去（否则这条用例测的就不是降级路径了）。
      expect(busOf(appC).stats.published).toBe(0);
      expect(busOf(appC).stats.subscribed).toBe(false);

      // 实例 B 收不到事件 → 陈旧延迟回落到 **TTL 上界**：
      // TTL 窗口内仍是旧列表（这正是「≤TTL」的上界），但**不是永久陈旧**。
      const duringTtl = await listCategories(appB).expect(200);
      expect(hasCategory(duringTtl, categoryName)).toBe(false);

      // 等过 TTL（5 秒）→ 必须变成新值。
      const waitMs = Math.max(0, cachedAt + 5_500 - Date.now());
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      const afterTtl = await listCategories(appB).expect(200);
      // eslint-disable-next-line no-console
      console.log(
        `[字典失效总线] 总线不可用：TTL 窗口内看不到新分类 → 过 TTL 后 ${hasCategory(afterTtl, categoryName) ? '看得到' : '仍看不到'}`,
      );
      expect(hasCategory(afterTtl, categoryName)).toBe(true);
    } finally {
      await appC?.close();
    }
  });

  it('写操作**失败**时不发布字典失效事件（事件只在事务提交之后才发）', async () => {
    // ⚠️ 守的是 `docs/SECURITY.md` 第 2.1.5 / 2.1.6 节「**在事务提交之后**才发布」。
    //    这条此前**没有任何用例守着** ——
    //    把 publish 挪到事务**之前**，套件照样全绿（事件早到一点，看不出来）。
    const actor = `dict_actor_fail_${uniq}`;
    await makeAdmin(actor, `r_dict_fail_${uniq}`, 'admin:manage');
    await makeAdmin(actor, `r_dict_fail2_${uniq}`, 'content:manage');
    await makeAdmin(actor, `r_dict_fail3_${uniq}`, 'settings:manage');
    const actorToken = await adminLogin(appA, actor);

    // 先成功写一次设置项（成功 → 会发一条事件）。
    const okKey = `dict_fail_ok_${uniq}`;
    createdSettingKeys.push(okKey);
    await request(appA.getHttpServer())
      .put(`${API}/admin/settings`)
      .set('Authorization', `Bearer ${actorToken}`)
      .send({ key: okKey, value: 'v1' })
      .expect(200);

    const before = busOf(appA).stats.published;

    // 写一个**不合法**的设置项（缺 `key`）→ 400，写操作根本没成功。
    await request(appA.getHttpServer())
      .put(`${API}/admin/settings`)
      .set('Authorization', `Bearer ${actorToken}`)
      .send({ value: '没有 key 的设置项' })
      .expect(400);

    // 失败的那次**没有**发出失效事件。
    expect(busOf(appA).stats.published).toBe(before);
  });
});
