#!/usr/bin/env node
/**
 * 写操作的**错误语义**对账（唯一键登记表 ↔ 实现 ↔ 文档）。
 *
 * 背景：
 *   客户端是按业务 `code` 分支处理失败的（`docs/API-SPEC.md` 通用约定）：
 *     400 `VALIDATION_ERROR`（参数写错了）
 *     404 `NOT_FOUND`（对象不存在）
 *     409 `CONFLICT`（撞键 / 业务状态冲突）
 *   一旦某个失败形态返回 **500 `INTERNAL_ERROR`**，客户端就会把它当成
 *   「服务端故障」—— 运维去查服务健康度，用户去刷新页面 ——
 *   而真实原因可能只是「你填的 slug 重复了」「你已经报名过了」。
 *
 *   缺陷 #190 就是这样暴露的：`article_categories.slug` 上有唯一索引，
 *   重复写入时数据库抛 `ER_DUP_ENTRY`，此前**直接冒泡**成 500。
 *   （`admin_users.username` 早已修好，见缺陷 #112。）
 *
 *   第九轮把同一套口径**扩到用户侧写端点**：连接申请、联系方式授权、
 *   活动报名、资源附件、认证附件、用户 openid / unionid、会话 refreshToken
 *   …… 这些唯一键此前**逐条都没核过**「撞了返回什么」。
 *
 * 本脚本对账五件事：
 *   1) **唯一键登记表是唯一事实来源**（R1 / R2）：
 *      扫**全部实体文件**，把每个唯一键（单列唯一、复合唯一、主键自然键）
 *      都算出来；登记表里**必须**有一条写清「撞键时返回什么、在哪处置」。
 *      实体里多了一个唯一键却没登记 → 报错
 *      （新唯一键上线时必须先想清楚「撞了返回什么」）。
 *   2) **冲突处置真的存在**（R3）：
 *      登记表里写的处置痕迹必须**确实**出现在代码里 ——
 *      把那段捕获删掉（也就是把缺陷 #190 重新犯一遍），这里必须抓到。
 *   3) **口径写进了文档**（R4）：
 *      每个登记条目对应的端点都必须在 `docs/API-SPEC.md` 的「错误语义」小节里
 *      被点名并给出对应的状态码 —— 代码改了、文档没改，等于对外契约悄悄变了。
 *   4) **迁移层真的有那道防线**（R5，第十轮新增）：
 *      生产库 `synchronize: false`，跑的是 `apps/api/src/database/migrations/*`，
 *      **真正约束数据的是迁移，不是实体声明**。
 *      所以把迁移里**真正创建的**唯一索引（`uk_*` 与复合主键）抽出来，
 *      与实体声明、登记表**三方对账**：
 *        - 实体/登记表声明了、迁移里**没有** → 报 `MIGRATION_UNIQUE_MISSING`
 *          （生产库根本没有那道防线：撞键不会报错，会**静默写出重复行**）；
 *        - 迁移里建了、实体**没声明** → 报 `MIGRATION_UNIQUE_NOT_DECLARED`
 *          （库比实体多一道约束，写入会被库挡下而代码没准备）；
 *        - 列集合不一致（少了列 → 覆盖不足；多了列 → 比实体更严） → 报
 *          `MIGRATION_UNIQUE_COLUMN_MISMATCH`；
 *        - 唯一键列的**长度 / 可空性**与迁移不一致 → 报
 *          `MIGRATION_UNIQUE_COLUMN_DEF_MISMATCH`
 *          （长度被截短会让两把不同的钥匙被判成同一把）。
 *      ⚠️ 「主键等价」不算缺陷：`admin_user_roles` / `role_permissions` 这类
 *         关联表由**复合主键**提供唯一性，迁移里不必再建一条同列的唯一索引
 *         （那是重复约束 + 写放大）。
 *   5) **反向验证**（`check-error-semantics-selftest.sh`）：
 *      本脚本自己也被反向验证过 —— 各类「语义失配」缺陷都必须被抓出、退出码非 0。
 *
 * 第十二轮把「迁移层对账」（R5）从**唯一键**扩到「**实体 ↔ 迁移**」的完整三层：
 *   R7 **全部索引**（含非唯一 `idx_*`）：实体声明了、迁移里没建 → 报；
 *      迁移里建了、实体没声明 → **也报**（库比实体多一道索引）；
 *      索引的**列集合**或**唯一性**对不上 → 报。
 *      ⚠️ 「主键等价」不算缺陷：唯一索引的列就是主键时，主键天然唯一，
 *         不必再建一条同列的唯一索引（重复约束 = 写放大）。
 *   R8 **外键**：实体的 `@ManyToOne` / `@OneToOne` + `@JoinColumn`
 *      ↔ 迁移里的 `FOREIGN KEY`；缺一边 → 报；**指向**（目标表 / 目标列）不一致 → 报。
 *      ⚠️ `ON DELETE` 行为**不判**（CASCADE / SET NULL / RESTRICT 不在口径里）。
 *   R9 **全部列的定义**：类型 / 长度 / 可空性，逐列与迁移对账；
 *      实体有迁移没有的列、迁移有实体没有的列 → 都报。
 *      ⚠️ 枚举**取值**、精度、`unsigned`、默认值一律**不判**
 *         （那些要么查不到、要么判了会动到业务语义）。
 *
 * ⚠️ 这一层**必须解析得准**，否则会凭空报出「假缺口」（门禁假红比不做更糟）：
 *    类级 `@Index` 的**类归属**、**属性名 → 列名**映射、关系列的列名来自
 *    `@JoinColumn` —— 三处只要错一处，就会报出一堆并不存在的缺口。
 *
 * ⚠️ **第十三轮的误报率抽查**（故意在实体里加一个「合法但迁移未建」的索引）：
 *    校验器**只**报出这一条、其余逐条仍对齐 → 没有假红。
 *    抽查中查出并修掉 1 处**解析缺陷**：索引建在**关系属性**上时
 *    （`@Index('idx_x', ['region'])`，真实列名取自 `@JoinColumn` 的 `region_code`），
 *    列名曾退回「属性名小写」→ 报成 `region`，照着它补迁移会建出一个**不存在的列**。
 *    现在关系属性的列名一律取自 `@JoinColumn`（与 R8 外键对账同一份解析）。
 *    **口径未放宽**：R7 / R8 / R9 的判定条件一字未改，只把「解析得更准」。
 *
 * ⚠️ 口径与判定的局限（写在这里，免得被当成万能护栏）：
 *   - 判定是**静态**的：只看源码里有没有「捕获重复键 + 转成可预期错误码」的形态，
 *     不执行代码，也不连数据库；真值由集成测试
 *     （`apps/api/test/integration/admin-write-error-semantics.e2e-spec.ts`
 *      与 `apps/api/test/integration/user-write-error-semantics.e2e-spec.ts`）守着。
 *   - 「处置痕迹」是**字符串**判定：登记表里写明的痕迹必须出现在处置代码里，
 *     写错名字（改了代码里的函数名却没改登记表）会被当成不一致 —— 这是**故意的**：
 *     宁可吵，也不要让「登记表与实现分叉」悄悄发生。
 *
 * 用法：
 *   node infra/scripts/check-error-semantics.mjs [--root <repo>] [--json] [--list]
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
const LIST_ONLY = args.includes('--list');

/**
 * 仓库根目录（**惰性**求值）。
 *
 * ⚠️ 为什么要惰性：本文件会被别的脚本 `import`（`check-unique-index-db.mjs`
 *    要拿同一份唯一键登记表与同一套迁移解析），而 `--root` 是从
 *    `process.argv` 里读的 —— 模块加载时求值会让「导入方自己解析的
 *    `--root`」失效（导入方与被导入方各算各的根目录）。
 *    惰性求值之后，两边读到的是**同一个**根目录。
 */
function root() {
  return path.resolve(argValue('--root', process.cwd()));
}

/* ------------------------------ 处置口径 ------------------------------ */

/**
 * 每种**处置**对应的「代码里必须出现的痕迹」与「文档里必须出现的口径」。
 *
 * - `CONFLICT`   撞键 → 409 `CONFLICT`（客户端可据此提示「重复了」）
 * - `IDEMPOTENT` 撞键 → 幂等命中（返回既有对象 / 更新既有行），**不是**错误
 * - `RETRY`      撞键 → 重跑整个事务（并发「先查后插」的兜底）；重试耗尽 → 409
 * - `OR_IGNORE`  撞键 → 由数据库的 `INSERT IGNORE` 吸收，随后读回既有行（幂等）
 * - `REPLACE`    该唯一键**先删后插**，同一事务内不可能撞键
 * - `SEEDED`     该唯一键**没有用户可触发的写端点**（只由种子 / 迁移写入）
 *
 * ⚠️ `markers` / `catchMarkers` 是**组**（数组的数组）：
 *    一组里**任一**成员出现即算满足，全部组都满足才算齐备。
 *    「任一」很重要：同一个处置有多种写法（`idempotent: true` /
 *    `const existing = ...` / `concurrent.allow = ...`），
 *    把它们写成「必须全都出现」会把正确实现判成不一致。
 */
const DUPLICATE_KEY_MARKERS = ['isDuplicateKeyError', 'ER_DUP_ENTRY', '1062', 'QueryFailedError'];

const DISPOSITIONS = {
  CONFLICT: {
    markers: [DUPLICATE_KEY_MARKERS, ['ConflictException']],
    catchMarkers: [['ConflictException']],
    docTokens: ['409', 'CONFLICT'],
  },
  IDEMPOTENT: {
    markers: [DUPLICATE_KEY_MARKERS, ['idempotent', 'existing', 'concurrent']],
    catchMarkers: [['idempotent', 'existing', 'concurrent']],
    docTokens: ['幂等'],
  },
  RETRY: {
    markers: [DUPLICATE_KEY_MARKERS, ['withDuplicateKeyRetry']],
    catchMarkers: [['ConflictException']],
    docTokens: ['409', 'CONFLICT'],
  },
  OR_IGNORE: {
    markers: [['orIgnore']],
    catchMarkers: [],
    docTokens: ['幂等'],
  },
  REPLACE: {
    markers: [['delete']],
    catchMarkers: [],
    docTokens: ['先删后插'],
  },
  SEEDED: {
    markers: [],
    catchMarkers: [],
    docTokens: [],
  },
};

/** 组是否被满足（组里任一成员出现即算满足）。 */
function groupsSatisfied(text, groups) {
  const missing = groups
    .filter((group) => !group.some((member) => text.includes(member)))
    .map((group) => group.join(' / '));
  return { ok: missing.length === 0, missing };
}

/* ------------------------------ 登记表 ------------------------------ */

/**
 * **唯一键登记表** —— 「已对账」的唯一事实来源。
 *
 * 每条必须写清：撞键时**返回什么**（disposition）、**在哪**做这件事（guards）。
 * 缺一条就等于「这个唯一键撞了会怎样」没人想过 ——
 * 那正是缺陷 #190 的土壤（唯一索引在、语义没人管）。
 *
 * ⚠️ `columns` 写的是**数据库列名**（不是属性名），
 *    复合唯一键按**字典序**排列（`(a,b)` 与 `(b,a)` 是同一把钥匙）。
 */
