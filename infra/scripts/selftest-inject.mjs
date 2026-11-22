#!/usr/bin/env node
/**
 * 校验器反向验证 —— 缺陷注入器。
 *
 * 用法：node infra/scripts/selftest-inject.mjs <case> <copyRoot>
 *
 * 只在**临时副本**里操作（由 backup-restore-drill-selftest / check-frontend-selftest
 * 创建），绝不触碰真实工作副本。每个 case 制造一类**真实缺陷**，
 * 用来证明对应的校验器确实会报错，而不是恒过。
 *
 * 注入 case 与期望错误码：
 *   mini-page-not-registered      → PAGE_NOT_REGISTERED
 *   mini-handler-missing          → HANDLER_MISSING
 *   mini-component-missing        → COMPONENT_MISSING
 *   admin-route-component-missing → ROUTE_COMPONENT_MISSING
 *   admin-permission-not-contract → PERMISSION_NOT_IN_CONTRACT
 *   spec-page-not-in-matrix       → PAGE_NOT_IN_MATRIX
 *   spec-api-group-missing        → API_GROUP_NOT_IMPLEMENTED
 *   doc-endpoint-missing          → DOC_ENDPOINT_MISSING
 *   paths-route-not-found         → ROUTE_NOT_FOUND
 *   coverage-new-endpoint         → 端点覆盖校验（新增未测端点必须被抓出）
 *   coverage-remove-call          → 端点覆盖校验（删除调用点后端点必须变未覆盖）
 *   swagger-param-declared-unused → 声明参数消费（DTO 声明了但 handler 不用）
 *   swagger-param-service-drop    → 声明参数消费（整体透传后 service 丢弃筛选条件）
 *   swagger-param-own-helper-drop → 声明参数消费（整体透传给控制器私有方法，私有方法丢弃字段）
 *   body-dto-to-any              → 请求体 DTO 校验（改成 any → 运行时跳过校验）
 *   body-dto-to-inline           → 请求体 DTO 校验（改成内联字面量 → 运行时跳过校验）
 *   body-dto-no-validator        → 请求体 DTO 校验（删掉 class-validator 装饰器 → 不触发校验）
 *   query-dto-to-intersection    → 查询 DTO 校验（改成交叉类型 → 运行时 metatype 退化成 Object）
 *   enum-dto-not-in-db          → 枚举一致性（DTO 放行了数据库不接受的枚举值）
 *   enum-status-not-validated   → 枚举一致性（状态筛选字段退回裸 string）
 *   enum-wrong-table-binding    → 枚举一致性（DTO 放行了**别的表**才有的枚举值）
 *   enum-contract-wrong-table   → 枚举一致性（契约承诺了**别的表**才有的枚举值）
 *   tx-escape-in-transaction     → 事务逃逸（事务里用注入仓储写入 → 跳出事务）
 *   multi-step-no-transaction    → 多步写候选（方法内两次写且没有事务）
 *   dead-error-code             → 错误码对账（契约声明了服务端从不返回的死码）
 *   contract-missing-code       → 错误码对账（服务端会返回但契约里没有的码）
 *   status-code-assertion-stale → 状态码对账（服务端改成 200 了，测试仍断言 201）
 *   concurrent-upsert-unprotected → 并发撞唯一键（先查后插且没有唯一键兜底）
 *   concurrent-upsert-safe-cross-table → 并发撞唯一键（读 A 插 B —— **不得**误报）
 *   swagger-param-multiline-decorator → 声明参数消费（多行装饰器不得被当成字段）
 *   error-semantics-conflict-mapping-removed → 错误语义对账（唯一键冲突被改回 500）
 *   error-semantics-new-unique-column     → 错误语义对账（新增唯一列却没登记失败语义）
 *   error-semantics-doc-row-removed        → 错误语义对账（口径改了但文档没改）
 *   error-semantics-user-conflict-mapping-removed      → 用户侧：报名撞键的处置被删掉
 *   error-semantics-user-unique-key-unregistered       → 用户侧：新增唯一列却没登记
 *   error-semantics-composite-unique-key-unregistered  → 用户侧：新增**复合**唯一索引却没登记
 *   error-semantics-user-doc-row-removed              → 用户侧：口径改了但文档没改
 *   error-semantics-migration-unique-missing           → 迁移层：唯一索引**没建**（生产库没有那道防线）
 *   error-semantics-migration-unique-columns-changed   → 迁移层：唯一索引的**列**与实体对不上
 *   error-semantics-migration-unique-not-declared      → 迁移层：迁移建了实体没声明的唯一约束
 *   error-semantics-doc-index-not-in-migration         → 文档索引清单：文档写了迁移里没有的索引
 *   error-semantics-migration-index-not-in-doc         → 文档索引清单：迁移建了文档里没写的索引
 *   error-semantics-entity-index-missing-in-migration   → 实体 ↔ 迁移：**实体有、迁移没有**的索引
 *   error-semantics-migration-index-not-declared       → 实体 ↔ 迁移：**迁移有、实体没有**的索引
 *   error-semantics-column-length-mismatch             → 实体 ↔ 迁移：同一列的**长度**不一致
 *   error-semantics-entity-foreign-key-missing         → 实体 ↔ 迁移：实体声明了、迁移里没有的外键
 *   error-semantics-foreign-key-target-mismatch        → 实体 ↔ 迁移：外键的**指向**不一致
 *   error-semantics-column-default-mismatch              → 实体 ↔ 迁移：同一列的**默认值**不一致
 *   error-semantics-column-unsigned-mismatch             → 实体 ↔ 迁移：同一列的**无符号性**不一致
 *   error-semantics-column-enum-mismatch                → 实体 ↔ 迁移：同一列的**枚举取值**不一致
 *   unique-index-db-registry-injected → 库内对账：登记表要求、但**库里其实没有**的唯一键
 *   migration-schema-db-entity-index-injected  → 库内实况：实体声明了、但**库里其实没有**的索引
 *   migration-schema-db-index-columns-injected  → 库内实况：索引的**列**与库里对不上
 *   migration-schema-db-column-length-injected  → 库内实况：同一列的**长度**不一致
 *   migration-schema-db-column-nullable-injected → 库内实况：同一列的**可空性**不一致
 *   migration-schema-db-foreign-key-injected     → 库内实况：实体声明了、但**库里其实没有**的外键
 *   migration-schema-db-column-default-injected   → 库内实况：同一列的**默认值**不一致
 *   migration-schema-db-column-unsigned-injected  → 库内实况：同一列的**无符号性**不一致
 *   migration-schema-db-column-enum-injected      → 库内实况：同一列的**枚举取值**不一致
 *   read-visibility-filter-removed    → 读端点可见性：**可见性过滤被删掉**（未发布内容凭 id 就能读到）
 *   read-visibility-status-changed    → 读端点可见性：「不可见 → 404」被改成 403（泄露存在性）
 *   read-visibility-endpoint-unregistered → 读端点可见性：新增公开读端点却**没登记口径**
 *   read-visibility-doc-row-removed   → 读端点可见性：API-SPEC 里的可见性口径那一行被删掉
 *   read-visibility-known-issue-removed → 读端点可见性：待拍板条目（#197）被从 KNOWN-ISSUES 删掉
 *   read-visibility-pending-resolved  → 读端点可见性：待拍板端点的行为被改掉（登记表过期）
 *   read-visibility-auth-403-changed-to-404 → 已登录端点：「无权 → 403」被改成 404
 *   read-visibility-auth-endpoint-unregistered → 已登录端点：新增端点却**没登记可见性分界**
 *   read-visibility-auth-doc-row-removed → 已登录端点：API-SPEC 里的那一行被删掉
 *   read-visibility-admin-404-removed → 管理端：「资源不存在 → 404」的处置被删掉
 *   read-visibility-admin-endpoint-unregistered → 管理端：新增端点却**没登记可见性分界**
 *   read-visibility-admin-doc-row-removed → 管理端：API-SPEC 里的那一行被删掉
 */

import fs from 'node:fs';
import path from 'node:path';

const [caseName, copyRoot] = process.argv.slice(2);
if (!caseName || !copyRoot) {
  console.error('用法：node selftest-inject.mjs <case> <copyRoot>');
  process.exit(2);
}

const MINI = path.join(copyRoot, 'apps/miniprogram/src');
const ADMIN = path.join(copyRoot, 'apps/admin-web/src');

const readText = (file) => fs.readFileSync(file, 'utf8');
const writeText = (file, content) => fs.writeFileSync(file, content, 'utf8');
const readJson = (file) => JSON.parse(readText(file));
const writeJson = (file, data) => writeText(file, `${JSON.stringify(data, null, 2)}\n`);

/** 找一个存在的页面 wxml（排除 tabBar 页面，避免影响其它检查） */
function pickPageWxml() {
  const appJson = readJson(path.join(MINI, 'app.json'));
  const pages = appJson.pages ?? [];
  const candidate = pages.find((p) => !p.startsWith('pages/home/')) ?? pages[0];
  return path.join(MINI, `${candidate}.wxml`);
}

function replaceOnce(file, pattern, replacement) {
  const src = readText(file);
  if (!pattern.test(src)) {
    throw new Error(`注入失败：${file} 中找不到目标模式 ${pattern}`);
  }
  writeText(file, src.replace(pattern, replacement));
}

/** 替换**所有**匹配（用于「把某一类处置整体改掉」这类注入） */
function replaceAllText(file, pattern, replacement) {
  const src = readText(file);
  if (!pattern.test(src)) {
    throw new Error(`注入失败：${file} 中找不到目标模式 ${pattern}`);
  }
  writeText(file, src.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), replacement));
}

