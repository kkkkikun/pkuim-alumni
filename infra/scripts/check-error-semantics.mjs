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
 * 本脚本对账四件事：
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
 *   4) **反向验证**（`check-error-semantics-selftest.sh`）：
 *      本脚本自己也被反向验证过 —— 三类「语义失配」缺陷都必须被抓出、退出码非 0。
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

/* ------------------------------ 参数 ------------------------------ */

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const ROOT = path.resolve(argValue('--root', process.cwd()));
const AS_JSON = args.includes('--json');
const LIST_ONLY = args.includes('--list');

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
 * 取一个类里带唯一约束的**列组合**。
 *
 * 认三种形态：
 *   - `@Column({ ..., unique: true })` —— 单列唯一索引；
 *   - `@PrimaryColumn({ name: 'key', ... })` —— 主键天然唯一
 *     （`system_settings.key`、字典表的 `code` 就是这种）；
 *   - 类级 `@Index('uk_x', ['a','b'], { unique: true })` —— **复合**唯一索引
 *     （用户侧的连接对、活动报名、附件挂载都是这种）。
 *
 * @returns {string[][] | null} 每个唯一键的列名数组；类不存在时返回 null
 */
function uniqueColumnsOf(src, className) {
  const block = classBlock(src, className);
  if (!block) return null;
  const columns = [];

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
    unique.push(item);
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
  const dir = path.join(ROOT, 'apps/api/src/database/entities');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.endsWith('.ts')).sort()
    : [];
  const discovered = [];
  for (const name of files) {
    const rel = `apps/api/src/database/entities/${name}`;
    const src = readTextSafe(path.join(ROOT, rel));
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
          columns: item,
          key: keyOf(item),
        });
      }
    }
  }
  return discovered;
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
  const src = readTextSafe(path.join(ROOT, guard.file));
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
  const src = readTextSafe(path.join(ROOT, 'docs/API-SPEC.md'));
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

  const report = {
    reviewedUniqueKeys: UNIQUE_KEY_REGISTRY.length,
    discoveredUniqueKeys: discovered.length,
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
          `每个都有可预期的处置与文档口径\n`,
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

main();