const UNIQUE_KEY_REGISTRY = [
  /* --------------------------- 管理端 --------------------------- */
  {
    side: 'admin',
    entity: 'admin_users',
    entityClass: 'AdminUser',
    entityFile: 'apps/api/src/database/entities/admin.entity.ts',
    columns: ['username'],
    endpoints: [{ method: 'POST', path: '/admin/users' }],
    guards: [{ file: 'apps/api/src/modules/admin/admin-users.controller.ts', method: 'createAdmin' }],
    disposition: 'CONFLICT',
    note: '登录名重复 → 409 `CONFLICT`（缺陷 #112）',
  },
  {
    side: 'admin',
    entity: 'roles',
    entityClass: 'Role',
    entityFile: 'apps/api/src/database/entities/admin.entity.ts',
    columns: ['code'],
    disposition: 'SEEDED',
    note: '角色编码没有写端点（只由种子写入）→ 用户无法触发撞键',
  },
  {
    side: 'admin',
    entity: 'permissions',
    entityClass: 'Permission',
    entityFile: 'apps/api/src/database/entities/admin.entity.ts',
    columns: ['code'],
    disposition: 'SEEDED',
    note: '权限点编码没有写端点（只由种子写入）→ 用户无法触发撞键',
  },
  {
    side: 'admin',
    entity: 'admin_user_roles',
    entityClass: 'AdminUserRole',
    entityFile: 'apps/api/src/database/entities/admin.entity.ts',
    columns: ['admin_user_id', 'role_id'],
    guards: [{ file: 'apps/api/src/modules/admin/admin-users.controller.ts', method: 'syncRoles' }],
    disposition: 'REPLACE',
    markers: [['delete']],
    note: '管理员角色的绑定关系**先删后插**（同一事务内），撞键不可能发生',
  },
  {
    side: 'admin',
    entity: 'role_permissions',
    entityClass: 'RolePermission',
    entityFile: 'apps/api/src/database/entities/admin.entity.ts',
    columns: ['permission_id', 'role_id'],
    disposition: 'SEEDED',
    note: '角色与权限点的对应关系没有写端点（只由种子写入）',
  },
  {
    side: 'admin',
    entity: 'article_categories',
    entityClass: 'ArticleCategory',
    entityFile: 'apps/api/src/database/entities/content.entity.ts',
    columns: ['slug'],
    endpoints: [
      { method: 'POST', path: '/admin/articles/categories' },
      { method: 'PATCH', path: '/admin/articles/categories/:id' },
    ],
    guards: [{ file: 'apps/api/src/modules/content/content.service.ts', method: 'createCategory' }],
    extraGuards: [{ file: 'apps/api/src/modules/content/content.service.ts', method: 'updateCategory' }],
    disposition: 'CONFLICT',
    note: '分类 slug 重复 → 409 `CONFLICT`（缺陷 #190）',
  },
  {
    side: 'admin',
    entity: 'system_settings',
    entityClass: 'SystemSetting',
    entityFile: 'apps/api/src/database/entities/system.entity.ts',
    columns: ['key'],
    endpoints: [{ method: 'PUT', path: '/admin/settings' }],
    guards: [
      { file: 'apps/api/src/modules/admin/admin-users.controller.ts', method: 'withDuplicateKeyRetry' },
    ],
    disposition: 'CONFLICT',
    note: '并发 upsert 同一 key 且重试耗尽 → 409 `CONFLICT`（缺陷 #190 的口径）',
  },
  {
    side: 'admin',
    entity: 'regions',
    entityClass: 'Region',
    entityFile: 'apps/api/src/database/entities/dictionary.entity.ts',
    columns: ['code'],
    disposition: 'SEEDED',
    note: '地区字典没有写端点（只由种子写入）',
  },
  {
    side: 'admin',
    entity: 'industries',
    entityClass: 'Industry',
    entityFile: 'apps/api/src/database/entities/dictionary.entity.ts',
    columns: ['code'],
    disposition: 'SEEDED',
    note: '行业字典没有写端点（只由种子写入）',
  },

  /* --------------------------- 用户侧 --------------------------- */
  {
    side: 'user',
    entity: 'users',
    entityClass: 'User',
    entityFile: 'apps/api/src/database/entities/user.entity.ts',
    columns: ['openid'],
    endpoints: [
      { method: 'POST', path: '/auth/mock/login' },
      { method: 'POST', path: '/auth/wechat/login' },
    ],
    guards: [{ file: 'apps/api/src/auth/auth.service.ts', method: 'issueUserLogin' }],
    disposition: 'RETRY',
    markers: [['isDuplicateKeyError', 'ER_DUP_ENTRY', '1062', 'QueryFailedError'], ['withDuplicateKeyRetry']],
    docTokens: ['409', 'CONFLICT'],
    note: '并发首登（同一 openid）→ 重跑整个事务命中既有用户；重试耗尽 → 409',
  },
  {
    side: 'user',
    entity: 'users',
    entityClass: 'User',
    entityFile: 'apps/api/src/database/entities/user.entity.ts',
    columns: ['unionid'],
    endpoints: [
      { method: 'POST', path: '/auth/mock/login' },
      { method: 'POST', path: '/auth/wechat/login' },
    ],
    guards: [{ file: 'apps/api/src/auth/auth.service.ts', method: 'issueUserLogin' }],
    disposition: 'CONFLICT',
    markers: [['isDuplicateKeyError', 'ER_DUP_ENTRY', '1062', 'QueryFailedError'], ['ConflictException']],
    docTokens: ['409', 'CONFLICT'],
    note: '同一个 unionid 已绑定另一个账号 → 409 `CONFLICT`（业务冲突，不是服务端故障）',
  },
  {
    side: 'user',
    entity: 'user_sessions',
    entityClass: 'UserSession',
    entityFile: 'apps/api/src/database/entities/user.entity.ts',
    columns: ['refresh_token_hash'],
    endpoints: [
      { method: 'POST', path: '/auth/mock/login' },
      { method: 'POST', path: '/auth/wechat/login' },
      { method: 'POST', path: '/auth/refresh' },
    ],
    guards: [{ file: 'apps/api/src/auth/auth.service.ts', method: 'signUserTokens' }],
    disposition: 'CONFLICT',
    markers: [['isDuplicateKeyError', 'ER_DUP_ENTRY', '1062', 'QueryFailedError'], ['ConflictException']],
    docTokens: ['409', 'CONFLICT'],
    note: '会话令牌哈希撞键 → 重新签发一次；仍撞 → 409（不得抛成 500）',
  },
  {
    side: 'user',
    entity: 'alumni_profiles',
    entityClass: 'AlumniProfile',
    entityFile: 'apps/api/src/database/entities/alumni.entity.ts',
    columns: ['user_id'],
    endpoints: [
      { method: 'PATCH', path: '/me/profile' },
      { method: 'PATCH', path: '/me/privacy' },
      { method: 'PUT', path: '/me/contacts' },
    ],
    guards: [
      { file: 'apps/api/src/modules/me/me.service.ts', method: 'requireProfile' },
      { file: 'apps/api/src/auth/auth.service.ts', method: 'issueUserLogin' },
    ],
    disposition: 'IDEMPOTENT',
    markers: [['isDuplicateKeyError', 'ER_DUP_ENTRY', '1062', 'QueryFailedError'], ['idempotent', 'existing', 'concurrent']],
    docTokens: ['幂等', '409'],
    note: '并发建档（同一 user_id）→ 读回既有档案（幂等）；读不到 → 409',
  },
  {
    side: 'user',
    entity: 'private_contacts',
    entityClass: 'PrivateContact',
    entityFile: 'apps/api/src/database/entities/alumni.entity.ts',
    columns: ['user_id'],
    endpoints: [
      { method: 'PUT', path: '/me/contacts' },
      { method: 'PATCH', path: '/me/contacts' },
    ],
    guards: [{ file: 'apps/api/src/modules/me/me.service.ts', method: 'updateContact' }],
    disposition: 'IDEMPOTENT',
    markers: [DUPLICATE_KEY_MARKERS, ['idempotent', 'existing', 'concurrent']],
    docTokens: ['幂等', '409'],
    note: '并发建联系方式行（主键 user_id）→ 读回既有行（幂等）；读不到 → 409',
  },
  {
    side: 'user',
    entity: 'connection_pairs',
    entityClass: 'ConnectionPair',
    entityFile: 'apps/api/src/database/entities/connection.entity.ts',
    columns: ['user_a_id', 'user_b_id'],
    endpoints: [{ method: 'POST', path: '/connections/requests/:id/accept' }],
    guards: [{ file: 'apps/api/src/modules/connections/connections.service.ts', method: 'accept' }],
    disposition: 'OR_IGNORE',
    docTokens: ['幂等'],
    note: '并发接受同一份申请 → `INSERT IGNORE` 吸收冲突，随后读回既有关系行（幂等）',
  },
  {
    side: 'user',
    entity: 'connection_request_history',
    entityClass: 'ConnectionRequestHistory',
    entityFile: 'apps/api/src/database/entities/connection.entity.ts',
    columns: ['pending_guard'],
    endpoints: [{ method: 'POST', path: '/connections/requests' }],
    guards: [{ file: 'apps/api/src/modules/connections/connections.service.ts', method: 'createRequest' }],
    disposition: 'IDEMPOTENT',
    markers: [['isDuplicateKeyError', 'ER_DUP_ENTRY', '1062', 'QueryFailedError'], ['idempotent', 'existing', 'concurrent']],
    docTokens: ['幂等', '409'],
    note: '同一对用户的 pending 申请只允许一条 → 重复提交返回既有申请（幂等）；读不到 → 409',
  },
  {
    side: 'user',
    entity: 'contact_share_grants',
    entityClass: 'ContactShareGrant',
    entityFile: 'apps/api/src/database/entities/connection.entity.ts',
    columns: ['pair_id', 'user_id'],
    endpoints: [{ method: 'PUT', path: '/connections/:id/contact-grant' }],
    guards: [
      { file: 'apps/api/src/modules/connections/connections.service.ts', method: 'setContactGrant' },
    ],
    disposition: 'CONFLICT',
    markers: [['isDuplicateKeyError', 'ER_DUP_ENTRY', '1062', 'QueryFailedError'], ['ConflictException']],
    docTokens: ['幂等', '409'],
    note: '并发授权同一对连接 → 更新既有授权行（幂等）；读不到既有行 → 409',
  },
  {
    side: 'user',
    entity: 'event_registrations',
    entityClass: 'EventRegistration',
    entityFile: 'apps/api/src/database/entities/event.entity.ts',
    columns: ['event_id', 'user_id'],
    endpoints: [{ method: 'POST', path: '/events/:id/registrations' }],
    guards: [{ file: 'apps/api/src/modules/events/events.service.ts', method: 'register' }],
    disposition: 'CONFLICT',
    note: '同一活动只能报名一次 → 并发重复报名 → 409 `CONFLICT`',
  },
  {
    side: 'user',
    entity: 'resource_post_attachments',
    entityClass: 'ResourcePostAttachment',
    entityFile: 'apps/api/src/database/entities/resource.entity.ts',
    columns: ['media_id', 'post_id'],
    endpoints: [
      { method: 'POST', path: '/resources' },
      { method: 'PATCH', path: '/resources/:id' },
    ],
    guards: [{ file: 'apps/api/src/modules/resources/resources.service.ts', method: 'replaceAttachments' }],
    disposition: 'CONFLICT',
    note: '同一份附件不能挂两次 → 409 `CONFLICT`',
  },
  {
    side: 'user',
    entity: 'verification_attachments',
    entityClass: 'VerificationAttachment',
    entityFile: 'apps/api/src/database/entities/verification.entity.ts',
    columns: ['application_id', 'media_id'],
    endpoints: [
      { method: 'POST', path: '/alumni/verification' },
      { method: 'PUT', path: '/alumni/verification/:id/resubmit' },
    ],
    guards: [{ file: 'apps/api/src/modules/alumni/alumni.service.ts', method: 'submit' }],
    extraGuards: [{ file: 'apps/api/src/modules/alumni/alumni.service.ts', method: 'resubmit' }],
    disposition: 'CONFLICT',
    note: '同一份证明材料不能挂两次 → 409 `CONFLICT`',
  },
  {
    side: 'user',
    entity: 'idempotency_records',
    entityClass: 'IdempotencyRecord',
    entityFile: 'apps/api/src/database/entities/system.entity.ts',
    columns: ['idem_key', 'scope'],
    endpoints: [{ method: 'POST', path: '/connections/requests' }],
    guards: [
      { file: 'apps/api/src/common/interceptors/idempotency.interceptor.ts', method: 'claim' },
    ],
    disposition: 'CONFLICT',
    markers: [['QueryFailedError'], ['idempotencyConflict']],
    catchMarkers: [['idempotencyConflict']],
    docTokens: ['409', 'IDEMPOTENCY_CONFLICT'],
    note: '同一个幂等键并发占用 → 409 `IDEMPOTENCY_CONFLICT`（不得抛成 500）',
  },
];

/* ------------------------------ 迁移层 ------------------------------ */

/**
 * 迁移层：**真正被创建**的唯一约束与列定义。
 *
 * ⚠️ 为什么必须单独抽一层：
 *   生产库 `synchronize: false`（`apps/api/src/database/data-source.ts`），
 *   跑的是 `apps/api/src/database/migrations/*` ——
 *   **真正约束生产数据的是迁移，不是实体声明**。
 *   实体里写了 `unique: true`、迁移里没建那道索引 =
 *   生产库**根本没有那道防线**：撞键不报错，数据库**静默写出重复行**
 *   （业务代码里那段「捕获重复键 → 409」永远不会触发）。
 *   这一类缺陷此前**没人核过**。
 *
 * 抽出来的形态：
 *   - `CREATE UNIQUE INDEX uk_x ON t (a, b)`；
 *   - 建表语句里的 `PRIMARY KEY (a, b)`（复合主键天然唯一）；
 *   - `ALTER TABLE t ADD CONSTRAINT uk_x UNIQUE (a)`。
 *
 * ⚠️ 「自增主键」(`id ... AUTO_INCREMENT` 的单列主键) 不算**业务唯一键** ——
 *    它在实体里是 `@PrimaryGeneratedColumn`，本就不在登记表口径里，
 *    否则每张表都会被误报成「迁移里多了一个实体没声明的唯一约束」。
 */

/** 按分隔符切分，**不**切括号 / 引号内部（`ENUM('a','b')` 里也有逗号）。 */
function splitTopLevel(text, separator) {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === '\\') {
        current += text[i + 1] ?? '';
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** 取出一段源码里所有**字符串字面量**的内容（`'` / `"` / 反引号都算）。 */
function extractStringLiterals(text) {
  const literals = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== "'" && ch !== '"' && ch !== '`') {
      i += 1;
      continue;
    }
    const quote = ch;
    let value = '';
    i += 1;
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') {
        value += c + (text[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (c === quote) {
        i += 1;
        break;
      }
      value += c;
      i += 1;
    }
    literals.push(value);
  }
  return literals;
}

