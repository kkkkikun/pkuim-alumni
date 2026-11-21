import { execFileSync } from 'node:child_process';
import path from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, ensureAdmin, resetDatabase } from '../helpers';

/**
 * 管理端「**资源不存在 → 404**」分界的**运行时**用例（第十四轮）。
 *
 * 背景：
 *   第十三轮把管理端的失败语义分界做成了**静态对账**
 *   （`infra/scripts/check-read-visibility.mjs` 的 R9 ~ R12）：
 *   管理端凡是实现里会抛 404 的端点，都必须登记「资源不存在 → 404」，
 *   实现里必须看得见 `NotFoundException`，`docs/API-SPEC.md` 第 13.4 节逐条点名。
 *
 *   但静态对账只能证明「**源码里写了**抛 404」——
 *   证明不了「**真的请求这个端点时，返回的就是 404**」。
 *   这中间有一整层它看不见：
 *     - 中间件 / 守卫 / 过滤器可能把状态码改掉（404 被当成 200 或 500）；
 *     - DTO 校验可能先于业务判定生效（该 404 的请求先撞上 400）；
 *     - 事务、异常包装可能把 `NotFoundException` 吞掉（变成 500）；
 *     - 端点的 id 语义可能不是「行 id」（例如按 `user_id` 查），
 *       用错了 id，404 就只是「碰巧没查到」。
 *   管理后台正是按状态码分支的：404 =「对象不存在」（可以刷新列表），
 *   500 =「服务端坏了」（要报工单）。这两者的区别**必须**由运行时用例钉住。
 *
 * 本套件做三件事：
 *   1) 对登记在册的**每一个**管理端端点逐条跑一遍「资源不存在」的请求，
 *      断言真实响应是 **404 `NOT_FOUND`**（且**不得**是 5xx、不得是 403）；
 *   2) 断言这些端点**确实是靠 id 找不到**才 404 的 ——
 *      造一条**真实存在**的行，用它的 id 请求必须**不是 404**
 *      （否则这个 404 可能只是「参数永远解析失败」）；
 *   3) 断言运行时用例与**登记表**（第十三轮那 20 条）**逐条一致** ——
 *      登记表加了端点而这里没加、或这里加了而登记表没写，都必须红。
 *
 * ⚠️ **不改正对外行为**：本套件只**断言现状**。
 *    若某个端点当前不是 404，那是**缺陷**，应登记到 `docs/KNOWN-ISSUES.md`
 *    并由产品拍板后再改 —— 本轮**一个字都没改**。
 */
const API = '/api/v1';

/** 一个必定不存在的 id（库里没有这么大的主键）。 */
const MISSING_ID = 999_999_999;

/** 请求体（写端点必须先过 DTO 校验，否则会先撞 400 而不是 404）。 */
interface RuntimeCase {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** 与登记表 / API-SPEC 一致的对外路径（**不含** `/api/v1` 前缀）。 */
  path: string;
  /** 相对路径的完整形态（含 `:id` 占位与查询串）。 */
  requestPath: string;
  body?: Record<string, unknown>;
  /** 这条端点的 404 到底代表什么（用例失败时能一眼看懂）。 */
  boundary: string;
}

/**
 * 第十三轮登记在册的 **20 个**管理端端点 —— 逐条对应
 * `infra/scripts/check-read-visibility.mjs` 的 `ADMIN_VISIBILITY_REGISTRY`
 * 与 `docs/API-SPEC.md` 第 13.4 节的表格。
 *
 * ⚠️ 这张表必须与登记表**逐条一致**（最后一条用例会断言）——
 *    少一条 = 那个端点的 404 没人验；多一条 = 验了一个没登记的端点。
 */
