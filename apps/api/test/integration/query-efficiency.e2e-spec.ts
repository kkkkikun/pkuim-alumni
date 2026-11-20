/**
 * 列表接口的**查询效率**防线（N+1 回归守卫）。
 *
 * ⚠️ 背景：列表接口此前是「逐行装配视图」——
 *    `Promise.all(rows.map((row) => this.toView(row)))`，
 *    而 `toView()` 每行要打 3~4 条 SQL（作者 / 附件 / 审核记录 / 管理员名）。
 *    结果是**每页 20 条就要 80+ 条 SQL**，页大小 100 时 400+ 条 ——
 *    数据库往返成了这类接口的主要开销，且开销随页大小**线性增长**。
 *
 *    这个缺陷不会让任何既有测试变红（返回内容完全一样，只是慢），
 *    所以必须有**专门盯住 SQL 条数**的用例，否则改回去也没人知道。
 *
 * 口径：每个列表端点处理 20 行数据时，SQL 条数必须**与页大小无关**（有固定上界）。
 */

import request from 'supertest';
import type { DataSource, Logger } from 'typeorm';
import { createTestApp, ensureAdmin, resetDatabase } from '../helpers';

/** 每个列表端点塞多少行数据。 */
const ROWS = 20;

/**
 * SQL 条数的**上界**。
 *
 * 修复后每个端点的 SQL 条数是「固定的几条 + 1~2 条鉴权查询」，
 * 与页大小无关。这里给一个宽松的上界（足以容纳后续新增的必要查询），
 * 同时远低于修复前的 80+ 条 —— 逐行查询一旦回来，必然被这条线抓住。
 */
const MAX_QUERIES = 20;

/** 计数 logger：替换 DataSource 的 logger，统计一条请求里打了多少条 SQL。 */
class QueryCounter {
  private count = 0;
  private original: Logger;
  private counting: Logger;

