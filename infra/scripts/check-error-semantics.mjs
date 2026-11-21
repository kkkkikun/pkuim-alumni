#!/usr/bin/env node
/**
 * 管理端**写操作**的错误语义对账（缺陷 #190）。
 *
 * 背景：
 *   管理端是按业务 `code` 分支处理失败的（`docs/API-SPEC.md` 通用约定）：
 *     400 `VALIDATION_ERROR`（参数写错了）
 *     404 `NOT_FOUND`（对象不存在）
 *     409 `CONFLICT`（撞键 / 业务状态冲突）
 *   一旦某个失败形态返回 **500 `INTERNAL_ERROR`**，管理端就会把它当成
 *   「服务端故障」—— 运维去查服务健康度，管理员去刷新页面 ——
 *   而真实原因可能只是「你填的 slug 重复了」。
 *
 *   缺陷 #190 就是这样暴露的：`article_categories.slug` 上有唯一索引，
 *   重复写入时数据库抛 `ER_DUP_ENTRY`，此前**直接冒泡**成 500。
 *   （`admin_users.username` 早已修好，见缺陷 #112。）
 *
 * 本脚本对账三件事：
 *   1) **唯一键登记表**（R1 / R2）：
 *      管理端写端点能触发的每个唯一列，都必须在下面的登记表里
 *      **点名**它的处置位置。新加唯一列却没登记 → 报错
 *      （新唯一键上线时必须先想清楚「撞了返回什么」）。
 *   2) **冲突处置真的存在**（R3）：
 *      登记表里写的处置位置必须**确实**把重复键映射成了 409 ——
 *      把那段捕获删掉（也就是把缺陷 #190 重新犯一遍），这里必须抓到。
 *   3) **口径写进了文档**（R4）：
 *      每个登记条目都必须在 `docs/API-SPEC.md` 的「错误语义」小节里
 *      被点名并给出 409 —— 代码改了、文档没改，等于对外契约悄悄变了。
 *
 * ⚠️ 口径与判定的局限（写在这里，免得被当成万能护栏）：
 *   - 判定是**静态**的：只看源码里有没有「捕获重复键 + 转 409」的形态，
 *     不执行代码，也不连数据库；真值由集成测试
 *     （`apps/api/test/integration/admin-write-error-semantics.e2e-spec.ts`）守着。
 *   - 登记表只覆盖**管理端写端点能触发的**唯一列；
 *     其它表（连接、活动报名、通知附件等）的唯一键不在本脚本的范围内。
 *
 * 用法：
 *   node infra/scripts/check-error-semantics.mjs [--root <repo>] [--json]
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

/* ------------------------------ 登记表 ------------------------------ */

/**
 * 管理端写端点能触发的**唯一键**登记表。
 *
 * 每条必须写清：撞键时**返回什么**、**在哪**做这件事。
 * 缺一条就等于「这个唯一键撞了会怎样」没人想过 ——
 * 那正是缺陷 #190 的土壤（唯一索引在、语义没人管）。
 */
const UNIQUE_KEY_REGISTRY = [
  {
    entity: 'admin_users',
    entityClass: 'AdminUser',
    entityFile: 'apps/api/src/database/entities/admin.entity.ts',
    column: 'username',
    endpoints: [{ method: 'POST', path: '/admin/users' }],
    guard: { file: 'apps/api/src/modules/admin/admin-users.controller.ts', method: 'createAdmin' },
    note: '登录名重复 → 409 `CONFLICT`（缺陷 #112）',
  },
  {
    entity: 'article_categories',
    entityClass: 'ArticleCategory',
    entityFile: 'apps/api/src/database/entities/content.entity.ts',
    column: 'slug',
    endpoints: [
      { method: 'POST', path: '/admin/articles/categories' },
      { method: 'PATCH', path: '/admin/articles/categories/:id' },
    ],
    guard: { file: 'apps/api/src/modules/content/content.service.ts', method: 'createCategory' },
    extraGuards: [
      { file: 'apps/api/src/modules/content/content.service.ts', method: 'updateCategory' },
    ],
    note: '分类 slug 重复 → 409 `CONFLICT`（缺陷 #190）',
  },
  {
    entity: 'system_settings',
    entityClass: 'SystemSetting',
    entityFile: 'apps/api/src/database/entities/system.entity.ts',
    column: 'key',
    endpoints: [{ method: 'PUT', path: '/admin/settings' }],
    guard: {
      file: 'apps/api/src/modules/admin/admin-users.controller.ts',
      method: 'withDuplicateKeyRetry',
    },
    note: '并发撞键 → 重试耗尽后 409 `CONFLICT`（缺陷 #190 的口径）',
  },
];