const RUNTIME_CASES: RuntimeCase[] = [
  {
    method: 'GET',
    path: '/admin/alumni/:id',
    requestPath: `/admin/alumni/${MISSING_ID}`,
    boundary: '校友不存在 → 404（管理端按 id 取不到档案即 404，不返回空对象）',
  },
  {
    method: 'GET',
    path: '/admin/users/:id',
    requestPath: `/admin/users/${MISSING_ID}`,
    boundary: '账号不存在 → 404',
  },
  {
    method: 'PATCH',
    path: '/admin/users/:id',
    requestPath: `/admin/users/${MISSING_ID}`,
    body: { displayName: '404 边界用例' },
    boundary: '管理员不存在 → 404（在事务内判定，不会改到别的行）',
  },
  {
    method: 'PATCH',
    path: '/admin/users/:id/status',
    requestPath: `/admin/users/${MISSING_ID}/status`,
    body: { status: 'disabled' },
    boundary: '账号不存在 → 404（改状态与写审计同事务）',
  },
  {
    method: 'POST',
    path: '/admin/users/:id/status',
    requestPath: `/admin/users/${MISSING_ID}/status`,
    body: { status: 'disabled' },
    boundary: '账号不存在 → 404（与 PATCH /admin/users/:id/status 同一处置）',
  },
  {
    method: 'GET',
    path: '/admin/verifications/:id',
    requestPath: `/admin/verifications/${MISSING_ID}`,
    boundary: '认证申请不存在 → 404',
  },
  {
    method: 'POST',
    path: '/admin/verifications/:id/decision',
    requestPath: `/admin/verifications/${MISSING_ID}/decision`,
    body: { action: 'approve' },
    boundary: '认证申请不存在 → 404；动作不被支持 → 409',
  },
  {
    method: 'GET',
    path: '/admin/verifications/:id/attachments/:mediaId/url',
    requestPath: `/admin/verifications/${MISSING_ID}/attachments/${MISSING_ID}/url`,
    boundary: '附件不存在**或**不属于该申请 → 404（不泄露「该文件存在」）',
  },
  {
    method: 'GET',
    path: '/admin/resources/:id',
    requestPath: `/admin/resources/${MISSING_ID}`,
    boundary: '内容不存在 → 404',
  },
  {
    method: 'POST',
    path: '/admin/resources/:id/decision',
    requestPath: `/admin/resources/${MISSING_ID}/decision`,
    body: { action: 'approve' },
    boundary: '内容不存在 → 404',
  },
  {
    method: 'GET',
    path: '/admin/resources/:id/attachments/:mediaId/url',
    requestPath: `/admin/resources/${MISSING_ID}/attachments/${MISSING_ID}/url`,
    boundary: '附件不存在**或**不属于该内容 → 404（不泄露「该文件存在」）',
  },
  {
    method: 'GET',
    path: '/admin/events/:id',
    requestPath: `/admin/events/${MISSING_ID}`,
    boundary: '活动不存在 → 404',
  },
  {
    method: 'PATCH',
    path: '/admin/events/:id',
    requestPath: `/admin/events/${MISSING_ID}`,
    body: { title: '404 边界用例' },
    boundary: '活动不存在 → 404',
  },
  {
    method: 'DELETE',
    path: '/admin/events/:id',
    requestPath: `/admin/events/${MISSING_ID}`,
    boundary: '活动不存在 → 404（删不到就报「不存在」，不假装删成功）',
  },
  {
    method: 'PATCH',
    path: '/admin/articles/:id',
    requestPath: `/admin/articles/${MISSING_ID}`,
    body: { title: '404 边界用例' },
    boundary: '内容不存在 → 404',
  },
  {
    method: 'DELETE',
    path: '/admin/articles/:id',
    requestPath: `/admin/articles/${MISSING_ID}`,
    boundary: '内容不存在 → 404',
  },
  {
    method: 'PATCH',
    path: '/admin/notices/:id',
    requestPath: `/admin/notices/${MISSING_ID}`,
    body: { title: '404 边界用例' },
    boundary: '公告不存在 → 404',
  },
  {
    method: 'DELETE',
    path: '/admin/notices/:id',
    requestPath: `/admin/notices/${MISSING_ID}`,
    boundary: '公告不存在 → 404',
  },
  {
    method: 'PATCH',
    path: '/admin/articles/categories/:id',
    requestPath: `/admin/articles/categories/${MISSING_ID}`,
    body: { name: '404 边界用例' },
    boundary: '分类不存在 → 404',
  },
  {
    method: 'DELETE',
    path: '/admin/articles/categories/:id',
    requestPath: `/admin/articles/categories/${MISSING_ID}`,
    boundary: '分类不存在 → 404',
  },
];

/** 仓库根目录（本文件在 `apps/api/test/integration/` 下，往上三层）。 */
const REPO_ROOT = path.resolve(__dirname, '../../../..');

