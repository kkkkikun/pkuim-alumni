import { execFileSync } from 'node:child_process';
import path from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, ensureAdmin, login, markVerified, resetDatabase } from '../helpers';

/**
 * 管理端「**权限点不足 → 403**」分界的**运行时**用例（第十六轮）。
 *
 * 背景：
 *   管理端的两条失败语义分界，此前只有一条有运行时防线：
 *     - 「资源不存在 → **404**」：第十四轮（`admin-not-found-boundary.e2e-spec.ts`）
 *       与第十五轮（`admin-not-found-boundary-positive.e2e-spec.ts`）各钉了一半；
 *     - 「权限点不足 → **403**」：此前**只有静态对账**守着
 *       （`infra/scripts/check-rbac-matrix.mjs` 核对「端点 ↔ 权限点」的矩阵）。
 *
 *   静态对账证明不了运行时那一半：
 *     - 守卫（`PermissionsGuard`）可能没挂上、或者挂错位置；
 *     - `@RequirePermissions` 的装饰器**顺序**一变，静态解析就可能读不到它；
 *     - 令牌里的权限点解析、RBAC 缓存、停用账号的即时失效 —— 静态脚本一律看不见；
 *     - 更要命的是：如果 403 这一半**整体失效**（所有管理员都能调所有端点），
 *       静态矩阵仍然是「绿的」（矩阵只说「这个端点该要哪个权限点」，
 *       并不说「运行时真的按它拒绝了」）。
 *
 *   而这一半失效的后果是**静默且严重**的：
 *   权限守卫形同虚设 → 任何管理员（包括只有「看校友」权限的审核员）
 *   都能调「管账号」「改设置」「发通知」这类端点 ——
 *   管理后台是按权限点分菜单的，后台看着「没这个菜单」，接口却照样能调通。
 *
 * 本套件做两件事（**每个管理端端点各来一次**）：
 *   1) **权限点不足 → 403**：给一个**别的**权限点，真去请求 → 断言 403 `FORBIDDEN`；
 *   2) **权限点给足 → 2xx**：给该端点**要的**那个权限点 → 断言 2xx（且不是 403）。
 *      这一半是防「恒过」的另一半：如果守卫坏成「一律拒绝」，
 *      只钉 403 那一半会全绿 —— 加上这一半，「403 是因为权限点不足」
 *      才站得住脚。
 *
 * ⚠️ **不改正对外行为**：本套件只**断言现状**。
 *   若某个端点当前不是 403 / 不是 2xx，那是**缺陷**，
 *   应登记到 `docs/KNOWN-ISSUES.md` 并由产品拍板后再改 —— 本轮**一个字都没改**。
 *
 * ⚠️ **用例与 RBAC 矩阵必须逐条一致**（最后一条用例会断言）：
 *   运行时用例是**按 `check-rbac-matrix.mjs` 的矩阵**列出来的；
 *   矩阵少一条端点、运行时用例多一条（或反过来），都必须当场红 ——
 *   否则「矩阵」与「真跑的」会各说各话。
 */
const API = '/api/v1';

/** 仓库根目录（本文件在 `apps/api/test/integration/` 下，往上三层）。 */
const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** 2xx 的合法形态（DELETE 返回 200 + `{deleted:true}`，不是 204）。 */
const OK_STATUSES = [200, 201, 204];

/**
 * RBAC 矩阵里**真的被端点用到**的权限点（12 个种子权限点里的 10 个；
 * `resource:manage` 与 `notification:broadcast` 是「悬空能力」，见 KNOWN-ISSUES #71）。
 *
 * ⚠️ 这张表用来给「权限点不足」的那个管理员挑一个**别的**权限点：
 *   他手上必须**有**权限点（否则 401 / 403 的原因会混在一起：
 *   「没登录」与「权限不够」是两回事），但**不是**这个端点要的那个。
 */
