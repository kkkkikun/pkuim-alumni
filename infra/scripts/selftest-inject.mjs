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
 *   unique-index-db-registry-injected → 库内对账：登记表要求、但**库里其实没有**的唯一键
 *   read-visibility-filter-removed    → 读端点可见性：**可见性过滤被删掉**（未发布内容凭 id 就能读到）
 *   read-visibility-status-changed    → 读端点可见性：「不可见 → 404」被改成 403（泄露存在性）
 *   read-visibility-endpoint-unregistered → 读端点可见性：新增公开读端点却**没登记口径**
 *   read-visibility-doc-row-removed   → 读端点可见性：API-SPEC 里的可见性口径那一行被删掉
 *   read-visibility-known-issue-removed → 读端点可见性：待拍板条目（#197）被从 KNOWN-ISSUES 删掉
 *   read-visibility-pending-resolved  → 读端点可见性：待拍板端点的行为被改掉（登记表过期）
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
    const file = path.join(
      copyRoot,
      'apps/api/test/integration/read-coverage.e2e-spec.ts',
    );
    replaceOnce(
      file,
      /\$\{API\}\/system\/health`/,
      '${API}/system/health-disabled`',
    );
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