/** 取 `(` … `)` 之间的内容（跳过引号里的括号）。 */
function readParenthesized(text, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  return null;
}

/** 把列清单（`` `a`, `b` `` / `a, b`）解析成小写列名数组。 */
function parseColumnList(text) {
  return text
    .replace(/[()]/g, '')
    .split(',')
    .map((item) => item.trim().replace(/`/g, '').toLowerCase())
    .filter(Boolean);
}

/**
 * 解析迁移里一列的**定义**（类型 / 长度 / 可空性）。
 *
 * ⚠️ `TEXT` / `BLOB` 这类**不能**直接建索引的类型（MySQL 要求前缀长度），
 *    与实体声明的 `varchar` 对不上时必须报出来 ——
 *    否则唯一索引根本建不出来，或者建在了错误的列上。
 */
function analyzeDdlColumnDef(def) {
  const text = def.trim();
  const typeMatch =
    /\b(varchar|char|varbinary|binary|text|tinytext|mediumtext|longtext|int|integer|bigint|smallint|tinyint|datetime|date|timestamp|json|decimal|numeric|float|double|blob|bit)\b/i.exec(
      text,
    );
  const type = typeMatch ? typeMatch[1].toLowerCase() : null;
  let length = null;
  if (type) {
    const lengthMatch = new RegExp(`\\b${type}\\s*\\(\\s*(\\d+)`, 'i').exec(text);
    if (lengthMatch) length = Number(lengthMatch[1]);
  }
  const notNull = /\bNOT\s+NULL\b/i.test(text);
  // ⚠️ `DEFAULT` 的取值有三种形态，**不能一律当字面量**：
  //    - 字面量：DEFAULT 0 / DEFAULT 'draft'
  //    - 表达式：DEFAULT CURRENT_TIMESTAMP(3)（`@CreateDateColumn` 就是它）
  //    - 函数：DEFAULT (uuid())
  //    表达式与函数**判不了**（库里的形态与 DDL 原文不一定逐字相同），
  //    所以单独标出来 —— 对账时**跳过**，不报。
  const defaultMatch = /\bDEFAULT\s+('(?:[^']|'')*'|[A-Za-z_][\w$]*(?:\s*\([^)]*\))?)/i.exec(text);
  const defaultRaw = defaultMatch ? defaultMatch[1] : null;
  const defaultIsExpression = Boolean(
    defaultRaw && !/^'/.test(defaultRaw) && /[A-Za-z_]/.test(defaultRaw),
  );
  const enumMatch = /\bENUM\s*\(([^)]*)\)/i.exec(text);
  return {
    type,
    length,
    nullable: notNull ? false : true,
    autoIncrement: /\bAUTO_INCREMENT\b/i.test(text),
    unsigned: /\bUNSIGNED\b/i.test(text),
    defaultValue: defaultIsExpression ? null : normalizeDefaultValue(defaultRaw),
    defaultIsExpression,
    enumValues: enumMatch
      ? [...enumMatch[1].matchAll(/'((?:[^']|'')*)'/g)].map((item) => item[1].replace(/''/g, "'"))
      : null,
  };
}

/**
 * 把迁移里的 **down()** 方法**摘掉**，只留「会被执行的」语句。
 *
 * ⚠️ 为什么必须摘掉 `down()`：
 *   `down()` 是**回滚**（把列改回窄、把索引删掉）——
 *   把它也算进「最终结构」就会把结论算反：
 *   `WidenIdempotencyScope` 的 down() 里有
 *   `ALTER TABLE idempotency_records MODIFY COLUMN scope VARCHAR(64)`，
 *   算进去之后 `scope` 的长度会变成 64 —— 而**实际生效**的是 255。
 *
 * ⚠️ 为什么不能只取 `up()` 的方法体：
 *   迁移把建表拆在**私有方法**里（`this.createTables(...)`），
 *   只看 up() 会把建表语句整段漏掉。
 */
function withoutDownMethod(src) {
  const downIndex = src.indexOf('async down(');
  if (downIndex < 0) return src;
  const braceIndex = src.indexOf('{', downIndex);
  if (braceIndex < 0) return src.slice(0, downIndex);
  let depth = 0;
  for (let i = braceIndex; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(0, downIndex) + src.slice(i + 1);
    }
  }
  return src.slice(0, downIndex);
}

/**
 * 扫**全部迁移文件**，抽出：
 *   - 每张表每一列的**最终定义**（后一条迁移的 ALTER 覆盖前一条的 CREATE）；
 *   - 每一条**真正被创建的**唯一约束。
 *
 * 迁移按**文件名**（时间戳前缀）顺序处理 —— 后面的迁移覆盖前面的，
 * 这与 TypeORM 实际应用的顺序一致。
 */
function discoverMigrationSchema() {
  const dir = path.join(root(), 'apps/api/src/database/migrations');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir)
        .filter((name) => name.endsWith('.ts') && name !== 'index.ts')
        .sort()
    : [];
  /** 表名 → (列名 → 列定义原文) */
  const tables = new Map();
  /** 真正被创建的唯一约束 */
  const uniques = [];
  /** 真正被创建的**全部**索引（唯一与非唯一，第十一轮起） */
  const indexes = [];
  /** 表 → 主键列 */
  const primaryKeys = new Map();
  /** 「表.列」 → 外键（后一条迁移覆盖前一条） */
  const foreignKeys = new Map();
  /** 外键名 → 「表.列」（`DROP FOREIGN KEY` 要靠它删） */
  const foreignKeyNames = new Map();

  const tableOf = (name) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };

  for (const name of files) {
    const src = readTextSafe(path.join(dir, name));
    if (!src) continue;
    // ⚠️ 只看**会被执行**的语句：`down()` 是回滚（把列改回窄、把索引删掉），
    //    把它也算进来会把「最终结构」算反 ——
    //    例如 `WidenIdempotencyScope` 的 down() 里有
    //    `MODIFY COLUMN scope VARCHAR(64)`，算进去就成了 64。
    // ⚠️ 模板字符串里的反引号在**源码**里是「反斜杠 + 反引号」，
    //    直接按 `` ` `` 去匹配会一个都匹配不上 ——
    //    先把转义去掉，剩下的才是能读懂的那份 SQL 文本。
    const body = withoutDownMethod(src).replace(/\\`/g, '`');

    // --- 建表：this.createTable(queryRunner, 'table', '列定义...') ---------
    const callRe = /\bcreateTable\s*\(/g;
    let match;
    while ((match = callRe.exec(body)) !== null) {
      const args = readParenthesized(body, match.index + match[0].length - 1);
      if (args === null) continue;
      const literals = extractStringLiterals(args);
      if (literals.length < 2) continue;
      const table = literals[0].trim().toLowerCase();
      const defs = literals.slice(1).join('');
      const columns = tableOf(table);
      for (const part of splitTopLevel(defs, ',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        if (/^(primary|unique|key|index|constraint|foreign)\b/i.test(trimmed)) continue;
        const columnMatch = /^`?([A-Za-z_][A-Za-z0-9_]*)`?\s+([\s\S]+)$/.exec(trimmed);
        if (!columnMatch) continue;
        columns.set(columnMatch[1].toLowerCase(), columnMatch[2]);
      }
      const primaryMatch = /PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(defs);
      if (primaryMatch) {
        const primaryColumns = parseColumnList(primaryMatch[1]);
        primaryKeys.set(table, primaryColumns);
        uniques.push({
          table,
          columns: primaryColumns,
          name: 'PRIMARY',
          kind: 'primary',
          source: name,
        });
      }
    }

    // --- 索引描述对象：{ table: 't', name: 'uk_x', columns: '`a`', unique: true }
    const descriptorRe =
      /\{\s*table:\s*'([A-Za-z0-9_]+)'\s*,\s*name:\s*'([^']+)'\s*,\s*columns:\s*(?:'([^']*)'|\[([^\]]*)\])\s*([^{}]*)\}/g;
    while ((match = descriptorRe.exec(body)) !== null) {
      const tail = match[5] ?? '';
      const unique = /unique:\s*true/.test(tail);
      const columns = match[3] !== undefined
        ? parseColumnList(match[3])
        : splitTopLevel(match[4] ?? '', ',')
            .map((item) => item.trim().replace(/^['"]|['"]$/g, '').toLowerCase())
            .filter(Boolean);
      if (!columns.length) continue;
      const entry = {
        table: match[1].toLowerCase(),
        columns,
        name: match[2],
        kind: 'index',
        unique,
        source: name,
      };
      indexes.push(entry);
      if (unique) uniques.push(entry);
    }

    // --- 裸 SQL：CREATE [UNIQUE] INDEX / ADD CONSTRAINT ... UNIQUE -------
    const createIndexRe =
      /CREATE\s+(UNIQUE\s+)?INDEX\s+`?([A-Za-z0-9_]+)`?\s+ON\s+`?([A-Za-z0-9_]+)`?\s*\(([^)]*)\)/gi;
    while ((match = createIndexRe.exec(body)) !== null) {
      const entry = {
        table: match[3].toLowerCase(),
        columns: parseColumnList(match[4]),
        name: match[2],
        kind: 'index',
        unique: Boolean(match[1]),
        source: name,
      };
      indexes.push(entry);
      if (entry.unique) uniques.push(entry);
    }
    const constraintRe =
      /ALTER\s+TABLE\s+`?([A-Za-z0-9_]+)`?\s+ADD\s+(?:CONSTRAINT\s+`?([A-Za-z0-9_]+)`?\s+)?UNIQUE(?:\s+KEY)?\s*\(([^)]*)\)/gi;
    while ((match = constraintRe.exec(body)) !== null) {
      const entry = {
        table: match[1].toLowerCase(),
        columns: parseColumnList(match[3]),
        name: match[2] ?? 'UNIQUE',
        kind: 'constraint',
        unique: true,
        source: name,
      };
      indexes.push(entry);
      uniques.push(entry);
    }

    // --- 裸 SQL：CREATE TABLE ... (列定义) --------------------------------
    const createTableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([A-Za-z0-9_]+)`?\s*\(/gi;
    while ((match = createTableRe.exec(body)) !== null) {
      const openIndex = body.indexOf('(', match.index + match[0].length - 1);
      const defs = readParenthesized(body, openIndex);
      if (defs === null) continue;
      const table = match[1].toLowerCase();
      const columns = tableOf(table);
      for (const part of splitTopLevel(defs, ',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        if (/^(primary|unique|key|index|constraint|foreign)\b/i.test(trimmed)) continue;
        const columnMatch = /^`?([A-Za-z_][A-Za-z0-9_]*)`?\s+([\s\S]+)$/.exec(trimmed);
        if (!columnMatch) continue;
        columns.set(columnMatch[1].toLowerCase(), columnMatch[2]);
      }
      const primaryMatch = /PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(defs);
      if (primaryMatch) {
        const primaryColumns = parseColumnList(primaryMatch[1]);
        primaryKeys.set(table, primaryColumns);
        uniques.push({
          table,
          columns: primaryColumns,
          name: 'PRIMARY',
          kind: 'primary',
          source: name,
        });
      }
    }

    // --- ALTER TABLE ... MODIFY/CHANGE/ADD COLUMN -------------------------
    const alterRe =
      /ALTER\s+TABLE\s+`?([A-Za-z0-9_]+)`?\s+(MODIFY|CHANGE|ADD)\s+(?:COLUMN\s+)?`?([A-Za-z0-9_]+)`?\s+([^,;]+)/gi;
    while ((match = alterRe.exec(body)) !== null) {
      // ⚠️ `ADD CONSTRAINT ... FOREIGN KEY ...` 也是 `ALTER TABLE ... ADD` ——
      //    但它**不是加列**。不排除掉就会凭空多出一列叫 `constraint`。
      if (/^(constraint|primary|unique|key|index|foreign|fulltext|spatial)$/i.test(match[3])) {
        continue;
      }
      const table = match[1].toLowerCase();
      const column = match[3].toLowerCase();
      const definition = match[4].trim().replace(/['"`]+$/, '').trim();
      // `CHANGE COLUMN old new ...` —— 取**新**列名
      const renamed = match[2].toUpperCase() === 'CHANGE'
        ? (/^`?([A-Za-z_][A-Za-z0-9_]*)`?\s+([\s\S]+)$/.exec(definition)?.[2] ?? null)
        : definition;
      if (renamed === null) continue;
      tableOf(table).set(column, renamed);
    }

    // --- 外键（第十一轮起对账这一层） -------------------------------------
    // ⚠️ 必须**按文件内的先后顺序**处理：`DROP FOREIGN KEY` 之后再
    //    `ADD CONSTRAINT ... FOREIGN KEY` 是「改指向」（迁移 1000 / 2000 就是这么干的），
    //    只看「最后有没有 ADD」会把改指向算成「两个外键并存」。
    const events = [];
    const fkDescriptorRe =
      /\{\s*table:\s*'([A-Za-z0-9_]+)'\s*,\s*name:\s*'([^']+)'\s*,\s*column:\s*'([^']+)'\s*,\s*refTable:\s*'([^']+)'\s*,\s*refColumn:\s*'([^']+)'/g;
    while ((match = fkDescriptorRe.exec(body)) !== null) {
      events.push({
        pos: match.index,
        kind: 'add',
        table: match[1].toLowerCase(),
        name: match[2],
        column: match[3].toLowerCase(),
        refTable: match[4].toLowerCase(),
        refColumn: match[5].toLowerCase(),
      });
    }
    // ⚠️ 表名必须从 `ALTER TABLE` 里一起取 ——
    //    「改外键指向」的迁移（1000 / 2000）只写 `ADD CONSTRAINT ... FOREIGN KEY`，
    //    表名在**前一句**的 `ALTER TABLE` 上；不一起取就不知道这条外键属于哪张表。
    const fkAddRe =
      /ALTER\s+TABLE\s+`?([A-Za-z0-9_]+)`?\s+ADD\s+(?:CONSTRAINT\s+`?([A-Za-z0-9_]+)`?\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+`?([A-Za-z0-9_]+)`?\s*\(([^)]*)\)/gi;
    while ((match = fkAddRe.exec(body)) !== null) {
      const columns = parseColumnList(match[3]);
      if (!columns.length) continue;
      const refs = parseColumnList(match[5]);
      events.push({
        pos: match.index,
        kind: 'add',
        table: match[1].toLowerCase(),
        name: match[2] ?? 'FOREIGN',
        column: columns[0],
        refTable: match[4].toLowerCase(),
        refColumn: refs[0] ?? null,
      });
    }
    const fkDropRe = /DROP\s+FOREIGN\s+KEY\s+`?([A-Za-z0-9_]+)`?/gi;
    while ((match = fkDropRe.exec(body)) !== null) {
      events.push({ pos: match.index, kind: 'drop', name: match[1] });
    }
    events.sort((left, right) => left.pos - right.pos);
    for (const event of events) {
      if (event.kind === 'drop') {
        const key = foreignKeyNames.get(event.name);
        if (key) foreignKeys.delete(key);
        continue;
      }
      if (!event.table) continue;
      const key = `${event.table}.${event.column}`;
      foreignKeys.set(key, {
        table: event.table,
        column: event.column,
        name: event.name,
        refTable: event.refTable,
        refColumn: event.refColumn,
        source: name,
      });
      foreignKeyNames.set(event.name, key);
    }
  }

  // 自增主键不是「业务唯一键」 —— 标出来，反向对账时排除。
  for (const item of uniques) {
    if (item.kind !== 'primary') continue;
    const columns = tables.get(item.table);
    if (!columns) continue;
    const def = columns.get(item.columns[0]);
    item.identity = Boolean(def && analyzeDdlColumnDef(def).autoIncrement);
  }

  // ⚠️ 同一条索引可能被**描述两遍**（迁移里的「描述对象」+ 真正执行的
  //    `CREATE INDEX` 语句）—— 去重，否则同一条差异会被报两次。
  const uniqueIndexes = new Map();
  for (const item of indexes) {
    const key = `${item.table}.${item.name}`;
    if (!uniqueIndexes.has(key)) uniqueIndexes.set(key, item);
  }
  const dedupedUniques = [];
  const seenUniques = new Set();
  for (const item of uniques) {
    const key = `${item.table}.${item.kind === 'primary' ? 'PRIMARY' : item.name}.${keyOf(item.columns)}`;
    if (seenUniques.has(key)) continue;
    seenUniques.add(key);
    dedupedUniques.push(item);
  }

  return {
    tables,
    uniques: dedupedUniques,
    indexes: [...uniqueIndexes.values()],
    primaryKeys,
    foreignKeys,
  };
}

/* ------------------------------ 工具 ------------------------------ */

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 唯一键的规范表示：列名按字典序排列后用 `+` 连接。 */
function keyOf(columns) {
  return [...columns].sort().join('+');
}

/**
 * 切出某个类的主体（按 `export class X` 切块）。
 *
 * 一个实体文件里可能有多个实体（`admin.entity.ts` 里就有
 * AdminUser / AdminUserRole / Role / Permission / AdminActionLog），
 * 不切块就会把别的实体的列算到这一个头上。
 */
function classBlock(src, className) {
  const matched = new RegExp(`export class ${className}\\b`).exec(src);
  if (!matched) return null;
  const start = matched.index;
  const next = src.indexOf('\nexport class ', start + 1);
  return next > 0 ? src.slice(start, next) : src.slice(start);
}

/**
 * 取某个类**上方**的装饰器块（`@Entity` / `@Index(...)`）。
 *
 * 类级 `@Index('uk_x', [...], { unique: true })` 是复合唯一键的来源，
 * 不取它就等于漏掉了「一整类」唯一键（用户侧的那些全是这样写的）。
 *
 * ⚠️ 装饰器之间**可能夹着注释行**（`event.entity.ts` 就是这样写的），
 *    所以向上扫描时注释行要**跳过**而不是中断 ——
 *    中断会把 `@Index('uk_event_registration', ...)` 漏掉。
 */
function classDecorators(src, className) {
  const matched = new RegExp(`export class ${className}\\b`).exec(src);
  if (!matched) return '';
  const lines = src.slice(0, matched.index).split('\n');
  const collected = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line === '') {
      // 类声明紧邻的那个空行（切片末尾）跳过；再往上的空行就是分界，停止。
      if (i === lines.length - 1) continue;
      break;
    }
    if (line.startsWith('@')) {
      collected.unshift(line);
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    break;
  }
  return collected.join('\n');
}

/**
 * 解析实体文件里导出的**常量数组**（枚举取值的来源）。
 *
 * ⚠️ 为什么需要它：实体的枚举列写的是 `enum: [...NOTIFICATION_TYPES]`，
 *    取值本身定义在**同一个文件**里的
 *    `export const NOTIFICATION_TYPES = [...] as const;`。
 *    不把常量解析出来，就拿不到「实体声称的枚举取值」——
 *    那一维度（枚举取值）就会因为「读不出来」而**永远判不了**。
 *
 * @returns {Map<string, string[]>} 常量名 → 取值数组
 */
function parseEntityConstArrays(src) {
  const map = new Map();
  const re = /export const ([A-Z0-9_]+)\s*=\s*\[([\s\S]*?)\]\s*as const/g;
  let match;
  while ((match = re.exec(src)) !== null) {
    const values = [...match[2].matchAll(/'([^']*)'|"([^"]*)"/g)].map(
      (item) => item[1] ?? item[2],
    );
    map.set(match[1], values);
  }
  return map;
}

