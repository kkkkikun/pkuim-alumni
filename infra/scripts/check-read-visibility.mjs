#!/usr/bin/env node
/**
 * **公开读端点的可见性口径**对账（登记表 ↔ 实现 ↔ 文档）。
 *
 * 背景（第十一轮）：
 *   `docs/DATABASE-DESIGN.md`「未审核内容公开」与
 *   `docs/KNOWN-ISSUES.md`「已知设计取舍」第 2 条定的口径是：
 *     - **未审核 / 未发布的内容**在公开读端点上**不可见**；
 *     - 「不可见」一律返回 **404**（而不是 403）——
 *       403 会通过状态码泄露「这个对象存在」，
 *       404 才是「不存在 / 看不见」的标准口径。
 *   这条口径此前**只被人工抽查过两轮**（第十轮抽查 articles / notices /
 *   resources / 通讯录，发现 `GET /events/:id` 漏了过滤，记为 #197）。
 *   人工抽查的性质决定了它**必然漏**：新增一个公开读端点、
 *   或把某个端点的过滤条件删掉，**没有任何机制会报警**。
 *
 * 本脚本把这条口径做成**自动化对账**，四件事：
 *   R1 **覆盖**：扫**全部控制器**里标了 `@Public()` 的 **GET** 端点 ——
 *      每一个都必须在本脚本的登记表里（口径没人想过 = 漏登记 → 报错）；
 *   R2 **落地**：登记表里写明的**可见性过滤痕迹**必须真的出现在实现里 ——
 *      把某个端点的过滤删掉（等于让未发布内容凭 id 就能公开读到）必须被抓出；
 *   R3 **状态码**：不可见的对象必须落到 **404 `NOT_FOUND`**
 *      （用成 403 就把「存在性」泄露出去了）；
 *   R4 **文档**：`docs/API-SPEC.md` 的「读端点的可见性口径」小节必须**逐条**点名
 *      每个公开读端点与它的不可见状态码 —— 对外契约不能只存在于代码里。
 *   R5 **待拍板**：口径尚未拍板的端点（#197 / #198）必须仍然**记在**
 *      `docs/KNOWN-ISSUES.md` 里；一旦有人把它**悄悄改掉**（实现变了、
 *      登记表没变），必须被抓出来（`READ_VISIBILITY_REGISTRY_STALE`）。
 *
 * 第十二轮把口径从**公开**读端点扩到**已登录**端点（同一支脚本、同一条口径）：
 *   R6 **覆盖**：用户侧（`/me`、`/connections`、`/directory`、`/alumni/verification`、
 *      `/notifications`、`/uploads`、`/resources`）的已登录端点，
 *      凡是实现里**会抛 403 / 404** 的，都必须登记它的可见性分界 ——
 *      口径没人想过 = 漏登记 → 报错；
 *   R7 **落地**：登记项写明的状态码痕迹必须真的出现在实现里
 *      （「不可见 → 404」「无权 → 403」用反了就是对外契约的错）；
 *   R8 **文档**：`docs/API-SPEC.md` 第 13.2 节必须**逐条**点名每个已登录端点。
 *
 * 第十三轮把覆盖面从**用户侧**扩到**管理端**（同一支脚本、同一份「分界」口径）：
 *   R9 **覆盖**：`/admin/*` 的端点，凡是实现里**会抛 404**（资源不存在）的，
 *      都必须登记它的分界 —— 口径没人想过 = 漏登记 → 报错；
 *   R10 **落地**：登记项写明的 404 痕迹必须真的出现在实现里
 *      （资源不存在却返回 200 / 500 = 管理端拿到的不是「不存在」而是「服务端坏了」）；
 *   R11 **文档**：`docs/API-SPEC.md` 第 13.4 节必须**逐条**点名每个管理端点；
 *   R12 **不重复登记**：同一个端点不许在「用户侧表」与「管理端表」里各登记一次。
 *
 * ⚠️ **与 `check-rbac-matrix.mjs` 的分工**（两张表不许重复登记）：
 *   管理端的两种失败语义**分属两张表、各守一半**：
 *     - 「**权限点不足 → 403**」= 端点 ↔ 权限点（端点有没有守卫、权限点拼写对不对、
 *       有没有角色被授予）→ 由 `infra/scripts/check-rbac-matrix.mjs` 守着；
 *     - 「**资源不存在 → 404**」= 端点 ↔ 资源（对象查不到时返回什么）→ 由**本表**守着。
 *   本表**不再**重复登记「端点要哪些权限点」——那是 RBAC 矩阵那一行的活；
 *   两张表各管一段，**同一端点**只会在其中一张表里出现。
 *
 * ⚠️ 口径与局限（写在这里，免得被当成万能护栏）：
 *   - 判定是**静态**的：看源码里有没有「可见性过滤 + 抛 404」的形态，
 *     不执行代码、不连数据库。真值由集成测试
 *     （`apps/api/test/integration/public-read-visibility.e2e-spec.ts`）守着。
 *   - 「可见性过滤痕迹」是**字符串**判定：登记表里写明的痕迹必须出现在实现里，
 *     改写代码却不改登记表会被判成不一致 —— 这是**故意的**：
 *     宁可吵，也不要让「口径与实现分叉」悄悄发生。
 *   - `@Public()` 的**写**端点不在本脚本范围内（那是错误语义对账
 *     `check-error-semantics.mjs` 的地盘）。
 *
 * 用法：
 *   node infra/scripts/check-read-visibility.mjs [--root <repo>] [--json]
 *
 * 退出码：0 = 一致；1 = 存在不一致。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/* ------------------------------ 参数 ------------------------------ */

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const AS_JSON = args.includes('--json');

/** 仓库根目录（惰性求值，便于被别的脚本 import）。 */
function root() {
  return path.resolve(argValue('--root', process.cwd()));
}

/* ------------------------------ 登记表 ------------------------------ */

/**
 * **公开读端点的可见性口径登记表** —— 「已对账」的唯一事实来源。
 *
 * 每条必须写清：
 *   - `path` / `method`：对外路径（**不含** `/api/v1` 前缀，与 API-SPEC 一致）；
 *   - `impl`：可见性过滤发生在哪个文件的哪个方法里；
 *   - `filterMarkers`：**可见性过滤**的痕迹（缺一个即报 `READ_VISIBILITY_FILTER_MISSING`）；
 *   - `statusMarkers`：不可见时抛的异常（`NotFoundException` = 404 /
 *     `ForbiddenException` = 403）—— 用错就是「泄露存在性」；
 *   - `docToken`：文档那一行里必须出现的口径词（'404' / '列表' / '公开' / '待拍板'）；
 *   - `pending`：**口径待产品拍板**时，指向 `docs/KNOWN-ISSUES.md` 的条目号。
 *
 * ⚠️ 为什么 `GET /events/:id` 是 `pending` 而不是「补上过滤」：
 *    把它改成 404 是**对外契约变更**（公开端点的响应从 200 变 404），
 *    按仓库约定「对外契约变更先确认再动」，第十轮只记录（#197）、
 *    第十一轮仍**无产品结论** —— 所以既不改行为，也不假装它已经合规：
 *    本脚本对它断言的是「**尚未拍板的那部分不得被悄悄改掉**」
 *    （实现里一旦出现过滤痕迹，登记表就过期了 → 报错要求更新登记表与文档）。
 */
