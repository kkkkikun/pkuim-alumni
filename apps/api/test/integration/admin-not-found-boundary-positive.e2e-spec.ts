import { execFileSync } from 'node:child_process';
import path from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, ensureAdmin, login, markVerified, resetDatabase } from '../helpers';

/**
 * 管理端「**资源存在时不得 404**」分界的**正向**用例（第十五轮）。
 *
 * 背景：
 *   第十四轮补上了「资源**不存在** → 404」的**运行时**用例
 *   （`admin-not-found-boundary.e2e-spec.ts`，20 个端点逐条真去请求不存在的 id）。
 *   但那一半只证明了「查不到时会 404」，
 *   **没有**证明「查得到时**不会** 404」——
 *   而后者才是管理后台真正依赖的那一半：
 *   后台按状态码分支（404 = 对象不存在、刷新列表；5xx = 服务端坏了、报工单），
 *   「明明存在却回 404」会让后台把**在正常显示的内容**判成「已被删除」，
 *   用户会看到一条凭空消失的记录 —— 那比 5xx 更难排查。
 *
 *   静态对账（`check-read-visibility.mjs` 的 R9 ~ R12）也证明不了这一半：
 *   它只能看出「源码里写了抛 404」，看不出「**真的存在时**会不会走到那一句」。
 *
 * 本套件做什么：
 *   对登记在册的**每一个**管理端端点，**先把对象真的造出来**
 *   （走真实 API —— 造出来的对象满足业务不变量），
 *   再去请求它，断言响应**不是 404**（是 2xx）。
 *
 * ⚠️ **误报风险**（造出来的对象若不满足业务不变量，端点本就该 404）：
 *   本套件一律**走真实 API 建对象**，不直接插库 ——
 *   这样造出来的对象必然满足端点的前置条件（审核状态、归属、附件挂载……）。
 *   例：资源审核端点要求状态 ∈ (pending, published, rejected)，
 *   所以资源是**用发布接口建的**（建出来就是 pending），不是插一行 draft；
 *   认证审核端点要求状态 ∈ (pending, resubmitted, needs_more_material)，
 *   所以申请是**用提交接口建的**（建出来就是 pending）。
 *
 * ⚠️ **不改正对外行为**：本套件只**断言现状**。
 *    若某个端点在资源存在时真的返回 404，那是**缺陷**，
 *    应登记到 `docs/KNOWN-ISSUES.md` 并由产品拍板后再改 —— 本轮**一个字都没改**。
 */
const API = '/api/v1';

/** 仓库根目录（本文件在 `apps/api/test/integration/` 下，往上三层）。 */
const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** 2xx 的合法形态（DELETE 返回 200 + `{deleted:true}`，不是 204）。 */
const OK_STATUSES = [200, 201, 204];

/**
 * 「本套件**没有**覆盖、且写明了原因」的端点。
 *
 * ⚠️ 本轮实测：**20 个端点全部可以安全造数据**（逐条都有正向用例），
 *    所以这张表是**空的**。
 *    但机制**留着** —— 将来某个端点确实造不出满足业务不变量的对象时，
 *    应当在这里写明**为什么**（而不是悄悄不测）：
 *    最后那条「逐条对齐」的用例会保证
 *    「已覆盖 + 写明原因未覆盖 = 登记在册的 20 条」，少一条 / 多一条当场红。
 */
const NOT_COVERED: { method: string; path: string; reason: string }[] = [];