describe('管理端「资源不存在 → 404」分界（第十四轮运行时用例）', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
    await resetDatabase(dataSource);

    // ⚠️ 必须给到**全部**权限点：这些端点各自有守卫
    //   （`alumni:view` / `admin:manage` / `alumni:manage` / `verification:review` /
    //     `resource:review` / `event:manage` / `content:manage`），
    //   权限点不足会先撞上 **403** —— 那测的就不是「资源不存在」这一说了。
    //   逐个显式授予（而不是依赖 seed 恰好把权限点给了这个角色）：
    //   这样本套件**不依赖别的套件或 seed 的残留状态**（缺陷 #158 的教训）。
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

    const login = await request(app.getHttpServer())
      .post(`${API}/auth/admin/login`)
      .send({ username: 'admin-test', password: 'Admin@2026' })
      .expect(200);
    adminToken = login.body.data.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => request(app.getHttpServer());

  /* ------------------------- 逐条跑通：资源不存在 → 404 ------------------------- */

  describe.each(RUNTIME_CASES.map((item) => [item.method, item.path, item] as const))(
    '%s %s',
    (_method, _path, item) => {
      it(`资源不存在 → 404 NOT_FOUND（${item.boundary}）`, async () => {
        const call = server()[item.method.toLowerCase() as 'get'](
          `${API}${item.requestPath}`,
        );
        if (item.body) call.send(item.body);
        const response = await call.set('Authorization', `Bearer ${adminToken}`);

        // ⚠️ 断言的是**真实响应**，不是「源码里写了 NotFoundException」。
        expect(response.status).toBe(404);
        expect(response.body.code).toBe('NOT_FOUND');
        // 404 之外的失败形态一律不认：403 = 权限点没给对（测试环境问题），
        // 5xx = 实现把「不存在」当成了「服务端炸了」（那才是真缺陷）。
        expect(response.status).toBeLessThan(500);
      });
    },
  );

  /* ------------------------- 反向验证：真的存在时不能 404 ------------------------- */

  it('反向验证：资源**存在**时这些端点不返回 404（404 来自「查不到」而不是「参数永远无效」）', async () => {
    // 造一条**真实存在**的活动（走管理端建档端点，顺带证明管理员权限点是通的）。
    const created = await server()
      .post(`${API}/admin/events`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: '404 边界反向验证用活动', kind: '沙龙', capacity: 0 })
      .expect(201);
    const eventId = Number(created.body.data.id);

    const response = await server()
      .get(`${API}/admin/events/${eventId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).not.toBe(404);
    expect(response.status).toBe(200);
    expect(Number(response.body.data.id)).toBe(eventId);
  });

  /* ------------------------- 已知口径缺口：把现状钉住 ------------------------- */

  it('已知缺口（#200，未改）：`GET /admin/events/:id/registrations` 在活动不存在时返回 200 + 空名单', async () => {
    // ⚠️ 这是**当前行为**，与「资源不存在 → 404」的口径**不一致**：
    //    它按 `event_id` 过滤报名记录，不校验活动本身是否存在。
    //    改它就是**改对外行为**（管理后台据此提示的文案会变）——
    //    需产品拍板（见 `docs/KNOWN-ISSUES.md` #200），本轮**一个字没改**。
    //    这里把现状**钉住**：口径一旦被改（无论往哪边改），这条用例会红，
    //    提醒同步文档与登记表 —— 与公开端点那条（#197）同一做法。
    const response = await server()
      .get(`${API}/admin/events/${MISSING_ID}/registrations`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data.items).toEqual([]);
    expect(response.body.data.meta.total).toBe(0);
  });

  /* ------------------------- 运行时用例 ↔ 登记表逐条一致 ------------------------- */

  it('运行时用例与第十三轮的登记表（20 条）逐条一致', () => {
    const checker = path.join(REPO_ROOT, 'infra/scripts/check-read-visibility.mjs');
    // 静态对账本身必须先绿（不一致时它的退出码非 0，这里如实失败，
    // 并把它的输出原样带出来 —— 否则「为什么红」会变成一件要猜的事）。
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

    expect(registered.length).toBe(20);
    expect(registered.sort()).toEqual(
      RUNTIME_CASES.map((item) => `${item.method} ${item.path}`).sort(),
    );
  });
});
