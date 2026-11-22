import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import * as net from 'node:net';
import Redis from 'ioredis';
import { BUILT_IN_ROLE_CODES, createTestApp, ensureAdmin, resetDatabase } from '../helpers';
import { InvalidationBusService } from '../../src/common/services/invalidation-bus.service';
import {
  DEFAULT_INVALIDATION_CHANNEL,
  resolveInvalidationChannel,
} from '../../src/config/configuration';

/**
 * 共享失效总线（第五轮引入）· 跨实例撤权。
 *
 * ⚠️ 为什么要有这个套件：
 *    `docs/SECURITY.md` 第 2.1.4 节承诺了「多实例部署时撤权跨实例**立刻**生效」，
 *    而第 2.1.5 节承诺了「**Redis 不可用时写操作照常成功**，撤权延迟回落到 TTL 上界」。
 *    这两条此前**没有任何用例守着** ——
 *    把总线实现成一个「永远连不上」的东西，**整个集成测试套件照样全绿**
 *    （因为既有用例都是**单实例**的，进程内主动失效就已经够了）。
 *
 *    这里用**同一个进程内的两个应用实例 + 一个 Redis**把这条语义钉住：
 *      ① 实例 A 降权 → 实例 B 的缓存**立刻**失效（**不等 TTL**）；
 *      ② 总线不可用时 → 写操作**仍 200**，且撤权延迟**回落到 TTL 上界**（不是永久放行）；
 *      ③ 总线上**只有失效事件**，没有任何权限内容。
 *
 *    TTL 在本套件里被调成 **5 秒**：
 *    「不等 TTL 就失效」与「回落到 TTL 上界」这两条都能在几秒内验证完，
 *    而不必等 30/60 秒（既快，又把「TTL 兜底」与「总线即时」区分得很清楚）。
 */

const API = '/api/v1';

/**
 * 本套件要改的环境变量。
 *
 * ⚠️ 顶层改 `process.env` 有副作用：`jest --runInBand` 会在同一进程内顺序执行
 *    多个测试文件，TTL=5 会**泄漏到后续文件** → 因此在 `afterAll` 里原样恢复
 *    （与 `rate-limit.e2e-spec.ts` 同一套做法）。
 */
const ENV_KEYS = [
  'RBAC_CACHE_TTL_SECONDS',
  'RBAC_INVALIDATION_ENABLED',
  'RBAC_INVALIDATION_CHANNEL',
  'REDIS_PORT',
  'REDIS_HOST',
] as const;

const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

process.env.RBAC_CACHE_TTL_SECONDS = '5';
process.env.RBAC_INVALIDATION_ENABLED = 'true';
process.env.RBAC_INVALIDATION_CHANNEL = 'nmg:test:rbac:invalidate';

/** 一个**肯定连不上**的端口：用来模拟「Redis 挂了 / 订阅断开」。 */
const DEAD_REDIS_PORT = '1';