describe('管理端「资源存在 → 不得 404」分界（第十五轮正向用例）', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;

  /* ------------------------- 夹具 ------------------------- */

  /** 管理员账号 id（`admin_users.id`）—— `PATCH /admin/users/:id` 用它。 */
  let adminAccountId: number;
  /** 普通账号 id（`users.id`）—— `GET /admin/users/:id` 与两个 status 端点用它。 */
  let normalUserId: number;
  /** 资源内容 id + 它挂着的附件 media id。 */
  let resourceId: number;
  let resourceMediaId: number;
  /** 认证申请 id + 它挂着的证明材料 media id。 */
  let verificationId: number;
  let verificationMediaId: number;
  /** 活动 id：一份供读 / 改，一份供删。 */
  let eventId: number;
  let eventToDeleteId: number;
  /** 资讯 id：一份供改，一份供删。 */
  let articleId: number;
  let articleToDeleteId: number;
  /** 公告 id：一份供改，一份供删。 */
  let noticeId: number;
  let noticeToDeleteId: number;
  /** 分类 id：一份供改，一份供删。 */
  let categoryId: number;
  let categoryToDeleteId: number;

  /** 本套件**已覆盖**的端点（`METHOD PATH`）—— 最后一条用例拿它与登记表对账。 */
  const covered: string[] = [];

  const server = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
    await resetDatabase(dataSource);

    // ⚠️ 必须给到**全部**权限点（与第十四轮那支同样的 7 个）：
    //   权限点不足会先撞上 **403** —— 那测的就不是「资源存在」这一说了。
    for (const permissionCode of [
      'alumni:view',
      'admin:manage',
      'alumni:manage',
      'verification:review',
      'resource:review',
      'event:manage',
      'content:manage',
    ]) {
      await ensureAdmin(dataSource, { roleCode: 'super_admin', permissionCode });
    }

    const loginResponse = await server()
      .post(`${API}/auth/admin/login`)
      .send({ username: 'admin-test', password: 'Admin@2026' })
      .expect(200);
    adminToken = loginResponse.body.data.accessToken;
    const [adminRow] = await dataSource.query(
      "SELECT id FROM admin_users WHERE username = 'admin-test'",
    );
    adminAccountId = Number(adminRow.id);

    // --- 普通账号（`users` 表）---
    // Mock 登录会**顺带建出 `alumni_profiles` 资料行**（见 auth.service 的 buildAlumniProfile），
    // 所以「校友存在」不需要额外插库。
    const normal = await login(app, 'positive-normal-user');
    normalUserId = normal.userId;

    // --- 已认证校友（发布资源需要 stage = verified）---
    const author = await login(app, 'positive-author');
    await markVerified(dataSource, author.userId);
    const authorToken = author.accessToken;

    // 登记一个媒体资产（**只登记，不上传字节**）：附件外键需要真实的 media 行。
    const assetResponse = await server()
      .post(`${API}/uploads/records`)
      .set('Authorization', `Bearer ${authorToken}`)
      .send({ fileName: 'positive-resource.png', mimeType: 'image/png', size: 128 })
      .expect(201);
    resourceMediaId = Number(assetResponse.body.data.id);

    // 资源：**用发布接口建**（建出来就是 pending —— 审核端点要求这个状态）。
    const resourceResponse = await server()
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${authorToken}`)
      .send({
        type: 'resource',
        title: '正向用例用的资源内容',
        body: '这是一段用于「资源存在时不得 404」正向用例的资源描述内容，长度满足校验要求。',
        attachmentMediaIds: [resourceMediaId],
      })
      .expect(201);
    resourceId = Number(resourceResponse.body.data.id);

    // --- 认证申请（申请人视角）---
    const verifier = await login(app, 'positive-verifier');
    const verifierAsset = await server()
      .post(`${API}/uploads/records`)
      .set('Authorization', `Bearer ${verifier.accessToken}`)
      .send({ fileName: 'positive-proof.png', mimeType: 'image/png', size: 128 })
      .expect(201);
    verificationMediaId = Number(verifierAsset.body.data.id);

    const verificationResponse = await server()
      .post(`${API}/alumni/verification`)
      .set('Authorization', `Bearer ${verifier.accessToken}`)
      .send({
        realName: '正向用例校友',
        college: '北京大学',
        graduationYear: 2015,
        studentIdMasked: 'SN12345678',
        attachmentMediaIds: [verificationMediaId],
      })
      .expect(201);
    verificationId = Number(verificationResponse.body.data.id);

    // --- 管理端的对象（活动 / 资讯 / 公告 / 分类）---
    const createEvent = async (title: string): Promise<number> => {
      const response = await server()
        .post(`${API}/admin/events`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title, kind: '沙龙', capacity: 0 })
        .expect(201);
      return Number(response.body.data.id);
    };
    eventId = await createEvent('正向用例用的活动');
    eventToDeleteId = await createEvent('正向用例用的待删活动');

    const createArticle = async (title: string): Promise<number> => {
      const response = await server()
        .post(`${API}/admin/articles`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title, body: '正向用例用的资讯正文。' })
        .expect(201);
      return Number(response.body.data.id);
    };
    articleId = await createArticle('正向用例用的资讯');
    articleToDeleteId = await createArticle('正向用例用的待删资讯');

    const createNotice = async (title: string): Promise<number> => {
      const response = await server()
        .post(`${API}/admin/notices`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title, body: '正向用例用的公告正文。' })
        .expect(201);
      return Number(response.body.data.id);
    };
    noticeId = await createNotice('正向用例用的公告');
    noticeToDeleteId = await createNotice('正向用例用的待删公告');

    const createCategory = async (name: string, slug: string): Promise<number> => {
      const response = await server()
        .post(`${API}/admin/articles/categories`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name, slug })
        .expect(201);
      return Number(response.body.data.id);
    };
    categoryId = await createCategory('正向用例分类', 'positive-case-category');
    categoryToDeleteId = await createCategory('正向用例待删分类', 'positive-case-category-to-delete');
  });

  afterAll(async () => {
    await app?.close();
  });

  /**
   * 断言「资源存在时**不是** 404」。
   *
   * ⚠️ 断言的是**真实响应**：既要 2xx，也不能带 `NOT_FOUND` 错误码。
   */
  const expectExists = async (
    method: 'get' | 'post' | 'patch' | 'delete',
    requestPath: string,
    body?: Record<string, unknown>,
  ): Promise<void> => {
    const call = server()[method](`${API}${requestPath}`);
    if (body) call.send(body);
    const response = await call.set('Authorization', `Bearer ${adminToken}`);
    expect(response.status).not.toBe(404);
    expect(OK_STATUSES).toContain(response.status);
    expect(response.body?.code ?? '').not.toBe('NOT_FOUND');
  };

  /* ------------------------- 校友 ------------------------- */

  it('GET /admin/alumni/:id —— 校友存在 → 200（不是 404）', async () => {
    covered.push('GET /admin/alumni/:id');
    await expectExists('get', `/admin/alumni/${normalUserId}`);
  });

  /* ------------------------- 账号 ------------------------- */

  it('GET /admin/users/:id —— 普通账号存在 → 200（不是 404）', async () => {
    covered.push('GET /admin/users/:id');
    await expectExists('get', `/admin/users/${normalUserId}`);
  });

  it('PATCH /admin/users/:id —— 管理员存在 → 200（不是 404）', async () => {
    covered.push('PATCH /admin/users/:id');
    await expectExists('patch', `/admin/users/${adminAccountId}`, {
      displayName: '正向用例改过的显示名',
    });
  });

  it('PATCH /admin/users/:id/status —— 普通账号存在 → 200（不是 404）', async () => {
    covered.push('PATCH /admin/users/:id/status');
    await expectExists('patch', `/admin/users/${normalUserId}/status`, { status: 'active' });
  });

  it('POST /admin/users/:id/status —— 普通账号存在 → 200（不是 404）', async () => {
    covered.push('POST /admin/users/:id/status');
    await expectExists('post', `/admin/users/${normalUserId}/status`, { status: 'active' });
  });

  /* ------------------------- 认证审核 ------------------------- */

  it('GET /admin/verifications/:id —— 认证申请存在 → 200（不是 404）', async () => {
    covered.push('GET /admin/verifications/:id');
    await expectExists('get', `/admin/verifications/${verificationId}`);
  });

  it('GET /admin/verifications/:id/attachments/:mediaId/url —— 附件确实挂在该申请上 → 200（不是 404）', async () => {
    covered.push('GET /admin/verifications/:id/attachments/:mediaId/url');
    await expectExists(
      'get',
      `/admin/verifications/${verificationId}/attachments/${verificationMediaId}/url`,
    );
  });

  it('POST /admin/verifications/:id/decision —— 认证申请存在 → 200（不是 404）', async () => {
    covered.push('POST /admin/verifications/:id/decision');
    await expectExists('post', `/admin/verifications/${verificationId}/decision`, {
      action: 'approve',
      note: '正向用例：资源存在时不得 404',
    });
  });

  /* ------------------------- 资源审核 ------------------------- */

  it('GET /admin/resources/:id —— 内容存在 → 200（不是 404）', async () => {
    covered.push('GET /admin/resources/:id');
    await expectExists('get', `/admin/resources/${resourceId}`);
  });

  it('GET /admin/resources/:id/attachments/:mediaId/url —— 附件确实挂在该内容上 → 200（不是 404）', async () => {
    covered.push('GET /admin/resources/:id/attachments/:mediaId/url');
    await expectExists(
      'get',
      `/admin/resources/${resourceId}/attachments/${resourceMediaId}/url`,
    );
  });

  it('POST /admin/resources/:id/decision —— 内容存在 → 200（不是 404）', async () => {
    covered.push('POST /admin/resources/:id/decision');
    await expectExists('post', `/admin/resources/${resourceId}/decision`, {
      action: 'approve',
      note: '正向用例：资源存在时不得 404',
    });
  });

  /* ------------------------- 活动 ------------------------- */

  it('GET /admin/events/:id —— 活动存在 → 200（不是 404）', async () => {
    covered.push('GET /admin/events/:id');
    await expectExists('get', `/admin/events/${eventId}`);
  });

  it('PATCH /admin/events/:id —— 活动存在 → 200（不是 404）', async () => {
    covered.push('PATCH /admin/events/:id');
    await expectExists('patch', `/admin/events/${eventId}`, { title: '正向用例改过的活动' });
  });

  it('DELETE /admin/events/:id —— 活动存在 → 200（不是 404）', async () => {
    covered.push('DELETE /admin/events/:id');
    await expectExists('delete', `/admin/events/${eventToDeleteId}`);
  });

  /* ------------------------- 资讯 ------------------------- */

  it('PATCH /admin/articles/:id —— 资讯存在 → 200（不是 404）', async () => {
    covered.push('PATCH /admin/articles/:id');
    await expectExists('patch', `/admin/articles/${articleId}`, {
      title: '正向用例改过的资讯',
    });
  });

  it('DELETE /admin/articles/:id —— 资讯存在 → 200（不是 404）', async () => {
    covered.push('DELETE /admin/articles/:id');
    await expectExists('delete', `/admin/articles/${articleToDeleteId}`);
  });

  /* ------------------------- 公告 ------------------------- */

  it('PATCH /admin/notices/:id —— 公告存在 → 200（不是 404）', async () => {
    covered.push('PATCH /admin/notices/:id');
    await expectExists('patch', `/admin/notices/${noticeId}`, { title: '正向用例改过的公告' });
  });

  it('DELETE /admin/notices/:id —— 公告存在 → 200（不是 404）', async () => {
    covered.push('DELETE /admin/notices/:id');
    await expectExists('delete', `/admin/notices/${noticeToDeleteId}`);
  });

  /* ------------------------- 资讯分类 ------------------------- */

  it('PATCH /admin/articles/categories/:id —— 分类存在 → 200（不是 404）', async () => {
    covered.push('PATCH /admin/articles/categories/:id');
    await expectExists('patch', `/admin/articles/categories/${categoryId}`, {
      name: '正向用例改过的分类',
    });
  });

  it('DELETE /admin/articles/categories/:id —— 分类存在 → 200（不是 404）', async () => {
    covered.push('DELETE /admin/articles/categories/:id');
    await expectExists('delete', `/admin/articles/categories/${categoryToDeleteId}`);
  });

  /* ------------------------- 与登记表逐条一致 ------------------------- */

  it('正向用例覆盖的端点与登记在册的 20 条**逐条一致**（少一条 / 多一条当场红）', () => {
    const checker = path.join(REPO_ROOT, 'infra/scripts/check-read-visibility.mjs');
    let stdout: string;
    try {
      stdout = execFileSync('node', [checker, '--root', REPO_ROOT, '--json'], {
        encoding: 'utf8',
        cwd: REPO_ROOT,
      });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      throw new Error(
        `可见性口径静态对账失败（check-read-visibility.mjs 退出码非 0）：\n` +
          `${failure.stdout ?? ''}${failure.stderr ?? ''}${failure.message ?? ''}`,
      );
    }
    const report = JSON.parse(stdout) as { adminRegistry?: { method: string; path: string }[] };
    const registered = (report.adminRegistry ?? []).map(
      (entry) => `${entry.method} ${entry.path}`,
    );

    const notCovered = NOT_COVERED.map((entry) => `${entry.method} ${entry.path}`);
    const union = [...covered, ...notCovered];

    expect(registered.length).toBe(20);
    // 「已覆盖 + 写明原因未覆盖」必须**恰好**等于登记在册的 20 条。
    expect([...union].sort()).toEqual([...registered].sort());
    // 同一个端点不许被登记两次（否则上面那条相等会被「凑数」蒙混过去）。
    expect(new Set(union).size).toBe(union.length);
  });
});