const READ_VISIBILITY_REGISTRY = [
  /* ------------------------- 内容（资讯 / 公告） ------------------------- */
  {
    method: 'GET',
    path: '/articles',
    controller: 'apps/api/src/modules/content/content.controller.ts',
    handler: 'listArticles',
    impl: { file: 'apps/api/src/modules/content/content.service.ts', method: 'listArticles' },
    visibility: '列表只含已发布',
    invisibleStatus: null,
    rule: "列表固定 `status='published'` —— 未发布的内容**根本不出现在列表里**",
    filterMarkers: ["article.status = :status", "params.status ?? 'published'"],
    statusMarkers: [],
    docToken: '列表',
  },
  {
    method: 'GET',
    path: '/articles/categories',
    controller: 'apps/api/src/modules/content/content.controller.ts',
    handler: 'listCategories',
    impl: { file: 'apps/api/src/modules/content/content.service.ts', method: 'listCategories' },
    visibility: '分类恒公开',
    invisibleStatus: null,
    rule: '分类目录本身公开；每类的文章数**只统计已发布**（草稿数属于内部信息）',
    filterMarkers: ["status: 'published'"],
    statusMarkers: [],
    docToken: '公开',
  },
  {
    method: 'GET',
    path: '/articles/:id',
    controller: 'apps/api/src/modules/content/content.controller.ts',
    handler: 'articleDetail',
    impl: { file: 'apps/api/src/modules/content/content.service.ts', method: 'articleDetail' },
    visibility: '仅已发布可见',
    invisibleStatus: 404,
    rule: "`status !== 'published'` → **404**（与「不存在」同一个答案，不泄露存在性）",
    filterMarkers: ["status !== 'published'"],
    statusMarkers: ['NotFoundException'],
    docToken: '404',
  },
  {
    method: 'GET',
    path: '/notices',
    controller: 'apps/api/src/modules/content/content.controller.ts',
    handler: 'listNotices',
    impl: { file: 'apps/api/src/modules/content/content.service.ts', method: 'listNotices' },
    visibility: '列表只含已发布',
    invisibleStatus: null,
    rule: "列表固定 `status='published'`",
    filterMarkers: ["notice.status = :status", "params.status ?? 'published'"],
    statusMarkers: [],
    docToken: '列表',
  },
  {
    method: 'GET',
    path: '/notices/:id',
    controller: 'apps/api/src/modules/content/content.controller.ts',
    handler: 'noticeDetail',
    impl: { file: 'apps/api/src/modules/content/content.service.ts', method: 'noticeDetail' },
    visibility: '仅已发布可见',
    invisibleStatus: 404,
    rule: "`status !== 'published'` → **404**",
    filterMarkers: ["status !== 'published'"],
    statusMarkers: ['NotFoundException'],
    docToken: '404',
  },
  {
    method: 'GET',
    path: '/home/feed',
    controller: 'apps/api/src/modules/content/content.controller.ts',
    handler: 'homeFeed',
    impl: { file: 'apps/api/src/modules/content/content.service.ts', method: 'homeFeed' },
    visibility: '聚合只含已发布',
    invisibleStatus: null,
    rule: '首页聚合的资讯 / 公告 / 公告条**全部来自已发布集合**',
    filterMarkers: ['listArticles', 'listNotices', "status: 'published'"],
    statusMarkers: [],
    docToken: '聚合',
  },

  /* ----------------------------- 活动 ----------------------------- */
  {
    method: 'GET',
    path: '/events',
    controller: 'apps/api/src/modules/events/events.controller.ts',
    handler: 'list',
    impl: { file: 'apps/api/src/modules/events/events.service.ts', method: 'list' },
    visibility: '列表只含已发布',
    invisibleStatus: null,
    rule: "列表固定 `status='published'`",
    filterMarkers: ["event.status = :status", "params.status ?? 'published'"],
    statusMarkers: [],
    docToken: '列表',
  },
  {
    method: 'GET',
    path: '/events/:id',
    controller: 'apps/api/src/modules/events/events.controller.ts',
    handler: 'detail',
    impl: { file: 'apps/api/src/modules/events/events.service.ts', method: 'detail' },
    visibility: '**口径待拍板**（#197）',
    invisibleStatus: null,
    rule:
      '当前**不过滤** `status`（草稿 / 已关闭的活动凭 id 就能公开读到）—— ' +
      '改成 404 属对外契约变更，需产品拍板（KNOWN-ISSUES #197）',
    filterMarkers: [],
    statusMarkers: ['NotFoundException'],
    docToken: '待拍板',
    pending: '197',
    /** 待拍板项一旦出现可见性过滤痕迹，说明行为已被改掉 → 登记表过期 */
    pendingFilterMarkers: ["status !== 'published'", "status === 'published'"],
  },

  /* --------------------------- 资源与需求 --------------------------- */
  {
    method: 'GET',
    path: '/resources',
    controller: 'apps/api/src/modules/resources/resources.controller.ts',
    handler: 'list',
    impl: { file: 'apps/api/src/modules/resources/resources.service.ts', method: 'listPublic' },
    visibility: '列表只含已审核通过',
    invisibleStatus: null,
    rule: "列表固定 `status='published'`（未审核内容一律不进公开列表）",
    filterMarkers: ["post.status = :status", "status: 'published'"],
    statusMarkers: [],
    docToken: '列表',
  },
  {
    method: 'GET',
    path: '/resources/:id',
    controller: 'apps/api/src/modules/resources/resources.controller.ts',
    handler: 'detail',
    impl: { file: 'apps/api/src/modules/resources/resources.service.ts', method: 'detail' },
    visibility: '仅已发布可见（作者与管理员除外）',
    invisibleStatus: 404,
    rule: '未发布且**非作者 / 非管理员** → **404**',
    filterMarkers: ["post.status === 'published'"],
    statusMarkers: ['NotFoundException'],
    docToken: '404',
  },

  /* ---------------------------- 通讯录名片 ---------------------------- */
  {
    method: 'GET',
    path: '/alumni/:id',
    controller: 'apps/api/src/modules/alumni/alumni.controller.ts',
    handler: 'profile',
    impl: { file: 'apps/api/src/modules/directory/directory.service.ts', method: 'detail' },
    visibility: '仅已认证且授权公开者可见',
    invisibleStatus: 404,
    rule:
      "未认证（`stage !== 'verified'`）、账号停用、或 `show_in_directory=0` → **404**" +
      '（KNOWN-ISSUES「已知设计取舍」第 2 条：不用 403，避免泄露存在性）',
    filterMarkers: ["user.stage !== 'verified'", 'profile.showInDirectory'],
    statusMarkers: ['NotFoundException'],
    docToken: '404',
  },

  /* ------------------------- 系统（字典 / 探针） ------------------------- */
  {
    method: 'GET',
    path: '/system/regions',
    controller: 'apps/api/src/modules/system/system.controller.ts',
    handler: 'listRegions',
    impl: { file: 'apps/api/src/modules/system/system.controller.ts', method: 'listRegions' },
    visibility: '恒公开',
    invisibleStatus: null,
    rule: '地区字典恒公开；其中的校友计数**只统计已认证且公开的校友**',
    filterMarkers: ["showInDirectory = :visible", "stage: 'verified'"],
    statusMarkers: [],
    docToken: '公开',
  },
  {
    method: 'GET',
    path: '/system/industries',
    controller: 'apps/api/src/modules/system/system.controller.ts',
    handler: 'listIndustries',
    impl: { file: 'apps/api/src/modules/system/system.controller.ts', method: 'listIndustries' },
    visibility: '恒公开',
    invisibleStatus: null,
    rule: '行业字典恒公开；计数口径同地区字典',
    filterMarkers: ["showInDirectory = :visible", "stage: 'verified'"],
    statusMarkers: [],
    docToken: '公开',
  },
  {
    method: 'GET',
    path: '/system/settings',
    controller: 'apps/api/src/modules/system/system.controller.ts',
    handler: 'listSettings',
    impl: { file: 'apps/api/src/modules/system/system.controller.ts', method: 'listSettings' },
    visibility: '恒公开',
    invisibleStatus: null,
    rule: '系统设置项恒公开（`system_settings` 没有可见性列，表中各项都是公开项）',
    filterMarkers: [],
    statusMarkers: [],
    docToken: '公开',
  },
  {
    method: 'GET',
    path: '/system/health',
    controller: 'apps/api/src/modules/system/system.controller.ts',
    handler: 'health',
    impl: { file: 'apps/api/src/modules/system/system.controller.ts', method: 'health' },
    visibility: '恒公开',
    invisibleStatus: null,
    rule: '健康检查恒公开；**只返回依赖连通性**，不泄露内部拓扑',
    filterMarkers: [],
    statusMarkers: [],
    docToken: '公开',
  },
  {
    method: 'GET',
    path: '/healthz',
    controller: 'apps/api/src/app.controller.ts',
    handler: 'health',
    impl: { file: 'apps/api/src/app.controller.ts', method: 'health' },
    visibility: '恒公开',
    invisibleStatus: null,
    rule: '存活探针恒公开',
    filterMarkers: [],
    statusMarkers: [],
    docToken: '公开',
  },
];

/* --------------------- 已登录端点的可见性口径（第十二轮） --------------------- */

/**
 * **已登录端点**的可见性口径登记表 —— 「403 与 404 的分界」的唯一事实来源。
 *
 * 为什么要把口径扩到**已登录**端点（第十一轮只核了公开那一半）：
 *   `docs/API-SPEC.md` 第 13 节把两种失败语义分得很清楚：
 *     - **不可见 → 404**：「这个对象对你不存在」（不泄露存在性）；
 *     - **无权 → 403**：「对象存在，但你没有权限」。
 *   公开端点这一半此前已经被自动化守住；**已登录端点这一半**此前只有人工抽查，
 *   而这一半恰恰是**最容易改坏**的：把「不是你的」从 403 改成 404（或反过来）
 *   会改变客户端的引导逻辑（去认证页 vs 提示无权限），却没有任何机制会报警。
 *
 * 每条必须写清：
 *   - `impl`：判定发生在哪个文件的哪个方法里；
 *   - `notFoundMarkers`：**不可见**时抛的异常（`NotFoundException` = 404）；
 *   - `forbiddenMarkers`：**无权**时抛的异常（`ForbiddenException` = 403）；
 *   - `controllerMarkers`：控制器上必须有的守卫（如 `@RequireAlumniStage('verified')`）；
 *   - `docTokens`：文档那一行里必须出现的口径词。
 *
 * ⚠️ 范围：**用户侧**的已登录端点（`/me`、`/connections`、`/directory`、
 *    `/alumni/verification`、`/notifications`、`/uploads`、`/resources`）。
 *    `/admin/*` **不在本表**——管理端的「权限点不足 → 403」由
 *    `infra/scripts/check-rbac-matrix.mjs`（端点 ↔ 权限点）对账守着，
 *    两张表各管一段，不要重复。
 */
const AUTHENTICATED_SCOPE_PREFIXES = [
  '/me',
  '/connections',
  '/directory',
  '/alumni',
  '/notifications',
  '/uploads',
  '/resources',
];