/**
 * 把实体里声明的**默认值**归一成字符串。
 *
 * ⚠️ 为什么归一：实体里写的是**字面量**（`default: 0` / `default: 'draft'`），
 *    库里 `information_schema.columns.column_default` 回来的也是字符串
 *    （`'0'` / `'draft'`）—— 两边要按**同一个形态**比，否则
 *    `0` 与 `'0'` 会被判成「不一致」（那是假红，不是缺陷）。
 * ⚠️ **非字面量**（`default: () => 'x'` 这类表达式）**判不了** → 返回 `null`
 *    （= 不判定）：库里那一列的默认值是**算出来的**，
 *    拿源码里的表达式去比数据库里的结果，比出来的必然是假红。
 * @returns {string|null} 归一后的默认值；实体没声明或不是字面量就是 `null`
 */
function normalizeDefaultValue(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (text === 'true') return '1';
  if (text === 'false') return '0';
  // 表达式（函数 / 箭头函数 / 括号）：**不判定**
  if (/[()=>]/.test(text)) return null;
  return text.replace(/^['"]|['"]$/g, '');
}

/**
 * 解析实体里一列的**声明**（类型 / 长度 / 可空性 / 无符号 / 默认值 / 枚举取值）。
 *
 * ⚠️ `nullable` 的默认值是 **false**（TypeORM 的约定）：
 *    实体没写 `nullable` 就是「NOT NULL」。
 *    这条与迁移里的 DDL 对账时必须一致 ——
 *    实体说 NOT NULL、库里允许 NULL 的话，那一列**不会**参与唯一约束的碰撞
 *    （MySQL 的唯一索引允许多个 NULL），防线比声明的弱。
 *
 * ⚠️ `unsigned` / `default` / `enum` 三项**只在实体显式声明时**才有值
 *    （`null` = 没声明 = **不判定**）：
 *    「实体没写」不等于「实体说有符号 / 没有默认值 / 取值任意」——
 *    那是推断，不是声明。按「只报能直接判定的分歧」的口径，
 *    没声明就**不报**。
 *    （`default` 尤其要这样：`@CreateDateColumn` 在迁移里是
 *    `DEFAULT CURRENT_TIMESTAMP(3)`，实体侧**不写** `default` ——
 *    拿「实体没声明」去判「库里有默认值」会把每一张表的时间列都报成缺陷。）
 *
 * @param {string} args  装饰器参数原文
 * @param {Map<string,string[]>|null} consts  同一文件里导出的常量数组（解析枚举取值用）
 */
function analyzeEntityColumnArgs(args, consts = null) {
  const typeMatch = /type:\s*'([^']+)'/.exec(args);
  const lengthMatch = /length:\s*(\d+)/.exec(args);
  const nullableMatch = /nullable:\s*(true|false)/.exec(args);
  const unsignedMatch = /unsigned:\s*(true|false)/.exec(args);
  const defaultMatch = /default:\s*([^,\n}]+)/.exec(args);
  const enumMatch = /enum:\s*\[([^\]]*)\]/.exec(args);

  // 枚举取值：`enum: ['a', 'b']`（内联）或 `enum: [...SOME_CONST]`（引用常量）
  let enumValues = null;
  if (enumMatch) {
    const inner = enumMatch[1].trim();
    if (inner.startsWith('...')) {
      const constName = inner.replace(/^\.\.\./, '').trim();
      const resolved = consts?.get(constName) ?? null;
      // ⚠️ 常量解析不出来（引用了别的文件 / 动态生成）→ 记 `null`（**不判定**），
      //    绝不猜 —— 猜错就会凭空报出假缺口。
      enumValues = resolved ? [...resolved] : null;
    } else if (inner) {
      enumValues = [...inner.matchAll(/'([^']*)'|"([^"]*)"/g)].map((item) => item[1] ?? item[2]);
    } else {
      enumValues = [];
    }
  }

  return {
    type: typeMatch ? typeMatch[1].toLowerCase() : null,
    length: lengthMatch ? Number(lengthMatch[1]) : null,
    nullable: nullableMatch ? nullableMatch[1] === 'true' : false,
    unsigned: unsignedMatch ? unsignedMatch[1] === 'true' : null,
    defaultValue: normalizeDefaultValue(defaultMatch ? defaultMatch[1] : null),
    enumValues,
  };
}

/**
 * 类型名的**别名归一**（实体声明 ↔ 迁移 DDL）。
 *
 * ⚠️ 只归一**同义**写法，不做「族」的合并 ——
 *    `varchar` 与 `char` 是不同的类型（定长 vs 变长），
 *    `text` 与 `mediumtext` 的上限差了几万倍 ——
 *    这些必须**报出来**，不能被归一成同一个。
 */
function normalizeType(type) {
  if (!type) return null;
  const normalized = String(type).toLowerCase().trim();
  const aliases = {
    integer: 'int',
    numeric: 'decimal',
    bool: 'tinyint',
    boolean: 'tinyint',
    datetime: 'datetime',
  };
  return aliases[normalized] ?? normalized;
}

/** 是否是**字符串族**（有「长度」这个概念，可以比长度）。 */
function isStringType(type) {
  return Boolean(type) && ['varchar', 'char', 'varbinary', 'binary'].includes(String(type).toLowerCase());
}

/**
 * 取一个类里带唯一约束的**列组合**。
 *
 * 认三种形态：
 *   - `@Column({ ..., unique: true })` —— 单列唯一索引；
 *   - `@PrimaryColumn({ name: 'key', ... })` —— 主键天然唯一
 *     （`system_settings.key`、字典表的 `code` 就是这种）；
 *   - 类级 `@Index('uk_x', ['a','b'], { unique: true })` —— **复合**唯一索引
 *     （用户侧的连接对、活动报名、附件挂载都是这种）。
 *
 * @returns {{columns: string[], defs: Record<string, object>}[] | null}
 *   每个唯一键的列名数组 + 各列的声明（类型 / 长度 / 可空性）；类不存在时返回 null
 */