const USED_PERMISSIONS = [
  'dashboard:view',
  'alumni:view',
  'alumni:manage',
  'verification:review',
  'resource:review',
  'event:manage',
  'content:manage',
  'admin:manage',
  'audit:view',
  'settings:manage',
] as const;

/** 造出来的对象（真实存在，2xx 那一半才有意义）。 */
interface Fixture {
  normalUserId: number;
  adminAccountId: number;
  resourceId: number;
  resourceMediaId: number;
  verificationId: number;
  verificationMediaId: number;
  eventId: number;
  eventToDeleteId: number;
  articleId: number;
  articleToDeleteId: number;
  noticeId: number;
  noticeToDeleteId: number;
  categoryId: number;
  categoryToDeleteId: number;
}

/**
 * 运行时用例的一条：端点 ↔ 权限点 ↔ 请求形态。
 *
 * ⚠️ 这张表必须是**静态**的：`describe.each` 在**收集阶段**求值，
 *    而夹具（真实 id）要到 `beforeAll` 里才造得出来 ——
 *    所以表里放的是「用哪个对象的 id」，请求路径在**用例执行时**才拼出来。
 */
interface RbacCase {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** 与 RBAC 矩阵一致的对外路径（**不含** `/api/v1` 前缀，含 `:id` 占位）。 */
  path: string;
  /** 该端点要求的权限点（与 RBAC 矩阵一致）。 */
  permission: string;
  /** 请求路径里的 id 取自哪个夹具（`null` = 路径里没有 id）。 */
  target: keyof Fixture | null;
  /** 路径里的第二个 id（附件那类端点）。 */
  secondaryTarget?: keyof Fixture;
  /** 查询串（列表端点）。 */
  query?: string;
  body?: Record<string, unknown>;
  /** 这条端点的 403 到底代表什么（用例失败时能一眼看懂）。 */
  boundary: string;
}

/**
 * 逐条列出**每个**管理端端点（与 `check-rbac-matrix.mjs` 的矩阵一一对应）。
 *
 * ⚠️ 对象一律**走真实 API 造出来**（满足业务不变量）——
 *   直接插库造出来的对象可能本就不满足端点的前置条件
 *   （审核状态、归属、附件挂载……），那样「2xx」就成了假绿。
 */