const AUTHENTICATED_VISIBILITY_REGISTRY = [
  /* ------------------------------ 我的 ------------------------------ */
  {
    method: 'GET',
    path: '/me',
    controller: 'apps/api/src/modules/me/me.controller.ts',
    handler: 'getMe',
    impl: { file: 'apps/api/src/modules/me/me.service.ts', method: 'getMe' },
    boundary: '只返回当前登录用户自己的资料；账号不存在 → 404',
    notFoundMarkers: ['NotFoundException'],
    forbiddenMarkers: [],
    docTokens: ['404'],
  },

  /* ---------------------------- 连接关系 ---------------------------- */
  {
    method: 'GET',
    path: '/connections/:id',
    controller: 'apps/api/src/modules/connections/connections.controller.ts',
    handler: 'connectionDetail',
    impl: { file: 'apps/api/src/modules/connections/connections.service.ts', method: 'getConnection' },
    boundary: '不是关系双方 → 403；关系不存在**或已解除** → 404',
    notFoundMarkers: ['NotFoundException'],
    forbiddenMarkers: ['ForbiddenException'],
    controllerMarkers: ["@RequireAlumniStage('verified')"],
    docTokens: ['403', '404'],
  },
  {
    method: 'DELETE',
    path: '/connections/:id',
    controller: 'apps/api/src/modules/connections/connections.controller.ts',
    handler: 'revoke',
    impl: { file: 'apps/api/src/modules/connections/connections.service.ts', method: 'revokeConnection' },
    boundary: '不是关系双方 → 403；关系不存在 → 404',
    notFoundMarkers: ['NotFoundException'],
    forbiddenMarkers: ['ForbiddenException'],
    controllerMarkers: ["@RequireAlumniStage('verified')"],
    docTokens: ['403', '404'],
  },
  {
    method: 'PUT',
    path: '/connections/:id/contact-grant',
    controller: 'apps/api/src/modules/connections/connections.controller.ts',
    handler: 'grant',
    impl: { file: 'apps/api/src/modules/connections/connections.service.ts', method: 'setContactGrant' },
    boundary: '不是关系双方 → 403；关系不存在 → 404；关系已解除 → 409',
    notFoundMarkers: ['NotFoundException'],
    forbiddenMarkers: ['ForbiddenException'],
    controllerMarkers: ["@RequireAlumniStage('verified')"],
    docTokens: ['403', '404'],
  },
  {
    method: 'POST',
    path: '/connections/requests',
    controller: 'apps/api/src/modules/connections/connections.controller.ts',
    handler: 'create',
    impl: { file: 'apps/api/src/modules/connections/connections.service.ts', method: 'createRequest' },
    boundary: '对方不存在 → 404；对方未认证 / 不接受联系申请 → 403',
    notFoundMarkers: ['NotFoundException'],
    forbiddenMarkers: ['ForbiddenException'],
    controllerMarkers: ["@RequireAlumniStage('verified')"],
    docTokens: ['403', '404'],
  },
  {
    method: 'GET',
    path: '/connections/requests/:id',
    controller: 'apps/api/src/modules/connections/connections.controller.ts',
    handler: 'detail',
    impl: { file: 'apps/api/src/modules/connections/connections.service.ts', method: 'requestDetail' },
    boundary: '不是申请双方 → 403；申请不存在 → 404',
    notFoundMarkers: ['NotFoundException'],
    forbiddenMarkers: ['ForbiddenException'],
    controllerMarkers: ["@RequireAlumniStage('verified')"],
    docTokens: ['403', '404'],
  },
  {
    method: 'POST',
    path: '/connections/requests/:id/accept',
    controller: 'apps/api/src/modules/connections/connections.controller.ts',
    handler: 'accept',
    impl: { file: 'apps/api/src/modules/connections/connections.service.ts', method: 'accept' },
    boundary: '不是接收方 → 403；申请不存在 → 404',
    notFoundMarkers: ['NotFoundException'],
    forbiddenMarkers: ['ForbiddenException'],
    controllerMarkers: ["@RequireAlumniStage('verified')"],
    docTokens: ['403', '404'],
  },
  {
    method: 'POST',
    path: '/connections/requests/:id/reject',
    controller: 'apps/api/src/modules/connections/connections.controller.ts',
    handler: 'reject',
    impl: { file: 'apps/api/src/modules/connections/connections.service.ts', method: 'reject' },
    boundary: '不是接收方 → 403；申请不存在 → 404',
    notFoundMarkers: ['NotFoundException'],
    forbiddenMarkers: ['ForbiddenException'],
    controllerMarkers: ["@RequireAlumniStage('verified')"],
    docTokens: ['403', '404'],
  },
  {
    method: 'POST',
    path: '/connections/requests/:id/cancel',
    controller: 'apps/api/src/modules/connections/connections.controller.ts',
    handler: 'cancel',
    impl: { file: 'apps/api/src/modules/connections/connections.service.ts', method: 'cancel' },
    boundary: '不是发起方 → 403；申请不存在 → 404',
    notFoundMarkers: ['NotFoundException'],
    forbiddenMarkers: ['ForbiddenException'],
    controllerMarkers: ["@RequireAlumniStage('verified')"],
    docTokens: ['403', '404'],
  },

  /* ------------------------------ 通讯录 ------------------------------ */
  {
    method: 'GET',
    path: '/directory/:id',
    controller: 'apps/api/src/modules/directory/directory.controller.ts',
    handler: 'detail',
    impl: { file: 'apps/api/src/modules/directory/directory.service.ts', method: 'detail' },
    boundary: '未认证 / 账号停用 / 未授权公开 → **404**（不区分原因，不泄露存在性）',
    notFoundMarkers: ['NotFoundException'],
    forbiddenMarkers: [],
    docTokens: ['404'],
  },

  /* --------------------------- 校友认证 --------------------------- */
  {
    method: 'GET',
    path: '/alumni/verification/:id',
    controller: 'apps/api/src/modules/alumni/alumni.controller.ts',
    handler: 'detail',
    impl: { file: 'apps/api/src/modules/alumni/alumni.service.ts', method: 'detail' },
    boundary: '不是本人（且不是管理员）→ 403；申请不存在 → 404',
    notFoundMarkers: ['NotFoundException'],
    forbiddenMarkers: ['ForbiddenException'],
    docTokens: ['403', '404'],
  },
  {
    method: 'GET',
    path: '/alumni/verification/:id/history',
    controller: 'apps/api/src/modules/alumni/alumni.controller.ts',
    handler: 'history',
    impl: { file: 'apps/api/src/modules/alumni/alumni.service.ts', method: 'history' },
    boundary: '不是本人（且不是管理员）→ 403；申请不存在 → 404',
    notFoundMarkers: ['NotFoundException'],
    forbiddenMarkers: ['ForbiddenException'],
    docTokens: ['403', '404'],
  },
  {
    method: 'PUT',
    path: '/alumni/verification/:id/resubmit',
    controller: 'apps/api/src/modules/alumni/alumni.controller.ts',
    handler: 'resubmit',
    impl: { file: 'apps/api/src/modules/alumni/alumni.service.ts', method: 'resubmit' },
    boundary: '不是本人 → 403；申请不存在 → 404；状态不允许 → 409',
    notFoundMarkers: ['NotFoundException'],
    forbiddenMarkers: ['ForbiddenException'],
    docTokens: ['403', '404'],
  },

  /* ------------------------------ 通知 ------------------------------ */
  {
    method: 'GET',
    path: '/notifications/:id',
    controller: 'apps/api/src/modules/notifications/notifications.controller.ts',
    handler: 'detail',
    impl: { file: 'apps/api/src/modules/notifications/notifications.controller.ts', method: 'detail' },
    boundary: '不是本人的通知 → **404**（按 `id + userId` 查，查不到即 404）',
    notFoundMarkers: ['NotFoundException'],
    forbiddenMarkers: [],
    docTokens: ['404'],
  },
  {
    method: 'POST',
    path: '/notifications/:id/read',
    controller: 'apps/api/src/modules/notifications/notifications.controller.ts',
    handler: 'markRead',
    impl: { file: 'apps/api/src/modules/notifications/notification.service.ts', method: 'markRead' },
    boundary: '不是本人的通知 → **404**（与 `GET /notifications/:id` 一致）',
    notFoundMarkers: ['NotFoundException'],
    forbiddenMarkers: [],
    docTokens: ['404'],
  },

  /* --------------------------- 资源（发布方） --------------------------- */
  {
    method: 'PATCH',
    path: '/resources/:id',
    controller: 'apps/api/src/modules/resources/resources.controller.ts',
    handler: 'update',
    impl: { file: 'apps/api/src/modules/resources/resources.service.ts', method: 'update' },
    boundary: '不是作者 → 403；内容不存在 → 404',
    notFoundMarkers: ['NotFoundException'],
    forbiddenMarkers: ['ForbiddenException'],
    controllerMarkers: ["@RequireAlumniStage('verified')"],
    docTokens: ['403', '404'],
  },
  {
    method: 'POST',
    path: '/resources/:id/submit',
    controller: 'apps/api/src/modules/resources/resources.controller.ts',
    handler: 'submit',
    impl: { file: 'apps/api/src/modules/resources/resources.service.ts', method: 'submit' },
    boundary: '不是作者 → 403；内容不存在 → 404',
    notFoundMarkers: ['NotFoundException'],
    forbiddenMarkers: ['ForbiddenException'],
    controllerMarkers: ["@RequireAlumniStage('verified')"],
    docTokens: ['403', '404'],
  },
  {
    method: 'POST',
    path: '/resources/:id/withdraw',
    controller: 'apps/api/src/modules/resources/resources.controller.ts',
    handler: 'withdraw',
    impl: { file: 'apps/api/src/modules/resources/resources.service.ts', method: 'withdraw' },
    boundary: '不是作者 → 403；内容不存在 → 404',
    notFoundMarkers: ['NotFoundException'],
    forbiddenMarkers: ['ForbiddenException'],
    controllerMarkers: ["@RequireAlumniStage('verified')"],
    docTokens: ['403', '404'],
  },

  /* ------------------------------ 附件 ------------------------------ */
  {
    method: 'GET',
    path: '/uploads/:id/url',
    controller: 'apps/api/src/modules/uploads/uploads.controller.ts',
    handler: 'url',
    impl: { file: 'apps/api/src/modules/uploads/uploads.service.ts', method: 'urlFor' },
    boundary: '私有资产且不是上传者 → **404**（不泄露「该文件存在」）',
    notFoundMarkers: ['NotFoundException'],
    forbiddenMarkers: [],
    docTokens: ['404'],
  },
];