const injectors = {
  /* 小程序：页面文件存在但没在 app.json 注册 → 运行时无法被导航到 */
  'mini-page-not-registered'() {
    const file = path.join(MINI, 'app.json');
    const appJson = readJson(file);
    if (appJson.pages.length < 2) throw new Error('注入失败：pages 数量不足');
    appJson.pages.splice(1, 1);
    writeJson(file, appJson);
  },

  /* 小程序：WXML 绑定了 TS 里不存在的方法 → 点击无反应 */
  'mini-handler-missing'() {
    const file = pickPageWxml();
    writeText(file, `${readText(file)}\n<view bindtap="__selftestMissingHandler__"></view>\n`);
  },

  /* 小程序：usingComponents 指向不存在的组件 → 渲染失败 */
  'mini-component-missing'() {
    const wxml = pickPageWxml();
    const jsonFile = wxml.replace(/\.wxml$/, '.json');
    const json = fs.existsSync(jsonFile) ? readJson(jsonFile) : {};
    json.usingComponents = { ...(json.usingComponents ?? {}), '__selftest-missing': '/components/__selftest-missing__/__selftest-missing' };
    writeJson(jsonFile, json);
  },

  /* 管理后台：路由指向不存在的视图组件 → 打开页面白屏 */
  'admin-route-component-missing'() {
    const file = path.join(ADMIN, 'router/index.ts');
    replaceOnce(file, /@\/views\/[A-Za-z0-9_\-/]+\.vue/, '@/views/__SelftestMissingView.vue');
  },

  /* 管理后台：路由声明了契约里没有的权限点 → 权限守卫行为不可预期 */
  'admin-permission-not-contract'() {
    const file = path.join(ADMIN, 'router/index.ts');
    replaceOnce(file, /requiredPermission:\s*'[^']+'/, "requiredPermission: '__selftest:permission'");
  },

  /* 需求覆盖矩阵：app.json 注册了矩阵未覆盖的页面 → 需求与实现脱节 */
  'spec-page-not-in-matrix'() {
    const file = path.join(MINI, 'app.json');
    const appJson = readJson(file);
    appJson.pages.push('pages/selftest/index');
    writeJson(file, appJson);

    const dir = path.join(MINI, 'pages/selftest/index');
    fs.mkdirSync(dir, { recursive: true });
    writeText(path.join(dir, 'index.ts'), 'Page({\n  data: {},\n});\n');
    writeText(path.join(dir, 'index.wxml'), '<view>selftest</view>\n');
    writeText(path.join(dir, 'index.json'), '{}\n');
  },

  /* 需求覆盖矩阵：登记了服务端根本没有实现的 API 分组 */
  'spec-api-group-missing'() {
    const file = path.join(copyRoot, 'docs/SPEC-COVERAGE.json');
    const matrix = readJson(file);
    matrix.apiGroups = [...(matrix.apiGroups ?? []), { requirement: '自测注入', path: '/selftest-group' }];
    writeJson(file, matrix);
  },

  /* 接口文档：API-SPEC 写了服务端不存在的端点 */
  'doc-endpoint-missing'() {
    const file = path.join(copyRoot, 'docs/API-SPEC.md');
    const lines = readText(file).split('\n');
    const index = lines.findIndex((line) => /^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|/.test(line));
    if (index < 0) throw new Error('注入失败：API-SPEC 里找不到端点表');
    lines.splice(index, 0, '| GET | `/selftest/missing` | 自测注入的假端点 | 登录 |');
    writeText(file, lines.join('\n'));
  },

  /* 客户端路径：调用点指向服务端没有注册的路径 → 运行时 404
   * 契约与镜像表同步加同一个键，保证镜像一致性检查不先报错，
   * 真正被触发的是「调用点路径在服务端不存在」。 */
  'paths-route-not-found'() {
    const contractFile = path.join(copyRoot, 'packages/contracts/src/api.ts');
    replaceOnce(
      contractFile,
      /export const ApiPaths = \{/,
      "export const ApiPaths = {\n  __selftestMissing: '/selftest/not-exist',",
    );

    const mirrorFile = path.join(MINI, 'services/paths.ts');
    replaceOnce(
      mirrorFile,
      /export const ApiPaths = \{/,
      "export const ApiPaths = {\n  __selftestMissing: '/selftest/not-exist',",
    );

    const file = path.join(MINI, 'services/directory.ts');
    replaceOnce(file, /ApiPaths\.directory/, 'ApiPaths.__selftestMissing');
  },

  /* 小程序绕过契约镜像表、直接写字面量路径 → 契约改路径时不会同步 */
  'mirror-literal-path'() {
    const file = path.join(MINI, 'services/directory.ts');
    replaceOnce(file, /ApiPaths\.directory/, "'/directory'");
  },

  /* 契约：新增一个服务端根本没实现的路径键 */
  'contract-route-missing'() {
    const file = path.join(copyRoot, 'packages/contracts/src/api.ts');
    replaceOnce(
      file,
      /export const ApiPaths = \{/,
      "export const ApiPaths = {\n  __selftestMissing: '/selftest/not-exist',",
    );
  },

  /* 服务端：Swagger 里塞一条契约没有声明的路由（对 <copyRoot>/swagger.json 生效） */
  'swagger-extra-route'() {
    const file = path.join(copyRoot, 'swagger.json');
    const doc = readJson(file);
    doc.paths ??= {};
    doc.paths['/api/v1/selftest/not-exist'] = {
      get: { summary: '自测注入的假路由', responses: { '200': { description: 'ok' } } },
    };
    writeJson(file, doc);
  },

  /* 端点覆盖：新增一条服务端端点，但没有任何测试调用它 */
  'coverage-new-endpoint'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/admin/admin.controller.ts');
    replaceOnce(
      file,
      /(\n\s*)@Get\('stats'\)/,
      `$1@Get('selftest-uncovered')\n  @ApiOperation({ summary: '自测注入的未覆盖端点' })\n  selftestUncovered() {\n    return { ok: true };\n  }\n$1@Get('stats')`,
    );
  },

  /* RBAC 矩阵：前端硬编码的角色权限与种子不一致 */
  'rbac-matrix-drift'() {
    const file = path.join(copyRoot, 'apps/admin-web/src/stores/auth.ts');
    replaceOnce(
      file,
      /alumni_reviewer: \['alumni:view', 'alumni:manage', 'verification:review', 'audit:view'\],/,
      "alumni_reviewer: ['alumni:view', 'verification:review', 'audit:view'],",
    );
  },

  /* 契约镜像：小程序本地类型副本与契约分叉（字段少了） */
  'mirror-type-drift'() {
    const file = path.join(copyRoot, 'apps/miniprogram/src/types/index.ts');
    replaceOnce(
      file,
      /export interface ArticleCategoryDto \{/,
      'export interface ArticleCategoryDto {\n'
        + '  /** 自测注入：镜像副本少了字段 */\n'
        + '  selftestDriftedField?: string;',
    );
  },

  /* 端点覆盖：把某个测试里的调用点改掉，让对应端点不再被触达 */
  'coverage-remove-call'() {
    // ⚠️ 必须把**所有**调用点都改掉：
    //    `GET /system/health` 现在有**两处**调用（read-coverage + ops-invalidation-bus，
    //    后者是第十六轮加的）。只改一处的话，端点仍被另一个套件触达 →
    //    覆盖校验器**正确地**判它「已覆盖」→ 反向验证会误判「校验器恒过」。
    //    这不是校验器的问题，是**注入不够狠**。
    const dir = path.join(copyRoot, 'apps/api/test');
    let changed = 0;
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith('.ts')) continue;
        const src = readText(full);
        if (!src.includes('${API}/system/health')) continue;
        writeText(full, src.split('${API}/system/health').join('${API}/system/health-disabled'));
        changed += 1;
      }
    };
    walk(dir);
    if (changed === 0) {
      throw new Error('注入失败：测试树里找不到任何 `${API}/system/health` 调用点');
    }
  },

  /* 请求契约：客户端多发一个服务端没声明的查询参数（会被静默忽略） */
  'request-extra-query-param'() {
    const file = path.join(copyRoot, 'apps/admin-web/src/api/admin.ts');
    replaceOnce(
      file,
      /export interface AdminVerificationQuery extends PagedQuery \{/,
      'export interface AdminVerificationQuery extends PagedQuery {\n'
        + '  /** 自测注入：服务端未声明的查询参数 */\n'
        + '  selftestBogusFilter?: string;',
    );
  },

  /* 请求契约：客户端多发一个服务端 schema 里没有的请求体字段（会被 whitelist 剥掉） */
  'request-extra-body-field'() {
    // 注意：打在**小程序本地类型副本**上，而不是契约 ——
    // 小程序无法在运行时引用 @nmg/contracts，它用的是自己那份镜像。
    const file = path.join(copyRoot, 'apps/miniprogram/src/types/index.ts');
    replaceOnce(
      file,
      /export interface UpdateProfileBody \{/,
      'export interface UpdateProfileBody {\n'
        + '  /** 自测注入：服务端 schema 里没有的字段 */\n'
        + '  selftestExtraContact?: string;',
    );
  },

  /* 声明参数消费：DTO 声明了一个 handler 从不使用的筛选参数（Swagger 会公布，但服务端丢弃） */
  'swagger-param-declared-unused'() {
    const file = path.join(copyRoot, 'apps/api/src/common/dto/list-query.dto.ts');
    replaceOnce(
      file,
      /export class AdminVerificationListQueryDto extends PaginationQueryDto \{/,
      'export class AdminVerificationListQueryDto extends PaginationQueryDto {\n'
        + '  /** 自测注入：声明了但 handler 从不使用的筛选参数 */\n'
        + '  selftestUnusedFilter?: string;',
    );
  },

  /* 声明参数消费：handler 把 body 整体交给控制器自己的私有方法，但私有方法里那个字段被删掉了
   * （对应校验器盲点：只认 service 调用 → 会漏掉 `this.someHelper(body)` 这种） */
  'swagger-param-own-helper-drop'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/admin/admin-users.controller.ts');
    replaceOnce(
      file,
      /      reason: body\.reason \?\? null,\n/,
      '',
    );
  },

  /* 请求体 DTO 校验：把 DTO 类型改成 any → 运行时会被 ValidationPipe 跳过 */
  'body-dto-to-any'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/uploads/uploads.controller.ts');
    replaceOnce(
      file,
      /@Body\(\) body: CreateUploadBodyDto/,
      '@Body() body: any',
    );
  },

  /* 请求体 DTO 校验：把 DTO 类型改成内联对象字面量 → 运行时 metatype 是 Object */
  'body-dto-to-inline'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/events/events.controller.ts');
    replaceOnce(
      file,
      /@Body\(\) body: RegisterEventBodyDto/,
      '@Body() body: { note?: string }',
    );
  },

  /* 请求体 DTO 校验：把 DTO 上的 class-validator 装饰器全删掉 → 运行时不会触发任何校验 */
  'body-dto-no-validator'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/uploads/dto/upload.dto.ts');
    const src = readText(file);
    const start = src.indexOf('export class CreateUploadBodyDto');
    if (start < 0) throw new Error('注入失败：找不到 CreateUploadBodyDto');
    const head = src.slice(0, start);
    const tail = src
      .slice(start)
      .replace(/^\s*@(Is\w*|Max\w*|Min\w*|Type|Validate\w*|Allow)\([^\n]*\)\n/gm, '');
    writeText(file, head + tail);
  },

  /* 请求参数 DTO 校验：把查询 DTO 改成交叉类型 → 运行时 metatype 退化成 Object */
  'query-dto-to-intersection'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/admin/admin.controller.ts');
    replaceOnce(
      file,
      /@Query\(\) query: AdminAlumniListQueryDto/,
      '@Query() query: PaginationQueryDto & { keyword?: string }',
    );
  },

  /* 枚举一致性：DTO 的 @IsIn 放行了一个数据库 ENUM 里没有的值 → 落库会 500 */
  'enum-dto-not-in-db'() {
    const file = path.join(copyRoot, 'apps/api/src/common/dto/list-query.dto.ts');
    replaceOnce(
      file,
      /@IsIn\(\['active', 'disabled', 'locked'\]\)/,
      "@IsIn(['active', 'disabled', 'locked', 'frozen'])",
    );
  },

  /* 枚举一致性：状态筛选字段退回裸 string → 非法值静默返回空列表 */
  'enum-status-not-validated'() {
    const file = path.join(copyRoot, 'apps/api/src/common/dto/list-query.dto.ts');
    replaceOnce(
      file,
      /  @IsIn\(\['pending', 'needs_more_material', 'approved', 'rejected', 'resubmitted'\]\)\n/,
      '  @IsString()\n',
    );
  },

  /* 枚举一致性（表绑定）：管理员账号的筛选放行 'locked' ——
   * users.status 里恰好有这三个值，R1 判过；只有「绑定到 admin_users.status」才抓得住 */
  'enum-wrong-table-binding'() {
    const file = path.join(copyRoot, 'apps/api/src/common/dto/list-query.dto.ts');
    replaceOnce(
      file,
      /  @ApiPropertyOptional\(\{ enum: \['active', 'disabled'\] \}\)\n  @IsIn\(\['active', 'disabled'\]\)/,
      "  @ApiPropertyOptional({ enum: ['active', 'disabled', 'locked'] })\n" +
        "  @IsIn(['active', 'disabled', 'locked'])",
    );
  },

  /* 枚举一致性（契约 ↔ 表绑定）：契约把管理员状态写成 UserStatus ——
   * 内联字面量没有，但类型别名能解析出来，且能看出它与 admin_users.status 不符 */
  'enum-contract-wrong-table'() {
    const file = path.join(copyRoot, 'packages/contracts/src/domain.ts');
    replaceOnce(file, /  status: 'active' \| 'disabled';/, '  status: UserStatus;');
  },

  /* 声明参数消费：把 DTO 的状态筛选写成**多行**装饰器
   * → 校验器若不剥装饰器，会把装饰器里的 `enum:` 当成字段名（误报「参数 enum 未被消费」） */
  'swagger-param-multiline-decorator'() {
    const file = path.join(copyRoot, 'apps/api/src/common/dto/list-query.dto.ts');
    replaceOnce(
      file,
      /  @ApiPropertyOptional\(\{ enum: \['active', 'disabled', 'locked'\], description: '账号状态' \}\)\n/,
      "  @ApiPropertyOptional({\n    enum: ['active', 'disabled', 'locked'],\n    description: '账号状态',\n  })\n",
    );
  },

  /* 错误码对账：契约里声明一个服务端从不返回的错误码（死码） */
  'dead-error-code'() {
    const file = path.join(copyRoot, 'packages/contracts/src/common.ts');
    replaceOnce(
      file,
      /  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',\n/,
      "  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',\n  SELFTEST_DEAD_CODE: 'SELFTEST_DEAD_CODE',\n",
    );
  },

  /* 错误码对账：把服务端会返回的码从契约里删掉（客户端按契约判断会失配） */
  'contract-missing-code'() {
    const file = path.join(copyRoot, 'packages/contracts/src/common.ts');
    replaceOnce(
      file,
      /  NOT_FOUND: 'NOT_FOUND',\n/,
      '',
    );
  },

  /* 事务逃逸：在事务回调里用注入的默认仓储写入 → 跳出事务（立刻提交，回滚不掉） */
  'tx-escape-in-transaction'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/alumni/alumni.service.ts');
    replaceOnce(
      file,
      /      const applications = manager\.getRepository\(VerificationApplication\);\n/,
      '      const applications = manager.getRepository(VerificationApplication);\n' +
        '      await this.applications.save(this.applications.create({ userId }));\n',
    );
  },

  /* 多步写候选：注入一个「两次写且没有事务」的方法 → 应被提示级规则点名 */
  'multi-step-no-transaction'() {
    // ⚠️ 这里**新增一个文件**而不是改现有代码 ——
    //    注入点如果依赖现有代码的写法，实现一演进就会「注入失败」
    //    （缺陷 #134 的重构就真的把旧的注入点打失配了）。
    //    新增文件不依赖任何现有代码的形状，永远可注入。
    const dir = path.join(copyRoot, 'apps/api/src/modules/content');
    const file = path.join(dir, 'injected-two-writes.service.ts');
    writeText(
      file,
      `import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Article, ArticleCategory } from '../../database/entities/content.entity';

/** 注入缺陷用：方法内有两次写，且**没有事务**。 */
@Injectable()
export class InjectedTwoWritesService {
  constructor(
    @InjectRepository(Article) private readonly articles: Repository<Article>,
    @InjectRepository(ArticleCategory) private readonly categories: Repository<ArticleCategory>,
  ) {}

  async createBoth(title: string): Promise<void> {
    await this.articles.save(this.articles.create({ title, body: '注入正文' }));
    await this.categories.save(this.categories.create({ name: '注入分类', slug: 'injected' }));
  }
}
`,
    );
  },

  /* 声明参数消费：handler 把 query 整体透传给 service，但 service 里那个筛选条件被删掉了 */
  'swagger-param-service-drop'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/directory/directory.service.ts');
    replaceOnce(
      file,
      /    if \(query\.graduationYear\) \{\n[^\n]*\n    \}\n/,
      '',
    );
  },

  /*
   * 状态码断言漂移（缺陷 #129）：
   * 服务端已把「标记通知已读」从 201 改成 200，但既有测试仍断言 201。
   * 这类漂移不在改动清单里，只能靠对账工具兜住。
   */
  'status-code-assertion-stale'() {
    const file = path.join(
      copyRoot,
      'apps/api/test/integration/notifications.e2e-spec.ts',
    );
    replaceOnce(
      file,
      /(\.post\(`\/api\/v1\/notifications\/\$\{id\}\/read`\)\n\s*\.set\('Authorization', `Bearer \$\{b\.accessToken\}`\)\n\s*\.expect\()200(\);)/,
      '$1201$2',
    );
  },

  /*
   * 跨方法的多步写（缺陷 #132）：
   * 把资源「修改」回退成修复前的形态 —— 内容写入与附件整体替换**没有事务**，
   * 而且附件归属校验排在内容写入**之后**。
   * 期望：R3 规则点名 `resources.service.ts · update`。
   */
  /*
   * 事务感知的方法里**绕过 manager** 的写入（R4）：
   * 方法接受事务的 manager（由调用方开事务），
   * 却还有一次写走的是注入仓储 —— 那次写不在调用方的事务里。
   */
  'transaction-aware-bypass'() {
    const dir = path.join(copyRoot, 'apps/api/src/modules/content');
    const file = path.join(dir, 'injected-bypass.service.ts');
    writeText(
      file,
      `import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Article } from '../../database/entities/content.entity';

/** 注入缺陷用：事务感知，却绕过 manager 写入。 */
@Injectable()
export class InjectedBypassService {
  constructor(
    @InjectRepository(Article) private readonly articles: Repository<Article>,
  ) {}

  async saveInside(manager: EntityManager, title: string): Promise<void> {
    await manager.getRepository(Article).save(manager.getRepository(Article).create({ title, body: '注入正文' }));
    await this.articles.save(this.articles.create({ title, body: '注入正文' }));
  }
}
`,
    );
  },

  /*
   * 「先查后插」但**没有**唯一键兜底（缺陷 #137 的形态）：
   * 先 findOne 读一行，读不到就 INSERT —— 并发下两个请求都读不到 → 都 INSERT → 撞唯一键。
   * 期望：CONCURRENT_UPSERT 点名 `injected-upsert.service.ts · upsertSetting`。
   */
  'concurrent-upsert-unprotected'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/content/injected-upsert.service.ts');
    writeText(
      file,
      `import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemSetting } from '../../database/entities/system.entity';

/** 注入缺陷用：先查后插，且没有唯一键兜底。 */
@Injectable()
export class InjectedUpsertService {
  constructor(
    @InjectRepository(SystemSetting) private readonly settings: Repository<SystemSetting>,
  ) {}

  async upsertSetting(key: string, value: string): Promise<void> {
    const existing = await this.settings.findOne({ where: { key } });
    if (existing) {
      existing.value = value;
      await this.settings.save(existing);
      return;
    }
    await this.settings.save(this.settings.create({ key, value }));
  }
}
`,
    );
  },

  /*
   * 「读 A 校验、往 B 插子行」—— **不是**「先查后插」：
   * 读的是文章（只为校验存在），插的是公告（另一张表）→ 并发下不会撞唯一键。
   * 期望：**不得**报出 CONCURRENT_UPSERT（防误报断言）。
   */
  'concurrent-upsert-safe-cross-table'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/content/injected-safe-upsert.service.ts');
    writeText(
      file,
      `import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Article, Notice } from '../../database/entities/content.entity';

/** 注入用例：读一张表做校验，往**另一张**表插入 —— 不是「先查后插」。 */
@Injectable()
export class InjectedSafeUpsertService {
  constructor(
    @InjectRepository(Article) private readonly articles: Repository<Article>,
    @InjectRepository(Notice) private readonly notices: Repository<Notice>,
  ) {}

  async publish(articleId: number, title: string): Promise<void> {
    const article = await this.articles.findOne({ where: { id: articleId } });
    if (!article) {
      throw new Error('文章不存在');
    }
    await this.notices.save(this.notices.create({ title, body: '正文' }));
  }
}
`,
    );
  },

  /*
   * 错误语义对账（缺陷 #190）：把「捕获唯一键冲突 → 转 409」改成 500 ——
   * 这正是缺陷 #190 的原形（slug 重复时数据库异常直接冒泡成 500）。
   * 期望：MISSING_CONFLICT_MAPPING 点名 article_categories.slug。
   */
  'error-semantics-conflict-mapping-removed'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/content/content.service.ts');
    replaceAllText(file, /new ConflictException\(/g, 'new InternalServerErrorException(');
  },

  /*
   * 错误语义对账：给**受审实体**加一个没人登记过的唯一列 ——
   * 「撞了返回什么」没人想过，正是缺陷 #190 的土壤。
   * 期望：UNIQUE_COLUMN_NOT_REVIEWED 点名 article_categories.code。
   */
  'error-semantics-new-unique-column'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/content.entity.ts');
    replaceOnce(
      file,
      /(\n\s*)@Column\(\{ name: 'slug', type: 'varchar', length: 64, nullable: false, unique: true \}\)/,
      "$1@Column({ name: 'slug', type: 'varchar', length: 64, nullable: false, unique: true })\n"
        + "$1/** 自测注入：没人登记过失败语义的唯一列 */\n"
        + "$1@Column({ name: 'code', type: 'varchar', length: 32, nullable: false, unique: true })",
    );
  },

  /*
   * 错误语义对账：把 API-SPEC 里「分类 slug 重复 → 409」那一行删掉 ——
   * 代码改了、文档没改，等于对外契约悄悄变了。
   * 期望：ERROR_SEMANTICS_UNDOCUMENTED 点名 POST /admin/articles/categories。
   */
  'error-semantics-doc-row-removed'() {
    const file = path.join(copyRoot, 'docs/API-SPEC.md');
    const lines = readText(file).split('\n');
    const index = lines.findIndex((line) =>
      line.includes('`POST /admin/articles/categories`') && line.includes('409'),
    );
    if (index < 0) throw new Error('注入失败：API-SPEC 里找不到分类 slug 冲突那一行');
    lines.splice(index, 1);
    writeText(file, lines.join('\n'));
  },

  /*
   * 错误语义对账（用户侧）：把「活动报名撞唯一键 → 409」的处置删掉 ——
   * 撞键会重新冒泡成 500（用户侧与管理端是同一类缺陷）。
   * 期望：MISSING_CONFLICT_MAPPING 点名 event_registrations。
   */
  'error-semantics-user-conflict-mapping-removed'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/events/events.service.ts');
    replaceOnce(
      file,
      /        if \(isDuplicateKeyError\(error\)\) \{\n          throw new ConflictException\('报名信息冲突，请重试'\);\n        \}\n/,
      '        if (isDuplicateKeyError(error)) {\n          throw error;\n        }\n',
    );
  },

  /*
   * 错误语义对账（用户侧）：给 `users` 加一个**没人登记过**的唯一列 ——
   * 「撞了返回什么」没人想过，正是缺陷 #190 的土壤（用户侧同样适用）。
   * 期望：UNIQUE_COLUMN_NOT_REVIEWED 点名 users.nickname。
   */
  'error-semantics-user-unique-key-unregistered'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/user.entity.ts');
    replaceOnce(
      file,
      /@Column\(\{ name: 'nickname', type: 'varchar', length: 64, nullable: false \}\)/,
      "@Column({ name: 'nickname', type: 'varchar', length: 64, nullable: false, unique: true })",
    );
  },

  /*
   * 错误语义对账（用户侧）：给 `contact_share_grants` 加一个**复合**唯一索引 ——
   * 复合唯一键（类级 `@Index(..., { unique: true })`）此前不在对账范围内，
   * 用户侧几乎所有唯一键都是这种形态。
   * 期望：UNIQUE_COLUMN_NOT_REVIEWED 点名 contact_share_grants.pair_id,user_id 之外的列。
   */
  'error-semantics-composite-unique-key-unregistered'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/connection.entity.ts');
    replaceOnce(
      file,
      /@Index\('uk_contact_grant', \['pairId', 'userId'\], \{ unique: true \}\)/,
      "@Index('uk_contact_grant', ['pairId', 'userId'], { unique: true })\n"
        + "@Index('uk_contact_grant_allow', ['pairId', 'allow'], { unique: true })",
    );
  },

  /*
   * 错误语义对账（用户侧）：把 API-SPEC 里「活动重复报名 → 409」那一行删掉 ——
   * 代码改了、文档没改，等于对外契约悄悄变了。
   * 期望：ERROR_SEMANTICS_UNDOCUMENTED 点名 POST /events/:id/registrations。
   */
  'error-semantics-user-doc-row-removed'() {
    const file = path.join(copyRoot, 'docs/API-SPEC.md');
    const lines = readText(file).split('\n');
    const index = lines.findIndex((line) =>
      line.includes('`POST /events/:id/registrations`') && line.includes('409'),
    );
    if (index < 0) throw new Error('注入失败：API-SPEC 里找不到活动重复报名那一行');
    lines.splice(index, 1);
    writeText(file, lines.join('\n'));
  },

  /*
   * 错误语义对账（迁移层，第十轮）：把 `uk_event_registration` 的
   * **唯一**标记去掉 —— 迁移不再创建那道唯一索引。
   * 后果：生产库 `synchronize: false`，跑的是迁移 →
   * 生产库**根本没有那道防线**，重复报名会**静默写出两行**，
   * 而代码里「捕获重复键 → 409」的那一段永远不会触发。
   * 期望：MIGRATION_UNIQUE_MISSING 点名 event_registrations。
   */
  'error-semantics-migration-unique-missing'() {
    const file = path.join(
      copyRoot,
      'apps/api/src/database/migrations/1730000000000-InitSchema.ts',
    );
    replaceOnce(
      file,
      /(\{\s*\n\s*table: 'event_registrations',\s*\n\s*name: 'uk_event_registration',\s*\n\s*columns: '`event_id`, `user_id`',\s*\n\s*)unique: true,/,
      '$1// 自测注入：不再创建唯一索引（生产库于是没有那道防线）',
    );
  },

  /*
   * 错误语义对账（迁移层，第十轮）：把 `uk_event_registration` 的列
   * 从 `(event_id, user_id)` 改成只有 `(event_id)` ——
   * **覆盖不足**：两把不同的钥匙（不同用户报同一活动）会被判成同一把。
   * 期望：MIGRATION_UNIQUE_COLUMN_MISMATCH 点名 event_registrations。
   */
  'error-semantics-migration-unique-columns-changed'() {
    const file = path.join(
      copyRoot,
      'apps/api/src/database/migrations/1730000000000-InitSchema.ts',
    );
    replaceOnce(
      file,
      /columns: '`event_id`, `user_id`',\s*\n\s*unique: true,/,
      "columns: '`event_id`',\n        unique: true,",
    );
  },

  /*
   * 错误语义对账（迁移层，第十轮）：迁移里多建一条**实体没声明**的唯一索引 ——
   * 库比实体多一道约束，写入会被库挡下，而实体与业务代码没准备这条唯一键。
   * 期望：MIGRATION_UNIQUE_NOT_DECLARED 点名 articles.title。
   */
  'error-semantics-migration-unique-not-declared'() {
    const file = path.join(
      copyRoot,
      'apps/api/src/database/migrations/1730000000000-InitSchema.ts',
    );
    replaceOnce(
      file,
      /(\{\s*\n\s*table: 'articles',\s*\n\s*name: 'idx_articles_published',\s*\n\s*columns: '`status`, `published_at`',\s*\n\s*\},\s*\n)/,
      "$1      {\n        table: 'articles',\n        name: 'uk_articles_title',\n        columns: '`title`',\n        unique: true,\n      },\n",
    );
  },

  /*
   * 库内唯一键对账（第十轮）：往**唯一键登记表**里塞一条
   * 「库里其实并不存在」的唯一键 ——
   * 模拟「迁移没建 / 迁移没应用 / 索引被人手工删了」这三类情形：
   * 静态对账看不出来，只有对着**真实库**查才看得见。
   * 期望：DB_UNIQUE_MISSING 点名 articles.title。
   */
  'unique-index-db-registry-injected'() {
    const file = path.join(copyRoot, 'infra/scripts/check-error-semantics.mjs');
    replaceOnce(
      file,
      /const UNIQUE_KEY_REGISTRY = \[\n/,
      "const UNIQUE_KEY_REGISTRY = [\n"
        + "  {\n"
        + "    side: 'admin',\n"
        + "    entity: 'articles',\n"
        + "    entityClass: 'Article',\n"
        + "    entityFile: 'apps/api/src/database/entities/content.entity.ts',\n"
        + "    columns: ['title'],\n"
        + "    disposition: 'SEEDED',\n"
        + "    note: '自测注入：库里并没有这道唯一约束',\n"
        + "  },\n",
    );
  },

  /*
   * 库内实况对账（第十四轮）：在实体里声明一个**库里并不存在**的索引 ——
   * 模拟「迁移没建 / 迁移没应用 / 索引被人手工删了」这三类情形：
   * 静态对账（实体 ↔ 迁移）看不出来，只有对着**真实库**查才看得见。
   * 期望：DB_INDEX_MISSING 点名 idx_alumni_profiles_injected_db。
   */
  'migration-schema-db-entity-index-injected'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/alumni.entity.ts');
    replaceOnce(
      file,
      /@Index\('idx_alumni_profiles_graduation_year', \['graduationYear'\]\)\n/,
      "@Index('idx_alumni_profiles_graduation_year', ['graduationYear'])\n"
        + "// 自测注入：实体声明了一个库里并不存在的索引\n"
        + "@Index('idx_alumni_profiles_injected_db', ['college'])\n",
    );
  },

  /*
   * 库内实况对账（第十四轮）：把实体里一条索引的**列**改掉 ——
   * 库里那条索引还在（旧列），实体说的是新列：两边说的不是一回事。
   * 期望：DB_INDEX_COLUMN_MISMATCH 点名 idx_alumni_profiles_region。
   */
  'migration-schema-db-index-columns-injected'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/alumni.entity.ts');
    replaceOnce(
      file,
      /@Index\('idx_alumni_profiles_region', \['regionCode'\]\)/,
      "@Index('idx_alumni_profiles_region', ['regionCode', 'college'])",
    );
  },

  /*
   * 库内实况对账（第十四轮）：把实体里一列的**长度**改短 ——
   * 库里仍是 VARCHAR(64)，实体却说 32：按实体写进库的值会被**静默截断**。
   * 期望：DB_COLUMN_DEF_MISMATCH 点名 alumni_profiles.display_name。
   */
  'migration-schema-db-column-length-injected'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/alumni.entity.ts');
    replaceOnce(
      file,
      /@Column\(\{ name: 'display_name', type: 'varchar', length: 64, nullable: false \}\)/,
      "@Column({ name: 'display_name', type: 'varchar', length: 32, nullable: false })",
    );
  },

  /*
   * 库内实况对账（第十四轮）：把实体里一列的**可空性**改掉 ——
   * 库里那一列可空，实体却说是 NOT NULL：写进 NULL 时实体与库的理解不一致。
   * 期望：DB_COLUMN_DEF_MISMATCH 点名 alumni_profiles.real_name。
   */
  'migration-schema-db-column-nullable-injected'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/alumni.entity.ts');
    replaceOnce(
      file,
      /@Column\(\{ name: 'real_name', type: 'varchar', length: 64, nullable: true \}\)/,
      "@Column({ name: 'real_name', type: 'varchar', length: 64, nullable: false })",
    );
  },

  /*
   * 库内实况对账（第十四轮）：把实体里一条**关系**的 `@JoinColumn` 改掉 ——
   * 库里那条外键还在（旧列），实体说的是新列：引用完整性不再被数据库保证。
   * 期望：DB_FOREIGN_KEY_MISSING 点名 alumni_profiles.region_code_injected。
   */
  'migration-schema-db-foreign-key-injected'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/alumni.entity.ts');
    replaceOnce(
      file,
      /@ManyToOne\(\(\) => Region, \{ onDelete: 'SET NULL', nullable: true \}\)\n  @JoinColumn\(\{ name: 'region_code' \}\)/,
      "@ManyToOne(() => Region, { onDelete: 'SET NULL', nullable: true })\n"
        + "  @JoinColumn({ name: 'region_code_injected' })",
    );
  },

  /*
   * 库内实况对账（第十五轮）：把实体里一列的**默认值**改掉 ——
   * 库里那一列的默认值仍是 0，实体却说是 7：
   * 「这一列没传值时填什么」的理解不一致（走实体的写入与走库默认值的写入会填不同的值）。
   * 期望：DB_COLUMN_DEFAULT_MISMATCH 点名 users.version。
   */
  'migration-schema-db-column-default-injected'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/user.entity.ts');
    replaceOnce(
      file,
      /@Column\(\{ name: 'version', type: 'int', default: 0 \}\)/,
      "@Column({ name: 'version', type: 'int', default: 7 })",
    );
  },

  /*
   * 库内实况对账（第十五轮）：把实体里一列的**无符号性**改掉 ——
   * 库里那一列是 `bigint unsigned`，实体却说是有符号：
   * 有符号性与实体不一致（**外键两侧的有符号性必须一致**，
   * 不一致时那一列连外键都建不出来）。
   * 期望：DB_COLUMN_UNSIGNED_MISMATCH 点名 alumni_profiles.verified_by。
   */
  'migration-schema-db-column-unsigned-injected'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/alumni.entity.ts');
    replaceOnce(
      file,
      /@Column\(\{ name: 'verified_by', type: 'bigint', unsigned: true, nullable: true \}\)/,
      "@Column({ name: 'verified_by', type: 'bigint', unsigned: false, nullable: true })",
    );
  },

  /*
   * 库内实况对账（第十五轮）：把实体里一个**枚举列的取值**改掉 ——
   * 库里那一列的枚举是 ('active','disabled','locked')，
   * 实体却多了一个 'archived'：实体的类型检查放过去了，数据库会拒收（1265）。
   * 期望：DB_COLUMN_ENUM_MISMATCH 点名 users.status。
   */
  'migration-schema-db-column-enum-injected'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/user.entity.ts');
    replaceOnce(
      file,
      /export const USER_STATUSES = \['active', 'disabled', 'locked'\] as const;/,
      "export const USER_STATUSES = ['active', 'disabled', 'locked', 'archived'] as const;",
    );
  },

  /*
   * 错误语义对账（文档索引清单，第十一轮）：在 `docs/DATABASE-DESIGN.md`
   * 的索引清单里塞一条**迁移里根本没有**的索引 ——
   * 文档是表结构的事实来源，文档与迁移分叉时，
   * 读文档的人会以为生产库里真有那么一道索引。
   * 期望：DOC_INDEX_NOT_IN_MIGRATION 点名 idx_articles_by_title。
   */
  'error-semantics-doc-index-not-in-migration'() {
    const file = path.join(copyRoot, 'docs/DATABASE-DESIGN.md');
    replaceOnce(
      file,
      /索引 `idx_articles_published\(status, published_at\)`/,
      '索引 `idx_articles_published(status, published_at)`、`idx_articles_by_title(title)`',
    );
  },

  /*
   * 错误语义对账（文档索引清单，第十一轮）：把 `docs/DATABASE-DESIGN.md`
   * 索引清单里的 `idx_articles_published` 删掉 ——
   * 迁移里明明建了这条索引，文档却没写 → 清单不完整，
   * 下一轮「文档 ↔ 迁移逐条对齐」就没有基线。
   * 期望：MIGRATION_INDEX_NOT_IN_DOC 点名 idx_articles_published。
   */
  'error-semantics-migration-index-not-in-doc'() {
    const file = path.join(copyRoot, 'docs/DATABASE-DESIGN.md');
    replaceOnce(
      file,
      /`idx_articles_published\(status, published_at\)`、/,
      '',
    );
  },

  /*
   * 库内实况对账（第十七轮）：库里多出一道**来源不明**的唯一约束 ——
   * 登记表与迁移里都没有它，写入会被它挡下（撞键），
   * 而代码没准备这条唯一键的失败语义。
   *
   * ⚠️ 要同时动**两处**（登记表 + 迁移），因为库内层的「已知」判定是
   *   「登记表里有 **或** 迁移里有」—— 只去掉一处，另一处还认得它。
   * 期望：DB_UNIQUE_NOT_DECLARED 点名 uk_alumni_profiles_user。
   */
  'db-reality-unique-not-declared-injected'() {
    const registryFile = path.join(copyRoot, 'infra/scripts/check-error-semantics.mjs');
    // ⚠️ 只把**这一条**登记表项摘掉（其余字段保持原样）——
    //   整块删除会让解析器读到残缺的项。
    replaceOnce(
      registryFile,
      /    entity: 'alumni_profiles',\n    entityClass: 'AlumniProfile',\n    entityFile: 'apps\/api\/src\/database\/entities\/alumni\.entity\.ts',\n    columns: \['user_id'\],\n/,
      "    entity: '__selftest_removed_alumni_profiles',\n" +
        "    entityClass: 'AlumniProfile',\n" +
        "    entityFile: 'apps/api/src/database/entities/alumni.entity.ts',\n" +
        "    columns: ['user_id'],\n",
    );
    const migrationFile = path.join(
      copyRoot,
      'apps/api/src/database/migrations/1730000000000-InitSchema.ts',
    );
    replaceOnce(
      migrationFile,
      /      \{\n        table: 'alumni_profiles',\n        name: 'uk_alumni_profiles_user',\n        columns: '`user_id`',\n        unique: true,\n      \},\n/,
      '',
    );
  },

  /*
   * 库内实况对账（第十七轮）：实体声明了一张**库里根本没有**的表 ——
   * 生产库 `synchronize: false`，跑的是迁移：这张表在生产库上根本不存在。
   * 期望：DB_TABLE_MISSING 点名该表。
   */
  'db-reality-table-missing-injected'() {
    const extra = path.join(copyRoot, 'apps/api/src/database/entities/selftest-extra.entity.ts');
    writeText(
      extra,
      `import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'selftest_extra_table' })
export class SelftestExtraTable {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'label', type: 'varchar', length: 64, nullable: false })
  label: string;
}
`,
    );
  },

  /*
   * 库内实况对账（第十七轮）：索引的**唯一性**与库里对不上 ——
   * 实体说这条索引是**唯一**索引，库里却是**非唯一**的：
   * 约束强度不同（唯一索引会让撞键直接报错，非唯一索引不会）。
   * 期望：DB_INDEX_UNIQUENESS_MISMATCH 点名该索引。
   */
  'db-reality-index-uniqueness-injected'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/alumni.entity.ts');
    replaceOnce(
      file,
      /@Index\('idx_alumni_profiles_graduation_year', \['graduationYear'\]\)/,
      "@Index('idx_alumni_profiles_graduation_year', ['graduationYear'], { unique: true })",
    );
  },

  /*
   * 库内实况对账（第十七轮）：库里多出一道**实体没声明**的索引 ——
   * 库比实体多一道索引：会让查询计划与实体声明对不上。
   *
   * ⚠️ 挑的是 `idx_alumni_profiles_directory`（三列）而不是 `idx_alumni_profiles_region`：
   *   后者只建在**外键列**上，库内层会把它当成「MySQL 为外键自动建的
   *   支撑索引」而**排除**（那条排除规则是对的：这类索引本就不在契约里）。
   * 期望：DB_INDEX_NOT_DECLARED 点名 idx_alumni_profiles_directory。
   */
  'db-reality-index-not-declared-injected'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/alumni.entity.ts');
    replaceOnce(
      file,
      /@Index\('idx_alumni_profiles_directory', \['showInDirectory', 'regionCode', 'industryCode'\]\)\n/,
      '',
    );
  },

  /*
   * 库内实况对账（第十七轮）：外键的**指向**与库里对不上 ——
   * 实体说这一列指向 A 表，库里那条外键却指向 B 表：
   * 实体与库里说的不是一回事。
   * 期望：DB_FOREIGN_KEY_TARGET_MISMATCH 点名该列。
   */
  'db-reality-foreign-key-target-injected'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/alumni.entity.ts');
    replaceOnce(
      file,
      /@ManyToOne\(\(\) => Region, \{ onDelete: 'SET NULL', nullable: true \}\)\n  @JoinColumn\(\{ name: 'region_code' \}\)/,
      "@ManyToOne(() => Industry, { onDelete: 'SET NULL', nullable: true })\n" +
        "  @JoinColumn({ name: 'region_code' })",
    );
  },

  /*
   * 库内实况对账（第十七轮）：库里多出一道**实体没声明**的外键 ——
   * 写入会被库挡下（外键失败），而实体与业务代码没准备这个约束。
   * 期望：DB_FOREIGN_KEY_NOT_DECLARED 点名该列。
   */
  'db-reality-foreign-key-not-declared-injected'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/alumni.entity.ts');
    replaceOnce(
      file,
      /@ManyToOne\(\(\) => Region, \{ onDelete: 'SET NULL', nullable: true \}\)\n  @JoinColumn\(\{ name: 'region_code' \}\)\n/,
      '',
    );
  },

  /*
   * 库内实况对账（第十七轮）：实体声明了、**库里没有**的那一列 ——
   * 读写这一列会直接报「未知列」。
   *
   * ⚠️ 必须加一整个**新的属性**（带自己的 `@Column`），
   *   不能只在已有属性上再挂一个 `@Column` ——
   *   实体解析是「一个属性取**第一个**列装饰器」，
   *   多挂一个会被当成同一个属性的声明，解析出来的还是原来那一列。
   * 期望：DB_COLUMN_MISSING 点名 selftest_absent_column。
   */
  'db-reality-column-missing-injected'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/alumni.entity.ts');
    replaceOnce(
      file,
      /  @Column\(\{ name: 'college', type: 'varchar', length: 64, nullable: true \}\)\n  college: string \| null;\n/,
      "  @Column({ name: 'college', type: 'varchar', length: 64, nullable: true })\n" +
        "  college: string | null;\n\n" +
        "  // 自测注入：实体声明了、库里没有的那一列\n" +
        "  @Column({ name: 'selftest_absent_column', type: 'varchar', length: 32, nullable: true })\n" +
        "  selftestAbsentColumn: string | null;\n",
    );
  },

  /*
   * 库内实况对账（第十七轮）：库里多出一列**实体没声明**的列 ——
   * 任何 `synchronize: true` 的环境都会把它删掉，
   * 而生产库上它一直在（两边对这一列的理解不一致）。
   * 期望：DB_COLUMN_NOT_DECLARED 点名该列。
   */
  'db-reality-column-not-declared-injected'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/alumni.entity.ts');
    replaceOnce(
      file,
      /  @Column\(\{ name: 'college', type: 'varchar', length: 64, nullable: true \}\)\n/,
      '',
    );
  },

  /*
   * 读端点可见性对账（第十一轮）：把「未发布 → 404」的**可见性过滤**删掉 ——
   * 公开详情端点只判「存在与否」，不再判「发布与否」。
   * 后果：草稿 / 未审核的资讯**凭 id 就能公开读到**（对外可见性失控）。
   * 期望：READ_VISIBILITY_FILTER_MISSING 点名 GET /articles/:id。
   */
  'read-visibility-filter-removed'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/content/content.service.ts');
    replaceOnce(
      file,
      /if \(!article \|\| article\.status !== 'published'\) throw new NotFoundException\('内容不存在'\);/,
      "if (!article) throw new NotFoundException('内容不存在');",
    );
  },

  /*
   * 读端点可见性对账（第十七轮，**第二种退化形态**）：
   * 把「未发布 → 404」的过滤条件**换个写法**（`status === 'published'` 之外的两处写法）——
   * 过滤**还在**，但登记表的「过滤痕迹」字符串对不上了。
   *
   * ⚠️ 为什么要有第二种形态：第一种形态（整条删除）只覆盖了
   *   「痕迹字符串被整段删掉」这一种退化 —— 校验器若只认整段缺失，
   *   遇到「痕迹还在但语义变了」（如 `!=` 写成 `<>`）就会漏判。
   *   两种形态一起守，才说明它守的是**语义**而不是某一段文本。
   * 期望：READ_VISIBILITY_FILTER_MISSING 点名 GET /articles/:id。
   */
  'read-visibility-filter-spelled-differently'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/content/content.service.ts');
    replaceOnce(
      file,
      /if \(!article \|\| article\.status !== 'published'\) throw new NotFoundException\('内容不存在'\);/,
      "if (!article || 'published' !== article.status) throw new NotFoundException('内容不存在');",
    );
  },

  /*
   * 读端点可见性对账（第十七轮，**第二种退化形态**）：
   * 把「不可见 → 404」改成 **500**（服务器内部错误）——
   * 与 403 不同：403 泄露「对象存在」，500 则是「服务端炸了」，
   * 客户端拿不到任何可引导的信息。
   * 期望：READ_VISIBILITY_STATUS_MISMATCH 点名 GET /articles/:id。
   */
  'read-visibility-status-changed-to-500'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/content/content.service.ts');
    replaceOnce(
      file,
      /if \(!article \|\| article\.status !== 'published'\) throw new NotFoundException\('内容不存在'\);/,
      "if (!article || article.status !== 'published') throw new InternalServerErrorException('内容不存在');",
    );
  },

  /*
   * 读端点可见性对账（第十一轮）：把「不可见 → 404」改成 **403** ——
   * 状态码本身就泄露了「这个对象存在」，与「已知设计取舍」第 2 条相反。
   * 期望：READ_VISIBILITY_STATUS_MISMATCH 点名 GET /articles/:id。
   */
  'read-visibility-status-changed'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/content/content.service.ts');
    replaceOnce(
      file,
      /if \(!article \|\| article\.status !== 'published'\) throw new NotFoundException\('内容不存在'\);/,
      "if (!article || article.status !== 'published') throw new ForbiddenException('内容不存在');",
    );
  },

  /*
   * 读端点可见性对账（第十一轮）：新增一个**公开读端点**却没人登记可见性口径 ——
   * 「不可见的对象返回什么」没人想过，上线后只能靠人记得。
   * 期望：READ_VISIBILITY_NOT_REGISTERED 点名 GET /draft-preview。
   */
  'read-visibility-endpoint-unregistered'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/content/content.controller.ts');
    replaceOnce(
      file,
      /\n\}\n$/,
      `
  @Public()
  @Get('draft-preview')
  @ApiOperation({ summary: '自测注入：没登记可见性口径的公开读端点' })
  draftPreview() {
    return { ok: true };
  }
}
`,
    );
  },

  /*
   * 读端点可见性对账（第十七轮，**第二种退化形态**）：
   * 新增一个**公开读端点**，但把它挂在**另一个控制器**上 ——
   * 第一种形态挂在 content 控制器上，若校验器只认那一个控制器的端点，
   * 换到别处就漏判了。
   * 期望：READ_VISIBILITY_NOT_REGISTERED 点名 GET /articles/draft-preview。
   */
  'read-visibility-endpoint-unregistered-in-other-controller'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/content/content.controller.ts');
    replaceOnce(
      file,
      /\n\}\n$/,
      `
  @Public()
  @Get('articles/draft-preview')
  @ApiOperation({ summary: '自测注入：没登记可见性口径的公开读端点（另一个路径）' })
  draftPreview() {
    return { ok: true };
  }
}
`,
    );
  },

  /*
   * 读端点可见性对账（第十一轮）：把 API-SPEC「读端点的可见性口径」里的
   * `GET /articles/:id` 那一行删掉 ——
   * 对外契约只存在于代码里，客户端无从得知「未发布 → 404」。
   * 期望：READ_VISIBILITY_UNDOCUMENTED 点名 GET /articles/:id。
   */
  'read-visibility-doc-row-removed'() {
    const file = path.join(copyRoot, 'docs/API-SPEC.md');
    const lines = readText(file).split('\n');
    // ⚠️ 必须按**单元格**定位：说明列里常出现「同 `/articles/:id`」这样的引用，
    //    按子串找会删掉**别处**的那一行，注入就白注了。
    const index = lines.findIndex((line) => {
      if (!line.trim().startsWith('|')) return false;
      const cells = line.split('|').map((cell) => cell.trim());
      return cells[1] === 'GET' && cells[2] === '`/articles/:id`' && line.includes('**404**');
    });
    if (index < 0) throw new Error('注入失败：API-SPEC 里找不到 /articles/:id 的可见性那一行');
    lines.splice(index, 1);
    writeText(file, lines.join('\n'));
  },

  /*
   * 读端点可见性对账（第十七轮，**第二种退化形态**）：
   * 把 API-SPEC 里 `GET /articles/:id` 那一行的**状态码**从 404 改成 403 ——
   * 那一行还在，但写的口径与实现对不上（对外契约说了 403，实现是 404）。
   * 第一种形态是「整行删掉」，第二种是「行还在但内容错了」——
   * 两种一起守，才说明它守的是**口径本身**而不只是「有没有这一行」。
   * 期望：READ_VISIBILITY_UNDOCUMENTED 点名 GET /articles/:id。
   */
  'read-visibility-doc-row-status-changed'() {
    const file = path.join(copyRoot, 'docs/API-SPEC.md');
    const lines = readText(file).split('\n');
    const index = lines.findIndex((line) => {
      if (!line.trim().startsWith('|')) return false;
      const cells = line.split('|').map((cell) => cell.trim());
      return cells[1] === 'GET' && cells[2] === '`/articles/:id`' && line.includes('**404**');
    });
    if (index < 0) throw new Error('注入失败：API-SPEC 里找不到 /articles/:id 的可见性那一行');
    lines[index] = lines[index].replace('**404**', '**403**');
    writeText(file, lines.join('\n'));
  },

  /*
   * 读端点可见性对账（第十一轮）：把 KNOWN-ISSUES 里 #197（`GET /events/:id`
   * 的可见性口径待拍板）整条删掉 ——
   * 「口径还没人拍板」这件事必须仍然记着，否则这个端点就没人管了。
   * 期望：READ_VISIBILITY_KNOWN_ISSUE_MISSING 点名 GET /events/:id。
   */
  'read-visibility-known-issue-removed'() {
    const file = path.join(copyRoot, 'docs/KNOWN-ISSUES.md');
    const lines = readText(file).split('\n');
    const start = lines.findIndex((line) => /^#{2,4}\s*197\./.test(line));
    if (start < 0) throw new Error('注入失败：KNOWN-ISSUES 里找不到 #197');
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^#{2,4}\s/.test(lines[i])) {
        end = i;
        break;
      }
    }
    lines.splice(start, end - start);
    writeText(file, lines.join('\n'));
  },

  /*
   * 读端点可见性对账（第十七轮，**第二种退化形态**）：
   * 把 KNOWN-ISSUES 里 #197 的**端点路径**删掉（条目还在，但不再点名那个端点）——
   * 「待拍板」这件事还记着，却已经没人知道它指的是哪个端点。
   * 期望：READ_VISIBILITY_KNOWN_ISSUE_MISSING 点名 GET /events/:id。
   */
  'read-visibility-known-issue-endpoint-forgotten'() {
    const file = path.join(copyRoot, 'docs/KNOWN-ISSUES.md');
    const lines = readText(file).split('\n');
    const start = lines.findIndex((line) => /^#{2,4}\s*197\./.test(line));
    if (start < 0) throw new Error('注入失败：KNOWN-ISSUES 里找不到 #197');
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^#{2,4}\s/.test(lines[i])) {
        end = i;
        break;
      }
    }
    for (let i = start; i < end; i += 1) {
      if (lines[i].includes('/events/:id')) {
        lines[i] = lines[i].replace('/events/:id', '（端点路径略）');
      }
    }
    writeText(file, lines.join('\n'));
  },

  /*
   * 读端点可见性对账（第十一轮）：把 `GET /events/:id` 的**可见性过滤补上** ——
   * 模拟「产品已拍板 / 有人擅自改了对外行为」，但登记表与文档还停在「待拍板」。
   * 期望：READ_VISIBILITY_REGISTRY_STALE 点名 GET /events/:id。
   */
  'read-visibility-pending-resolved'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/events/events.service.ts');
    replaceOnce(
      file,
      /if \(!event\) throw new NotFoundException\('活动不存在'\);/,
      "if (!event || event.status !== 'published') throw new NotFoundException('活动不存在');",
    );
  },

  /*
   * 读端点可见性对账（第十七轮，**第二种退化形态**）：
   * 把 `GET /events/:id` 的过滤**写成相反的判断**（`status === 'published'`）——
   * 同样是「擅自改了对外行为」，但痕迹的写法与第一种形态不同。
   * 期望：READ_VISIBILITY_REGISTRY_STALE 点名 GET /events/:id。
   */
  'read-visibility-pending-resolved-inverted'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/events/events.service.ts');
    replaceOnce(
      file,
      /if \(!event\) throw new NotFoundException\('活动不存在'\);/,
      "if (!event || event.status === 'published') throw new NotFoundException('活动不存在');",
    );
  },

  /*
   * 迁移层对账（第十二轮，实体 ↔ 迁移扩面）：实体里声明了一个**迁移没有建**的索引 ——
   * 生产库 `synchronize: false`，跑的是迁移：这条索引在生产库上**根本不存在**，
   * 按该列的查询会退化成全表扫。
   * 期望：MIGRATION_INDEX_MISSING 点名 idx_alumni_profiles_injected。
   */
  'error-semantics-entity-index-missing-in-migration'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/alumni.entity.ts');
    replaceOnce(
      file,
      /@Index\('idx_alumni_profiles_graduation_year', \['graduationYear'\]\)\n/,
      "@Index('idx_alumni_profiles_graduation_year', ['graduationYear'])\n" +
        "// 自测注入：实体声明了一个迁移里没有的索引\n" +
        "@Index('idx_alumni_profiles_injected', ['college'])\n",
    );
  },

  /*
   * 迁移层对账（第十二轮，实体 ↔ 迁移扩面）：把实体里的**索引声明**删掉 ——
   * 迁移里那条索引还在（库比实体多一道索引），两边对「这张表有哪些索引」的说法分叉了。
   * 期望：MIGRATION_INDEX_NOT_DECLARED 点名 idx_alumni_profiles_region。
   */
  'error-semantics-migration-index-not-declared'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/alumni.entity.ts');
    replaceOnce(file, /@Index\('idx_alumni_profiles_region', \['regionCode'\]\)\n/, '');
  },

  /*
   * 迁移层对账（第十二轮，列定义）：把实体里一列的**长度**改短 ——
   * 迁移里仍是 VARCHAR(64)，实体却说 32：按实体写进库的值会被**静默截断**。
   * 期望：MIGRATION_COLUMN_DEF_MISMATCH 点名 alumni_profiles.display_name。
   */
  'error-semantics-column-length-mismatch'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/alumni.entity.ts');
    replaceOnce(
      file,
      /@Column\(\{ name: 'display_name', type: 'varchar', length: 64, nullable: false \}\)/,
      "@Column({ name: 'display_name', type: 'varchar', length: 32, nullable: false })",
    );
  },

  /*
   * 迁移层对账（第十二轮，外键）：把迁移里的一条**外键**删掉 ——
   * 生产库上引用完整性不再被数据库保证：可以写入指向不存在行的外键。
   * 期望：ENTITY_FOREIGN_KEY_MISSING 点名 alumni_profiles.user_id。
   */
  'error-semantics-entity-foreign-key-missing'() {
    const file = path.join(
      copyRoot,
      'apps/api/src/database/migrations/1730000000000-InitSchema.ts',
    );
    replaceOnce(
      file,
      /      \{\n        table: 'alumni_profiles',\n        name: 'fk_alumni_profiles_user',\n        column: 'user_id',\n        refTable: 'users',\n        refColumn: 'id',\n        onDelete: 'CASCADE',\n      \},\n/,
      '',
    );
  },

  /*
   * 迁移层对账（第十二轮，外键）：把一条外键的**指向**改掉 ——
   * 实体说的是「指向 users(id)」，迁移建成了「指向 admin_users(id)」：
   * 两边说的不是一回事（写入会被库挡下，而实体没准备）。
   * 期望：FOREIGN_KEY_TARGET_MISMATCH 点名 alumni_profiles.user_id。
   */
  'error-semantics-foreign-key-target-mismatch'() {
    const file = path.join(
      copyRoot,
      'apps/api/src/database/migrations/1730000000000-InitSchema.ts',
    );
    replaceOnce(
      file,
      /        name: 'fk_alumni_profiles_user',\n        column: 'user_id',\n        refTable: 'users',/,
      "        name: 'fk_alumni_profiles_user',\n        column: 'user_id',\n        refTable: 'admin_users',",
    );
  },

  /*
   * 错误语义对账（实体 ↔ 迁移，第十六轮新增的三个维度）：把实体里一列的
   * **默认值**改掉 —— 迁移里那一列仍是 `DEFAULT 0`，实体却说是 7：
   * 「这一列没传值时填什么」的理解不一致（走实体的写入与走库默认值的写入
   * 会填不同的值）。
   * 期望：MIGRATION_COLUMN_DEFAULT_MISMATCH 点名 users.version。
   */
  'error-semantics-column-default-mismatch'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/user.entity.ts');
    replaceOnce(
      file,
      /@Column\(\{ name: 'version', type: 'int', default: 0 \}\)/,
      "@Column({ name: 'version', type: 'int', default: 7 })",
    );
  },

  /*
   * 错误语义对账（实体 ↔ 迁移，第十六轮新增的三个维度）：把实体里一列的
   * **无符号性**改掉 —— 迁移里那一列是 `BIGINT UNSIGNED`，实体却说有符号：
   * 有符号性与实体不一致（**外键两侧的有符号性必须一致**，
   * 不一致时那一列连外键都建不出来）。
   * 期望：MIGRATION_COLUMN_UNSIGNED_MISMATCH 点名 alumni_profiles.verified_by。
   */
  'error-semantics-column-unsigned-mismatch'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/alumni.entity.ts');
    replaceOnce(
      file,
      /@Column\(\{ name: 'verified_by', type: 'bigint', unsigned: true, nullable: true \}\)/,
      "@Column({ name: 'verified_by', type: 'bigint', unsigned: false, nullable: true })",
    );
  },

  /*
   * 错误语义对账（实体 ↔ 迁移，第十六轮新增的三个维度）：把实体里一个
   * **枚举列的取值**改掉 —— 迁移里那一列的枚举是 ('active','disabled','locked')，
   * 实体却多了一个 'archived'：实体的类型检查放过去了，数据库会拒收（1265）。
   * 期望：MIGRATION_COLUMN_ENUM_MISMATCH 点名 users.status。
   */
  'error-semantics-column-enum-mismatch'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/user.entity.ts');
    replaceOnce(
      file,
      /export const USER_STATUSES = \['active', 'disabled', 'locked'\] as const;/,
      "export const USER_STATUSES = ['active', 'disabled', 'locked', 'archived'] as const;",
    );
  },

  /*
   * 读端点可见性对账（第十二轮，已登录端点）：把「不是关系双方 → 403」改成 **404** ——
   * 客户端于是分不清「没有这个对象」与「不是你的」，两种引导都错了。
   * 期望：AUTH_VISIBILITY_STATUS_MISSING 点名 GET /connections/:id。
   */
  'read-visibility-auth-403-changed-to-404'() {
    const file = path.join(
      copyRoot,
      'apps/api/src/modules/connections/connections.service.ts',
    );
    replaceOnce(
      file,
      /throw new ForbiddenException\('无权查看该连接关系'\);/,
      "throw new NotFoundException('连接关系不存在');",
    );
  },

  /*
   * 读端点可见性对账（第十七轮，**第二种退化形态**）：
   * 把已登录端点的「无权 → 403」改成 **500** ——
   * 第一种形态是「403 改成 404」（客户端分不清两种引导），
   * 第二种是「403 改成 500」（客户端连「无权」这件事都拿不到）——
   * 两者都是「403 这条口径没落到实现上」。
   * 期望：AUTH_VISIBILITY_STATUS_MISSING 点名 GET /connections/:id。
   */
  'read-visibility-auth-403-changed-to-500'() {
    const file = path.join(
      copyRoot,
      'apps/api/src/modules/connections/connections.service.ts',
    );
    replaceOnce(
      file,
      /throw new ForbiddenException\('无权查看该连接关系'\);/,
      "throw new InternalServerErrorException('无权查看该连接关系');",
    );
  },

  /*
   * 读端点可见性对账（第十七轮，**第二种退化形态**）：
   * 把已登录端点的「不可见 → 404」改成 **500** ——
   * 客户端分不清「不存在」与「服务端故障」，引导全错。
   * 期望：AUTH_VISIBILITY_STATUS_MISSING 点名 GET /connections/:id。
   */
  'read-visibility-auth-404-changed-to-500'() {
    const file = path.join(
      copyRoot,
      'apps/api/src/modules/connections/connections.service.ts',
    );
    replaceAllText(
      file,
      /throw new NotFoundException\('连接关系不存在'\);/g,
      "throw new InternalServerErrorException('连接关系不存在');",
    );
  },

  /*
   * 读端点可见性对账（第十七轮，**第二种退化形态**）：
   * 把已登录端点的**认证阶段守卫**摘掉 ——
   * `@RequireAlumniStage('verified')` 这道「未完成校友认证 → 403」的守卫
   * 一旦消失，未认证用户就能用到只有认证用户才能用的功能。
   * （第一种形态是「实现里的状态码被改掉」，第二种是「控制器上的守卫被摘掉」——
   * 两条不同的判定路径，各要一个用例。）
   * 期望：AUTH_VISIBILITY_GUARD_MISSING 点名 GET /connections/:id。
   */
  'read-visibility-auth-guard-removed'() {
    const file = path.join(
      copyRoot,
      'apps/api/src/modules/connections/connections.controller.ts',
    );
    replaceOnce(
      file,
      /  @Get\(':id'\)\n  @RequireAlumniStage\('verified'\)\n/,
      "  @Get(':id')\n",
    );
  },

  /*
   * 读端点可见性对账（第十二轮，已登录端点）：新增一个**已登录端点**，
   * 它的实现会抛 404，却没人登记可见性分界 ——
   * 「不可见 → 404 还是无权 → 403」没人想过，上线后只能靠人记得。
   * 期望：AUTH_VISIBILITY_NOT_REGISTERED 点名 GET /connections/injected-preview。
   */
  'read-visibility-auth-endpoint-unregistered'() {
    const file = path.join(
      copyRoot,
      'apps/api/src/modules/connections/connections.controller.ts',
    );
    replaceOnce(
      file,
      /\n\}\n$/,
      `
  @Get('injected-preview')
  @ApiOperation({ summary: '自测注入：没登记可见性分界的已登录端点' })
  async injectedPreview(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number) {
    return this.connectionsService.getConnection(id, user.id);
  }
}
`,
    );
  },

  /*
   * 读端点可见性对账（第十二轮，已登录端点）：把 API-SPEC 第 13.2 节里
   * `GET /connections/:id` 那一行删掉 ——
   * 403 与 404 的分界只存在于代码里，客户端无从得知该怎么引导用户。
   * 期望：AUTH_VISIBILITY_UNDOCUMENTED 点名 GET /connections/:id。
   */
  'read-visibility-auth-doc-row-removed'() {
    const file = path.join(copyRoot, 'docs/API-SPEC.md');
    const lines = readText(file).split('\n');
    // ⚠️ 必须锁定**可见性口径表**里的那一行（5 列以上）：
    //    API-SPEC 里还有一张「端点清单」表，它也有「GET | `/connections/:id`」，
    //    删那一行不算缺陷（只是清单少了一行），删错地方会让注入白注。
    const index = lines.findIndex((line) => {
      if (!line.trim().startsWith('|')) return false;
      const cells = line.split('|').map((cell) => cell.trim());
      return (
        cells[1] === 'GET' &&
        cells[2] === '`/connections/:id`' &&
        cells.length >= 6 &&
        cells[3] === '**403**' &&
        cells[4] === '**404**'
      );
    });
    if (index < 0) throw new Error('注入失败：API-SPEC 里找不到 /connections/:id 的可见性口径那一行');
    lines.splice(index, 1);
    writeText(file, lines.join('\n'));
  },

  /*
   * 可见性对账（第十三轮，管理端）：把「活动不存在 → 404」的处置删掉 ——
   * 删一条**不存在**的活动会返回「已删除」，管理后台于是提示成功，
   * 而库里那条活动**根本不存在**。
   * 期望：ADMIN_VISIBILITY_STATUS_MISSING 点名 DELETE /admin/events/:id。
   */
  'read-visibility-admin-404-removed'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/events/events.service.ts');
    replaceOnce(
      file,
      /if \(!result\.affected\) throw new NotFoundException\('活动不存在'\);/,
      'if (!result.affected) return { deleted: false };',
    );
  },

  /*
   * 可见性对账（第十七轮，**第二种退化形态**）：
   * 把「活动不存在 → 404」改成 **500** ——
   * 第一种形态是「处置被删掉」，第二种是「处置还在、但抛的是服务器错误」：
   * 管理端把 500 当成「服务端故障」而不是「这条记录不存在」，
   * 提示仍然是错的。
   * 期望：ADMIN_VISIBILITY_STATUS_MISSING 点名 DELETE /admin/events/:id。
   */
  'read-visibility-admin-404-changed-to-500'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/events/events.service.ts');
    replaceOnce(
      file,
      /if \(!result\.affected\) throw new NotFoundException\('活动不存在'\);/,
      "if (!result.affected) throw new InternalServerErrorException('活动不存在');",
    );
  },

  /*
   * 可见性对账（第十三轮，管理端）：新增一个**管理端端点**，
   * 它的实现会抛 404，却没人登记「资源不存在 → 404」的分界 ——
   * 管理端于是分不清「资源不存在（404）」与「权限点不足（403）」。
   * 期望：ADMIN_VISIBILITY_NOT_REGISTERED 点名 GET /admin/injected-preview。
   */
  'read-visibility-admin-endpoint-unregistered'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/admin/admin.controller.ts');
    replaceOnce(
      file,
      /\n\}\n$/,
      `
  @Get('injected-preview')
  @RequirePermissions('alumni:view')
  @ApiOperation({ summary: '自测注入：没登记可见性分界的管理端端点' })
  async injectedPreview(@Param('id', ParseIntPipe) id: number) {
    return this.directoryService.adminDetail(id);
  }
}
`,
    );
  },

  /*
   * 可见性对账（第十七轮，**第二种退化形态**）：
   * 新增一个管理端端点，但**挂在另一个路径**上（第一种形态是 `injected-preview`）——
   * 若校验器只认某一个具体路径，换个路径就漏判了。
   * 期望：ADMIN_VISIBILITY_NOT_REGISTERED 点名 GET /admin/injected-preview-2。
   */
  'read-visibility-admin-endpoint-unregistered-other-path'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/admin/admin.controller.ts');
    replaceOnce(
      file,
      /\n\}\n$/,
      `
  @Get('injected-preview-2')
  @RequirePermissions('alumni:view')
  @ApiOperation({ summary: '自测注入：没登记可见性分界的管理端端点（另一个路径）' })
  async injectedPreview2(@Param('id', ParseIntPipe) id: number) {
    return this.directoryService.adminDetail(id);
  }
}
`,
    );
  },

  /*
   * 读端点可见性对账（第十七轮，**第二种退化形态**）：
   * 新增一个已登录端点，但**挂在另一个路径**上（第一种形态是 `injected-preview`）——
   * 若校验器只认某一个具体路径，换个路径就漏判了。
   * 期望：AUTH_VISIBILITY_NOT_REGISTERED 点名 GET /connections/injected-preview-2。
   */
  'read-visibility-auth-endpoint-unregistered-other-path'() {
    const file = path.join(
      copyRoot,
      'apps/api/src/modules/connections/connections.controller.ts',
    );
    replaceOnce(
      file,
      /\n\}\n$/,
      `
  @Get('injected-preview-2')
  @RequireAlumniStage('verified')
  @ApiOperation({ summary: '自测注入：没登记可见性分界的已登录端点（另一个路径）' })
  async injectedPreview2(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number) {
    return this.connectionsService.getConnection(id, user.id);
  }
}
`,
    );
  },

  /*
   * 读端点可见性对账（第十七轮，**第二种退化形态**）：
   * 把 API-SPEC 里 `GET /connections/:id` 那一行的 **403 列**改成 401 ——
   * 那一行还在，但写的口径与实现对不上。
   * 期望：AUTH_VISIBILITY_UNDOCUMENTED 点名 GET /connections/:id。
   */
  'read-visibility-auth-doc-row-status-changed'() {
    const file = path.join(copyRoot, 'docs/API-SPEC.md');
    const lines = readText(file).split('\n');
    const index = lines.findIndex((line) => {
      if (!line.trim().startsWith('|')) return false;
      const cells = line.split('|').map((cell) => cell.trim());
      return (
        cells[1] === 'GET' &&
        cells[2] === '`/connections/:id`' &&
        cells.length >= 6 &&
        cells[3] === '**403**' &&
        cells[4] === '**404**'
      );
    });
    if (index < 0) throw new Error('注入失败：API-SPEC 里找不到 /connections/:id 的可见性口径那一行');
    // ⚠️ 这一行里 **403** 出现了**两次**（状态码格 + 说明列的「→ 403」）：
    //    只换状态码格的话，说明列里还留着 403，校验器照样认为口径写明了 ——
    //    注入就白注了。两处一起换。
    lines[index] = lines[index].replace(/403/g, '401');
    writeText(file, lines.join('\n'));
  },

  /*
   * RBAC 矩阵（第十七轮）：把一个**管理端端点**的 `@RequirePermissions` 摘掉 ——
   * 规则 6（「每个管理端端点都必须声明权限点」）在第十六轮被修好之前
   * 是一条**恒过**的判定（控制器前缀没有前导斜杠，拼出来的路径永远不以
   * `/admin` 开头 → 判定一次都没跑过）。
   * 这个用例是那道修复的**反向验证**：把权限点摘掉，它必须被抓出来。
   * 期望：ADMIN_ENDPOINT_NO_PERMISSION 点名该管理端端点。
   */
  'rbac-matrix-admin-endpoint-no-permission'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/admin/admin.controller.ts');
    replaceOnce(
      file,
      /  @Get\('alumni'\)\n  @RequirePermissions\('alumni:view'\)\n/,
      "  @Get('alumni')\n",
    );
  },

  /*
   * 可见性对账（第十三轮，管理端）：把 API-SPEC 第 13.4 节里
   * \`DELETE /admin/events/:id\` 那一行删掉 ——
   * 管理端两种失败语义的分界只存在于代码里，后台无从得知该怎么提示。
   * 期望：ADMIN_VISIBILITY_UNDOCUMENTED 点名 DELETE /admin/events/:id。
   */
  'read-visibility-admin-doc-row-removed'() {
    const file = path.join(copyRoot, 'docs/API-SPEC.md');
    const lines = readText(file).split('\n');
    // ⚠️ 必须锁定**第 13.4 节那张表**里的那一行（5 列以上、含 404 / 403 两列）：
    //    API-SPEC 第 11 节还有一张「端点清单」表，它也有「DELETE | `/admin/events/:id`」，
    //    删那一行不算缺陷（只是清单少了一行），删错地方会让注入白注。
    const index = lines.findIndex((line) => {
      if (!line.trim().startsWith('|')) return false;
      const cells = line.split('|').map((cell) => cell.trim());
      return (
        cells[1] === 'DELETE' &&
        cells[2] === '`/admin/events/:id`' &&
        cells.length >= 7 &&
        cells[3] === '**404**' &&
        cells[4] === '**403**'
      );
    });
    if (index < 0) throw new Error('注入失败：API-SPEC 里找不到 /admin/events/:id 的可见性口径那一行');
    lines.splice(index, 1);
    writeText(file, lines.join('\n'));
  },

  /*
   * 可见性对账（第十七轮，**第二种退化形态**）：
   * 把 API-SPEC 第 13.4 节里 `DELETE /admin/events/:id` 那一行的
   * **404 列**改成 500 —— 那一行还在，但写的口径与实现对不上。
   * 期望：ADMIN_VISIBILITY_UNDOCUMENTED 点名 DELETE /admin/events/:id。
   */
  'read-visibility-admin-doc-row-status-changed'() {
    const file = path.join(copyRoot, 'docs/API-SPEC.md');
    const lines = readText(file).split('\n');
    const index = lines.findIndex((line) => {
      if (!line.trim().startsWith('|')) return false;
      const cells = line.split('|').map((cell) => cell.trim());
      return (
        cells[1] === 'DELETE' &&
        cells[2] === '`/admin/events/:id`' &&
        cells.length >= 7 &&
        cells[3] === '**404**' &&
        cells[4] === '**403**'
      );
    });
    if (index < 0) throw new Error('注入失败：API-SPEC 里找不到 /admin/events/:id 的可见性口径那一行');
    // ⚠️ 404 在这一行里出现**两次**（状态码格 + 说明列的「→ 404」）：两处一起换。
    lines[index] = lines[index].replace(/404/g, '500');
    writeText(file, lines.join('\n'));
  },

  /*
   * 两层结论对账（第十七轮）：把**迁移里**某一列的长度改掉 ——
   * 静态层（实体 ↔ 迁移）判「不一致」，库内层（实体 ↔ 真实的库）判「一致」——
   * 两层对**同一个对象**给出了互相矛盾的结论：
   * 说明**迁移与库里真实的结构已经不是一回事**（迁移改过没重跑、或库被手工改过）。
   * 期望：LAYER_VERDICT_CONFLICT 点名那一列。
   */
  'layer-reconciliation-migration-column-drifted'() {
    const file = path.join(
      copyRoot,
      'apps/api/src/database/migrations/1730000000000-InitSchema.ts',
    );
    replaceOnce(
      file,
      /        '`display_name` VARCHAR\(64\) NOT NULL,' \+/,
      "        '`display_name` VARCHAR(32) NOT NULL,' +",
    );
  },

  /*
   * 两层结论对账（第十七轮，**第一种退化形态**）：
   * 把**迁移里**某一列的长度改掉（VARCHAR(64) → VARCHAR(32)）——
   * 静态层（实体 ↔ 迁移）判「不一致」，库内层（实体 ↔ 真实的库）判「一致」——
   * 两层对**同一个对象**给出了互相矛盾的结论：
   * 说明**迁移与库里真实的结构已经不是一回事**（迁移改过没重跑、或库被手工改过）。
   * 期望：LAYER_VERDICT_CONFLICT 点名那一列。
   */
  'layer-reconciliation-migration-column-drifted'() {
    const file = path.join(
      copyRoot,
      'apps/api/src/database/migrations/1730000000000-InitSchema.ts',
    );
    replaceOnce(
      file,
      /        '`display_name` VARCHAR\(64\) NOT NULL,' \+/,
      "        '`display_name` VARCHAR(32) NOT NULL,' +",
    );
  },

  /*
   * 两层结论对账（第十七轮，**第二种退化形态**）：
   * 把**实体里**某一列的默认值改掉（迁移与库里都还是原来那个）——
   * 静态层判「不一致」（实体 ≠ 迁移），库内层也判「不一致」（实体 ≠ 库）。
   *
   * ⚠️ 这一条是**反向的**用例：两层**都**判了不一致，
   *   而且说的是**同一件事**（这一列的默认值对不上）——
   *   所以对账脚本**不该**报任何矛盾，它必须**通过**。
   *   它守的是「对账脚本不是『只要有一层说不一致就报』」：
   *   真出现了一处**只有一层**说不一致（第一、二条用例）时，
   *   它报的才是真矛盾。
   * 期望：退出码 0（无任何分叉）。
   */
  'layer-reconciliation-entity-default-drifted'() {
    const file = path.join(copyRoot, 'apps/api/src/database/entities/alumni.entity.ts');
    replaceOnce(
      file,
      /  @Column\(\{ name: 'college', type: 'varchar', length: 64, nullable: true \}\)\n/,
      "  @Column({ name: 'college', type: 'varchar', length: 64, nullable: true, default: 'x' })\n",
    );
  },

  /*
   * 两层结论对账（第十七轮，**第三种退化形态**）：
   * 把**迁移里**某一列整个删掉（实体与库里都还在）——
   * 静态层判「迁移里没这一列」（不一致），库内层判「一致」；
   * 更要紧的是：静态层**压根判不了**这一列的默认值 / 无符号性 / 枚举
   * （迁移里没有这一列 → 判不了），而库内层**判得了**——
   * 两层的**判定口径**分叉了（判的列数不一样）。
   * 期望：LAYER_DIMENSION_STATS_DRIFT（口径漂移）。
   */
  'layer-reconciliation-migration-column-removed'() {
    const file = path.join(
      copyRoot,
      'apps/api/src/database/migrations/1730000000000-InitSchema.ts',
    );
    replaceOnce(
      file,
      /        '`college` VARCHAR\(64\) NULL,' \+\n/,
      '',
    );
  },

  /*
   * 两层结论对账（第十七轮，**第四种退化形态**）：
   * 把**迁移里**某一列的默认值从字面量改成**表达式** ——
   * 静态层看的是**迁移里的 DDL 原文**：`DEFAULT CURRENT_TIMESTAMP(3)`
   * 是表达式 → 「**判不了**」（口径上跳过）；
   * 库内层看的是**库里真实的默认值**（`0`，建库时就写死了）→ **判得了**，判「一致」。
   *
   * ⚠️ 这一条打的是**「跳过」与「判了」的分叉**：
   *   两层的结论看起来都是「没问题」，但有一层**根本没判** ——
   *   这是「口径一致 ≠ 结论一致」里最隐蔽的一种：
   *   对账脚本若只比「有没有报错」，这一处就**永远发现不了**。
   * 期望：LAYER_SKIPPED_DIVERGENCE。
   */
  'layer-reconciliation-default-expression-skewed'() {
    const file = path.join(
      copyRoot,
      'apps/api/src/database/migrations/1730000000000-InitSchema.ts',
    );
    // 迁移里 `users.version` 的默认值从 `0` 改成 `CURRENT_TIMESTAMP(3)` ——
    // 静态层因此「判不了」，而库里的真实默认值仍是 `0`（库内层判得了）。
    replaceOnce(
      file,
      /        '`version` INT NOT NULL DEFAULT 0,' \+/,
      "        '`version` INT NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +",
    );
  },

  /*
   * 两层结论对账（第十七轮，**第五种退化形态**）：
   * 把**登记表里**一道唯一键的条目删掉 ——
   * 库内层是拿**登记表**当基准的（登记表里有，才去库里找那道约束），
   * 条目删了，它**压根不去判**这一道唯一键；
   * 静态层是拿**实体声明**当基准的（实体声明了，就去迁移里找），
   * 它**照判不误**。
   *
   * ⚠️ 这一条打的是**「互相遗漏」**：同一个对象，一层判了、另一层**没判**。
   *   对账脚本若只比「报出来的差异集」，这一处同样**永远发现不了**。
   * 期望：LAYER_VERDICT_OMISSION。
   */
  'layer-reconciliation-registry-entry-removed'() {
    const file = path.join(copyRoot, 'infra/scripts/check-error-semantics.mjs');
    replaceOnce(
      file,
      /    entity: 'alumni_profiles',\n    entityClass: 'AlumniProfile',\n    entityFile: 'apps\/api\/src\/database\/entities\/alumni\.entity\.ts',\n    columns: \['user_id'\],\n/,
      "    entity: '__selftest_removed_alumni_profiles',\n" +
        "    entityClass: 'AlumniProfile',\n" +
        "    entityFile: 'apps/api/src/database/entities/alumni.entity.ts',\n" +
        "    columns: ['user_id'],\n",
    );
  },

  /*
   * 两层结论对账（第十七轮，**第六种退化形态**）：
   * 给静态层加一个**新的判定码**（`MIGRATION_SELFTEST_NEW_CODE`），
   * 但**不**把它归到任何维度、也**不**写进「明确不跨层比」的清单 ——
   * 这个判定码的结论**永远不会被跨层对账比到**（漏判）。
   *
   * ⚠️ 这一条打的是「**判定码的归属完整性**」：
   *   新增判定码却忘了归维度，是最容易发生、也最不容易被发现的漏判 ——
   *   它**不会**让任何一层报错（两层都绿），
   *   只是这个判定码报出来的东西**没人交叉验证**。
   * 期望：LAYER_ISSUE_CODE_UNMAPPED。
   */
  'layer-reconciliation-new-issue-code'() {
    const file = path.join(copyRoot, 'infra/scripts/check-error-semantics.mjs');
    // 在静态层的「6.6 默认值」那一节**之前**加一条**没有归维度**的新判定码。
    // ⚠️ 要挑一个「语句级完整」的位置插：插到 `if` 块中间会把块结构弄坏
    //   （自测脚本自己就跑不起来了，注入就白注了）。
    replaceOnce(
      file,
      /      \/\* --- 6\.6\.1 默认值 --- \*\/\n      if \(column\.defaultValue !== null && column\.defaultValue !== undefined\) \{/,
      "      // 自测注入：一个**没有归维度**的新判定码 —— 它的结论没人交叉验证\n" +
        "      if (column.column === 'college' && table.table === 'alumni_profiles') {\n" +
        "        issues.push({\n" +
        "          kind: 'MIGRATION_SELFTEST_NEW_CODE',\n" +
        "          where: `${table.table}.${column.column}`,\n" +
        "          detail: '自测注入：这个判定码没有归到任何维度，也不在「明确不跨层比」的清单里',\n" +
        "        });\n" +
        "      }\n" +
        "      /* --- 6.6.1 默认值 --- */\n" +
        "      if (column.defaultValue !== null && column.defaultValue !== undefined) {",
    );
  },

  /*
   * 读端点可见性对账（第十七轮）：把 API-SPEC 里「读端点的可见性口径」
   * 那一**整节**的标题改掉 ——
   * 那一节里逐条写着「不可见 → 404」的口径，
   * 标题一改，整节就**认不出来了** → 口径等于没写。
   * 期望：READ_VISIBILITY_SECTION_MISSING。
   */
  'read-visibility-doc-section-missing'() {
    const file = path.join(copyRoot, 'docs/API-SPEC.md');
    replaceOnce(file, /读端点的可见性口径/, '读端点的响应口径');
  },

  /*
   * 读端点可见性对账（第十七轮）：把登记表里那个公开读端点的**路径**改掉 ——
   * 登记表说的那个端点在代码里**找不到了**（要么端点被改名，
   * 要么它不再是公开的了）。
   * 期望：READ_VISIBILITY_ROUTE_MISSING。
   */
  'read-visibility-route-missing'() {
    const file = path.join(copyRoot, 'infra/scripts/check-read-visibility.mjs');
    replaceOnce(
      file,
      /path: '\/articles\/:id',\n(\s+)controller: 'apps\/api\/src\/modules\/content\/content\.controller\.ts',/,
      "path: '/articles/:id/selftest-renamed',\n$1controller: 'apps/api/src/modules/content/content.controller.ts',",
    );
  },

  /*
   * 读端点可见性对账（第十七轮）：把登记表里那个公开读端点的**控制器**改错 ——
   * 端点还在，但它被挪到了**另一个控制器**里，登记表没跟着更新。
   * 期望：READ_VISIBILITY_CONTROLLER_MISMATCH。
   */
  'read-visibility-controller-mismatch'() {
    const file = path.join(copyRoot, 'infra/scripts/check-read-visibility.mjs');
    replaceOnce(
      file,
      /path: '\/articles\/:id',\n(\s+)controller: 'apps\/api\/src\/modules\/content\/content\.controller\.ts',/,
      "path: '/articles/:id',\n$1controller: 'apps/api/src/modules/content/selftest-other.controller.ts',",
    );
  },

  /*
   * 读端点可见性对账（第十七轮）：把**实现**里那个方法**改名** ——
   * 登记表说「口径落在 `articleDetail` 这个方法里」，
   * 方法一改名，口径就**无处核对**了。
   * 期望：READ_VISIBILITY_IMPL_MISSING。
   */
  'read-visibility-impl-missing'() {
    const file = path.join(copyRoot, 'apps/api/src/modules/content/content.service.ts');
    replaceOnce(
      file,
      /  async articleDetail\(id: number\): Promise<ArticleView> \{/,
      '  async articleDetailSelftestRenamed(id: number): Promise<ArticleView> {',
    );
  },

  /*
   * 已登录端点可见性对账（第十七轮）：把登记表里那个已登录端点的**路径**改掉 ——
   * 端点在代码里找不到了。
   * 期望：AUTH_VISIBILITY_ROUTE_MISSING。
   */
  'read-visibility-auth-route-missing'() {
    const file = path.join(copyRoot, 'infra/scripts/check-read-visibility.mjs');
    replaceOnce(
      file,
      /path: '\/connections\/:id',\n(\s+)controller: 'apps\/api\/src\/modules\/connections\/connections\.controller\.ts',/,
      "path: '/connections/:id/selftest-renamed',\n$1controller: 'apps/api/src/modules/connections/connections.controller.ts',",
    );
  },

  /*
   * 已登录端点可见性对账（第十七轮）：把登记表里那个已登录端点的**控制器**改错 ——
   * 端点被挪到了另一个控制器，登记表没跟着更新。
   * 期望：AUTH_VISIBILITY_CONTROLLER_MISMATCH。
   */
  'read-visibility-auth-controller-mismatch'() {
    const file = path.join(copyRoot, 'infra/scripts/check-read-visibility.mjs');
    replaceOnce(
      file,
      /path: '\/connections\/:id',\n(\s+)controller: 'apps\/api\/src\/modules\/connections\/connections\.controller\.ts',/,
      "path: '/connections/:id',\n$1controller: 'apps/api/src/modules/connections/selftest-other.controller.ts',",
    );
  },

  /*
   * 已登录端点可见性对账（第十七轮）：把**实现**里那个方法**改名** ——
   * 403 / 404 的分界无处核对。
   * 期望：AUTH_VISIBILITY_IMPL_MISSING。
   */
  'read-visibility-auth-impl-missing'() {
    const file = path.join(
      copyRoot,
      'apps/api/src/modules/connections/connections.service.ts',
    );
    replaceOnce(
      file,
      /  async getConnection\(pairId: number, userId: number\) \{/,
      '  async getConnectionSelftestRenamed(pairId: number, userId: number) {',
    );
  },

  /*
   * 管理端可见性对账（第十七轮）：把登记表里那个管理端端点的**路径**改掉 ——
   * 端点在代码里找不到了。
   * 期望：ADMIN_VISIBILITY_ROUTE_MISSING。
   */
  'read-visibility-admin-route-missing'() {
    const file = path.join(copyRoot, 'infra/scripts/check-read-visibility.mjs');
    replaceOnce(
      file,
      /path: '\/admin\/alumni\/:id',\n(\s+)controller: 'apps\/api\/src\/modules\/admin\/admin\.controller\.ts',/,
      "path: '/admin/alumni/:id/selftest-renamed',\n$1controller: 'apps/api/src/modules/admin/admin.controller.ts',",
    );
  },

  /*
   * 管理端可见性对账（第十七轮）：把登记表里那个管理端端点的**控制器**改错 ——
   * 端点被挪到了另一个控制器，登记表没跟着更新。
   * 期望：ADMIN_VISIBILITY_CONTROLLER_MISMATCH。
   */
  'read-visibility-admin-controller-mismatch'() {
    const file = path.join(copyRoot, 'infra/scripts/check-read-visibility.mjs');
    replaceOnce(
      file,
      /path: '\/admin\/alumni\/:id',\n(\s+)controller: 'apps\/api\/src\/modules\/admin\/admin\.controller\.ts',/,
      "path: '/admin/alumni/:id',\n$1controller: 'apps/api/src/modules/admin/selftest-other.controller.ts',",
    );
  },

  /*
   * 管理端可见性对账（第十七轮）：把**实现**里那个方法**改名** ——
   * 「资源不存在 → 404」的处置无处核对。
   * 期望：ADMIN_VISIBILITY_IMPL_MISSING。
   */
  'read-visibility-admin-impl-missing'() {
    const file = path.join(
      copyRoot,
      'apps/api/src/modules/directory/directory.service.ts',
    );
    replaceOnce(
      file,
      /  async adminDetail\(targetUserId: number\): Promise<Record<string, unknown>> \{/,
      '  async adminDetailSelftestRenamed(targetUserId: number): Promise<Record<string, unknown>> {',
    );
  },

  /*
   * 管理端可见性对账（第十七轮）：把**已登录端点表**里的一条，
   * 也登记进**管理端表** ——
   * 同一个端点出现在**两张表**里 → 改口径时要改两处、漏一处就分叉。
   * 期望：ADMIN_VISIBILITY_DUPLICATE。
   */
  'read-visibility-admin-duplicate-registration'() {
    const file = path.join(copyRoot, 'infra/scripts/check-read-visibility.mjs');
    // 在管理端表的最前面插一条**已登录端点表里已有**的端点。
    replaceOnce(
      file,
      /const ADMIN_VISIBILITY_REGISTRY = \[\n/,
      "const ADMIN_VISIBILITY_REGISTRY = [\n" +
        "  // 自测注入：同一个端点在两张表里各登记了一次\n" +
        "  {\n" +
        "    method: 'GET',\n" +
        "    path: '/connections/:id',\n" +
        "    controller: 'apps/api/src/modules/connections/connections.controller.ts',\n" +
        "    handler: 'getConnection',\n" +
        "    impl: {\n" +
        "      file: 'apps/api/src/modules/connections/connections.service.ts',\n" +
        "      method: 'getConnection',\n" +
        "    },\n" +
        "    boundary: '自测注入：与已登录端点表重复登记',\n" +
        "    docTokens: ['404'],\n" +
        "  },\n",
    );
  },

  'multi-step-across-methods'() {
    const file = path.join(
      copyRoot,
      'apps/api/src/modules/resources/resources.service.ts',
    );
    replaceOnce(
      file,
      /  \/\*\* 作者修改：版本号 \+1[\s\S]*?\n  \}\n/,
      `  /** 作者修改：版本号 +1；已发布内容修改后回到 pending 重新审核。 */
  async update(id: number, authorId: number, dto: UpdateResourceDto): Promise<ResourceView> {
    const post = await this.posts.findOne({ where: { id } });
    if (!post) throw new NotFoundException('内容不存在');
    if (post.authorId !== authorId) throw new ForbiddenException('只能修改自己发布的内容');
    if (dto.title !== undefined) post.title = dto.title;
    if (dto.body !== undefined) post.body = dto.body;
    post.version += 1;
    await this.posts.save(post);

    if (dto.attachmentMediaIds !== undefined) {
      const mediaIds = await this.assertOwnedMedia(authorId, dto.attachmentMediaIds);
      await this.replaceAttachments(post.id, mediaIds);
    }

    return this.toView(post);
  }
`,
    );
  },
};

const injector = injectors[caseName];
if (!injector) {
  console.error(`未知注入 case：${caseName}`);
  console.error(`可用：${Object.keys(injectors).join(', ')}`);
  process.exit(2);
}

try {
  injector();
  console.log(`已注入缺陷：${caseName}`);
} catch (error) {
  console.error(`注入失败（${caseName}）：${error.message}`);
  process.exit(1);
}
