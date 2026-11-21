#!/usr/bin/env node
/**
 * 唯一键的**库内实况**对账（登记表 ↔ 迁移 ↔ 真实数据库）。
 *
 * 背景（第十轮）：
 *   静态对账（`check-error-semantics.mjs` 的 R5）能证明
 *   「迁移里**写了**创建那道唯一索引」——
 *   但它证明不了「**这个库里真的有那道索引**」。
 *   生产库 `synchronize: false`，跑的是迁移；
 *   而迁移是否**真的被应用过**、应用后索引是否还在（例如有人手工 DROP 过、
 *   或者库是从旧备份恢复的），静态脚本**一律看不见**。
 *   这一层的失败同样是**静默**的：撞键不报错 → 静默写出重复行。
 *
 * 本脚本做三件事（**只读**，全程只执行 SELECT）：
 *   1) 从 `information_schema.statistics` 读出库里**真实存在**的唯一约束；
 *   2) 与**唯一键登记表**（`check-error-semantics.mjs` 的 `UNIQUE_KEY_REGISTRY`）
 *      和**迁移层**抽出来的唯一约束三方对账；
 *   3) 有出入就报错、退出码非 0。
 *
 * ⚠️ 口径与局限（写在这里，免得被当成万能护栏）：
 *   - 「等价的唯一约束」= **列集合相同**的唯一索引，**或**列集合相同的主键
 *     （复合主键天然唯一）。索引**名字**不同不算不一致 ——
 *     `admin_user_roles` 由复合主键提供唯一性就是等价形态。
 *   - **自增主键**（`id ... AUTO_INCREMENT` 的单列主键）不算业务唯一键，
 *     不参与对账（它在实体里是 `@PrimaryGeneratedColumn`，本就不在登记表口径里）。
 *   - 本脚本**只读**：它不会建索引、不会跑迁移、不会改数据。
 *   - 对账的**基线**是登记表与迁移 —— 那两者的静态一致性由
 *     `check-error-semantics.mjs` 负责（它先跑，本脚本后跑）。
 *
 * 用法：
 *   node infra/scripts/check-unique-index-db.mjs [--db <库名>] [--json] [--root <repo>]
 *   DATABASE_URL=mysql://user:pass@host:3306/nmg_alumni_test node infra/scripts/check-unique-index-db.mjs
 *
 * 退出码：0 = 库里与登记表 / 迁移一致；1 = 存在出入。
 */

import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------ 参数 ------------------------------ */

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const ROOT = path.resolve(argValue('--root', process.cwd()));
const AS_JSON = args.includes('--json');

/** 唯一键的规范表示：列名按字典序排列后用 `+` 连接。 */
function keyOf(columns) {
  return [...columns].sort().join('+');
}

/**
 * 载入「唯一键登记表 + 实体 / 迁移解析」—— **从 `--root` 指向的仓库里**载入。
 *
 * ⚠️ 为什么要动态 import 而不是顶层静态 import：
 *   反向验证（`check-unique-index-db-selftest.sh`）会在**临时副本**里
 *   注入缺陷（往登记表里塞一条库里并不存在的唯一键），
 *   然后用 `--root <副本>` 跑本脚本 ——
 *   静态 import 拿到的永远是**本脚本所在仓库**的登记表，注入就白注了。
 */
async function loadCheckerModule() {
  const modulePath = path.join(ROOT, 'infra/scripts/check-error-semantics.mjs');
  return import(pathToFileURL(modulePath).href);
}

/**
 * 载入 mysql2 —— 它是 `@nmg/api` 的依赖（pnpm 下不会提升到仓库根目录）。
 *
 * 不引新依赖、不动锁文件：按 `apps/api/package.json` 去 require。
 * 候选路径按顺序试：脚本所在仓库 → `--root` 指向的仓库
 * （反向验证时脚本在真仓库、依赖也在真仓库，而 `--root` 指向副本）。
 */