/** 「确实把重复键转成了 409」的判据 */
const DUPLICATE_KEY_MARKERS = ['isDuplicateKeyError', 'ER_DUP_ENTRY', '1062', 'QueryFailedError'];
const CONFLICT_MARKER = 'ConflictException';

/* ------------------------------ 工具 ------------------------------ */

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 切出某个类的主体（按 `export class X` 切块）。
 *
 * 一个实体文件里可能有多个实体（`admin.entity.ts` 里就有
 * AdminUser / AdminUserRole / Role / Permission / AdminActionLog），
 * 不切块就会把别的实体的列算到这一个头上。
 */
function classBlock(src, className) {
  const start = src.indexOf(`class ${className}`);
  if (start < 0) return null;
  const next = src.indexOf('\nexport class ', start + 1);
  return next > 0 ? src.slice(start, next) : src.slice(start);
}

/**
 * 取一个类里带唯一约束的列名。
 *
 * 认两种形态：
 *   - `@Column({ ..., unique: true })` —— 单列唯一索引；
 *   - `@PrimaryColumn({ name: 'key', ... })` —— 主键天然唯一
 *     （`system_settings.key` 就是这种）。
 */
function uniqueColumnsOf(src, className) {
  const block = classBlock(src, className);
  if (!block) return null;
  const columns = new Set();
  const columnRe = /@(Primary)?Column\(\{([\s\S]*?)\}\)/g;
  let match;
  while ((match = columnRe.exec(block)) !== null) {
    const args = match[2];
    const nameMatch = /name:\s*'([^']+)'/.exec(args);
    if (!nameMatch) continue;
    if (match[1] === 'Primary' || /unique:\s*true/.test(args)) {
      columns.add(nameMatch[1]);
    }
  }
  return columns;
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
    const brace = src.indexOf('{', close);
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

/** 方法体里是否「捕获了重复键」且「转成了 409」 */
function mapsDuplicateKeyToConflict(body) {
  const catches = DUPLICATE_KEY_MARKERS.some((marker) => body.includes(marker));
  return catches && body.includes(CONFLICT_MARKER);
}

/**
 * 判定某个处置位置是否真的把重复键转成了 409。
 *
 * 两种形态都算：
 *   1) 方法体里**直接**捕获重复键并抛 `ConflictException`；
 *   2) 方法体里**调用**了另一个带处置的方法（如 `withDuplicateKeyRetry(...)`）。
 */
function guardResolves(guard) {
  const src = readTextSafe(path.join(ROOT, guard.file));
  if (!src) return { ok: false, reason: `文件不存在：${guard.file}` };
  const methods = collectMethods(src);
  const target = methods.find((method) => method.name === guard.method);
  if (!target) return { ok: false, reason: `文件里找不到方法 ${guard.method}` };
  if (mapsDuplicateKeyToConflict(target.body)) {
    return { ok: true, where: `${guard.file} · ${guard.method}` };
  }
  // 间接形态：调用了同类里另一个带处置的方法
  for (const other of methods) {
    if (other.name === guard.method) continue;
    if (!new RegExp(`this\\.${other.name}\\s*\\(`).test(target.body)) continue;
    if (mapsDuplicateKeyToConflict(other.body)) {
      return { ok: true, where: `${guard.file} · ${other.name}（由 ${guard.method} 调用）` };
    }
  }
  return {
    ok: false,
    reason:
      `${guard.file} · ${guard.method} 里既没有捕获重复键（${DUPLICATE_KEY_MARKERS.join(' / ')}），` +
      '也没有转成 409（ConflictException）—— 撞唯一键会直接冒泡成 500',
  };
}

/**
 * 取 `docs/API-SPEC.md` 里「错误语义」那一小节。
 *
 * 取不到整节 = 口径没写 = 报错（宁可吵，也不要默默放过）。
 */