/* --------------------- 管理端端点的可见性口径（第十三轮） --------------------- */

/**
 * **管理端端点**的「资源不存在 → 404」登记表 —— 第十三轮新增。
 *
 * 为什么要把口径扩到**管理端**（第十二轮只核了用户侧）：
 *   管理端的两种失败语义必须**分清**，否则管理后台的处理就会走错分支：
 *     - 「**权限点不足 → 403**」：对象存在，但这个管理员**没有权限**管它
 *       → 由 `@RequirePermissions` 守卫拦下（**RBAC 矩阵**那一侧）；
 *     - 「**资源不存在 → 404**」：这个 id **根本没有对应的行**
 *       → 由业务实现抛 `NotFoundException`。
 *   此前这一层**从未被任何脚本核过**：管理端把「资源不存在」写成 200
 *   （删一条不存在的活动返回「已删除」）、或者写成 500（数据库异常直接冒泡），
 *   都没有任何机制会报警 —— 管理后台据此提示的文案就会是错的。
 *
 * 每条必须写清：
 *   - `impl`：抛 404 的那个方法（在哪个文件的哪个方法里）；
 *   - `boundary`：这个端点的 404 到底代表什么（一句话）；
 *   - `docTokens`：文档那一行里必须出现的口径词。
 *
 * ⚠️ **与 `check-rbac-matrix.mjs` 的分工**（两张表不许重复登记）：
 *   「端点 ↔ 权限点」由 RBAC 矩阵守着；**本表只管「端点 ↔ 资源」那一半**
 *   （资源不存在 → 404）。所以本表**不登记**权限点，
 *   R12 也会断言两张表没有登记同一个端点。
 */
const ADMIN_VISIBILITY_REGISTRY = [
  /* ------------------------------ 校友 ------------------------------ */
  {
    method: 'GET',
    path: '/admin/alumni/:id',
    controller: 'apps/api/src/modules/admin/admin.controller.ts',
    handler: 'alumniDetail',
    impl: { file: 'apps/api/src/modules/directory/directory.service.ts', method: 'adminDetail' },
    boundary: '校友不存在 → **404**（管理端按 id 取不到档案即 404，不返回空对象）',
    docTokens: ['404'],
  },
  {
    method: 'GET',
    path: '/admin/users/:id',
    controller: 'apps/api/src/modules/admin/admin-users.controller.ts',
    handler: 'getUser',
    impl: { file: 'apps/api/src/modules/admin/admin-users.controller.ts', method: 'getUser' },
    boundary: '账号不存在 → **404**',
    docTokens: ['404'],
  },
  {
    method: 'PATCH',
    path: '/admin/users/:id',
    controller: 'apps/api/src/modules/admin/admin-users.controller.ts',
    handler: 'updateAdmin',
    impl: { file: 'apps/api/src/modules/admin/admin-users.controller.ts', method: 'updateAdmin' },
    boundary: '管理员不存在 → **404**（在事务内判定，不会改到别的行）',
    docTokens: ['404'],
  },
  {
    method: 'PATCH',
    path: '/admin/users/:id/status',
    controller: 'apps/api/src/modules/admin/admin-users.controller.ts',
    handler: 'patchUserStatus',
    impl: { file: 'apps/api/src/modules/admin/admin-users.controller.ts', method: 'setUserStatus' },
    boundary: '账号不存在 → **404**（改状态与写审计同事务）',
    docTokens: ['404'],
  },
  {
    method: 'POST',
    path: '/admin/users/:id/status',
    controller: 'apps/api/src/modules/admin/admin-users.controller.ts',
    handler: 'updateUserStatus',
    impl: { file: 'apps/api/src/modules/admin/admin-users.controller.ts', method: 'setUserStatus' },
    boundary: '账号不存在 → **404**（与 `PATCH /admin/users/:id/status` 同一处置）',
    docTokens: ['404'],
  },

  /* ---------------------------- 认证审核 ---------------------------- */
  {
    method: 'GET',
    path: '/admin/verifications/:id',
    controller: 'apps/api/src/modules/admin/admin.controller.ts',
    handler: 'verificationDetail',
    impl: { file: 'apps/api/src/modules/alumni/alumni.service.ts', method: 'detail' },
    boundary: '认证申请不存在 → **404**',
    docTokens: ['404'],
  },
  {
    method: 'POST',
    path: '/admin/verifications/:id/decision',
    controller: 'apps/api/src/modules/admin/admin.controller.ts',
    handler: 'verificationDecision',
    impl: { file: 'apps/api/src/modules/alumni/alumni.service.ts', method: 'decide' },
    boundary: '认证申请不存在 → **404**；动作不被支持 → **409**',
    docTokens: ['404'],
  },
  {
    method: 'GET',
    path: '/admin/verifications/:id/attachments/:mediaId/url',
    controller: 'apps/api/src/modules/admin/admin.controller.ts',
    handler: 'verificationAttachmentUrl',
    impl: { file: 'apps/api/src/modules/admin/admin.controller.ts', method: 'verificationAttachmentUrl' },
    boundary: '附件不存在**或**不属于该申请 → **404**（不泄露「该文件存在」）',
    docTokens: ['404'],
  },

  /* ---------------------------- 资源审核 ---------------------------- */
  {
    method: 'GET',
    path: '/admin/resources/:id',
    controller: 'apps/api/src/modules/admin/admin.controller.ts',
    handler: 'resourceDetail',
    impl: { file: 'apps/api/src/modules/resources/resources.service.ts', method: 'detail' },
    boundary: '内容不存在 → **404**',
    docTokens: ['404'],
  },
  {
    method: 'POST',
    path: '/admin/resources/:id/decision',
    controller: 'apps/api/src/modules/admin/admin.controller.ts',
    handler: 'resourceDecision',
    impl: { file: 'apps/api/src/modules/resources/resources.service.ts', method: 'decide' },
    boundary: '内容不存在 → **404**',
    docTokens: ['404'],
  },
  {
    method: 'GET',
    path: '/admin/resources/:id/attachments/:mediaId/url',
    controller: 'apps/api/src/modules/admin/admin.controller.ts',
    handler: 'resourceAttachmentUrl',
    impl: { file: 'apps/api/src/modules/admin/admin.controller.ts', method: 'resourceAttachmentUrl' },
    boundary: '附件不存在**或**不属于该内容 → **404**（不泄露「该文件存在」）',
    docTokens: ['404'],
  },

  /* ------------------------------ 活动 ------------------------------ */
  {
    method: 'GET',
    path: '/admin/events/:id',
    controller: 'apps/api/src/modules/admin/admin.controller.ts',
    handler: 'eventDetail',
    impl: { file: 'apps/api/src/modules/events/events.service.ts', method: 'detail' },
    boundary: '活动不存在 → **404**',
    docTokens: ['404'],
  },
  {
    method: 'PATCH',
    path: '/admin/events/:id',
    controller: 'apps/api/src/modules/admin/admin.controller.ts',
    handler: 'updateEvent',
    impl: { file: 'apps/api/src/modules/events/events.service.ts', method: 'update' },
    boundary: '活动不存在 → **404**',
    docTokens: ['404'],
  },
  {
    method: 'DELETE',
    path: '/admin/events/:id',
    controller: 'apps/api/src/modules/admin/admin.controller.ts',
    handler: 'deleteEvent',
    impl: { file: 'apps/api/src/modules/events/events.service.ts', method: 'remove' },
    boundary: '活动不存在 → **404**（删不到就报「不存在」，不假装删成功）',
    docTokens: ['404'],
  },

  /* --------------------------- 资讯与公告 --------------------------- */
  {
    method: 'PATCH',
    path: '/admin/articles/:id',
    controller: 'apps/api/src/modules/admin/admin.controller.ts',
    handler: 'updateArticle',
    impl: { file: 'apps/api/src/modules/content/content.service.ts', method: 'adminUpdateArticle' },
    boundary: '内容不存在 → **404**',
    docTokens: ['404'],
  },
  {
    method: 'DELETE',
    path: '/admin/articles/:id',
    controller: 'apps/api/src/modules/admin/admin.controller.ts',
    handler: 'deleteArticle',
    impl: { file: 'apps/api/src/modules/content/content.service.ts', method: 'adminDeleteArticle' },
    boundary: '内容不存在 → **404**',
    docTokens: ['404'],
  },
  {
    method: 'PATCH',
    path: '/admin/notices/:id',
    controller: 'apps/api/src/modules/admin/admin.controller.ts',
    handler: 'updateNotice',
    impl: { file: 'apps/api/src/modules/content/content.service.ts', method: 'adminUpdateNotice' },
    boundary: '公告不存在 → **404**',
    docTokens: ['404'],
  },
  {
    method: 'DELETE',
    path: '/admin/notices/:id',
    controller: 'apps/api/src/modules/admin/admin.controller.ts',
    handler: 'deleteNotice',
    impl: { file: 'apps/api/src/modules/content/content.service.ts', method: 'adminDeleteNotice' },
    boundary: '公告不存在 → **404**',
    docTokens: ['404'],
  },

  /* ---------------------------- 资讯分类 ---------------------------- */
  {
    method: 'PATCH',
    path: '/admin/articles/categories/:id',
    controller: 'apps/api/src/modules/admin/admin-users.controller.ts',
    handler: 'updateCategory',
    impl: { file: 'apps/api/src/modules/content/content.service.ts', method: 'updateCategory' },
    boundary: '分类不存在 → **404**',
    docTokens: ['404'],
  },
  {
    method: 'DELETE',
    path: '/admin/articles/categories/:id',
    controller: 'apps/api/src/modules/admin/admin-users.controller.ts',
    handler: 'deleteCategory',
    impl: { file: 'apps/api/src/modules/content/content.service.ts', method: 'deleteCategory' },
    boundary: '分类不存在 → **404**',
    docTokens: ['404'],
  },
];