function uniqueColumnsOf(src, className) {
  const block = classBlock(src, className);
  if (!block) return null;
  const columns = [];
  /** 列名 → 声明（关系列没有声明 → 不参与「长度 / 可空性」对账） */
  const defs = {};

  // 属性名 → 数据库列名（复合索引里写的是属性名）
  const propToColumn = new Map();
  const columnRe = /@(Primary)?Column\(\{([^}]*)\}\)\s*\n\s*([A-Za-z_$][\w$]*)\s*[?!]?:/g;
  let match;
  const primaryColumns = [];
  while ((match = columnRe.exec(block)) !== null) {
    const args = match[2];
    const nameMatch = /name:\s*'([^']+)'/.exec(args);
    if (!nameMatch) continue;
    propToColumn.set(match[3], nameMatch[1]);
    defs[nameMatch[1]] = analyzeEntityColumnArgs(args);
    if (match[1] === 'Primary') {
      primaryColumns.push(nameMatch[1]);
    } else if (/unique:\s*true/.test(args)) {
      columns.push([nameMatch[1]]);
    }
  }
  // 关系列（@ManyToOne + @JoinColumn）也参与复合索引
  const joinRe = /@JoinColumn\(\{[^}]*name:\s*'([^']+)'[^}]*\}\)\s*\n\s*([A-Za-z_$][\w$]*)\s*[?!]?:/g;
  while ((match = joinRe.exec(block)) !== null) {
    propToColumn.set(match[2], match[1]);
    // 关系列的可空性由 @ManyToOne 的选项决定（不在 @JoinColumn 里），
    // 这里**不猜** —— 标成 relation，对账时跳过它的可空性。
    // ⚠️ 同一列可能**既**有 @Column 声明**又**有 @JoinColumn
    //    （关系列通常就是这么写的）：那种情况下 @Column 的声明才是权威的，
    //    所以只**补**一个 relation 标记，不覆盖已有的类型 / 长度 / 可空性。
    const existing = defs[match[1]];
    if (existing) existing.relation = true;
    else defs[match[1]] = { relation: true };
  }
  if (primaryColumns.length) columns.push(primaryColumns);

  // 类级唯一索引（复合）
  const decorators = classDecorators(src, className);
  const indexRe = /@Index\(\s*'([^']+)'\s*,\s*\[([^\]]*)\]([^)]*)\)/g;
  while ((match = indexRe.exec(decorators)) !== null) {
    if (!/unique:\s*true/.test(match[3])) continue;
    const props = match[2]
      .split(',')
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    if (!props.length) continue;
    columns.push(props.map((prop) => propToColumn.get(prop) ?? prop));
  }

  // 去重（主键与唯一索引常常是同一组列）
  const seen = new Set();
  const unique = [];
  for (const item of columns) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ columns: item, defs });
  }
  return unique;
}

/**
 * 扫**全部实体文件**，列出每一个唯一键。
 *
 * 这是「登记表 ↔ 实现」对账的**发现端**：
 * 只有扫全量，才能发现「新增的唯一键落在没登记过的表上」这种漏网
 * （此前只检查登记表里已有的实体 —— 新表上的新唯一键是看不见的）。
 */
function discoverUniqueKeys() {
  const dir = path.join(root(), 'apps/api/src/database/entities');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.endsWith('.ts')).sort()
    : [];
  const discovered = [];
  for (const name of files) {
    const rel = `apps/api/src/database/entities/${name}`;
    const src = readTextSafe(path.join(root(), rel));
    if (!src) continue;
    const classRe = /export class ([A-Za-z_$][\w$]*)/g;
    let match;
    while ((match = classRe.exec(src)) !== null) {
      const className = match[1];
      const entityMatch = /@Entity\(\{\s*name:\s*'([^']+)'/.exec(
        classDecorators(src, className),
      );
      if (!entityMatch) continue;
      const entity = entityMatch[1];
      const columns = uniqueColumnsOf(src, className);
      if (!columns) continue;
      for (const item of columns) {
        discovered.push({
          entity,
          entityClass: className,
          entityFile: rel,
          columns: item.columns,
          defs: item.defs,
          key: keyOf(item.columns),
        });
      }
    }
  }
  return discovered;
}

/* --------------------------- 实体侧 schema --------------------------- */

/**
 * 实体侧的结构声明（第十二轮新增）。
 *
 * 第十轮只把**唯一键**这一层对到了迁移层；第十二轮把对账扩到**三层**：
 *   1) 全部索引（含非唯一 `idx_*`）；
 *   2) 外键（`@ManyToOne` / `@OneToOne` + `@JoinColumn`）；
 *   3) 全部列的类型 / 长度 / 可空性。
 *
 * ⚠️ 这一层**必须解析得准**，否则会凭空报出「假缺口」——
 *    门禁假红比不做更糟（真正的新缺口会被淹没在噪声里）。
 *    三个最容易踩空的地方：
 *      a) **类级 `@Index` 装饰器的类归属**：
 *         一个文件里可能有多个实体，装饰器必须**归属到它下面那个类**
 *         （`classDecorators` 只向上扫描到空行为止）；
 *      b) **属性名 → 列名映射**：
 *         复合索引里写的是**属性名**（`['userAId','userBId']`），
 *         库里是**列名**（`user_a_id`）—— 不映射就一定对不上；
 *      c) **关系列的列名来自 `@JoinColumn`**：
 *         `adminUser?: AdminUser` 的列名是 `admin_user_id`，
 *         不是属性名，也不是 `adminUserId`。
 */

/** 装饰器里可能出现的「标量列」装饰器。 */
const COLUMN_DECORATORS = new Set([
  'Column',
  'PrimaryColumn',
  'PrimaryGeneratedColumn',
  'CreateDateColumn',
  'UpdateDateColumn',
  'DeleteDateColumn',
]);

/** 关系装饰器（会生成外键）。 */
const RELATION_DECORATORS = new Set(['ManyToOne', 'OneToOne']);

/** 文本里的括号是否配平（用于跨行装饰器的拼接）。 */
function isBalancedParens(text) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
  }
  return depth <= 0;
}

/**
 * 把一个类的**属性**与其装饰器对应起来。
 *
 * ⚠️ 为什么不用正则一把梭：
 *   装饰器**可能跨行**（`@Column({` 换行再写参数），
 *   而属性名在装饰器**之后**那一行；
 *   逐行扫描才能知道「这些装饰器属于哪个属性」。
 */
function parseClassProperties(block) {
  const props = [];
  let pending = [];
  let buffer = '';
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (buffer) {
      buffer += ` ${line}`;
      if (isBalancedParens(buffer)) {
        pending.push(buffer);
        buffer = '';
      }
      continue;
    }
    if (line === '') continue;
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    if (line.startsWith('@')) {
      buffer = line;
      if (isBalancedParens(buffer)) {
        pending.push(buffer);
        buffer = '';
      }
      continue;
    }
    const property = /^([A-Za-z_$][\w$]*)\s*[?!]?:/.exec(line);
    if (property) {
      props.push({ prop: property[1], decorators: pending });
      pending = [];
      continue;
    }
    pending = [];
  }
  return props;
}

/** 拆出装饰器的名字与参数表。 */
function parseDecorator(text) {
  const trimmed = text.trim();
  const matched = /^@([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/.exec(trimmed);
  if (!matched) return { name: trimmed.replace(/^@/, ''), args: '' };
  return { name: matched[1], args: matched[2] };
}

/**
 * 扫**全部实体文件**，抽出每张表的：
 *   - **列**（列名 → 类型 / 长度 / 可空性 / 是否唯一 / 主键）；
 *   - **索引**（类级 `@Index` 的名字、列、是否唯一）；
 *   - **关系**（外键：列 → 目标表 / 目标列）。
 *
 * @returns {{tables: Map, classToTable: Map}}
 */
function discoverEntitySchema() {
  const dir = path.join(root(), 'apps/api/src/database/entities');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.endsWith('.ts')).sort()
    : [];
  /** 实体类清单 */
  const classes = [];
  for (const name of files) {
    const rel = `apps/api/src/database/entities/${name}`;
    const src = readTextSafe(path.join(root(), rel));
    if (!src) continue;
    for (const match of src.matchAll(/export class ([A-Za-z_$][\w$]*)/g)) {
      const className = match[1];
      const entityMatch = /@Entity\(\{\s*name:\s*'([^']+)'/.exec(
        classDecorators(src, className),
      );
      if (!entityMatch) continue;
      classes.push({
        className,
        table: entityMatch[1].toLowerCase(),
        file: rel,
        src,
      });
    }
  }
  const classToTable = new Map(classes.map((item) => [item.className, item.table]));

  /** 表 → 声明 */
  const tables = new Map();
  for (const item of classes) {
    // ⚠️ 枚举取值写在**常量**里（`enum: [...NOTIFICATION_TYPES]`），
    //    常量与实体在**同一个文件**里 —— 先把该文件的常量数组解析出来。
    const constArrays = parseEntityConstArrays(item.src);
    const block = classBlock(item.src, item.className);
    if (!block) continue;
    /** 列名 → 声明 */
    const columns = new Map();
    /** 类级 `@Index` 声明 */
    const indexes = [];
    /** 关系（外键）声明 */
    const relations = [];

    for (const property of parseClassProperties(block)) {
      const decorators = property.decorators.map(parseDecorator);
      const columnDecorator = decorators.find((item) =>
        COLUMN_DECORATORS.has(item.name),
      );
      const relationDecorator = decorators.find((item) =>
        RELATION_DECORATORS.has(item.name),
      );
      const joinDecorator = decorators.find((item) => item.name === 'JoinColumn');

      let columnName = null;
      let columnDef = null;
      if (columnDecorator) {
        const nameMatch = /name:\s*'([^']+)'/.exec(columnDecorator.args);
        columnName = (nameMatch ? nameMatch[1] : property.prop).toLowerCase();
        const analyzed = analyzeEntityColumnArgs(columnDecorator.args, constArrays);
        columnDef = {
          column: columnName,
          prop: property.prop,
          kind: columnDecorator.name,
          type: analyzed.type,
          length: analyzed.length,
          // ⚠️ TypeORM 的 `nullable` 默认是 **false**（NOT NULL）
          nullable: analyzed.nullable,
          // 第十五轮起多带三项：**无符号 / 默认值 / 枚举取值**。
          // 三项都只在实体**显式声明**时才有值（否则是 `null` = 不判定）——
          // 库内实况对账（`check-db-reality.mjs`）据此判定，
          // 静态对账的既有判定条件**一个字没改**。
          unsigned: analyzed.unsigned,
          defaultValue: analyzed.defaultValue,
          enumValues: analyzed.enumValues,
          unique: /unique:\s*true/.test(columnDecorator.args),
          primary:
            columnDecorator.name === 'PrimaryColumn' ||
            columnDecorator.name === 'PrimaryGeneratedColumn',
        };
        columns.set(columnName, columnDef);
      }

      if (relationDecorator) {
        // ⚠️ 目标类是 `() => X`（**一对**括号，紧跟 `=>`）——
        //    写成 `\(\(\)` 会一个都匹配不到（外层 `@ManyToOne(` 的括号不在 args 里）。
        const target = /\(\s*\)\s*=>\s*([A-Za-z_$][\w$]*)/.exec(
          relationDecorator.args,
        );
        const relationNullable = /nullable:\s*(true|false)/.exec(
          relationDecorator.args,
        );
        const joinName = joinDecorator
          ? (/name:\s*'([^']+)'/.exec(joinDecorator.args)?.[1] ?? null)
          : null;
        const referenced = joinDecorator
          ? (/referencedColumnName:\s*'([^']+)'/.exec(joinDecorator.args)?.[1] ?? null)
          : null;
        const column = (joinName ?? columnName ?? '').toLowerCase();
        if (!column || !target) continue;
        relations.push({
          prop: property.prop,
          column,
          kind: relationDecorator.name,
          targetClass: target[1],
          targetTable: classToTable.get(target[1]) ?? null,
          // ⚠️ `referencedColumnName` 没写就是**目标表的主键** —— 留空，
          //    后面按目标表的主键列补齐（`regions.code` 是自然键主键）。
          referencedColumn: referenced ? referenced.toLowerCase() : null,
          // 可空性以**列声明**为准；关系列没有列声明时才用关系上的选项。
          nullable: columnDef
            ? columnDef.nullable
            : relationNullable
              ? relationNullable[1] === 'true'
              : false,
        });
      }
    }

    // 类级 `@Index` —— **类归属**由 `classDecorators` 保证（只向上扫到空行为止）
    const decorators = classDecorators(item.src, item.className);
    const indexRe = /@Index\(\s*'([^']+)'\s*,\s*\[([^\]]*)\]\s*(?:,\s*(\{[^{}]*\}))?\s*\)/g;
    let indexMatch;
    while ((indexMatch = indexRe.exec(decorators)) !== null) {
      const props = indexMatch[2]
        .split(',')
        .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
      if (!props.length) continue;
      const unique = /unique:\s*true/.test(indexMatch[3] ?? '');
      const columnsOfIndex = props.map((prop) => {
        for (const column of columns.values()) {
          if (column.prop === prop) return column.column;
        }
        // ⚠️ **关系属性**（`@ManyToOne` / `@OneToOne` + `@JoinColumn`）：
        //    它的列名取自 `@JoinColumn`（`region` → `region_code`），
        //    既不是属性名、也不是属性名小写 ——
        //    第十三轮的误报率抽查发现：这里以前直接退回属性名，
        //    于是「索引建在关系属性上」会被报成「索引建在 `region` 上」，
        //    **列名是错的**（照着它补迁移会建出一个不存在的列）。
        for (const relation of relations) {
          if (relation.prop === prop) return relation.column;
        }
        // 真的找不到对应列声明 → 退回属性名本身（保守：宁可报得含糊，也不猜错列名）
        return prop.toLowerCase();
      });
      indexes.push({
        name: indexMatch[1],
        props,
        columns: columnsOfIndex,
        unique,
      });
    }

    tables.set(item.table, {
      table: item.table,
      className: item.className,
      file: item.file,
      columns,
      indexes,
      relations,
      primaryKey: [...columns.values()].filter((column) => column.primary).map((column) => column.column),
    });
  }

  // 关系的外键目标列：没写 `referencedColumnName` 就是**目标表的主键**
  for (const table of tables.values()) {
    for (const relation of table.relations) {
      if (relation.referencedColumn) continue;
      const target = relation.targetTable ? tables.get(relation.targetTable) : null;
      relation.referencedColumn = target?.primaryKey?.[0] ?? null;
      relation.targetPrimaryKey = target?.primaryKey ?? [];
    }
  }

  return { tables, classToTable };
}