  constructor(private readonly dataSource: DataSource) {
    // ⚠️ 必须换 `dataSource.logger`（它代理到 driver.logger），
    //    换 `dataSource.options.logger` **不生效** —— 那是构造期的入参副本。
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

  /** 开始计数（清零）并装上计数 logger。 */
  start(): void {
    this.count = 0;
    this.dataSource.logger = this.counting;
  }

  /** 停止计数并还原 logger，返回本次统计到的 SQL 条数。 */
  stop(): number {
    this.dataSource.logger = this.original;
    return this.count;
  }
}

describe('列表接口查询效率 · N+1 回归守卫', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>['app'];
  let dataSource: DataSource;
  let counter: QueryCounter;
  let adminToken: string;
  let viewerToken: string;
  let viewerId: number;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    await resetDatabase(dataSource);

    const adminId = await ensureAdmin(dataSource);
    const adminLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/admin/login')
      .send({ username: 'admin-test', password: 'Admin@2026' })
      .expect(200);
    adminToken = adminLogin.body.data.accessToken;
    expect(adminId).toBeGreaterThan(0);

    // ---- 造数据：1 个查看者 + ROWS 个校友 --------------------------------
    const userIds: number[] = [];
    for (let index = 0; index <= ROWS; index += 1) {
      const rows = await dataSource.query(
        `INSERT INTO users (openid, nickname, source, status, stage, created_at, updated_at)
         VALUES (?, ?, 'mock', 'active', 'verified', NOW(3), NOW(3))`,
        [`qe-user-${index}`, `查询效率校友${index}`],
      );
      const idRows = await dataSource.query('SELECT LAST_INSERT_ID() AS id');
      const userId = Number(idRows[0]?.id ?? 0);
      userIds.push(userId);
      await dataSource.query(
        `INSERT INTO alumni_profiles (user_id, display_name, college, verified, show_in_directory)
         VALUES (?, ?, '信息学院', 1, 1)`,
        [userId, `查询效率校友${index}`],
      );
    }
    viewerId = userIds[0];

    // 资源：同一作者发 ROWS 条
    for (let index = 0; index < ROWS; index += 1) {
      await dataSource.query(
        `INSERT INTO resource_posts (author_id, type, title, body, status, version, published_at, created_at, updated_at)
         VALUES (?, 'resource', ?, '正文', 'published', 0, NOW(3), NOW(3), NOW(3))`,
        [userIds[1], `查询效率资源${index}`],
      );
    }

    // 认证申请：ROWS 个不同用户各一条
    for (let index = 1; index <= ROWS; index += 1) {
      await dataSource.query(
        `INSERT INTO verification_applications
           (user_id, real_name, college, graduation_year, degree, status, submitted_at, version, created_at, updated_at)
         VALUES (?, ?, '信息学院', 2015, '本科', 'pending', NOW(3), 0, NOW(3), NOW(3))`,
        [userIds[index], `查询效率校友${index}`],
      );
    }

    // 连接：查看者与 ROWS 个校友各一条 active 连接
    for (let index = 1; index <= ROWS; index += 1) {
      const [a, b] = [viewerId, userIds[index]].sort((x, y) => x - y);
      await dataSource.query(
        `INSERT INTO connection_pairs (user_a_id, user_b_id, status, established_at, version, created_at, updated_at)
         VALUES (?, ?, 'active', NOW(3), 0, NOW(3), NOW(3))`,
        [a, b],
      );
    }

    const viewerLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/mock/login')
      // 用**已存在的那个用户**登录（Mock 登录按 openid 找用户），
      // 否则会新建一个没有任何连接记录的查看者。
      // `mock:` 前缀表示「openid 就用这个原样」（否则 Mock 提供方会加 `mock_` 前缀）。
      .send({ mockOpenid: 'mock:qe-user-0', nickname: '查看者' })
      .expect(200);
    viewerToken = viewerLogin.body.data.accessToken;

    counter = new QueryCounter(dataSource);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /admin/resources：每页 20 条的 SQL 条数与页大小无关', async () => {
    counter.start();
    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/resources?page=1&pageSize=${ROWS}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const queries = counter.stop();

    expect(response.body.data.items).toHaveLength(ROWS);
    // eslint-disable-next-line no-console
    console.log(`[查询效率] GET /admin/resources（${ROWS} 行）= ${queries} 条 SQL`);
    expect(queries).toBeLessThanOrEqual(MAX_QUERIES);
  });

  it('GET /admin/verifications：每页 20 条的 SQL 条数与页大小无关', async () => {
    counter.start();
    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/verifications?page=1&pageSize=${ROWS}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const queries = counter.stop();

    expect(response.body.data.items.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`[查询效率] GET /admin/verifications（${ROWS} 行）= ${queries} 条 SQL`);
    expect(queries).toBeLessThanOrEqual(MAX_QUERIES);
  });

  it('GET /connections：每页 20 条的 SQL 条数与页大小无关', async () => {
    counter.start();
    const response = await request(app.getHttpServer())
      .get(`/api/v1/connections?page=1&pageSize=${ROWS}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200);
    const queries = counter.stop();

    expect(response.body.data.items).toHaveLength(ROWS);
    // eslint-disable-next-line no-console
    console.log(`[查询效率] GET /connections（${ROWS} 行）= ${queries} 条 SQL`);
    expect(queries).toBeLessThanOrEqual(MAX_QUERIES);
  });

  it('页大小翻倍时 SQL 条数**不跟着翻倍**（这是「与页大小无关」的直接证据）', async () => {
    counter.start();
    await request(app.getHttpServer())
      .get('/api/v1/admin/resources?page=1&pageSize=5')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const small = counter.stop();

    counter.start();
    await request(app.getHttpServer())
      .get(`/api/v1/admin/resources?page=1&pageSize=${ROWS}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const large = counter.stop();

    // eslint-disable-next-line no-console
    console.log(`[查询效率] /admin/resources pageSize=5 → ${small} 条；pageSize=${ROWS} → ${large} 条`);
    expect(large).toBeLessThanOrEqual(small + 2);
  });
});