const CASES: RbacCase[] = [
  /* ------------------------- 总览 ------------------------- */
  {
    method: 'GET',
    path: '/admin/stats',
    permission: 'dashboard:view',
    target: null,
    boundary: '数据总览需要 dashboard:view',
  },
  /* ------------------------- 校友 ------------------------- */
  {
    method: 'GET',
    path: '/admin/alumni',
    permission: 'alumni:view',
    target: null,
    query: '?page=1&pageSize=5',
    boundary: '校友列表需要 alumni:view',
  },
  {
    method: 'GET',
    path: '/admin/alumni/:id',
    permission: 'alumni:view',
    target: 'normalUserId',
    boundary: '校友详情需要 alumni:view',
  },
  /* ------------------------- 账号 ------------------------- */
  {
    method: 'GET',
    path: '/admin/users',
    permission: 'admin:manage',
    target: null,
    query: '?page=1&pageSize=5',
    boundary: '管理员列表需要 admin:manage',
  },
  {
    method: 'POST',
    path: '/admin/users',
    permission: 'admin:manage',
    target: null,
    body: {
      username: 'rfb_created_admin',
      password: 'Rfb@2026Pass',
      displayName: '403 分界用例建的管理员',
      roles: ['alumni_reviewer'],
    },
    boundary: '建管理员账号需要 admin:manage',
  },
  {
    method: 'GET',
    path: '/admin/users/:id',
    permission: 'alumni:view',
    target: 'normalUserId',
    boundary: '账号详情需要 alumni:view',
  },
  {
    method: 'PATCH',
    path: '/admin/users/:id',
    permission: 'admin:manage',
    target: 'adminAccountId',
    body: { displayName: '403 分界用例改过的显示名' },
    boundary: '改管理员账号需要 admin:manage',
  },
  {
    method: 'PATCH',
    path: '/admin/users/:id/status',
    permission: 'alumni:manage',
    target: 'normalUserId',
    body: { status: 'active' },
    boundary: '改账号状态需要 alumni:manage',
  },
  {
    method: 'POST',
    path: '/admin/users/:id/status',
    permission: 'alumni:manage',
    target: 'normalUserId',
    body: { status: 'active' },
    boundary: '改账号状态需要 alumni:manage（与 PATCH 同一处置）',
  },
  {
    method: 'GET',
    path: '/admin/roles',
    permission: 'admin:manage',
    target: null,
    boundary: '角色目录需要 admin:manage',
  },
  {
    method: 'GET',
    path: '/admin/permissions',
    permission: 'admin:manage',
    target: null,
    boundary: '权限点目录需要 admin:manage',
  },
  /* ------------------------- 审计 ------------------------- */
  {
    method: 'GET',
    path: '/admin/action-logs',
    permission: 'audit:view',
    target: null,
    query: '?page=1&pageSize=5',
    boundary: '审计日志需要 audit:view',
  },
  /* ------------------------- 系统设置 ------------------------- */
  {
    method: 'GET',
    path: '/admin/settings',
    permission: 'settings:manage',
    target: null,
    boundary: '系统设置需要 settings:manage',
  },
  {
    method: 'PUT',
    path: '/admin/settings',
    permission: 'settings:manage',
    target: null,
    body: { key: 'rfb_setting_key', value: 'rfb-value' },
    boundary: '写系统设置需要 settings:manage',
  },
  /* ------------------------- 认证审核 ------------------------- */
  {
    method: 'GET',
    path: '/admin/verifications',
    permission: 'verification:review',
    target: null,
    query: '?page=1&pageSize=5',
    boundary: '认证申请列表需要 verification:review',
  },
  {
    method: 'GET',
    path: '/admin/verifications/:id',
    permission: 'verification:review',
    target: 'verificationId',
    boundary: '认证申请详情需要 verification:review',
  },
  {
    method: 'GET',
    path: '/admin/verifications/:id/attachments/:mediaId/url',
    permission: 'verification:review',
    target: 'verificationId',
    secondaryTarget: 'verificationMediaId',
    boundary: '认证材料下载地址需要 verification:review',
  },
  {
    method: 'POST',
    path: '/admin/verifications/:id/decision',
    permission: 'verification:review',
    target: 'verificationId',
    body: { action: 'approve', note: '403 分界用例：权限点给足时应当审核通过' },
    boundary: '审核认证申请需要 verification:review',
  },
  /* ------------------------- 资源审核 ------------------------- */
  {
    method: 'GET',
    path: '/admin/resources',
    permission: 'resource:review',
    target: null,
    query: '?page=1&pageSize=5',
    boundary: '资源列表需要 resource:review',
  },
  {
    method: 'GET',
    path: '/admin/resources/:id',
    permission: 'resource:review',
    target: 'resourceId',
    boundary: '资源详情需要 resource:review',
  },
  {
    method: 'GET',
    path: '/admin/resources/:id/attachments/:mediaId/url',
    permission: 'resource:review',
    target: 'resourceId',
    secondaryTarget: 'resourceMediaId',
    boundary: '资源附件下载地址需要 resource:review',
  },
  {
    method: 'POST',
    path: '/admin/resources/:id/decision',
    permission: 'resource:review',
    target: 'resourceId',
    body: { action: 'approve', note: '403 分界用例：权限点给足时应当审核通过' },
    boundary: '审核资源需要 resource:review',
  },
  /* ------------------------- 活动 ------------------------- */
  {
    method: 'GET',
    path: '/admin/events',
    permission: 'event:manage',
    target: null,
    query: '?page=1&pageSize=5',
    boundary: '活动列表需要 event:manage',
  },
  {
    method: 'POST',
    path: '/admin/events',
    permission: 'event:manage',
    target: null,
    body: { title: '403 分界用例建的活动', kind: '沙龙', capacity: 0 },
    boundary: '建活动需要 event:manage',
  },
  {
    method: 'GET',
    path: '/admin/events/:id',
    permission: 'event:manage',
    target: 'eventId',
    boundary: '活动详情需要 event:manage',
  },
  {
    method: 'PATCH',
    path: '/admin/events/:id',
    permission: 'event:manage',
    target: 'eventId',
    body: { title: '403 分界用例改过的活动' },
    boundary: '改活动需要 event:manage',
  },
  {
    method: 'DELETE',
    path: '/admin/events/:id',
    permission: 'event:manage',
    target: 'eventToDeleteId',
    boundary: '删活动需要 event:manage',
  },
  {
    method: 'GET',
    path: '/admin/events/:id/registrations',
    permission: 'event:manage',
    target: 'eventId',
    boundary: '活动报名名单需要 event:manage',
  },
  /* ------------------------- 资讯 ------------------------- */
  {
    method: 'GET',
    path: '/admin/articles',
    permission: 'content:manage',
    target: null,
    query: '?page=1&pageSize=5',
    boundary: '资讯列表需要 content:manage',
  },
  {
    method: 'POST',
    path: '/admin/articles',
    permission: 'content:manage',
    target: null,
    body: { title: '403 分界用例建的资讯', body: '403 分界用例用的资讯正文。' },
    boundary: '建资讯需要 content:manage',
  },
  {
    method: 'PATCH',
    path: '/admin/articles/:id',
    permission: 'content:manage',
    target: 'articleId',
    body: { title: '403 分界用例改过的资讯' },
    boundary: '改资讯需要 content:manage',
  },
  {
    method: 'DELETE',
    path: '/admin/articles/:id',
    permission: 'content:manage',
    target: 'articleToDeleteId',
    boundary: '删资讯需要 content:manage',
  },
  /* ------------------------- 公告 ------------------------- */
  {
    method: 'GET',
    path: '/admin/notices',
    permission: 'content:manage',
    target: null,
    query: '?page=1&pageSize=5',
    boundary: '公告列表需要 content:manage',
  },
  {
    method: 'POST',
    path: '/admin/notices',
    permission: 'content:manage',
    target: null,
    body: { title: '403 分界用例建的公告', body: '403 分界用例用的公告正文。' },
    boundary: '建公告需要 content:manage',
  },
  {
    method: 'PATCH',
    path: '/admin/notices/:id',
    permission: 'content:manage',
    target: 'noticeId',
    body: { title: '403 分界用例改过的公告' },
    boundary: '改公告需要 content:manage',
  },
  {
    method: 'DELETE',
    path: '/admin/notices/:id',
    permission: 'content:manage',
    target: 'noticeToDeleteId',
    boundary: '删公告需要 content:manage',
  },
  /* ------------------------- 资讯分类 ------------------------- */
  {
    method: 'POST',
    path: '/admin/articles/categories',
    permission: 'content:manage',
    target: null,
    body: { name: '403 分界用例分类', slug: 'rfb-case-category' },
    boundary: '建分类需要 content:manage',
  },
  {
    method: 'PATCH',
    path: '/admin/articles/categories/:id',
    permission: 'content:manage',
    target: 'categoryId',
    body: { name: '403 分界用例改过的分类' },
    boundary: '改分类需要 content:manage',
  },
  {
    method: 'DELETE',
    path: '/admin/articles/categories/:id',
    permission: 'content:manage',
    target: 'categoryToDeleteId',
    boundary: '删分类需要 content:manage',
  },
  /* ------------------------- 运维 ------------------------- */
  {
    method: 'GET',
    path: '/admin/ops/invalidation-bus',
    permission: 'admin:manage',
    target: null,
    boundary: '共享失效总线状态（内部信息）只允许 admin:manage',
  },
];