/**
 * 粗粒度地切出方法体（不用 AST —— 校验器要能在注入的临时副本上跑）。
 *
 * ⚠️ 要能处理**跨行签名**与**参数里带括号**：
 *    `async createCategory(\n  @CurrentUser() actor: RequestUser,\n) {`
 *    以及 `@CurrentUser() actor` 这种装饰器调用都在签名里 ——
 *    所以这里从「方法名 + 左括号」出发做**括号配对**，
 *    而不是逐行正则（逐行正则会漏掉这两种形态，
 *    漏掉的后果是「明明有处置却被判成没有」）。
 */
function collectMethods(src) {
  const methods = [];
  const re =
    /^\s{2}(?:(?:public|private|protected|static|async|readonly|override)\s+)*([A-Za-z_$][\w$]*)(?:<[^>]*>)?\s*\(/gm;
  let match;
  while ((match = re.exec(src)) !== null) {
    const name = match[1];
    if (['if', 'for', 'while', 'switch', 'catch', 'constructor', 'return'].includes(name)) {
      continue;
    }
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
    // ⚠️ 方法体起始的 `{` **不一定是紧跟参数表的那个**：
    //    返回类型里可能带花括号（如 `Promise<{ kind: 'claimed' }>`），
    //    直接 `indexOf('{', close)` 会把**类型字面量**当成方法体 ——
    //    后果是「明明有处置却被判成没有」。
    //    所以这里按**尖括号深度**找：只有尖括号深度为 0 的 `{` 才是方法体。
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
    methods.push({
      name,
      line: src.slice(0, match.index).split('\n').length,
      body: src.slice(brace, end + 1),
    });
    // 跳过方法体（里面的调用不算方法定义）
    re.lastIndex = brace;
  }
  return methods;
}

/**
 * 从参数表右括号往后找**方法体的起始 `{`**。
 *
 * 跳过返回类型里的花括号（`Promise<{ kind: 'claimed' }>`）——
 * 只有**尖括号深度为 0** 的 `{` 才是方法体。
 */
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

/**
 * 取一个处置位置的**有效代码**。
 *
 * 两种形态都算：
 *   1) 方法体里**直接**捕获重复键并给出可预期错误码；
 *   2) 方法体里**调用**了同一个类里的另一个带处置的方法
 *      （如 `createAdmin` → `toDuplicateUsernameError`，
 *        `issueUserLogin` → `withDuplicateKeyRetry`）。
 *
 * 形态 2 必须一起看：只看调用方会漏判（调用方里根本没有捕获代码）。
 */
function effectiveBody(guard) {
  const src = readTextSafe(path.join(root(), guard.file));
  if (!src) return { ok: false, reason: `文件不存在：${guard.file}` };
  const methods = collectMethods(src);
  const target = methods.find((method) => method.name === guard.method);
  if (!target) return { ok: false, reason: `文件里找不到方法 ${guard.method}` };
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
  return { ok: true, where: `${guard.file} · ${guard.method}`, body };
}

/**
 * 找出「捕获了重复键」的 catch 块。
 *
 * ⚠️ 这一步是「校验器不恒过」的关键：
 *   只看方法体里有没有 `ConflictException` 是不够的 ——
 *   同一个方法里往往还有**别的**冲突分支（「名额已满」之类），
 *   把捕获重复键的那一段删掉之后，那些分支仍然在，
 *   于是「有处置」的错觉就成立了。
 *   所以必须**定位到 catch 块本身**再看它给了什么结果。
 */
function catchBlocksContaining(text, markers) {
  const blocks = [];
  const re = /catch\s*\([^)]*\)\s*\{/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const brace = text.indexOf('{', match.index);
    let depth = 0;
    let end = -1;
    for (let i = brace; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) continue;
    const block = text.slice(brace, end + 1);
    if (markers.some((marker) => block.includes(marker))) blocks.push(block);
  }
  return blocks;
}

/**
 * 取 `docs/API-SPEC.md` 里所有「错误语义」小节。
 *
 * 取不到 = 口径没写 = 报错（宁可吵，也不要默默放过）。
 */
function errorSemanticsSections() {
  const src = readTextSafe(path.join(root(), 'docs/API-SPEC.md'));
  if (!src) return [];
  const lines = src.split('\n');
  const sections = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^#{2,4}\s/.test(line) || !line.includes('错误语义')) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^#{2,4}\s/.test(lines[j])) {
        end = j;
        break;
      }
    }
    sections.push({ heading: line, lines: lines.slice(i, end) });
    i = end - 1;
  }
  return sections;
}

/* ------------------------------ 主流程 ------------------------------ */

