import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTestApp, resetDatabase } from '../helpers';

/**
 * **公开读端点的可见性口径**（第十一轮）。
 *
 * 背景：
 *   `docs/DATABASE-DESIGN.md`「未审核内容公开」与
 *   `docs/KNOWN-ISSUES.md`「已知设计取舍」第 2 条定的口径是：
 *     - 未审核 / 未发布的内容在**公开读端点**上不可见；
 *     - 「不可见」一律 **404**（不用 403 —— 403 会通过状态码泄露
 *       「这个对象存在」）。
 *   这条口径此前只被**人工抽查**过（第十轮抽查出 `GET /events/:id`
 *   漏了过滤，记为 #197），新增端点或改坏过滤**没有任何机制会报警**。
 *
 * 本套件是那条口径的**运行时**防线（静态那一层是
 * `infra/scripts/check-read-visibility.mjs`）：
 *   真的起一个应用、真的写库造出「未发布」的对象，
 *   然后真的去请求公开端点，断言它返回 404。
 *
 * ⚠️ 关于 `GET /events/:id`：
 *   它的可见性口径**尚未拍板**（#197）—— 改成 404 属对外契约变更，
 *   按仓库约定「对外契约变更先确认再动」，本轮**不改行为**。
 *   本套件把**现状**（草稿活动当前仍返回 200）**钉住**：
 *   一旦有人擅自改了（或产品拍板后改了），这条用例会红，
 *   提醒同步更新 API-SPEC / KNOWN-ISSUES / 校验器登记表。
 */
const API = '/api/v1';