function loadMysql() {
  const candidates = [
    path.join(SCRIPT_DIR, '../../apps/api/package.json'),
    path.join(ROOT, 'apps/api/package.json'),
  ];
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const require = createRequire(candidate);
      return require('mysql2/promise');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('找不到 mysql2');
}

/* ------------------------------ 连接 ------------------------------ */

/**
 * 连接参数 —— 与服务端 `apps/api/src/database/data-source.ts` 的解析规则一致
 * （`DATABASE_URL` 优先，其次 DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME）。
 */
function resolveConnection() {
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    const parsed = new URL(url);
    const database = argValue('--db', parsed.pathname.replace(/^\//, ''));
    return {
      host: parsed.hostname,
      port: Number(parsed.port || 3306),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database,
    };
  }
  return {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number.parseInt(process.env.DB_PORT ?? '3306', 10),
    user: process.env.DB_USER ?? 'nmg',
    password: process.env.DB_PASSWORD ?? '',
    database: argValue('--db', process.env.DB_NAME ?? 'nmg_pku_alumni'),
  };
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const { UNIQUE_KEY_REGISTRY, discoverMigrationSchema } = await loadCheckerModule();

  const mysql = loadMysql();

  const connection = resolveConnection();
  const issues = [];
  const notes = [];

  const client = await mysql.createConnection({
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    database: connection.database,
  });

  let rows;
  let identityRows;
  try {
    [rows] = await client.query(
      'SELECT table_name AS tableName, index_name AS indexName, ' +
        'GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns, ' +
        'MAX(non_unique) AS nonUnique ' +
        'FROM information_schema.statistics ' +
        'WHERE table_schema = DATABASE() AND non_unique = 0 ' +
        'GROUP BY table_name, index_name ' +
        'ORDER BY table_name, index_name',
    );
    // 自增列（`id ... AUTO_INCREMENT`）—— 单列主键落在它身上时，
    // 那条主键**不是业务唯一键**（实体里是 `@PrimaryGeneratedColumn`），
    // 不参与对账，否则每张表都会被误报成「多了一条来源不明的约束」。
    [identityRows] = await client.query(
      "SELECT table_name AS tableName, column_name AS columnName " +
        'FROM information_schema.columns ' +
        "WHERE table_schema = DATABASE() AND extra LIKE '%auto_increment%'",
    );
  } finally {
    await client.end();
  }

  const identityColumns = new Set(
    identityRows.map((row) => `${String(row.tableName).toLowerCase()}.${String(row.columnName).toLowerCase()}`),
  );

  /** 库里真实存在的唯一约束 */
  const dbUniques = rows.map((row) => ({
    table: String(row.tableName).toLowerCase(),
    name: String(row.indexName),
    columns: String(row.columns)
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
    primary: String(row.indexName).toUpperCase() === 'PRIMARY',
  }));

  // --- 期望值：登记表（唯一事实来源） --------------------------------------
  const registryKeys = UNIQUE_KEY_REGISTRY.map((entry) => ({
    table: entry.entity.toLowerCase(),
    columns: entry.columns.map((column) => column.toLowerCase()),
    source: `登记表 ${entry.entity}.${entry.columns.join(',')}`,
  }));

  // --- 期望值：迁移层 ------------------------------------------------------
  const migrationSchema = discoverMigrationSchema();
  const migrationKeys = migrationSchema.uniques
    .filter((item) => !item.identity)
    .map((item) => ({
      table: item.table,
      columns: item.columns,
      source: `迁移 ${item.source} · ${item.name}`,
    }));

  /**
   * 库里有没有「等价」的约束：
   *   - 同表、同列集合的唯一索引；或
   *   - 同表、同列集合的主键（复合主键天然唯一 —— 等价形态）。
   */
  function findEquivalent(table, columns) {
    return dbUniques.find(
      (item) => item.table === table && keyOf(item.columns) === keyOf(columns),
    );
  }

  for (const expected of registryKeys) {
    const found = findEquivalent(expected.table, expected.columns);
    if (!found) {
      issues.push({
        kind: 'DB_UNIQUE_MISSING',
        where: `${expected.table}.${expected.columns.join(',')}`,
        detail:
          `${expected.source} 要求这道唯一约束，但**库里没有** —— ` +
          '生产库 `synchronize: false`，撞键不会报错，数据库会**静默写出重复行**',
      });
      continue;
    }
    notes.push({
      kind: 'DB_UNIQUE_OK',
      where: `${expected.table}.${expected.columns.join(',')}`,
      detail: `库里由 \`${found.name}\` 提供唯一性（${found.columns.join(',')}）`,
    });
  }

  // --- 反向：库里多出来的唯一约束 ----------------------------------------
  //   迁移层与登记表都认可、但**实体没声明**的那些，由静态校验器负责；
  //   这里只报「登记表与迁移都没有」的（来源不明的约束）。
  for (const item of dbUniques) {
    if (item.primary && item.columns.length === 1) {
      // 单列主键：要么是自增 id（业务唯一键口径外），要么是自然键
      //   （`system_settings.key` / `private_contacts.user_id` 等）——
      //   后者都在登记表里，已在上面判过。
      if (identityColumns.has(`${item.table}.${item.columns[0]}`)) continue;
      const known = registryKeys.some(
        (expected) =>
          expected.table === item.table && keyOf(expected.columns) === keyOf(item.columns),
      );
      if (known) continue;
      const migrationKnown = migrationKeys.some(
        (expected) =>
          expected.table === item.table && keyOf(expected.columns) === keyOf(item.columns),
      );
      if (migrationKnown) continue;
      issues.push({
        kind: 'DB_UNIQUE_NOT_DECLARED',
        where: `${item.table}.${item.columns.join(',')}`,
        detail:
          `库里有一条唯一约束 \`${item.name}\`（${item.columns.join(',')}），` +
          '但**登记表与迁移里都没有** —— 来源不明的约束，' +
          '写入会被它挡下（撞键），而代码没准备这条唯一键的失败语义',
      });
      continue;
    }
    const known = registryKeys.some(
      (expected) =>
        expected.table === item.table && keyOf(expected.columns) === keyOf(item.columns),
    );
    if (known) continue;
    const migrationKnown = migrationKeys.some(
      (expected) =>
        expected.table === item.table && keyOf(expected.columns) === keyOf(item.columns),
    );
    if (migrationKnown) continue;
    issues.push({
      kind: 'DB_UNIQUE_NOT_DECLARED',
      where: `${item.table}.${item.columns.join(',')}`,
      detail:
        `库里有一条唯一约束 \`${item.name}\`（${item.columns.join(',')}），` +
        '但**登记表与迁移里都没有** —— 来源不明的约束',
    });
  }

  const report = {
    database: connection.database,
    host: connection.host,
    port: connection.port,
    registryUniqueKeys: registryKeys.length,
    migrationUniqueConstraints: migrationKeys.length,
    databaseUniqueConstraints: dbUniques.length,
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
        `✅ 库内唯一键对账通过（${connection.database} @ ${connection.host}:${connection.port}）：` +
          `${report.registryUniqueKeys} 个登记唯一键在库里**真实存在**，` +
          `库里共 ${report.databaseUniqueConstraints} 条唯一约束，无来源不明的约束\n`,
      );
    } else {
      for (const issue of issues) {
        process.stdout.write(`❌ [${issue.kind}] ${issue.where}\n     ${issue.detail}\n`);
      }
      process.stdout.write(`\n❌ 发现 ${issues.length} 处库内唯一键不一致\n`);
    }
  }

  process.exit(issues.length > 0 ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`库内唯一键对账失败：${error.message}\n`);
  process.exit(2);
});
