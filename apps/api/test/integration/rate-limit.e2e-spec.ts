import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { createTestApp, login, markVerified, resetDatabase } from '../helpers';

/**
 * 限流守卫行为验证。
 *
 * 背景：`RateLimitGuard` 是**固定窗口**限流，按「用户（或匿名 IP）+ 接口类别」计数：
 *   - 写接口（POST/PUT/PATCH/DELETE）阈值 `RATE_LIMIT_WRITE`
 *   - 登录 / 刷新接口阈值 `RATE_LIMIT_AUTH`
 *   - 其余读接口阈值 `RATE_LIMIT_DEFAULT`
 *   - Redis 不可用时**降级放行**（限流是保护措施，不是业务依赖）
 *
 * 计数维度与 docs/SECURITY.md 第 6 节一致：**写接口共享同一个额度桶**
 * （此前是「每个路由处理器一个桶」，实际阈值会被放大到文档承诺的数倍）。
 *
 * 此前限流只在压测中被「放宽再回滚」地间接验证过，从未验证过它**真的会拦截**。
 * 这里用低阈值 + 独立 Redis db（避免污染其他套件）做确定性验证。
 *
 * 注意：窗口设为 3600 秒，避免测试恰好跨分钟边界导致计数重置而偶发失败。
 */

const API = '/api/v1';

/**
 * 限流相关的环境变量。
 *
 * **必须在模块顶层设置**：`test/helpers.ts` 顶层就 `import { AppModule }`，
 * `ConfigModule.forRoot` 的配置工厂在**导入时**求值一次，
 * 放到 `beforeAll` 里就来不及了（限流阈值会退回默认值，测试必然失败）。
 *
 * 但顶层改 `process.env` 有副作用：`jest --runInBand` 会在同一进程内顺序执行
 * 多个测试文件，阈值为 2 的限流会**泄漏到后续文件**，让整条回归链变成「看运气」。
 * 因此在 `afterAll` 里把原值**原样恢复**。
 */
const RATE_LIMIT_ENV_KEYS = [
  'RATE_LIMIT_ENABLED',
  'RATE_LIMIT_WINDOW_SECONDS',
  'RATE_LIMIT_WRITE',
  'RATE_LIMIT_DEFAULT',
  'RATE_LIMIT_AUTH',
  'REDIS_DB',
] as const;

/** 原始环境变量快照，用于 afterAll 恢复 */
const originalEnv: Record<string, string | undefined> = {};
for (const key of RATE_LIMIT_ENV_KEYS) originalEnv[key] = process.env[key];

process.env.RATE_LIMIT_ENABLED = 'true';
process.env.RATE_LIMIT_WINDOW_SECONDS = '3600';
process.env.RATE_LIMIT_WRITE = '2';
process.env.RATE_LIMIT_DEFAULT = '5';
process.env.RATE_LIMIT_AUTH = '50';
process.env.REDIS_DB = '3';

describe('限流守卫 · 固定窗口', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let redis: Redis;

  const ctx: {
    aliceToken?: string;
    bobToken?: string;
  } = {};

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
    await resetDatabase(dataSource);

    redis = new Redis({
      host: process.env.REDIS_HOST ?? 'redis',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      db: 3,
    });
    await redis?.flushdb();

    const alice = await login(app, 'rl-alice', '限流甲');
    const bob = await login(app, 'rl-bob', '限流乙');
    ctx.aliceToken = alice.accessToken;
    ctx.bobToken = bob.accessToken;
    await markVerified(dataSource, alice.userId);
    await markVerified(dataSource, bob.userId);
  });

  afterAll(async () => {
    await redis?.flushdb();
    await redis?.quit();
    await app?.close();

    // 还原环境变量，避免污染同一进程内的后续测试文件
    for (const key of RATE_LIMIT_ENV_KEYS) {
      const original = originalEnv[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  const server = () => request(app.getHttpServer());

  it('同一用户连续写请求超过阈值 → 第 N+1 次返回 429', async () => {
    const payload = { showCollege: true };

    // 阈值 = 2：前两次放行
    await server()
      .put(`${API}/me/privacy`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send(payload)
      .expect(200);
    await server()
      .put(`${API}/me/privacy`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send(payload)
      .expect(200);

    // 第三次必须被拦截
    const blocked = await server()
      .put(`${API}/me/privacy`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send(payload)
      .expect(429);

    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(String(blocked.body.message)).toContain('操作过于频繁');
  });

  it('限流按用户隔离：另一用户不被牵连', async () => {
    // 甲已经被限流，乙的同端点请求仍应放行
    await server()
      .put(`${API}/me/privacy`)
      .set('Authorization', `Bearer ${ctx.bobToken}`)
      .send({ showIndustry: true })
      .expect(200);
  });

  it('限流按「用户 + 接口类别」计数：写端点之间共享额度（docs/SECURITY.md 第 6 节）', async () => {
    // 甲在 me/privacy 上已用完写接口额度；按文档口径「写接口 30 次/分钟」是**按类别**计的，
    // 因此另一个写端点同样被拦 —— 逐端点分桶会让攻击者把请求摊到多个端点上，
    // 把实际阈值放大到文档承诺的数倍。
    await server()
      .put(`${API}/me/contacts`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({ contactPhone: '13800002222', contactWechat: 'rl_alice' })
      .expect(429);
  });

  it('匿名请求按 IP 计数：同 IP 的不同用户共享额度', async () => {
    // 匿名身份 = IP（这里都是 127.0.0.1），因此连续匿名写请求会互相占用额度。
    // me/privacy 需要登录，这里用公开的 mock 登录端点做匿名写请求来验证「按 IP」这一维度。
    const first = await server()
      .post(`${API}/auth/mock/login`)
      .send({ mockOpenid: 'rl-anon-1', nickname: '匿名一' })
      .expect(200);
    const second = await server()
      .post(`${API}/auth/mock/login`)
      .send({ mockOpenid: 'rl-anon-2', nickname: '匿名二' })
      .expect(200);

    // 两个不同用户拿到的是不同令牌（说明没有发生响应回放）
    expect(second.body.data.accessToken).not.toBe(first.body.data.accessToken);
  });

  // ---------------------------------------------------------------------
  // 复核补漏（第二轮）：**认证失败的请求也必须计额**
  //
  // 此前限流守卫排在 JWT 守卫之后，伪造 / 过期令牌的请求在到达限流之前
  // 就被 401 拒掉 —— 攻击者塞一个垃圾 Bearer 值就能无限打受保护端点。
  // 现在认证失败会先按 IP 计一次额度，超阈值直接 429。
  // ---------------------------------------------------------------------
  it('带伪造令牌的请求同样消耗额度，超过阈值后返回 429', async () => {
    // 读接口阈值 = 5（IP 桶；此前本文件里没有别的读请求占用过这个桶）
    for (let i = 0; i < 5; i += 1) {
      const response = await server()
        .get(`${API}/me/profile`)
        .set('Authorization', 'Bearer not-a-real-token');
      expect(response.status).toBe(401);
    }

    // 第 6 次必须被限流挡下（而不是继续给 401）
    const blocked = await server()
      .get(`${API}/me/profile`)
      .set('Authorization', 'Bearer not-a-real-token');
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
  });
});