describe('共享失效总线 · 跨实例撤权', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let dataSource: DataSource;

  const uniq = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 8);
  const createdUsernames: string[] = [];
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

  /** 用某个实例请求管理端列表（会填充 / 读取该实例的 RBAC 缓存）。 */
  function listAlumni(app: INestApplication, token: string) {
    return request(app.getHttpServer())
      .get(`${API}/admin/alumni?page=1&pageSize=5`)
      .set('Authorization', `Bearer ${token}`);
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

  it('频道名走配置，并按环境隔离（dev / test / prod 各不相同）', () => {
    // 基准名默认值：写在配置里，不写死在业务代码里。
    expect(DEFAULT_INVALIDATION_CHANNEL).toBe('nmg:rbac:invalidate');
    // 环境段插在命名空间之后 → 测试库的事件不可能打到生产实例。
    expect(resolveInvalidationChannel(DEFAULT_INVALIDATION_CHANNEL, 'production')).toBe(
      'nmg:prod:rbac:invalidate',
    );
    expect(resolveInvalidationChannel(DEFAULT_INVALIDATION_CHANNEL, 'development')).toBe(
      'nmg:dev:rbac:invalidate',
    );
    expect(resolveInvalidationChannel(DEFAULT_INVALIDATION_CHANNEL, 'test')).toBe(
      'nmg:test:rbac:invalidate',
    );
    // 已经带了环境段的配置原样使用（运维显式指定时不改写）。
    expect(resolveInvalidationChannel('nmg:prod:rbac:invalidate', 'production')).toBe(
      'nmg:prod:rbac:invalidate',
    );
    // 三个环境的频道互不相同。
    const channels = new Set([
      resolveInvalidationChannel(DEFAULT_INVALIDATION_CHANNEL, 'production'),
      resolveInvalidationChannel(DEFAULT_INVALIDATION_CHANNEL, 'development'),
      resolveInvalidationChannel(DEFAULT_INVALIDATION_CHANNEL, 'test'),
    ]);
    expect(channels.size).toBe(3);
    // 本套件实际订阅的频道 = 配置里写的那个（未被改写）。
    expect(busOf(appA).stats.channel).toBe('nmg:test:rbac:invalidate');
  });

  it('总线上只有**失效事件**，没有任何权限内容', async () => {
    const actor = `bus_actor_msg_${uniq}`;
    const target = `bus_target_msg_${uniq}`;
    await makeAdmin(actor, `role_bus_actor_${uniq}`, 'admin:manage');
    const targetId = await makeAdmin(target, `role_bus_tgt_${uniq}`, 'alumni:view');
    const actorToken = await adminLogin(appA, actor);

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
        .patch(`${API}/admin/users/${targetId}`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send({ status: 'disabled' })
        .expect(200);

      // 等消息送到（本地 Redis 通常是毫秒级）。
      const deadline = Date.now() + 5_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(received.length).toBeGreaterThan(0);

      const payload = JSON.parse(received[0]) as Record<string, unknown>;
      // 只有「谁的缓存该作废」。
      expect(payload).toEqual({ kind: 'admin', adminId: targetId });
      // 明确断言：**不含**任何权限相关内容。
      const serialized = JSON.stringify(payload).toLowerCase();
      for (const forbidden of ['permission', 'role', 'token', 'openid', 'phone', 'password']) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      await listener.quit();
    }
  });

  it('实例 A 降权 → 实例 B 的缓存**立刻**失效（不等 TTL）', async () => {
    const actor = `bus_actor_a_${uniq}`;
    const target = `bus_target_a_${uniq}`;
    const highRole = `role_bus_high_${uniq}`;
    const lowRole = `role_bus_low_${uniq}`;

    await makeAdmin(actor, `role_bus_actor_${uniq}`, 'admin:manage');
    const targetId = await makeAdmin(target, highRole, 'alumni:view');
    // 降权后只剩这个角色（不含 alumni:view）。
    await makeAdmin(target, lowRole, 'resource:review');

    // 目标账号先在**实例 B** 上用一次 → B 的进程内缓存里有他的权限集。
    const targetToken = await adminLogin(appB, target);
    await listAlumni(appB, targetToken).expect(200);

    // 实例 A 上的操盘手降权 → 事务提交后向总线发布失效事件。
    const actorToken = await adminLogin(appA, actor);
    const startedAt = Date.now();
    await request(appA.getHttpServer())
      .patch(`${API}/admin/users/${targetId}`)
      .set('Authorization', `Bearer ${actorToken}`)
      .send({ roles: [lowRole] })
      .expect(200);

    // 实例 B：**不重新登录**，用同一张令牌 → 应当立刻 403。
    // ⚠️ TTL 是 5 秒：若总线没生效，B 仍会放行到 TTL 过期为止，
    //    所以「2 秒内就 403」这件事本身就是「总线生效」的证据。
    let status = 0;
    const deadline = startedAt + 2_000;
    while (Date.now() < deadline) {
      const response = await listAlumni(appB, targetToken);
      status = response.status;
      if (status === 403) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // eslint-disable-next-line no-console
    console.log(
      `[失效总线] 实例 A 降权 → 实例 B 在 ${Date.now() - startedAt} ms 内返回 ${status}`,
    );
    expect(status).toBe(403);
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    // 实例 B 确实收到了这条失效事件（不是「碰巧」403）。
    expect(busOf(appB).stats.received).toBeGreaterThan(0);
  });

  it('总线不可用：写操作**仍 200**，撤权延迟回落到 TTL 上界（**不是永久放行**）', async () => {
    const actor = `bus_actor_c_${uniq}`;
    const target = `bus_target_c_${uniq}`;
    const highRole = `role_bus_high_c_${uniq}`;
    const lowRole = `role_bus_low_c_${uniq}`;

    await makeAdmin(actor, `role_bus_actor_c_${uniq}`, 'admin:manage');
    const targetId = await makeAdmin(target, highRole, 'alumni:view');
    await makeAdmin(target, lowRole, 'resource:review');

    // 目标账号先在**实例 B**（Redis 正常）上用一次 → B 缓存了他的权限集。
    const targetToken = await adminLogin(appB, target);
    await listAlumni(appB, targetToken).expect(200);
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
      // 降权走**实例 C**（它的总线连不上 Redis）→ 写操作必须照常成功。
      const actorToken = await adminLogin(appC, actor);
      await request(appC.getHttpServer())
        .patch(`${API}/admin/users/${targetId}`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send({ roles: [lowRole] })
        .expect(200);

      // 实例 C 的总线确实**没能**把事件发出去（否则这条用例测的就不是降级路径了）。
      expect(busOf(appC).stats.published).toBe(0);
      expect(busOf(appC).stats.subscribed).toBe(false);

      // 实例 B 收不到事件 → 撤权延迟回落到 **TTL 上界**：
      // TTL 窗口内仍然放行（这正是「≤TTL」的上界），但**不是永久放行**。
      const duringTtl = await listAlumni(appB, targetToken);
      expect(duringTtl.status).toBe(200);

      // 等过 TTL（5 秒）→ 必须变成 403。
      const waitMs = Math.max(0, cachedAt + 5_500 - Date.now());
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      const afterTtl = await listAlumni(appB, targetToken);
      // eslint-disable-next-line no-console
      console.log(`[失效总线] 总线不可用：TTL 窗口内 ${duringTtl.status} → 过 TTL 后 ${afterTtl.status}`);
      expect(afterTtl.status).toBe(403);
    } finally {
      await appC?.close();
    }
  });

  it('总线恢复后**自动重新订阅**（不重启进程）', async () => {
    // ⚠️ 守的是 `docs/SECURITY.md` 第 2.1.5 节「总线恢复后自动重新订阅（不重启进程）」。
    //    这条此前**没有任何用例守着** ——
    //    把 `ensureSubscribed()` 里的重试与 `'ready'` 回调删掉，
    //    整个集成测试套件照样全绿（因为没有用例去「等 Redis 回来」）。
    const realRedisPort = Number(process.env.REDIS_PORT ?? '6379');
    // ⚠️ 上游 Redis 的**地址**必须用配置里的 host，不能写死 127.0.0.1：
    //    在容器里跑集成测试时，Redis 是**另一个容器**（REDIS_HOST=redis），
    //    127.0.0.1 上什么都没有 —— 代理连上游必然失败，
    //    「总线恢复后自动重新订阅」这条用例会**假红**（不是实现的错，是环境的错）。
    const realRedisHost = process.env.REDIS_HOST ?? '127.0.0.1';

    // 找一个「现在没人监听」的端口：先 listen(0) 拿到端口号，再立刻关掉。
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const deadPort = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    // 起一个**连不上 Redis** 的实例（模拟 Redis 挂了）。
    // ⚠️ 必须把 host 一并指到 127.0.0.1：代理就监听在 127.0.0.1:deadPort，
    //    若还让实例按配置里的 host（如容器里的 `redis`）去连，就**根本到不了代理**，
    //    「总线恢复」这一步永远等不到 → 用例假红。
    process.env.REDIS_HOST = '127.0.0.1';
    process.env.REDIS_PORT = String(deadPort);
    let appC: INestApplication | undefined;
    try {
      const context = await createTestApp();
      appC = context.app;
    } finally {
      const original = originalEnv.REDIS_PORT;
      if (original === undefined) delete process.env.REDIS_PORT;
      else process.env.REDIS_PORT = original;
      const originalHost = originalEnv.REDIS_HOST;
      if (originalHost === undefined) delete process.env.REDIS_HOST;
      else process.env.REDIS_HOST = originalHost;
    }

    try {
      // Redis 挂着 → 订阅不上，且**记下了错误**（运维能从运维端点看到）。
      expect(busOf(appC).stats.subscribed).toBe(false);
      expect(busOf(appC).stats.lastError).toBeTruthy();

      // 「Redis 恢复」：在同一个端口上开一个 TCP 代理，后面转发到真正的 Redis。
      // ⚠️ 必须记下所有 socket：`server.close()` **不会**关掉已建立的连接，
      //    回调要等连接全部结束才触发 —— 不主动 destroy 的话这里会**挂住**。
      const sockets = new Set<net.Socket>();
      const proxy = net.createServer((client) => {
        sockets.add(client);
        const upstream = net.connect(realRedisPort, realRedisHost);
        sockets.add(upstream);
        client.pipe(upstream);
        upstream.pipe(client);
        client.on('close', () => sockets.delete(client));
        upstream.on('close', () => sockets.delete(upstream));
        client.on('error', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
      });
      await new Promise<void>((resolve) => proxy.listen(deadPort, '127.0.0.1', () => resolve()));

      try {
        // **不重启进程**，等它自己重新订阅上（实现里每 5 秒重试一次）。
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && !busOf(appC).stats.subscribed) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        // eslint-disable-next-line no-console
        console.log(
          `[失效总线] 总线恢复后自动重新订阅：subscribed=${busOf(appC).stats.subscribed}`,
        );
        expect(busOf(appC).stats.subscribed).toBe(true);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
    } finally {
      await appC?.close();
    }
  });

  it('开关关闭（`RBAC_INVALIDATION_ENABLED=false`）时总线**整条**关闭，写操作照常成功', async () => {
    // ⚠️ 守的是 `docs/SECURITY.md` 第 2.1.6 节「关闭开关不变：`RBAC_INVALIDATION_ENABLED=false`
    //    仍然能**整条**关闭总线（此时撤权延迟回落到 TTL 上界）」。
    //    这条此前**没有任何用例守着** ——
    //    把开关读成「总是 true」，整个集成测试套件照样全绿。
    const actor = `bus_actor_off_${uniq}`;
    const target = `bus_target_off_${uniq}`;
    const highRole = `role_bus_off_high_${uniq}`;
    const lowRole = `role_bus_off_low_${uniq}`;

    await makeAdmin(actor, `role_bus_off_actor_${uniq}`, 'admin:manage');
    const targetId = await makeAdmin(target, highRole, 'alumni:view');
    await makeAdmin(target, lowRole, 'resource:review');

    process.env.RBAC_INVALIDATION_ENABLED = 'false';
    let appD: INestApplication | undefined;
    try {
      const context = await createTestApp();
      appD = context.app;
    } finally {
      process.env.RBAC_INVALIDATION_ENABLED = 'true';
    }

    try {
      // 总线整条关闭：不订阅、不发布。
      expect(busOf(appD).stats.enabled).toBe(false);
      expect(busOf(appD).stats.subscribed).toBe(false);

      // 写操作**照常成功**（关总线不影响业务语义）。
      const actorToken = await adminLogin(appD, actor);
      await request(appD.getHttpServer())
        .patch(`${API}/admin/users/${targetId}`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send({ roles: [lowRole] })
        .expect(200);

      // 一个事件都没发出去（总线是关的）。
      expect(busOf(appD).stats.published).toBe(0);
    } finally {
      await appD?.close();
    }
  });

  it('写操作**失败**时不发布失效事件（事件只在事务提交之后才发）', async () => {
    // ⚠️ 守的是 `docs/SECURITY.md` 第 2.1.5 节「**发布时机**：事务提交**之后**才发布」。
    //    这条此前**没有任何用例守着** ——
    //    把 publish 挪到事务**之前**（或事务失败也照样发），套件照样全绿。
    const actor = `bus_actor_fail_${uniq}`;
    await makeAdmin(actor, `role_bus_fail_actor_${uniq}`, 'admin:manage');
    const actorToken = await adminLogin(appA, actor);

    const before = busOf(appA).stats.published;

    // 目标不存在 → 404（事务回滚，什么都不该发）。
    await request(appA.getHttpServer())
      .patch(`${API}/admin/users/999999999`)
      .set('Authorization', `Bearer ${actorToken}`)
      .send({ status: 'disabled' })
      .expect(404);

    expect(busOf(appA).stats.published).toBe(before);
  });

  it('未知 / 畸形的失效事件被**忽略**（`kind` 是白名单）', async () => {
    // ⚠️ 守的是 `docs/SECURITY.md` 第 2.1.5 节「总线承载的失效事件种类（`kind` 取值，
    //    **白名单**：不认未知取值）」。
    //    总线是**共享通道**：一条畸形的或恶意的消息最多让本实例丢掉缓存
    //    （**不会**放行任何权限）—— 但这条「最多丢掉缓存」此前**没有用例守着**。
    const target = `bus_target_junk_${uniq}`;
    const highRole = `role_bus_junk_high_${uniq}`;
    const lowRole = `role_bus_junk_low_${uniq}`;
    await makeAdmin(target, highRole, 'alumni:view');
    await makeAdmin(target, lowRole, 'resource:review');

    // 目标账号先在**实例 B** 上用一次 → B 缓存了他的权限集。
    const targetToken = await adminLogin(appB, target);
    await listAlumni(appB, targetToken).expect(200);
    const receivedBefore = busOf(appB).stats.received;

    // 用一个「裸」的 Redis 连接，往频道里塞**未知**与**畸形**的事件。
    const injector = new Redis({
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      db: Number(process.env.REDIS_DB ?? 0),
    });
    try {
      await injector.publish(
        busOf(appB).stats.channel,
        JSON.stringify({ kind: 'unknown-kind', adminId: 1 }),
      );
      await injector.publish(busOf(appB).stats.channel, 'not-json-at-all');
      await injector.publish(busOf(appB).stats.channel, JSON.stringify({ kind: 'admin' }));
      await injector.publish(
        busOf(appB).stats.channel,
        JSON.stringify({ kind: 'admin', adminId: 'not-a-number' }),
      );
      await injector.publish(
        busOf(appB).stats.channel,
        JSON.stringify({ kind: 'admin', adminId: -1 }),
      );

      // 给订阅端一点时间把消息收走。
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      // 一条都**不算数**：白名单外的消息不进计数器。
      expect(busOf(appB).stats.received - receivedBefore).toBe(0);

      // 更要紧的：这些畸形消息**没有**把目标的缓存清掉 ——
      // 目标仍然保有降权前的权限（缓存还在）。
      const stillAllowed = await listAlumni(appB, targetToken);
      expect(stillAllowed.status).toBe(200);
    } finally {
      await injector.quit();
    }
  });
});