describe('公开读端点的可见性口径（第十一轮）', () => {
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
  });

  const server = () => request(app.getHttpServer());

  /** 取最近一次 INSERT 的自增 id（不同驱动返回结构不一致，LAST_INSERT_ID() 最稳）。 */
  const lastInsertId = async (): Promise<number> => {
    const rows = await dataSource.query('SELECT LAST_INSERT_ID() AS id');
    return Number((rows[0] as { id?: number | string } | undefined)?.id ?? 0);
  };

  const insertArticle = async (status: string, title = '可见性测试资讯'): Promise<number> => {
    await dataSource.query(
      `INSERT INTO articles (title, body, status, published_at, created_at, updated_at)
       VALUES (?, '正文', ?, ?, NOW(3), NOW(3))`,
      [title, status, status === 'published' ? new Date() : null],
    );
    return lastInsertId();
  };

  const insertNotice = async (status: string, title = '可见性测试公告'): Promise<number> => {
    await dataSource.query(
      `INSERT INTO notices (title, body, status, published_at, created_at, updated_at)
       VALUES (?, '正文', ?, ?, NOW(3), NOW(3))`,
      [title, status, status === 'published' ? new Date() : null],
    );
    return lastInsertId();
  };

  const insertEvent = async (status: string, title = '可见性测试活动'): Promise<number> => {
    await dataSource.query(
      `INSERT INTO events (title, kind, status, capacity, registered_count, version, created_at, updated_at)
       VALUES (?, 'reunion', ?, 0, 0, 0, NOW(3), NOW(3))`,
      [title, status],
    );
    return lastInsertId();
  };

  const insertResource = async (
    authorId: number,
    status: string,
    title = '可见性测试资源',
  ): Promise<number> => {
    await dataSource.query(
      `INSERT INTO resource_posts
         (author_id, type, title, body, status, version, published_at, created_at, updated_at)
       VALUES (?, 'resource', ?, '正文', ?, 0, ?, NOW(3), NOW(3))`,
      [authorId, title, status, status === 'published' ? new Date() : null],
    );
    return lastInsertId();
  };

  /** 造一个校友（`stage` 决定是否已认证，`showInDirectory` 决定是否公开）。 */
  const insertAlumni = async (
    openid: string,
    stage: string,
    showInDirectory: number,
  ): Promise<number> => {
    await dataSource.query(
      `INSERT INTO users (openid, nickname, source, status, stage, created_at, updated_at)
       VALUES (?, ?, 'mock', 'active', ?, NOW(3), NOW(3))`,
      [openid, `可见性校友${openid}`, stage],
    );
    const userId = await lastInsertId();
    await dataSource.query(
      `INSERT INTO alumni_profiles (user_id, display_name, college, verified, show_in_directory)
       VALUES (?, ?, '信息学院', ?, ?)`,
      [userId, `可见性校友${openid}`, stage === 'verified' ? 1 : 0, showInDirectory],
    );
    return userId;
  };

  /* --------------------------- 资讯 / 公告 --------------------------- */

  it('资讯详情：未发布 → 404 NOT_FOUND（不可见不等于 403）', async () => {
    const draftId = await insertArticle('draft', '草稿资讯');
    const response = await server().get(`${API}/articles/${draftId}`).expect(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('资讯详情：已发布 → 200，且不存在的 id 同样是 404', async () => {
    const publishedId = await insertArticle('published', '已发布资讯');
    await server().get(`${API}/articles/${publishedId}`).expect(200);
    const missing = await server().get(`${API}/articles/999999999`).expect(404);
    expect(missing.body.code).toBe('NOT_FOUND');
  });

  it('公告详情：未发布 → 404 NOT_FOUND', async () => {
    const draftId = await insertNotice('draft', '草稿公告');
    const response = await server().get(`${API}/notices/${draftId}`).expect(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('公告详情：已发布 → 200', async () => {
    const publishedId = await insertNotice('published', '已发布公告');
    await server().get(`${API}/notices/${publishedId}`).expect(200);
  });

  /* ------------------------------ 资源 ------------------------------ */

  it('资源详情：未审核通过（匿名访问）→ 404 NOT_FOUND', async () => {
    const authorId = await insertAlumni('res-author', 'verified', 1);
    const pendingId = await insertResource(authorId, 'pending', '待审核资源');
    const response = await server().get(`${API}/resources/${pendingId}`).expect(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('资源详情：已发布 → 200', async () => {
    const authorId = await insertAlumni('res-author-2', 'verified', 1);
    const publishedId = await insertResource(authorId, 'published', '已发布资源');
    await server().get(`${API}/resources/${publishedId}`).expect(200);
  });

  /* --------------------------- 校友公开名片 --------------------------- */

  it('校友公开名片：未认证 → 404（不区分「不存在」与「不可见」）', async () => {
    const userId = await insertAlumni('alumni-unverified', 'logged_in', 1);
    const response = await server().get(`${API}/alumni/${userId}`).expect(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('校友公开名片：已认证但未授权公开 → 404', async () => {
    const userId = await insertAlumni('alumni-hidden', 'verified', 0);
    const response = await server().get(`${API}/alumni/${userId}`).expect(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('校友公开名片：已认证且授权公开 → 200', async () => {
    const userId = await insertAlumni('alumni-public', 'verified', 1);
    const response = await server().get(`${API}/alumni/${userId}`).expect(200);
    expect(response.body.data.userId).toBe(userId);
  });

  /* ------------------------------ 活动 ------------------------------ */

  it('活动详情：口径待拍板（#197）—— 现状是草稿活动仍返回 200', async () => {
    // ⚠️ 这条用例**钉住现状**，不是认可现状：
    //   把草稿活动改成 404 属对外契约变更，需产品拍板（KNOWN-ISSUES #197）。
    //   产品拍板（或有人擅自改）之后，这条用例会红 ——
    //   那正是提醒同步 API-SPEC / KNOWN-ISSUES / 校验器登记表的时刻。
    const draftId = await insertEvent('draft', '草稿活动');
    await server().get(`${API}/events/${draftId}`).expect(200);
  });

  it('活动详情：已发布 → 200；不存在的 id → 404', async () => {
    const publishedId = await insertEvent('published', '已发布活动');
    await server().get(`${API}/events/${publishedId}`).expect(200);
    const missing = await server().get(`${API}/events/999999999`).expect(404);
    expect(missing.body.code).toBe('NOT_FOUND');
  });

  /* ---------------------------- 公开列表 ---------------------------- */

  it('公开列表不包含未发布 / 未审核通过的内容', async () => {
    await insertArticle('published', '列表里的已发布资讯');
    await insertArticle('draft', '列表外的草稿资讯');
    await insertNotice('published', '列表里的已发布公告');
    await insertNotice('draft', '列表外的草稿公告');
    await insertEvent('published', '列表里的已发布活动');
    await insertEvent('draft', '列表外的草稿活动');
    const authorId = await insertAlumni('list-author', 'verified', 1);
    await insertResource(authorId, 'published', '列表里的已发布资源');
    await insertResource(authorId, 'pending', '列表外的待审核资源');

    const articles = await server().get(`${API}/articles?page=1&pageSize=100`).expect(200);
    const articleTitles = articles.body.data.items.map((item: { title: string }) => item.title);
    expect(articleTitles).toContain('列表里的已发布资讯');
    expect(articleTitles).not.toContain('列表外的草稿资讯');

    const notices = await server().get(`${API}/notices?page=1&pageSize=100`).expect(200);
    const noticeTitles = notices.body.data.items.map((item: { title: string }) => item.title);
    expect(noticeTitles).toContain('列表里的已发布公告');
    expect(noticeTitles).not.toContain('列表外的草稿公告');

    const events = await server().get(`${API}/events?page=1&pageSize=100`).expect(200);
    const eventTitles = events.body.data.items.map((item: { title: string }) => item.title);
    expect(eventTitles).toContain('列表里的已发布活动');
    expect(eventTitles).not.toContain('列表外的草稿活动');

    const resources = await server().get(`${API}/resources?page=1&pageSize=100`).expect(200);
    const resourceTitles = resources.body.data.items.map((item: { title: string }) => item.title);
    expect(resourceTitles).toContain('列表里的已发布资源');
    expect(resourceTitles).not.toContain('列表外的待审核资源');
  });

  it('首页聚合（/home/feed）不包含未发布内容', async () => {
    await insertArticle('published', '首页里的已发布资讯');
    await insertArticle('draft', '首页外的草稿资讯');
    const feed = await server().get(`${API}/home/feed`).expect(200);
    const titles = feed.body.data.tabs.news.map((item: { title: string }) => item.title);
    expect(titles).toContain('首页里的已发布资讯');
    expect(titles).not.toContain('首页外的草稿资讯');
  });
});