/**
 * 把「矩阵形态」的路径（`:id`）换成**真实存在**的 id。
 *
 * ⚠️ 必须换成**真实存在**的对象：请求一个不存在的 id 时，
 *   「权限点给足」那一半会拿到 404（而不是 2xx），
 *   那就测不出「给足权限点之后这个端点真的能用」了。
 */
function resolveRequestPath(item: RbacCase, fixture: Fixture): string {
  let resolved = item.path;
  if (item.target) {
    resolved = resolved.replace(':id', String(fixture[item.target]));
  }
  if (item.secondaryTarget) {
    resolved = resolved.replace(':mediaId', String(fixture[item.secondaryTarget]));
  }
  return `${resolved}${item.query ?? ''}`;
}

describe('管理端「权限点不足 → 403」分界（第十六轮运行时用例）', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  /** 权限点**给足**的管理员令牌（按权限点分组）。 */
  const grantedTokens = new Map<string, string>();
  /** 权限点**不足**的管理员令牌（按「该端点要的权限点」分组）。 */
  const limitedTokens = new Map<string, string>();
  /** 本套件造出来的账号 / 角色（`admin_users` 是保留表，用完必须清理）。 */
  const createdUsernames: string[] = [];
  const createdRoleCodes: string[] = [];
  /** 夹具（真实存在的对象 id）—— 用例执行时才用来拼请求路径。 */
  let fixture: Fixture;

  const server = () => request(app.getHttpServer());

  /** 造一个只带**一个**权限点的管理员，并登录取令牌。 */
  async function adminWithPermission(
    tag: string,
    index: number,
    permissionCode: string,
  ): Promise<string> {
    const username = `rfb_${tag}_${index}`.slice(0, 32);
    const roleCode = `rfb_${tag}_r${index}`.slice(0, 32);
    createdUsernames.push(username);
    createdRoleCodes.push(roleCode);
    await ensureAdmin(dataSource, { username, roleCode, permissionCode });
    const response = await server()
      .post(`${API}/auth/admin/login`)
      .send({ username, password: 'Admin@2026' })
      .expect(200);
    return response.body.data.accessToken as string;
  }

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
    await resetDatabase(dataSource);

    // --- 造数据的「全能」管理员（只用来造对象，本身不参与断言） ---
    // ⚠️ 它是**夹具**，不是被测对象：被测的是「权限点不足 / 给足」那两个账号。
    const superRole = 'rfb_super_role';
    createdRoleCodes.push(superRole);
    for (const permissionCode of USED_PERMISSIONS) {
      await ensureAdmin(dataSource, { roleCode: superRole, permissionCode });
    }
    const superUsername = 'rfb_super';
    createdUsernames.push(superUsername);
    await ensureAdmin(dataSource, {
      username: superUsername,
      roleCode: superRole,
      permissionCode: USED_PERMISSIONS[0],
    });
    const superLogin = await server()
      .post(`${API}/auth/admin/login`)
      .send({ username: superUsername, password: 'Admin@2026' })
      .expect(200);
    const superToken = superLogin.body.data.accessToken as string;
    const [superRow] = await dataSource.query(
      'SELECT id FROM admin_users WHERE username = ?',
      [superUsername],
    );

    // --- 造对象（走真实 API，满足业务不变量） ---
    const normal = await login(app, 'rfb-normal-user');
    const author = await login(app, 'rfb-author');
    await markVerified(dataSource, author.userId);

    const assetResponse = await server()
      .post(`${API}/uploads/records`)
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({ fileName: 'rfb-resource.png', mimeType: 'image/png', size: 128 })
      .expect(201);
    const resourceMediaId = Number(assetResponse.body.data.id);

    const resourceResponse = await server()
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({
        type: 'resource',
        title: '403 分界用例用的资源内容',
        body: '这是一段用于「权限点不足 → 403」运行时用例的资源描述内容，长度满足校验要求。',
        attachmentMediaIds: [resourceMediaId],
      })
      .expect(201);

    const verifier = await login(app, 'rfb-verifier');
    const verifierAsset = await server()
      .post(`${API}/uploads/records`)
      .set('Authorization', `Bearer ${verifier.accessToken}`)
      .send({ fileName: 'rfb-proof.png', mimeType: 'image/png', size: 128 })
      .expect(201);
    const verificationMediaId = Number(verifierAsset.body.data.id);

    const verificationResponse = await server()
      .post(`${API}/alumni/verification`)
      .set('Authorization', `Bearer ${verifier.accessToken}`)
      .send({
        realName: '403 分界用例校友',
        college: '北京大学',
        graduationYear: 2015,
        studentIdMasked: 'SN87654321',
        attachmentMediaIds: [verificationMediaId],
      })
      .expect(201);

    const createEvent = async (title: string): Promise<number> => {
      const response = await server()
        .post(`${API}/admin/events`)
        .set('Authorization', `Bearer ${superToken}`)
        .send({ title, kind: '沙龙', capacity: 0 })
        .expect(201);
      return Number(response.body.data.id);
    };
    const eventId = await createEvent('403 分界用例用的活动');
    const eventToDeleteId = await createEvent('403 分界用例用的待删活动');

    const createArticle = async (title: string): Promise<number> => {
      const response = await server()
        .post(`${API}/admin/articles`)
        .set('Authorization', `Bearer ${superToken}`)
        .send({ title, body: '403 分界用例用的资讯正文。' })
        .expect(201);
      return Number(response.body.data.id);
    };
    const articleId = await createArticle('403 分界用例用的资讯');
    const articleToDeleteId = await createArticle('403 分界用例用的待删资讯');

    const createNotice = async (title: string): Promise<number> => {
      const response = await server()
        .post(`${API}/admin/notices`)
        .set('Authorization', `Bearer ${superToken}`)
        .send({ title, body: '403 分界用例用的公告正文。' })
        .expect(201);
      return Number(response.body.data.id);
    };
    const noticeId = await createNotice('403 分界用例用的公告');
    const noticeToDeleteId = await createNotice('403 分界用例用的待删公告');

    const createCategory = async (name: string, slug: string): Promise<number> => {
      const response = await server()
        .post(`${API}/admin/articles/categories`)
        .set('Authorization', `Bearer ${superToken}`)
        .send({ name, slug })
        .expect(201);
      return Number(response.body.data.id);
    };
    const categoryId = await createCategory('403 分界用例分类', 'rfb-case-category-keep');
    const categoryToDeleteId = await createCategory(
      '403 分界用例待删分类',
      'rfb-case-category-to-delete',
    );

    fixture = {
      normalUserId: normal.userId,
      adminAccountId: Number(superRow.id),
      resourceId: Number(resourceResponse.body.data.id),
      resourceMediaId,
      verificationId: Number(verificationResponse.body.data.id),
      verificationMediaId,
      eventId,
      eventToDeleteId,
      articleId,
      articleToDeleteId,
      noticeId,
      noticeToDeleteId,
      categoryId,
      categoryToDeleteId,
    };

    // --- 权限点「给足」与「不足」的两组账号 ---
    for (const [index, permissionCode] of USED_PERMISSIONS.entries()) {
      grantedTokens.set(
        permissionCode,
        await adminWithPermission('granted', index, permissionCode),
      );
      // 「不足」的那个账号带一个**别的**权限点（他仍然是管理员，
      // 只是没有这个端点要的那一个 —— 这样 403 的原因才只有一个）。
      const filler = USED_PERMISSIONS.find((item) => item !== permissionCode) as string;
      limitedTokens.set(
        permissionCode,
        await adminWithPermission('limited', index, filler),
      );
    }
  });

  afterAll(async () => {
    // ⚠️ 清理必须在 `app.close()` **之前**做：`app.close()` 会销毁 DataSource。
    try {
      // 造出来的那个管理员（POST /admin/users 建的）也要清掉。
      createdUsernames.push('rfb_created_admin');
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
        await dataSource.query(
          'DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE code = ?)',
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

  /** 发一次请求（带令牌；路径里的 `:id` 换成**真实存在**的对象 id）。 */
  const call = (item: RbacCase, token: string): request.Test =>
    server()[item.method.toLowerCase() as 'get'](
      `${API}${resolveRequestPath(item, fixture)}`,
    )
      .set('Authorization', `Bearer ${token}`)
      .send(item.body ?? {}) as unknown as request.Test;

  /* ------------------------- 权限点不足 → 403 ------------------------- */

  describe.each(CASES.map((item) => [`${item.method} ${item.path}`, item] as const))(
    '%s',
    (_label, item) => {
      it(`权限点不足 → 403 FORBIDDEN（${item.boundary}）`, async () => {
        const token = limitedTokens.get(item.permission);
        expect(token).toBeTruthy();

        const response = await call(item, token as string);

        expect(response.status).toBe(403);
        expect(response.body.code).toBe('FORBIDDEN');
        // 403 之外一律不认：404 = 权限点没给对（守卫没拦住），
        // 5xx = 实现把「权限不够」当成了「服务端炸了」。
        expect(response.status).toBeLessThan(500);
      });
    },
  );

  /* ------------------------- 权限点给足 → 2xx ------------------------- */

  describe.each(CASES.map((item) => [`${item.method} ${item.path}`, item] as const))(
    '%s',
    (_label, item) => {
      it(`权限点给足 → 2xx（${item.boundary}）`, async () => {
        const token = grantedTokens.get(item.permission);
        expect(token).toBeTruthy();

        const response = await call(item, token as string);

        expect(OK_STATUSES).toContain(response.status);
        expect(response.body?.code ?? '').not.toBe('FORBIDDEN');
      });
    },
  );

  /* ------------------------- 运行时用例 ↔ RBAC 矩阵逐条一致 ------------------------- */

  it('运行时用例与 `check-rbac-matrix.mjs` 的权限点矩阵**逐条一致**（少一条 / 多一条当场红）', () => {
    const checker = path.join(REPO_ROOT, 'infra/scripts/check-rbac-matrix.mjs');
    let stdout: string;
    try {
      stdout = execFileSync('node', [checker, '--root', REPO_ROOT, '--json'], {
        encoding: 'utf8',
        cwd: REPO_ROOT,
      });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      throw new Error(
        `RBAC 矩阵静态对账失败（check-rbac-matrix.mjs 退出码非 0）：\n` +
          `${failure.stdout ?? ''}${failure.stderr ?? ''}${failure.message ?? ''}`,
      );
    }
    const report = JSON.parse(stdout) as {
      adminEndpoints?: { method: string; path: string; permissions: string[] }[];
    };
    const matrix = (report.adminEndpoints ?? []).map(
      (entry) => `${entry.method} ${entry.path}`,
    );

    expect(matrix.length).toBe(CASES.length);
    expect(matrix.sort()).toEqual(CASES.map((item) => `${item.method} ${item.path}`).sort());

    // 权限点的对应关系也要**逐条**一致（矩阵说这个端点要哪个权限点，
    // 运行时就按哪个权限点分组放行 / 拒绝）。
    const matrixPermissions = new Map(
      (report.adminEndpoints ?? []).map((entry) => [
        `${entry.method} ${entry.path}`,
        entry.permissions.join(','),
      ]),
    );
    for (const item of CASES) {
      expect(matrixPermissions.get(`${item.method} ${item.path}`)).toBe(item.permission);
    }
  });
});