function main() {
  const issues = [];
  const notes = [];

  const discovered = discoverUniqueKeys();
  const registryByKey = new Map(
    UNIQUE_KEY_REGISTRY.map((entry) => [`${entry.entity}#${keyOf(entry.columns)}`, entry]),
  );

  if (LIST_ONLY) {
    process.stdout.write('发现的唯一键（实体 / 列）：\n');
    for (const item of discovered) {
      const registered = registryByKey.has(`${item.entity}#${item.key}`);
      process.stdout.write(
        `  ${registered ? '✓' : '✗'} ${item.entity} (${item.columns.join(', ')}) [${item.entityClass}]\n`,
      );
    }
    process.exit(0);
  }

  // --- 1) 唯一键登记表 ↔ 实体实现对账 -----------------------------------------
  for (const item of discovered) {
    const id = `${item.entity}#${item.key}`;
    if (registryByKey.has(id)) continue;
    issues.push({
      kind: 'UNIQUE_COLUMN_NOT_REVIEWED',
      where: `${item.entity}.${item.columns.join(',')}`,
      detail:
        `${item.entity} 上有一个唯一键（${item.entityClass}）没有登记失败语义 —— ` +
        '撞键时返回什么（409？幂等？）没人想过，必须先登记再上线',
    });
  }

  for (const entry of UNIQUE_KEY_REGISTRY) {
    const id = `${entry.entity}#${keyOf(entry.columns)}`;
    const found = discovered.find((item) => `${item.entity}#${item.key}` === id);
    if (!found) {
      issues.push({
        kind: 'REVIEWED_COLUMN_MISSING',
        where: `${entry.entity}.${entry.columns.join(',')}`,
        detail:
          `登记表的唯一键 ${entry.entity}.${entry.columns.join(',')} 在实体文件里没有了 —— ` +
          '要么唯一索引被删了（登记表该更新），要么实体与登记表分叉了',
      });
      continue;
    }
    if (found.entityFile !== entry.entityFile || found.entityClass !== entry.entityClass) {
      issues.push({
        kind: 'REGISTRY_ENTITY_MISMATCH',
        where: `${entry.entity}.${entry.columns.join(',')}`,
        detail:
          `登记表指向 ${entry.entityClass}（${entry.entityFile}），` +
          `实体文件里实际是 ${found.entityClass}（${found.entityFile}）`,
      });
    }
  }

  // --- 2) 处置真的存在 -------------------------------------------------------
  for (const entry of UNIQUE_KEY_REGISTRY) {
    const disposition = DISPOSITIONS[entry.disposition];
    if (!disposition) {
      issues.push({
        kind: 'UNKNOWN_DISPOSITION',
        where: `${entry.entity}.${entry.columns.join(',')}`,
        detail: `登记表的 disposition '${entry.disposition}' 不是已知口径`,
      });
      continue;
    }
    const guards = [...(entry.guards ?? []), ...(entry.extraGuards ?? [])];
    if (!guards.length) {
      if (entry.disposition !== 'SEEDED') {
        issues.push({
          kind: 'MISSING_GUARD',
          where: `${entry.entity}.${entry.columns.join(',')}`,
          detail: `登记表声明了处置 '${entry.disposition}'，却没有写处置位置（guards）`,
        });
      } else {
        notes.push({
          kind: 'NO_WRITE_ENDPOINT',
          where: `${entry.entity}.${entry.columns.join(',')}`,
          detail: entry.note,
        });
      }
      continue;
    }
    const markers = entry.markers ?? disposition.markers;
    const catchMarkers = entry.catchMarkers ?? disposition.catchMarkers;
    // 逐个处置位置：每个都必须**自己**看得见「重复键」的痕迹
    //   （否则「其中一个处置位置被改坏」会被另一个位置掩盖）。
    const bodies = [];
    let guardBroken = false;
    for (const guard of guards) {
      const result = effectiveBody(guard);
      if (!result.ok) {
        issues.push({
          kind: 'MISSING_CONFLICT_MAPPING',
          where: `${entry.entity}.${entry.columns.join(',')}`,
          detail: `${result.reason}。${entry.note}`,
        });
        guardBroken = true;
        continue;
      }
      bodies.push(result);
      if (!DUPLICATE_KEY_MARKERS.some((marker) => result.body.includes(marker))) {
        if (entry.disposition === 'OR_IGNORE' || entry.disposition === 'REPLACE') continue;
        issues.push({
          kind: 'MISSING_CONFLICT_MAPPING',
          where: `${entry.entity}.${entry.columns.join(',')}`,
          detail:
            `${result.where} 里既没有捕获重复键（${DUPLICATE_KEY_MARKERS.join(' / ')}），` +
            `也没有转成可预期错误码 —— 撞唯一键会直接冒泡成 500。${entry.note}`,
        });
        guardBroken = true;
        continue;
      }
      notes.push({
        kind: 'CONFLICT_MAPPING_OK',
        where: `${entry.entity}.${entry.columns.join(',')}`,
        detail: `${result.where}：${entry.note}`,
      });
    }
    if (guardBroken || !bodies.length) continue;
    // 全部处置位置合起来：登记的处置痕迹必须齐备
    //   （例如「既有行读回（幂等）」这种痕迹可能只落在其中一个位置）。
    const union = bodies.map((item) => item.body).join('\n');
    const check = groupsSatisfied(union, markers);
    if (!check.ok) {
      issues.push({
        kind: 'MISSING_CONFLICT_MAPPING',
        where: `${entry.entity}.${entry.columns.join(',')}`,
        detail:
          `处置位置里缺少处置痕迹：${check.missing.join(' / ')}。${entry.note} —— ` +
          '处置方式必须是「捕获唯一键冲突并给出可预期错误码（409 / 幂等）」，' +
          '**不得**把数据库异常原样抛出去（那会变成 500），' +
          '也**不得**靠去掉唯一索引来「解决」它（那等于允许重名，是数据损坏）',
      });
      continue;
    }
    // ⚠️ **捕获重复键的那一段**里必须真的给出了可预期结果。
    //   只看「整个方法里有没有 ConflictException」是不够的：
    //   方法里可能还有**别的**冲突分支（比如「名额已满」），
    //   把捕获重复键的那段删掉之后，ConflictException 仍然存在 ——
    //   校验器就会变成恒过的。
    if (catchMarkers.length) {
      const catchBlocks = catchBlocksContaining(union, DUPLICATE_KEY_MARKERS);
      if (catchBlocks.length) {
        const satisfied = catchBlocks.some((block) => groupsSatisfied(block, catchMarkers).ok);
        if (!satisfied) {
          issues.push({
            kind: 'MISSING_CONFLICT_MAPPING',
            where: `${entry.entity}.${entry.columns.join(',')}`,
            detail:
              `捕获重复键的那一段里没有给出可预期结果（需要 ${catchMarkers
                .map((group) => group.join(' / '))
                .join('、')}）—— 撞唯一键会直接冒泡成 500。${entry.note}`,
          });
        }
      }
    }
  }

  // --- 3) 口径写进了文档 -----------------------------------------------------
  const sections = errorSemanticsSections();
  if (!sections.length) {
    issues.push({
      kind: 'ERROR_SEMANTICS_SECTION_MISSING',
      where: 'docs/API-SPEC.md',
      detail:
        'API-SPEC 里找不到「错误语义」小节 —— 写操作的失败口径必须写进文档，' +
        '否则客户端只能靠猜',
    });
  } else {
    const allLines = sections.flatMap((section) => section.lines);
    for (const entry of UNIQUE_KEY_REGISTRY) {
      const disposition = DISPOSITIONS[entry.disposition];
      const docTokens = entry.docTokens ?? disposition?.docTokens ?? [];
      for (const endpoint of entry.endpoints ?? []) {
        // 一个端点可能对应**多行**文档（如「幂等命中」与「真冲突」各一行），
        // 所以口径按这些行的**并集**判定：
        //   - 一行都没有 → 口径没写（报错）；
        //   - 行都在，但并集里仍缺关键口径 → 写漏了（报错）。
        const rows = allLines.filter(
          (line) => line.includes(endpoint.path) && line.includes(endpoint.method),
        );
        if (!rows.length) {
          issues.push({
            kind: 'ERROR_SEMANTICS_UNDOCUMENTED',
            where: `${endpoint.method} ${endpoint.path}`,
            detail:
              `「错误语义」小节里没有点名 ${endpoint.method} ${endpoint.path} —— ` +
              '对外契约变了却没写进文档，客户端会按旧口径处理',
          });
          continue;
        }
        const union = rows.join('\n');
        const missing = docTokens.filter((token) => !union.includes(token));
        if (missing.length) {
          issues.push({
            kind: 'ERROR_SEMANTICS_UNDOCUMENTED',
            where: `${endpoint.method} ${endpoint.path}`,
            detail:
              `文档里没有写明 ${missing.join(' / ')}：${rows.map((row) => row.trim()).join(' / ')}`,
          });
          continue;
        }
        notes.push({
          kind: 'ERROR_SEMANTICS_DOCUMENTED',
          where: `${endpoint.method} ${endpoint.path}`,
          detail: rows.map((row) => row.trim()).join(' / '),
        });
      }
    }
  }

  // --- 4) 迁移层真的有那道防线吗（第十轮新增） ------------------------------
  //
  // 生产库 `synchronize: false` —— 真正约束数据的是**迁移**，不是实体声明。
  // 实体里声明了、迁移里没建 → 生产库**没有那道防线**：
  // 撞键不会报错，数据库会**静默写出重复行**，
  // 而业务代码里那段「捕获重复键 → 409」**永远不会触发**。
  const migrationSchema = discoverMigrationSchema();
  const migrationUniques = migrationSchema.uniques;

  /** 迁移层里与某张表相关的唯一约束 */
  const uniquesOfTable = (table) =>
    migrationUniques.filter((item) => item.table === table.toLowerCase());

  for (const item of discovered) {
    const table = item.entity.toLowerCase();
    const wanted = item.columns.map((column) => column.toLowerCase());
    const candidates = uniquesOfTable(table);
    const exact = candidates.find((entry) => keyOf(entry.columns) === keyOf(wanted));

    if (!exact) {
      // 有同表的唯一约束、但列集合对不上 → 分辨是「覆盖不足」还是「更严」
      const overlapping = candidates.find((entry) =>
        entry.columns.some((column) => wanted.includes(column)),
      );
      if (overlapping) {
        issues.push({
          kind: 'MIGRATION_UNIQUE_COLUMN_MISMATCH',
          where: `${item.entity}.${item.columns.join(',')}`,
          detail:
            `实体声明的唯一键是（${wanted.join(',')}），` +
            `迁移里建的唯一约束 \`${overlapping.name}\` 却是（${overlapping.columns.join(',')}）—— ` +
            '列集合不一致：少了列就是**覆盖不足**（两把不同的钥匙会被当成同一把），' +
            '多了列就是**比实体更严**（写入会被库挡下，而实体与代码没准备）。' +
            '两者都会让「实体 ↔ 迁移」分叉，必须逐条判断是补迁移还是改实体',
        });
      } else {
        issues.push({
          kind: 'MIGRATION_UNIQUE_MISSING',
          where: `${item.entity}.${item.columns.join(',')}`,
          detail:
            `实体声明了唯一键（${wanted.join(',')}），但迁移里**没有**对应的唯一约束 —— ` +
            '生产库 `synchronize: false`，跑的是迁移：' +
            '**生产库根本没有那道防线**，撞键不会报错，会**静默写出重复行**，' +
            '而代码里「捕获重复键 → 409」的那一段永远不会触发。' +
            '修法二选一（**必须逐条判断，不能一刀切**）：补一条 TypeORM 迁移' +
            '（`AddMissingUniqueIndexes*`），或去掉实体里那个唯一声明',
        });
      }
      continue;
    }

    if (exact.kind === 'primary') {
      // ⚠️ **主键等价**：主键（自然键主键 / 复合主键都算）天然唯一，
      //    不必再建一条同列的唯一索引
      //    （那是重复约束 + 写放大）。这类**不算缺陷**，只记一条提示。
      notes.push({
        kind: 'MIGRATION_UNIQUE_BY_PRIMARY_KEY',
        where: `${item.entity}.${item.columns.join(',')}`,
        detail:
          `迁移里由**主键**（PRIMARY KEY (${exact.columns.join(',')})）提供唯一性 —— ` +
          '等价于这条唯一键，不需要再建一条同列的唯一索引（重复约束 = 写放大）',
      });
    } else {
      notes.push({
        kind: 'MIGRATION_UNIQUE_OK',
        where: `${item.entity}.${item.columns.join(',')}`,
        detail: `迁移 \`${exact.source}\` 里创建了唯一索引 \`${exact.name}\`（${exact.columns.join(',')}）`,
      });
    }

    // --- 列定义（长度 / 可空性）也要一致 -----------------------------------
    const tableColumns = migrationSchema.tables.get(table);
    if (!tableColumns) continue;
    for (const column of item.columns) {
      const entityDef = item.defs?.[column];
      if (!entityDef || entityDef.relation === true && entityDef.type === undefined) continue;
      const ddlText = tableColumns.get(column.toLowerCase());
      if (!ddlText) continue;
      const ddl = analyzeDdlColumnDef(ddlText);
      const isStringType = (type) =>
        Boolean(type) && ['varchar', 'char', 'varbinary', 'binary'].includes(type);
      if (isStringType(entityDef.type) && isStringType(ddl.type)) {
        if (
          entityDef.length !== null &&
          ddl.length !== null &&
          entityDef.length !== ddl.length
        ) {
          issues.push({
            kind: 'MIGRATION_UNIQUE_COLUMN_DEF_MISMATCH',
            where: `${item.entity}.${column}`,
            detail:
              `实体声明 \`${column}\` 是 ${entityDef.type}(${entityDef.length})，` +
              `迁移里却是 ${ddl.type}(${ddl.length}) —— ` +
              '唯一键的列被**截短**的话，两把本该不同的钥匙会被判成同一把' +
              '（或反过来：按短列建索引，长值被截断后误判冲突）',
          });
        }
      } else if (isStringType(entityDef.type) !== isStringType(ddl.type)) {
        issues.push({
          kind: 'MIGRATION_UNIQUE_COLUMN_DEF_MISMATCH',
          where: `${item.entity}.${column}`,
          detail:
            `实体声明 \`${column}\` 是 ${entityDef.type ?? '(未声明类型)' ?? '未声明类型'}，` +
            `迁移里却是 ${ddl.type ?? '未声明类型'} —— 类型族不一致，` +
            '唯一索引可能根本建不出来（TEXT / BLOB 需要前缀长度）',
        });
      }
      if (entityDef.nullable !== ddl.nullable) {
        issues.push({
          kind: 'MIGRATION_UNIQUE_COLUMN_DEF_MISMATCH',
          where: `${item.entity}.${column}`,
          detail:
            `实体声明 \`${column}\` ${entityDef.nullable ? '可空' : 'NOT NULL'}，` +
            `迁移里却是 ${ddl.nullable ? '可空' : 'NOT NULL'} —— ` +
            '可空列**不参与**唯一约束的碰撞（MySQL 的唯一索引允许多个 NULL），' +
            '防线比声明的弱',
        });
      }
    }
  }

  // --- 反向：迁移里建了、实体没声明的唯一约束 ------------------------------
  for (const entry of migrationUniques) {
    if (entry.identity) continue; // 自增主键不是业务唯一键
    const declared = discovered.find(
      (item) =>
        item.entity.toLowerCase() === entry.table &&
        keyOf(item.columns.map((column) => column.toLowerCase())) === keyOf(entry.columns),
    );
    if (declared) continue;
    issues.push({
      kind: 'MIGRATION_UNIQUE_NOT_DECLARED',
      where: `${entry.table}.${entry.columns.join(',')}`,
      detail:
        `迁移 \`${entry.source}\` 里创建了唯一约束 \`${entry.name}\`（${entry.columns.join(',')}），` +
        '但**实体里没有对应的唯一声明** —— 库比实体多一道约束：' +
        '写入会被库挡下（撞键），而实体与业务代码没准备这条唯一键的失败语义',
    });
  }

  // --- 5) 文档的索引清单 ↔ 迁移（第十一轮新增） ----------------------------
  //
  // 生产库 `synchronize: false`，跑的是迁移；而 `docs/DATABASE-DESIGN.md`
  // 是「表结构事实来源」（该文件自己写的口径）。
  // 三者（文档 / 实体 / 迁移）里，**索引名**这一层此前从未被逐条核对过：
  //   - 文档里写了、迁移里没建 → 口径与生产库分叉（读文档的人以为有那个索引）；
  //   - 迁移里建了、文档里没写 → 文档的索引清单不完整（下一轮对账无从下手）。
  // 这一层只报**能由文档与迁移直接判定**的分歧（索引名），不猜列的含义。
  const docIndexNames = new Set();
  const docDesign = readTextSafe(path.join(root(), 'docs/DATABASE-DESIGN.md'));
  if (!docDesign) {
    issues.push({
      kind: 'DOC_INDEX_LIST_MISSING',
      where: 'docs/DATABASE-DESIGN.md',
      detail:
        '找不到 `docs/DATABASE-DESIGN.md` —— 它是表结构的事实来源，' +
        '索引清单必须与迁移逐条对齐',
    });
  } else {
    for (const match of docDesign.matchAll(/`((?:uk|idx)_[a-z0-9_]+)/g)) {
      docIndexNames.add(match[1]);
    }
  }

  const migrationIndexNames = new Map();
  {
    const dir = path.join(root(), 'apps/api/src/database/migrations');
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir)
          .filter((name) => name.endsWith('.ts') && name !== 'index.ts')
          .sort()
      : [];
    for (const name of files) {
      const src = readTextSafe(path.join(dir, name));
      if (!src) continue;
      // ⚠️ 只看**会被执行**的语句（down() 是回滚，见 withoutDownMethod 的说明）。
      const body = withoutDownMethod(src);
      const patterns = [
        /name:\s*'((?:uk|idx)_[a-z0-9_]+)'/g,
        /CREATE\s+(?:UNIQUE\s+)?INDEX\s+`?((?:uk|idx)_[a-z0-9_]+)`?/gi,
      ];
      for (const pattern of patterns) {
        for (const match of body.matchAll(pattern)) {
          migrationIndexNames.set(match[1], name);
        }
      }
    }
  }

  for (const name of docIndexNames) {
    if (migrationIndexNames.has(name)) continue;
    issues.push({
      kind: 'DOC_INDEX_NOT_IN_MIGRATION',
      where: name,
      detail:
        `\`docs/DATABASE-DESIGN.md\` 的索引清单里写着 \`${name}\`，` +
        '但**迁移里没有创建它** —— 生产库跑的是迁移：' +
        '要么文档写错了，要么迁移漏了这一条（两者分叉，必须逐条判断改哪一边）',
    });
  }

  for (const [name, source] of migrationIndexNames) {
    if (docIndexNames.has(name)) continue;
    issues.push({
      kind: 'MIGRATION_INDEX_NOT_IN_DOC',
      where: name,
      detail:
        `迁移 \`${source}\` 里创建了索引 \`${name}\`，` +
        '但 `docs/DATABASE-DESIGN.md` 的索引清单里**没有它** —— ' +
        '文档是表结构的事实来源，清单不完整就没法与迁移逐条对齐',
    });
  }

  // --- 6) 实体 ↔ 迁移：三层对账（第十二轮新增，R5 扩面） --------------------
  //
  // 第十轮只核了**唯一键**这一层；第十二轮把对账扩到完整三层：
  //   1) 全部索引（含非唯一 `idx_*`）：实体有迁移没有 / 迁移有实体没有，**都报**；
  //   2) 外键：实体的 `@ManyToOne` / `@OneToOne` + `@JoinColumn` ↔ 迁移的 FOREIGN KEY；
  //   3) 全部列的类型 / 长度 / 可空性（不止唯一键的列）。
  //
  // ⚠️ **口径**：只报**能由迁移与实体直接判定**的分歧 ——
  //    枚举取值、精度、`unsigned`、`ON DELETE` 行为、默认值一律**不判**
  //    （那些要么查不到、要么改了会动到业务语义）。
  const entitySchema = discoverEntitySchema();
  const migrationIndexes = migrationSchema.indexes;
  const migrationForeignKeys = migrationSchema.foreignKeys;

  // --- 6.1 全部索引：实体声明了、迁移里没建 --------------------------------
  for (const table of entitySchema.tables.values()) {
    const primaryKey = migrationSchema.primaryKeys.get(table.table) ?? [];
    for (const index of table.indexes) {
      const found = migrationIndexes.find((item) => item.name === index.name);
      if (!found) {
        // ⚠️ **主键等价**：唯一索引的列就是主键 → 主键天然唯一，
        //    不必再建一条同列的唯一索引（重复约束 = 写放大）。
        if (index.unique && primaryKey.length && keyOf(index.columns) === keyOf(primaryKey)) {
          notes.push({
            kind: 'MIGRATION_INDEX_BY_PRIMARY_KEY',
            where: `${table.table}.${index.name}`,
            detail:
              `迁移里由**主键**（PRIMARY KEY (${primaryKey.join(',')})）提供唯一性 —— ` +
              '等价于这条唯一索引，不需要再建一条同列的（重复约束 = 写放大）',
          });
          continue;
        }
        issues.push({
          kind: 'MIGRATION_INDEX_MISSING',
          where: `${table.table}.${index.name}`,
          detail:
            `实体类 \`${table.className}\`（${table.file}）声明了索引 ` +
            `\`${index.name}\`（列：${index.columns.join(',')}${index.unique ? '，唯一' : ''}），` +
            '但**迁移里没有创建它** —— 生产库 `synchronize: false`，跑的是迁移：' +
            '生产库上**这个索引不存在**，按该列的查询会退化成全表扫。' +
            '修法二选一（**必须逐条判断**）：补一条 TypeORM 迁移，或去掉实体里的声明',
        });
        continue;
      }
      if (found.table !== table.table) {
        issues.push({
          kind: 'MIGRATION_INDEX_TABLE_MISMATCH',
          where: `${table.table}.${index.name}`,
          detail:
            `实体在 \`${table.table}\` 上声明了索引 \`${index.name}\`，` +
            `迁移却把它建在了 \`${found.table}\` 上（迁移 \`${found.source}\`）—— ` +
            '这张表上**没有**那个索引',
        });
        continue;
      }
      if (keyOf(found.columns) !== keyOf(index.columns)) {
        issues.push({
          kind: 'MIGRATION_INDEX_COLUMN_MISMATCH',
          where: `${table.table}.${index.name}`,
          detail:
            `实体类 \`${table.className}\`（${table.file}）声明的索引 ` +
            `\`${index.name}\` 是（${index.columns.join(',')}），` +
            `迁移 \`${found.source}\` 里建的却是（${found.columns.join(',')}）—— 列集合不一致：` +
            '按哪个列组合建的索引，决定了哪些查询能用上它',
        });
        continue;
      }
      if (Boolean(found.unique) !== Boolean(index.unique)) {
        issues.push({
          kind: 'MIGRATION_INDEX_UNIQUENESS_MISMATCH',
          where: `${table.table}.${index.name}`,
          detail:
            `实体声明的索引 \`${index.name}\` 是${index.unique ? '**唯一**' : '非唯一'}索引，` +
            `迁移里建的却是${found.unique ? '**唯一**' : '非唯一'}索引 —— ` +
            '唯一性不同 → 约束强度不同（唯一索引会让撞键直接报错）',
        });
        continue;
      }
      notes.push({
        kind: 'MIGRATION_INDEX_OK',
        where: `${table.table}.${index.name}`,
        detail: `迁移 \`${found.source}\` 里创建了索引 \`${index.name}\`（${found.columns.join(',')}）`,
      });
    }
  }

  // --- 6.2 反向：迁移里建了、实体没声明的索引 ------------------------------
  for (const index of migrationIndexes) {
    const table = entitySchema.tables.get(index.table);
    if (!table) continue; // 没有实体类的表不判（无法判定）
    if (table.indexes.some((item) => item.name === index.name)) continue;
    // 唯一索引可能由实体里的 `unique: true` 声明（R5 已按**列集合**对账）
    if (index.unique) {
      const declared = [...table.columns.values()].some(
        (column) => column.unique && column.column === index.columns[0],
      );
      if (declared) {
        notes.push({
          kind: 'MIGRATION_INDEX_BY_UNIQUE_COLUMN',
          where: `${index.table}.${index.name}`,
          detail:
            `迁移里的唯一索引 \`${index.name}\`（${index.columns.join(',')}）` +
            '对应实体里的 `unique: true` 列声明 —— 唯一性已由 R5 的列集合对账覆盖',
        });
        continue;
      }
    }
    issues.push({
      kind: 'MIGRATION_INDEX_NOT_DECLARED',
      where: `${index.table}.${index.name}`,
      detail:
        `迁移 \`${index.source}\` 里创建了索引 \`${index.name}\`（${index.columns.join(',')}${index.unique ? '，唯一' : ''}），` +
        '但**实体里没有对应的索引声明** —— 库比实体多一道索引：' +
        '（唯一的那些会直接让写入撞键；非唯一的会让查询计划与实体声明对不上）',
    });
  }

  // --- 6.3 外键：实体声明了、迁移里没建 ------------------------------------
  for (const table of entitySchema.tables.values()) {
    for (const relation of table.relations) {
      const key = `${table.table}.${relation.column}`;
      const found = migrationForeignKeys.get(key);
      if (!found) {
        issues.push({
          kind: 'ENTITY_FOREIGN_KEY_MISSING',
          where: `${table.table}.${relation.column}`,
          detail:
            `实体把 \`${relation.column}\` 声明成指向 \`${relation.targetTable}\` 的关系` +
            `（${relation.kind}，属性 ${relation.prop}），但**迁移里没有对应的外键** —— ` +
            '生产库上**引用完整性不被数据库保证**：写入可以指向不存在的行，' +
            '删除被引用的行也不会被拦下',
        });
        continue;
      }
      if (
        found.refTable !== relation.targetTable ||
        found.refColumn !== relation.referencedColumn
      ) {
        issues.push({
          kind: 'FOREIGN_KEY_TARGET_MISMATCH',
          where: `${table.table}.${relation.column}`,
          detail:
            `实体声明 \`${relation.column}\` 指向 \`${relation.targetTable}\`（${relation.referencedColumn ?? '?'}），` +
            `迁移里的外键 \`${found.name}\` 却指向 \`${found.refTable}\`（${found.refColumn ?? '?'}）—— ` +
            '指向不同的表/列：实体与生产库说的不是一回事',
        });
        continue;
      }
      notes.push({
        kind: 'FOREIGN_KEY_OK',
        where: `${table.table}.${relation.column}`,
        detail:
          `迁移 \`${found.source}\` 里 \`${found.name}\` 指向 ` +
          `\`${found.refTable}\`（${found.refColumn}）`,
      });
    }
  }

  // --- 6.4 反向：迁移里建了、实体没声明的外键 ------------------------------
  for (const foreignKey of migrationForeignKeys.values()) {
    const table = entitySchema.tables.get(foreignKey.table);
    if (!table) continue;
    if (table.relations.some((item) => item.column === foreignKey.column)) continue;
    issues.push({
      kind: 'MIGRATION_FOREIGN_KEY_NOT_DECLARED',
      where: `${foreignKey.table}.${foreignKey.column}`,
      detail:
        `迁移 \`${foreignKey.source}\` 里 \`${foreignKey.name}\` 把 \`${foreignKey.column}\`` +
        `约束到 \`${foreignKey.refTable}\`（${foreignKey.refColumn}），` +
        '但**实体里没有对应的关系声明** —— 库比实体多一道外键：' +
        '写入会被库挡下（外键失败），而实体与业务代码没准备这个约束',
    });
  }

  // --- 6.5 全部列的定义（类型 / 长度 / 可空性） ----------------------------
  for (const table of entitySchema.tables.values()) {
    const migrationColumns = migrationSchema.tables.get(table.table);
    if (!migrationColumns) {
      issues.push({
        kind: 'MIGRATION_TABLE_MISSING',
        where: table.table,
        detail:
          `实体声明了表 \`${table.table}\`（${table.className}），但**迁移里没有建这张表** —— ` +
          '生产库 `synchronize: false`，跑的是迁移：这张表在生产库上根本不存在',
      });
      continue;
    }
    for (const column of table.columns.values()) {
      const ddlText = migrationColumns.get(column.column);
      if (!ddlText) {
        issues.push({
          kind: 'MIGRATION_COLUMN_MISSING',
          where: `${table.table}.${column.column}`,
          detail:
            `实体声明了列 \`${column.column}\`（${table.className}.${column.prop}），` +
            '但**迁移里没有这一列** —— 生产库上读写这一列会直接报「未知列」',
        });
        continue;
      }
      const ddl = analyzeDdlColumnDef(ddlText);
      // 类型
      if (column.type && ddl.type && normalizeType(column.type) !== normalizeType(ddl.type)) {
        issues.push({
          kind: 'MIGRATION_COLUMN_DEF_MISMATCH',
          where: `${table.table}.${column.column}`,
          detail:
            `实体声明 \`${column.column}\` 是 ${column.type}，` +
            `迁移里却是 ${ddl.type} —— 类型不一致：` +
            '读出来的值类型会变（日期变成字符串、数值精度丢失……），' +
            '长度上限不同还会导致写入被截断',
        });
        continue;
      }
      // 长度（只对**字符串族**判：整数族的「长度」是显示宽度，不是容量）
      if (
        isStringType(column.type) &&
        isStringType(ddl.type) &&
        column.length !== null &&
        ddl.length !== null &&
        column.length !== ddl.length
      ) {
        issues.push({
          kind: 'MIGRATION_COLUMN_DEF_MISMATCH',
          where: `${table.table}.${column.column}`,
          detail:
            `实体声明 \`${column.column}\` 是 ${column.type}(${column.length})，` +
            `迁移里却是 ${ddl.type}(${ddl.length}) —— 长度不一致：` +
            '库里的上限更小的话，超长写入会被**静默截断**（数据丢失）',
        });
        continue;
      }
      // 可空性
      if (column.nullable !== ddl.nullable) {
        issues.push({
          kind: 'MIGRATION_COLUMN_DEF_MISMATCH',
          where: `${table.table}.${column.column}`,
          detail:
            `实体声明 \`${column.column}\` ${column.nullable ? '可空' : 'NOT NULL'}，` +
            `迁移里却是 ${ddl.nullable ? '可空' : 'NOT NULL'} —— 可空性不一致：` +
            'NOT NULL 的列写进 NULL 会直接报错，可空的列在实体里却被当成一定有值',
        });
      }
    }
    // 反向：迁移里多出来的列
    for (const column of migrationColumns.keys()) {
      if (table.columns.has(column)) continue;
      issues.push({
        kind: 'MIGRATION_COLUMN_NOT_DECLARED',
        where: `${table.table}.${column}`,
        detail:
          `迁移里 \`${table.table}\` 有列 \`${column}\`，但**实体里没有这一列** —— ` +
          '库比实体多一列：任何 `synchronize: true` 的环境都会把它删掉，' +
          '而生产库上它一直在（两边对这一列的理解不一致）',
      });
    }
  }

  const report = {
    reviewedUniqueKeys: UNIQUE_KEY_REGISTRY.length,
    discoveredUniqueKeys: discovered.length,
    migrationUniqueConstraints: migrationUniques.length,
    docIndexNames: docIndexNames.size,
    migrationIndexNames: migrationIndexNames.size,
    entityTables: entitySchema.tables.size,
    entityIndexes: [...entitySchema.tables.values()].reduce(
      (total, table) => total + table.indexes.length,
      0,
    ),
    migrationIndexes: migrationIndexes.length,
    entityForeignKeys: [...entitySchema.tables.values()].reduce(
      (total, table) => total + table.relations.length,
      0,
    ),
    migrationForeignKeys: migrationForeignKeys.size,
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
        `✅ 写操作的错误语义对账通过：` +
          `${report.discoveredUniqueKeys} 个唯一键全部登记，` +
          `每个都有可预期的处置与文档口径；` +
          `迁移层也有对应的唯一约束（${report.migrationUniqueConstraints} 条，` +
          `含自增主键）—— 生产库跑的是迁移，那道防线真实存在\n`,
      );
    } else {
      for (const issue of issues) {
        process.stdout.write(`❌ [${issue.kind}] ${issue.where}\n     ${issue.detail}\n`);
      }
      process.stdout.write(`\n❌ 发现 ${issues.length} 处错误语义不一致\n`);
    }
  }

  process.exit(issues.length > 0 ? 1 : 0);
}

/* ------------------------------ 导出 ------------------------------ */

/**
 * 供别的脚本复用（`check-db-reality.mjs` 要拿**同一份**登记表与
 * **同一套**迁移解析 —— 两边各算各的就会出现「静态说有、库里没有」的假绿）。
 */
export {
  UNIQUE_KEY_REGISTRY,
  discoverUniqueKeys,
  discoverMigrationSchema,
  discoverEntitySchema,
  analyzeDdlColumnDef,
  analyzeEntityColumnArgs,
  parseEntityConstArrays,
};

/**
 * 只有**被直接执行**时才跑主流程。
 *
 * ⚠️ 被 `import` 时不能跑：导入方（数据库侧对账脚本）只想拿数据，
 *    不想被这个脚本的 `process.exit` 打断。
 */
const invokedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) main();