function errorSemanticsSection() {
  const src = readTextSafe(path.join(ROOT, 'docs/API-SPEC.md'));
  if (!src) return null;
  const lines = src.split('\n');
  const start = lines.findIndex((line) => /^#{2,4}\s/.test(line) && line.includes('错误语义'));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{2,4}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { heading: lines[start], lines: lines.slice(start, end) };
}

/* ------------------------------ 主流程 ------------------------------ */

function main() {
  const issues = [];
  const notes = [];

  // --- 1) 唯一键登记表与实体实现对账 -----------------------------------------
  for (const entry of UNIQUE_KEY_REGISTRY) {
    const entitySrc = readTextSafe(path.join(ROOT, entry.entityFile));
    if (!entitySrc) {
      issues.push({
        kind: 'ENTITY_FILE_MISSING',
        where: entry.entityFile,
        detail: `登记表指向的实体文件不存在：${entry.entityFile}`,
      });
      continue;
    }
    const columns = uniqueColumnsOf(entitySrc, entry.entityClass);
    if (!columns) {
      issues.push({
        kind: 'ENTITY_CLASS_MISSING',
        where: `${entry.entityFile} · ${entry.entity}`,
        detail: `实体文件里找不到 class ${entry.entityClass}`,
      });
      continue;
    }
    if (!columns.has(entry.column)) {
      issues.push({
        kind: 'REVIEWED_COLUMN_MISSING',
        where: `${entry.entity}.${entry.column}`,
        detail:
          `登记表的唯一列 ${entry.entity}.${entry.column} 在实体文件里没有了 —— ` +
          '要么唯一索引被删了（登记表该更新），要么实体与登记表分叉了',
      });
    }
    // 该实体里**其它**唯一列 → 必须也登记过
    const registered = new Set(
      UNIQUE_KEY_REGISTRY.filter((item) => item.entity === entry.entity).map((item) => item.column),
    );
    for (const column of columns) {
      if (registered.has(column)) continue;
      issues.push({
        kind: 'UNIQUE_COLUMN_NOT_REVIEWED',
        where: `${entry.entity}.${column}`,
        detail:
          `${entry.entity} 上多了一个唯一列 '${column}'，但登记表里没有它的失败语义 —— ` +
          '撞键时返回什么（409？404？）没人想过，必须先登记再上线',
      });
    }
  }

  // --- 2) 冲突处置真的存在 ---------------------------------------------------
  for (const entry of UNIQUE_KEY_REGISTRY) {
    const guards = [entry.guard, ...(entry.extraGuards ?? [])];
    for (const guard of guards) {
      const result = guardResolves(guard);
      if (result.ok) {
        notes.push({
          kind: 'CONFLICT_MAPPING_OK',
          where: `${entry.entity}.${entry.column}`,
          detail: `${result.where}：${entry.note}`,
        });
        continue;
      }
      issues.push({
        kind: 'MISSING_CONFLICT_MAPPING',
        where: `${entry.entity}.${entry.column}`,
        detail:
          `${result.reason}。${entry.note} —— ` +
          '处置方式必须是「捕获唯一键冲突并转成 409」，' +
          '**不得**靠去掉唯一索引来「解决」它（那等于允许重名，是数据损坏）',
      });
    }
  }

  // --- 3) 口径写进了文档 -----------------------------------------------------
  const section = errorSemanticsSection();
  if (!section) {
    issues.push({
      kind: 'ERROR_SEMANTICS_SECTION_MISSING',
      where: 'docs/API-SPEC.md',
      detail:
        'API-SPEC 里找不到「错误语义」小节 —— 管理端写操作的失败口径必须写进文档，' +
        '否则客户端只能靠猜',
    });
  } else {
    for (const entry of UNIQUE_KEY_REGISTRY) {
      for (const endpoint of entry.endpoints) {
        const row = section.lines.find(
          (line) => line.includes(endpoint.path) && line.includes(endpoint.method),
        );
        if (!row) {
          issues.push({
            kind: 'ERROR_SEMANTICS_UNDOCUMENTED',
            where: `${endpoint.method} ${endpoint.path}`,
            detail:
              `「${section.heading.trim()}」小节里没有点名 ${endpoint.method} ${endpoint.path} —— ` +
              '对外契约变了却没写进文档，客户端会按旧口径处理',
          });
          continue;
        }
        if (!row.includes('409') || !row.includes('CONFLICT')) {
          issues.push({
            kind: 'ERROR_SEMANTICS_UNDOCUMENTED',
            where: `${endpoint.method} ${endpoint.path}`,
            detail: `文档里这一行没有写明 409 / CONFLICT：${row.trim()}`,
          });
          continue;
        }
        notes.push({
          kind: 'ERROR_SEMANTICS_DOCUMENTED',
          where: `${endpoint.method} ${endpoint.path}`,
          detail: row.trim(),
        });
      }
    }
  }

  const report = {
    reviewedUniqueKeys: UNIQUE_KEY_REGISTRY.length,
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
        `✅ 管理端写操作的错误语义对账通过：${report.reviewedUniqueKeys} 个唯一键都有 409 处置与文档口径\n`,
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