/* ------------------------------ 工具 ------------------------------ */

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 列出仓库里全部控制器文件（相对路径）。 */
function listControllerFiles() {
  const dir = path.join(root(), 'apps/api/src');
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.controller.ts')) {
        found.push(path.relative(root(), full).split(path.sep).join('/'));
      }
    }
  };
  walk(dir);
  return found.sort();
}

/** 把控制器前缀与路由拼成对外路径（`/api/v1` 前缀不算在内）。 */
function joinPath(prefix, route) {
  const head = prefix ? `/${prefix}` : '';
  const tail = route ? `/${route}` : '';
  const joined = `${head}${tail}`;
  return joined === '' ? '/' : joined.replace(/\/+$/, '') || '/';
}

/**
 * 找出某个控制器文件里**全部**端点（`@Get` / `@Post` / `@Patch` / `@Put` / `@Delete`）。
 *
 * ⚠️ `@Public()` 与 `@Get(...)` 的**先后顺序不固定**：
 *    多数控制器是 `@Public()` 在前（`content.controller.ts`），
 *    `alumni.controller.ts` 却是 `@Get(':id')` 在前、`@Public()` 在后 ——
 *    只按一种顺序扫会**漏掉**一半公开读端点，R1 也就成了恒过的。
 *    所以这里把路由装饰器**上下**紧邻的装饰器块**一起**看。
 *
 * ⚠️ 处理器**名字**也要一起取出来：第十二轮起要靠它把端点
 *    解析到「它调用的服务方法」上（判断它到底会不会抛 403 / 404）。
 */
function findEndpoints(src) {
  const lines = src.split('\n');
  const classPublic = /@Public\(\)/.test(
    src.slice(0, src.indexOf('export class') > 0 ? src.indexOf('export class') : src.length),
  );
  const endpoints = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // ⚠️ 路径可以**省略**（`@Get()` = 控制器前缀本身，如 `GET /me`、`GET /connections`）——
    //    只认带引号的写法会漏掉这些端点，R6 / R1 就成了恒过的。
    const matched = /^\s*@(Get|Post|Patch|Put|Delete)\(\s*(?:'([^']*)')?\s*\)/.exec(line);
    if (!matched) continue;

    const decorators = [];
    for (let j = index - 1; j >= 0; j -= 1) {
      const text = lines[j].trim();
      if (text.startsWith('@')) decorators.unshift(text);
      else break;
    }
    for (let j = index + 1; j < lines.length; j += 1) {
      const text = lines[j].trim();
      if (text.startsWith('@')) decorators.push(text);
      else break;
    }
    const isPublic = classPublic || decorators.some((item) => item.startsWith('@Public'));

    // 处理器名字：路由装饰器之后的第一行「像方法签名」的行
    let cursor = index + 1;
    while (cursor < lines.length) {
      const text = lines[cursor].trim();
      if (text === '' || text.startsWith('@') || text.startsWith('//') || text.startsWith('*')) {
        cursor += 1;
        continue;
      }
      break;
    }
    const handler = /([A-Za-z_$][\w$]*)\s*\(/.exec(lines[cursor] ?? '');

    endpoints.push({
      method: matched[1].toUpperCase(),
      route: matched[2],
      line: index + 1,
      isPublic,
      handler: handler ? handler[1] : null,
    });
  }
  return endpoints;
}

/** 只要 `@Public()` 的 GET 端点（第十一轮口径）。 */
function findPublicGetEndpoints(src) {
  return findEndpoints(src)
    .filter((item) => item.isPublic && item.method === 'GET')
    .map((item) => ({ route: item.route, line: item.line }));
}

/** 控制器前缀（`@Controller('events')` → `events`；`@Controller()` → 空）。 */
function controllerPrefix(src) {
  const matched = /@Controller\(\s*(?:'([^']*)')?\s*\)/.exec(src);
  return matched && matched[1] ? matched[1] : '';
}

/**
 * 取某个方法体（含它**调用**的同类私有方法）。
 *
 * 形态 2 必须一起看：`listCategories` 自己不含 `'published'` 字样，
 * 真正做过滤的是它调用的 `publishedArticleCounts` ——
 * 只看调用方会把「明明有过滤」判成「没有过滤」。
 */
function collectMethods(src) {
  const methods = [];
  const re =
    /^\s{2}(?:(?:public|private|protected|static|async|readonly|override)\s+)*([A-Za-z_$][\w$]*)(?:<[^>]*>)?\s*\(/gm;
  let match;
  while ((match = re.exec(src)) !== null) {
    const name = match[1];
    if (['if', 'for', 'while', 'switch', 'catch', 'constructor', 'return'].includes(name)) continue;
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close < 0) continue;
    const brace = findBodyBrace(src, close);
    if (brace < 0) continue;
    let bodyDepth = 0;
    let end = -1;
    for (let j = brace; j < src.length; j += 1) {
      const ch = src[j];
      if (ch === '{') bodyDepth += 1;
      else if (ch === '}') {
        bodyDepth -= 1;
        if (bodyDepth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) continue;
    methods.push({ name, body: src.slice(brace, end + 1) });
    re.lastIndex = brace;
  }
  return methods;
}

/** 从参数表右括号往后找**方法体的起始 `{`**（跳过返回类型里的花括号）。 */
function findBodyBrace(src, close) {
  let angleDepth = 0;
  for (let i = close + 1; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '<') angleDepth += 1;
    else if (ch === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if (ch === '{' && angleDepth === 0) return i;
    else if (ch === ';' && angleDepth === 0) return -1;
  }
  return -1;
}

/** 方法体 + 它调用的同类方法体。 */
function effectiveBody(file, methodName) {
  const src = readTextSafe(path.join(root(), file));
  if (!src) return { ok: false, reason: `文件不存在：${file}` };
  const methods = collectMethods(src);
  const target = methods.find((method) => method.name === methodName);
  if (!target) return { ok: false, reason: `${file} 里找不到方法 ${methodName}` };
  let body = target.body;
  const used = new Set([target.name]);
  for (let round = 0; round < 3; round += 1) {
    for (const other of methods) {
      if (used.has(other.name)) continue;
      if (!new RegExp(`this\\.${other.name}\\s*\\(`).test(body)) continue;
      used.add(other.name);
      body += `\n${other.body}`;
    }
  }
  return { ok: true, where: `${file} · ${methodName}`, body };
}

/**
 * 列出某个目录下的**服务实现文件**（`.ts`，不含控制器与 DTO）。
 */
function listServiceFiles(dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.controller.ts')) {
        found.push(path.relative(root(), full).split(path.sep).join('/'));
      }
    }
  };
  walk(dir);
  return found.sort();
}

/**
 * 端点处理器 + 它调用到的**同模块**服务方法体。
 *
 * 用途：判断「这个端点到底会不会抛 403 / 404」——
 *   控制器只写 `return this.xxxService.doSomething(...)`，
 *   真正的 `throw new ForbiddenException(...)` 在**服务**里。
 *   不把服务方法一起看，就会把「会抛 403 的端点」判成「没有可见性分界」，
 *   R6 就成了恒过的。
 */
function endpointImplBodies(controllerFile, handlerName) {
  const controllerSrc = readTextSafe(path.join(root(), controllerFile));
  if (!controllerSrc) return { ok: false, reason: `文件不存在：${controllerFile}` };
  const methods = collectMethods(controllerSrc);
  const handler = methods.find((method) => method.name === handlerName);
  if (!handler) return { ok: false, reason: `${controllerFile} 里找不到方法 ${handlerName}` };

  const bodies = [{ where: `${controllerFile} · ${handlerName}`, body: handler.body }];
  const called = new Set(
    [...handler.body.matchAll(/this\.[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)\s*\(/g)].map(
      (match) => match[1],
    ),
  );
  if (!called.size) return { ok: true, bodies };

  const dir = path.dirname(path.join(root(), controllerFile));
  for (const file of listServiceFiles(dir)) {
    const src = readTextSafe(path.join(root(), file));
    if (!src) continue;
    for (const method of collectMethods(src)) {
      if (!called.has(method.name)) continue;
      bodies.push({ where: `${file} · ${method.name}`, body: method.body });
    }
  }
  return { ok: true, bodies };
}

/**
 * 控制器里**注入的服务**（属性名 → 服务文件）。
 *
 * ⚠️ 为什么不能按「方法名」满仓库找（第十二轮用户侧那套做法）：
 *    `detail` / `list` / `update` 这类方法名在**各个模块里都有**
 *    （`content.service.ts` 有 `detail`、`events.service.ts` 也有 `detail`），
 *    满仓库按名字找会把**别的模块**的方法体也算进来 ——
 *    于是「这个端点会不会抛 404」判错，报出一堆假缺口。
 *    管理端这一侧改用**注入点**解析：`this.eventsService.detail(...)`
 *    → 构造器里 `eventsService: EventsService` → `import { EventsService } from '../events/events.service'`
 *    → 文件路径 + 方法名，**精确到那一个方法**。
 *
 * @returns {Map<string, string>} 属性名 → 服务文件的仓库相对路径
 */
function injectedServiceFiles(controllerFile) {
  const src = readTextSafe(path.join(root(), controllerFile));
  const map = new Map();
  if (!src) return map;

  /** 类名 → 文件路径 */
  const classToFile = new Map();
  for (const match of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
    const names = match[1]
      .split(',')
      .map((entry) => entry.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    const target = match[2];
    if (!target.startsWith('.')) continue; // 只解析仓库内的相对导入
    for (const name of names) {
      const file = `${path
        .normalize(path.join(path.dirname(controllerFile), target))
        .split(path.sep)
        .join('/')}.ts`;
      classToFile.set(name, file);
    }
  }

  // 构造器：`private readonly eventsService: EventsService`
  const constructor = /constructor\(([\s\S]*?)\)\s*\{\s*\}/.exec(src);
  if (!constructor) return map;
  for (const match of constructor[1].matchAll(
    /private\s+readonly\s+([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/g,
  )) {
    const file = classToFile.get(match[2]);
    if (file) map.set(match[1], file);
  }
  return map;
}

/**
 * 管理端端点的**实现体**：控制器的方法（含它调用的同类私有方法）
 *   + 它调用到的**注入服务**的方法（含该服务文件里被它调用的方法）。
 *
 * 用途：判断「资源不存在时，这个端点到底返回什么」。
 */
function adminImplBodies(controllerFile, handlerName) {
  const own = effectiveBody(controllerFile, handlerName);
  if (!own.ok) return { ok: false, reason: own.reason };
  const bodies = [{ where: own.where, body: own.body }];

  const src = readTextSafe(path.join(root(), controllerFile));
  const methods = collectMethods(src);
  const handler = methods.find((method) => method.name === handlerName);
  if (!handler) return { ok: true, bodies };

  const services = injectedServiceFiles(controllerFile);
  const called = new Set(
    [...handler.body.matchAll(/this\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g)].map(
      (match) => `${match[1]}.${match[2]}`,
    ),
  );
  for (const call of called) {
    const [prop, method] = call.split('.');
    const file = services.get(prop);
    if (!file) continue;
    const service = effectiveBody(file, method);
    if (!service.ok) continue;
    bodies.push({ where: service.where, body: service.body });
  }
  return { ok: true, bodies };
}

/**
 * 取 `docs/API-SPEC.md` 里「读端点的可见性口径」小节的正文行。
 *
 * 取不到 = 口径没写 = 报错（宁可吵，也不要默默放过）。
 */
function visibilityDocLines() {
  const src = readTextSafe(path.join(root(), 'docs/API-SPEC.md'));
  if (!src) return null;
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const heading = /^(#{2,4})\s/.exec(line);
    if (!heading) continue;
    if (!line.includes('可见性')) continue;
    const level = heading[1].length;
    // ⚠️ 口径表放在**子小节**里（`### 13.1 逐个公开读端点`），
    //    只取到下一个**同级或更高级**的标题为止，否则表格会被漏掉 ——
    //    漏掉的后果是「文档里其实写了，检查器却报没写」。
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = /^(#{2,4})\s/.exec(lines[j]);
      if (next && next[1].length <= level) {
        end = j;
        break;
      }
    }
    return lines.slice(i, end);
  }
  return null;
}

/**
 * 取「读端点的可见性口径」小节里的**口径表行**。
 *
 * ⚠️ 必须按**单元格**判定，不能只按「这一行里出现过这个路径」：
 *    说明列里常出现「同 `/articles/:id`」这样的**引用**，
 *    只按子串匹配的话，删掉 `/articles/:id` 那一行之后，
 *    引用它的那一行仍会被当成「写过了」→ 校验器变成恒过的。
 *    所以这里只认「路径所在单元格**就是**这个路径」的行。
 */
function visibilityDocRows() {
  const lines = visibilityDocLines();
  if (!lines) return null;
  const rows = [];
  for (const line of lines) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 3) continue;
    if (/^-+$/.test(cells[1]) || /^-+$/.test(cells[2])) continue;
    const method = cells[1].replace(/[`*]/g, '').trim();
    const path = cells[2].replace(/[`*]/g, '').trim();
    if (!method || !path) continue;
    rows.push({ method, path, text: line });
  }
  return rows;
}

/** 取 `docs/KNOWN-ISSUES.md` 里某个编号的条目正文。 */
function knownIssueSection(number) {
  const src = readTextSafe(path.join(root(), 'docs/KNOWN-ISSUES.md'));
  if (!src) return null;
  const lines = src.split('\n');
  const headingRe = new RegExp(`^#{2,4}\\s*${number}\\.`);
  for (let i = 0; i < lines.length; i += 1) {
    if (!headingRe.test(lines[i])) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^#{2,4}\s/.test(lines[j])) {
        end = j;
        break;
      }
    }
    return lines.slice(i, end).join('\n');
  }
  return null;
}

/* ------------------------------ 主流程 ------------------------------ */

function main() {
  const issues = [];
  const notes = [];

  /* --- 发现端：全部 `@Public()` 的 GET 端点 ------------------------------ */
  const discovered = [];
  for (const file of listControllerFiles()) {
    const src = readTextSafe(path.join(root(), file));
    if (!src) continue;
    const prefix = controllerPrefix(src);
    for (const endpoint of findPublicGetEndpoints(src)) {
      discovered.push({
        method: 'GET',
        path: joinPath(prefix, endpoint.route),
        file,
        line: endpoint.line,
      });
    }
  }
  const registryKeys = new Set(
    READ_VISIBILITY_REGISTRY.map((item) => `${item.method} ${item.path}`),
  );

  /* --- R1：每个公开读端点都必须登记 ------------------------------------- */
  for (const item of discovered) {
    const key = `${item.method} ${item.path}`;
    if (registryKeys.has(key)) continue;
    issues.push({
      kind: 'READ_VISIBILITY_NOT_REGISTERED',
      where: key,
      detail:
        `这是一个**公开读端点**（${item.file}:${item.line}），但可见性口径没有登记 —— ` +
        '「不可见的对象返回什么」必须先想清楚（404 还是 403），再上线',
    });
  }

  /* --- R5：登记了的端点必须还在（端点被删 / 改名 / 换了控制器） ------------ */
  for (const entry of READ_VISIBILITY_REGISTRY) {
    const key = `${entry.method} ${entry.path}`;
    const found = discovered.find((item) => `${item.method} ${item.path}` === key);
    if (!found) {
      issues.push({
        kind: 'READ_VISIBILITY_ROUTE_MISSING',
        where: key,
        detail:
          `登记表里的公开读端点 ${key} 在代码里**找不到了** —— ` +
          '要么端点被删 / 改名（登记表该更新），要么它不再是公开的（口径该重判）',
      });
      continue;
    }
    if (entry.controller && found.file !== entry.controller) {
      issues.push({
        kind: 'READ_VISIBILITY_CONTROLLER_MISMATCH',
        where: key,
        detail:
          `登记表说它在 \`${entry.controller}\` 的 ${entry.handler} 里，` +
          `实际却在 \`${found.file}\`（第 ${found.line} 行）—— ` +
          '端点被挪了位置，登记表该跟着更新（否则「口径挂在哪个处理器上」就说不清了）',
      });
    }
  }

  /* --- R2 / R3：口径落地 + 文档 ----------------------------------------- */
  const docLines = visibilityDocLines();
  const docRows = visibilityDocRows();
  if (!docLines) {
    issues.push({
      kind: 'READ_VISIBILITY_SECTION_MISSING',
      where: 'docs/API-SPEC.md',
      detail:
        'API-SPEC 里找不到「读端点的可见性口径」小节 —— ' +
        '哪些端点「不可见 → 404」、哪些「无权 → 403」必须写进对外契约',
    });
  }

  for (const entry of READ_VISIBILITY_REGISTRY) {
    const key = `${entry.method} ${entry.path}`;

    // R2：可见性过滤痕迹
    const impl = effectiveBody(entry.impl.file, entry.impl.method);
    if (!impl.ok) {
      issues.push({
        kind: 'READ_VISIBILITY_IMPL_MISSING',
        where: key,
        detail: `${impl.reason} —— 可见性口径无处核对`,
      });
    } else {
      const missing = (entry.filterMarkers ?? []).filter(
        (marker) => !impl.body.includes(marker),
      );
      if (missing.length) {
        issues.push({
          kind: 'READ_VISIBILITY_FILTER_MISSING',
          where: key,
          detail:
            `${impl.where} 里看不到可见性过滤的痕迹（缺 ${missing.join(' / ')}）—— ` +
            `${entry.rule}。删掉过滤 = 未发布 / 未审核的内容**凭 id 就能公开读到**`,
        });
      }
      const missingStatus = (entry.statusMarkers ?? []).filter(
        (marker) => !impl.body.includes(marker),
      );
      if (missingStatus.length) {
        issues.push({
          kind: 'READ_VISIBILITY_STATUS_MISMATCH',
          where: key,
          detail:
            `${impl.where} 里没有 ${missingStatus.join(' / ')} —— ` +
            `不可见的对象必须落到 **404**（用 403 会通过状态码泄露「这个对象存在」）。${entry.rule}`,
        });
      }
      // R5：待拍板项 —— 实现里一旦出现可见性过滤，说明行为已被改掉
      if (entry.pending) {
        const settled = (entry.pendingFilterMarkers ?? []).some((marker) =>
          impl.body.includes(marker),
        );
        if (settled) {
          issues.push({
            kind: 'READ_VISIBILITY_REGISTRY_STALE',
            where: key,
            detail:
              `该端点的口径此前**待拍板**（KNOWN-ISSUES #${entry.pending}），` +
              '但实现里**已经出现**了可见性过滤 —— 对外行为被改掉了：' +
              '要么是产品已拍板（请更新登记表与 API-SPEC，并把 KNOWN-ISSUES 的条目结掉），' +
              '要么是有人擅自改了行为（请改回去）',
          });
        }
      }
    }

    // R3：文档
    if (docRows) {
      const rows = docRows.filter(
        (row) => row.method === entry.method && row.path === entry.path,
      );
      if (!rows.length) {
        issues.push({
          kind: 'READ_VISIBILITY_UNDOCUMENTED',
          where: key,
          detail:
            `「读端点的可见性口径」小节里没有点名 ${key} —— ` +
            '对外契约不能只存在于代码里',
        });
      } else {
        const union = rows.map((row) => row.text).join('\n');
        if (!union.includes(entry.docToken)) {
          issues.push({
            kind: 'READ_VISIBILITY_UNDOCUMENTED',
            where: key,
            detail:
              `文档里没有写明「${entry.docToken}」：${rows.map((row) => row.trim()).join(' / ')}`,
          });
        } else {
          notes.push({
            kind: 'READ_VISIBILITY_OK',
            where: key,
            detail: `${entry.visibility}：${entry.rule}`,
          });
        }
      }
    }

    // R4：待拍板项必须在 KNOWN-ISSUES 里仍然记着
    if (entry.pending) {
      const section = knownIssueSection(entry.pending);
      if (!section) {
        issues.push({
          kind: 'READ_VISIBILITY_KNOWN_ISSUE_MISSING',
          where: key,
          detail:
            `KNOWN-ISSUES 里找不到 #${entry.pending} —— ` +
            '「口径待拍板」这件事必须仍然记着，否则这个端点的口径就没人管了',
        });
      } else if (!section.includes(entry.path)) {
        issues.push({
          kind: 'READ_VISIBILITY_KNOWN_ISSUE_MISSING',
          where: key,
          detail:
            `KNOWN-ISSUES 的 #${entry.pending} 里没有点名 ${entry.path} —— ` +
            '待拍板的条目必须指向具体的端点',
        });
      }
    }
  }

  /* --- R6 / R7 / R8：已登录端点的 403 / 404 分界（第十二轮新增） ----------- */
  //
  // 公开端点这一半（第十一轮）核的是「不可见 → 404」；
  // 这一轮把**已登录**端点这一半也核起来：
  //   R6 **覆盖**：范围内（用户侧）的已登录端点，凡是会抛 403 / 404 的，
  //      都必须登记它的分界口径 —— 口径没人想过 = 漏登记 → 报错；
  //   R7 **落地**：登记项写明的状态码痕迹必须真的出现在实现里；
  //   R8 **文档**：`docs/API-SPEC.md` 第 13.3 节必须逐条点名。
  const authenticatedRegistryKeys = new Set(
    AUTHENTICATED_VISIBILITY_REGISTRY.map((entry) => `${entry.method} ${entry.path}`),
  );
  const inScope = (pathname) =>
    AUTHENTICATED_SCOPE_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );

  const allEndpoints = [];
  for (const file of listControllerFiles()) {
    const src = readTextSafe(path.join(root(), file));
    if (!src) continue;
    const prefix = controllerPrefix(src);
    for (const endpoint of findEndpoints(src)) {
      allEndpoints.push({
        method: endpoint.method,
        path: joinPath(prefix, endpoint.route),
        file,
        line: endpoint.line,
        handler: endpoint.handler,
        isPublic: endpoint.isPublic,
      });
    }
  }

  // R6：范围内、已登录、会抛 403/404 的端点必须登记
  for (const item of allEndpoints) {
    if (item.isPublic) continue;
    if (!inScope(item.path)) continue;
    const key = `${item.method} ${item.path}`;
    if (authenticatedRegistryKeys.has(key)) continue;
    if (!item.handler) continue;
    const impl = endpointImplBodies(item.file, item.handler);
    if (!impl.ok) continue; // 解析不了就不判（宁可漏报，也不要误报）
    const forbidden = impl.bodies.some((item2) => item2.body.includes('ForbiddenException'));
    const notFound = impl.bodies.some((item2) => item2.body.includes('NotFoundException'));
    if (!forbidden && !notFound) {
      notes.push({
        kind: 'AUTH_VISIBILITY_NO_BOUNDARY',
        where: key,
        detail: '该端点只返回当前用户自己的数据，不抛 403 / 404 —— 无可见性分界，无需登记',
      });
      continue;
    }
    issues.push({
      kind: 'AUTH_VISIBILITY_NOT_REGISTERED',
      where: key,
      detail:
        `这是一个**已登录端点**（${item.file}:${item.line}），它的实现里` +
        `${forbidden ? '会抛 403' : ''}${forbidden && notFound ? '、' : ''}${notFound ? '会抛 404' : ''}` +
        '，但**可见性分界没有登记** —— ' +
        '「对象存在但不是你的 → 403」与「对象不存在 / 对你不可见 → 404」必须先想清楚再上线',
    });
  }

  // R7 / R8：登记项的口径必须落地、必须写进文档
  for (const entry of AUTHENTICATED_VISIBILITY_REGISTRY) {
    const key = `${entry.method} ${entry.path}`;
    const found = allEndpoints.find(
      (item) => item.method === entry.method && item.path === entry.path && !item.isPublic,
    );
    if (!found) {
      issues.push({
        kind: 'AUTH_VISIBILITY_ROUTE_MISSING',
        where: key,
        detail:
          `登记表里的已登录端点 ${key} 在代码里**找不到了** —— ` +
          '要么端点被删 / 改名（登记表该更新），要么它不再需要可见性分界',
      });
      continue;
    }
    if (entry.controller && found.file !== entry.controller) {
      issues.push({
        kind: 'AUTH_VISIBILITY_CONTROLLER_MISMATCH',
        where: key,
        detail:
          `登记表说它在 \`${entry.controller}\`，实际却在 \`${found.file}\`（第 ${found.line} 行）—— ` +
          '端点被挪了位置，登记表该跟着更新',
      });
    }

    const impl = effectiveBody(entry.impl.file, entry.impl.method);
    if (!impl.ok) {
      issues.push({
        kind: 'AUTH_VISIBILITY_IMPL_MISSING',
        where: key,
        detail: `${impl.reason} —— 可见性分界无处核对`,
      });
      continue;
    }
    const missingNotFound = (entry.notFoundMarkers ?? []).filter(
      (marker) => !impl.body.includes(marker),
    );
    if (missingNotFound.length) {
      issues.push({
        kind: 'AUTH_VISIBILITY_STATUS_MISSING',
        where: key,
        detail:
          `${impl.where} 里没有 ${missingNotFound.join(' / ')} —— ` +
          `「不可见」必须落到 **404**（用 403 会泄露「这个对象存在」）。${entry.boundary}`,
      });
    }
    const missingForbidden = (entry.forbiddenMarkers ?? []).filter(
      (marker) => !impl.body.includes(marker),
    );
    if (missingForbidden.length) {
      issues.push({
        kind: 'AUTH_VISIBILITY_STATUS_MISSING',
        where: key,
        detail:
          `${impl.where} 里没有 ${missingForbidden.join(' / ')} —— ` +
          `「已登录但无权」必须落到 **403**（用 404 会把「对象存在」也一起藏掉，` +
          `客户端就分不清「没有这个对象」和「不是你的」）。${entry.boundary}`,
      });
    }
    if (entry.controllerMarkers?.length) {
      const controllerSrc = readTextSafe(path.join(root(), entry.controller)) ?? '';
      const missingGuards = entry.controllerMarkers.filter(
        (marker) => !controllerSrc.includes(marker),
      );
      if (missingGuards.length) {
        issues.push({
          kind: 'AUTH_VISIBILITY_GUARD_MISSING',
          where: key,
          detail:
            `\`${entry.controller}\` 上看不到 ${missingGuards.join(' / ')} —— ` +
            '「未完成校友认证 → 403 `VERIFICATION_REQUIRED`」这条守卫不能被摘掉' +
            '（摘掉之后未认证用户会用得到未认证才能用的功能）',
        });
      }
    }

    // R8：文档
    if (docRows) {
      const rows = docRows.filter((row) => row.method === entry.method && row.path === entry.path);
      if (!rows.length) {
        issues.push({
          kind: 'AUTH_VISIBILITY_UNDOCUMENTED',
          where: key,
          detail:
            `「读端点的可见性口径」小节里没有点名 ${key} —— ` +
            '对外契约不能只存在于代码里（客户端要靠它分清 403 与 404）',
        });
      } else {
        const union = rows.map((row) => row.text).join('\n');
        const missingTokens = (entry.docTokens ?? []).filter((token) => !union.includes(token));
        if (missingTokens.length) {
          issues.push({
            kind: 'AUTH_VISIBILITY_UNDOCUMENTED',
            where: key,
            detail:
              `文档里没有写明「${missingTokens.join(' / ')}」：${rows.map((row) => row.trim()).join(' / ')}`,
          });
        } else {
          notes.push({
            kind: 'AUTH_VISIBILITY_OK',
            where: key,
            detail: entry.boundary,
          });
        }
      }
    }
  }

  /* --- R9 / R10 / R11 / R12：管理端端点的 404 分界（第十三轮新增） ----------- */
  //
  // 第十二轮只核了**用户侧**的已登录端点；管理端这一侧此前**从未被核过**。
  // 管理端的两种失败语义分属两张表：
  //   「权限点不足 → 403」= 端点 ↔ 权限点 → `check-rbac-matrix.mjs` 守着；
  //   「资源不存在 → 404」= 端点 ↔ 资源   → **本表**守着。
  // R12 断言两张表**没有登记同一个端点**（避免重复登记 = 两处都要跟着改）。
  const adminRegistryKeys = new Set(
    ADMIN_VISIBILITY_REGISTRY.map((entry) => `${entry.method} ${entry.path}`),
  );

  // R12：同一个端点不许在两张表里各登记一次
  for (const entry of AUTHENTICATED_VISIBILITY_REGISTRY) {
    const key = `${entry.method} ${entry.path}`;
    if (!adminRegistryKeys.has(key)) continue;
    issues.push({
      kind: 'ADMIN_VISIBILITY_DUPLICATE',
      where: key,
      detail:
        `这个端点同时登记在「用户侧表」与「管理端表」里 —— ` +
        '两张表各管一段（用户侧管「无权 → 403 / 不可见 → 404」，管理端管「资源不存在 → 404」），' +
        '同一个端点只该出现在其中一张表里，否则改口径时要改两处、漏一处就分叉',
    });
  }
  for (const [name, registry] of [
    ['用户侧表', AUTHENTICATED_VISIBILITY_REGISTRY],
    ['管理端表', ADMIN_VISIBILITY_REGISTRY],
  ]) {
    const seen = new Set();
    for (const entry of registry) {
      const key = `${entry.method} ${entry.path}`;
      if (seen.has(key)) {
        issues.push({
          kind: 'ADMIN_VISIBILITY_DUPLICATE',
          where: key,
          detail: `${name}里同一个端点登记了两次`,
        });
      }
      seen.add(key);
    }
  }

  // R9：管理端端点凡是会抛 404（资源不存在）的，都必须登记分界
  for (const item of allEndpoints) {
    if (item.isPublic) continue;
    if (!item.path.startsWith('/admin')) continue;
    const key = `${item.method} ${item.path}`;
    if (adminRegistryKeys.has(key)) continue;
    if (!item.handler) continue;
    const impl = adminImplBodies(item.file, item.handler);
    if (!impl.ok) continue; // 解析不了就不判（宁可漏报，也不要误报）
    const notFound = impl.bodies.some((body) => body.body.includes('NotFoundException'));
    if (!notFound) {
      notes.push({
        kind: 'ADMIN_VISIBILITY_NO_BOUNDARY',
        where: key,
        detail: '该端点的实现里不抛 404（要么只返回列表，要么资源不存在也不报错）—— 无「资源不存在」分界',
      });
      continue;
    }
    issues.push({
      kind: 'ADMIN_VISIBILITY_NOT_REGISTERED',
      where: key,
      detail:
        `这是一个**管理端端点**（${item.file}:${item.line}），它的实现里会抛 **404**` +
        `（${impl.bodies
          .filter((body) => body.body.includes('NotFoundException'))
          .map((body) => body.where)
          .join('、')}），但**「资源不存在 → 404」的分界没有登记** —— ` +
        '「资源不存在」与「权限点不足（403）」必须分清：' +
        '前者是「这个 id 没有对应的行」，后者是「有，但你没权限管」',
    });
  }

  // R10 / R11：登记项必须落地、必须写进文档
  for (const entry of ADMIN_VISIBILITY_REGISTRY) {
    const key = `${entry.method} ${entry.path}`;
    const found = allEndpoints.find(
      (item) => item.method === entry.method && item.path === entry.path && !item.isPublic,
    );
    if (!found) {
      issues.push({
        kind: 'ADMIN_VISIBILITY_ROUTE_MISSING',
        where: key,
        detail:
          `登记表里的管理端端点 ${key} 在代码里**找不到了** —— ` +
          '要么端点被删 / 改名（登记表该更新），要么它不再需要「资源不存在 → 404」的分界',
      });
      continue;
    }
    if (entry.controller && found.file !== entry.controller) {
      issues.push({
        kind: 'ADMIN_VISIBILITY_CONTROLLER_MISMATCH',
        where: key,
        detail:
          `登记表说它在 \`${entry.controller}\`，实际却在 \`${found.file}\`（第 ${found.line} 行）—— ` +
          '端点被挪了位置，登记表该跟着更新',
      });
    }

    const impl = effectiveBody(entry.impl.file, entry.impl.method);
    if (!impl.ok) {
      issues.push({
        kind: 'ADMIN_VISIBILITY_IMPL_MISSING',
        where: key,
        detail: `${impl.reason} —— 「资源不存在 → 404」无处核对`,
      });
      continue;
    }
    if (!impl.body.includes('NotFoundException')) {
      issues.push({
        kind: 'ADMIN_VISIBILITY_STATUS_MISSING',
        where: key,
        detail:
          `${impl.where} 里**没有** \`NotFoundException\` —— ` +
          '「资源不存在」必须落到 **404**（返回 200 等于假装删成功；' +
          '让数据库异常冒泡成 500 则会被管理后台当成「服务端故障」）。' +
          entry.boundary,
      });
    }

    // R11：文档
    if (docRows) {
      const rows = docRows.filter((row) => row.method === entry.method && row.path === entry.path);
      if (!rows.length) {
        issues.push({
          kind: 'ADMIN_VISIBILITY_UNDOCUMENTED',
          where: key,
          detail:
            `「读端点的可见性口径」小节里没有点名 ${key} —— ` +
            '管理后台要靠它分清「资源不存在（404）」与「权限点不足（403）」',
        });
      } else {
        const union = rows.map((row) => row.text).join('\n');
        const missingTokens = (entry.docTokens ?? []).filter((token) => !union.includes(token));
        if (missingTokens.length) {
          issues.push({
            kind: 'ADMIN_VISIBILITY_UNDOCUMENTED',
            where: key,
            detail:
              `文档里没有写明「${missingTokens.join(' / ')}」：${rows.map((row) => row.trim()).join(' / ')}`,
          });
        } else {
          notes.push({
            kind: 'ADMIN_VISIBILITY_OK',
            where: key,
            detail: entry.boundary,
          });
        }
      }
    }
  }

  const report = {
    publicReadEndpoints: discovered.length,
    registered: READ_VISIBILITY_REGISTRY.length,
    pending: READ_VISIBILITY_REGISTRY.filter((entry) => entry.pending).length,
    authenticatedRegistered: AUTHENTICATED_VISIBILITY_REGISTRY.length,
    adminRegistered: ADMIN_VISIBILITY_REGISTRY.length,
    issues: issues.length,
    notes: notes.length,
    detail: issues,
    notesDetail: notes,
  };

  if (AS_JSON) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const note of notes) {
      process.stdout.write(`  [提示] ${note.where}：${note.detail}\n`);
    }
    if (issues.length === 0) {
      process.stdout.write(
        `✅ 读端点的可见性口径对账通过：` +
          `${report.publicReadEndpoints} 个公开读端点全部登记了可见口径，` +
          `每个都能在实现里看到对应的过滤与状态码，文档也逐条写明` +
          `（其中 ${report.pending} 个口径**待产品拍板**，已记在 KNOWN-ISSUES）；` +
          `另有 ${report.authenticatedRegistered} 个**已登录端点**登记了 403 / 404 的分界，` +
          `实现与文档同样逐条对齐；` +
          `管理端另有 ${report.adminRegistered} 个端点登记了「资源不存在 → 404」的分界` +
          `（「权限点不足 → 403」那一半由 check-rbac-matrix.mjs 守着，两张表不重复登记）\n`,
      );
    } else {
      for (const issue of issues) {
        process.stdout.write(`❌ [${issue.kind}] ${issue.where}\n     ${issue.detail}\n`);
      }
      process.stdout.write(`\n❌ 发现 ${issues.length} 处可见性口径不一致\n`);
    }
  }

  process.exit(issues.length > 0 ? 1 : 0);
}

main();
