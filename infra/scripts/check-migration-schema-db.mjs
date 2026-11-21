#!/usr/bin/env node
/**
 * 「实体 ↔ 迁移」三层对账的**库内实况**（实体 ↔ 真实数据库）。
 *
 * 背景（第十四轮）：
 *   第十二轮把「实体 ↔ 迁移」的对账扩到了完整三层：
 *     - 全部索引（含非唯一 `idx_*`）、外键、全部列的定义；
 *   第十轮补上了「唯一键」的**库内实况**（`check-unique-index-db.mjs`）。
 *   但**索引 / 外键 / 列定义**这三层的库内实况此前**从未被核过** ——
 *   静态对账只能证明「迁移里**写了**创建那道索引」，
 *   证明不了「**这个库里真的有**那道索引 / 那道外键 / 那一列」。
 *   而这一层的失败同样是**静默**的：
 *     - 索引没建 → 按该列的查询退化成全表扫（生产上只是「慢」，没人报警）；
 *     - 外键没建 → 引用完整性不再被数据库保证（可以写入指向不存在行的外键）；
 *     - 列没建 → 读写这一列直接报「未知列」（这个至少会炸出来）。
 *   生产库 `synchronize: false`，跑的是**迁移**：
 *   迁移是否真的被应用过、库是不是从旧备份恢复的、有没有人手工 DROP 过 ——
 *   静态脚本**一律看不见**。
 *
 * 本脚本做四件事（**只读**，全程只执行 SELECT）：
 *   1) 从 `information_schema` 读出库里**真实存在**的表 / 索引 / 外键 / 列；
 *   2) 与**实体声明**（`check-error-semantics.mjs` 的 `discoverEntitySchema`，
 *      即第十二轮那份解析）逐条对账；
 *   3) 有出入就报错、退出码非 0；
 *   4) 反向也查一遍：库里多出来的索引 / 列 / 外键（实体没声明的）同样报。
 *
 * ⚠️ 口径与局限（写在这里，免得被当成万能护栏）：
 *   - **只读**：不建索引、不跑迁移、不写数据、不改表。
 *   - 对账的**基线**是**实体声明**；实体 ↔ 迁移的静态一致性由
 *     `check-error-semantics.mjs` 负责（它先跑，本脚本后跑）。
 *   - **不判**的项（与静态对账同一口径）：
 *     枚举**取值**、精度、`unsigned`、默认值、`ON DELETE` 行为。
 *   - **「主键等价」不算缺陷**：唯一索引的列就是主键时，主键天然唯一，
 *     不必再建一条同列的唯一索引（重复约束 = 写放大）。
 *   - **MySQL 自动建的「外键支撑索引」不算缺陷**：MySQL 会为没有可用索引的
 *     外键自动建一条同名索引（例如 `fk_alumni_profiles_verified_by`）——
 *     那不是索引契约的一部分，实体里也不会声明它。
 *   - **实体里 `unique: true` 的列**由一条同名唯一索引兜着，
 *     那条索引同样不算「实体没声明」（唯一性已由列声明表达）。
 *   - **没有实体类的表**（例如 TypeORM 自己的 `migrations` 表）不参与对账 ——
 *     无法判定，也不该由这一层来管。
 *
 * 用法：
 *   node infra/scripts/check-migration-schema-db.mjs [--db <库名>] [--json] [--root <repo>]
 *   DATABASE_URL=mysql://user:pass@host:3306/nmg_alumni_test node infra/scripts/check-migration-schema-db.mjs
 *
 * 退出码：0 = 库里与实体声明一致；1 = 存在出入；2 = 脚本自身失败（连不上库等）。
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

/** 唯一键 / 列的规范表示：列名按字典序排列后用 `+` 连接。 */
function keyOf(columns) {
  return [...columns].sort().join('+');
}

/**
 * 载入「实体解析」—— **从 `--root` 指向的仓库里**载入。
 *
 * ⚠️ 为什么要动态 import 而不是顶层静态 import：
 *   反向验证（`check-migration-schema-db-selftest.sh`）会在**临时副本**里
 *   注入缺陷（往实体里塞一条库里并不存在的索引），
 *   然后用 `--root <副本>` 跑本脚本 ——
 *   静态 import 拿到的永远是**本脚本所在仓库**的实体声明，注入就白注了。
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

/* ------------------------------ 类型口径 ------------------------------ */

/**
 * 类型等价关系：TypeORM 的类型名与 MySQL 的 `information_schema.data_type`
 * 并非一一对应（`timestamp` 在 MySQL 上就是 `datetime`）。
 *
 * ⚠️ 只列**确实等价**的，不做「宽松包含」——
 *   宽松包含会把真的类型分叉判成一致（那正是这一层要抓的东西）。
 */
const TYPE_EQUIVALENTS = [
  ['timestamp', 'datetime'],
  ['boolean', 'tinyint'],
];

/** 归一化类型名（小写）。 */
function normalizeType(type) {
  return String(type ?? '').trim().toLowerCase();
}

/** 两个类型是否等价（严格：只认上面显式列出的等价对）。 */
function sameType(left, right) {
  const a = normalizeType(left);
  const b = normalizeType(right);
  if (a === b) return true;
  return TYPE_EQUIVALENTS.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

/** 字符串族（长度有意义的类型）。 */
function isStringType(type) {
  const value = normalizeType(type);
  return value === 'varchar' || value === 'char' || value === 'text' || value === 'mediumtext';
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const { discoverEntitySchema } = await loadCheckerModule();

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

  let columnRows;
  let indexRows;
  let foreignKeyRows;
  try {
    [columnRows] = await client.query(
      'SELECT table_name AS tableName, column_name AS columnName, data_type AS dataType, ' +
        'character_maximum_length AS charLength, is_nullable AS isNullable, ' +
        'column_type AS columnType ' +
        'FROM information_schema.columns ' +
        'WHERE table_schema = DATABASE() ' +
        'ORDER BY table_name, ordinal_position',
    );
    [indexRows] = await client.query(
      'SELECT table_name AS tableName, index_name AS indexName, ' +
        'GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns, ' +
        'MAX(non_unique) AS nonUnique ' +
        'FROM information_schema.statistics ' +
        'WHERE table_schema = DATABASE() ' +
        'GROUP BY table_name, index_name ' +
        'ORDER BY table_name, index_name',
    );
    [foreignKeyRows] = await client.query(
      'SELECT constraint_name AS constraintName, table_name AS tableName, ' +
        'column_name AS columnName, referenced_table_name AS referencedTable, ' +
        'referenced_column_name AS referencedColumn ' +
        'FROM information_schema.key_column_usage ' +
        'WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL ' +
        'ORDER BY table_name, constraint_name',
    );
  } finally {
    await client.end();
  }

  /* ------------------------- 库内实况 ------------------------- */

  /** 表名 → 列 */
  const dbColumns = new Map();
  for (const row of columnRows) {
    const table = String(row.tableName).toLowerCase();
    if (!dbColumns.has(table)) dbColumns.set(table, new Map());
    dbColumns.get(table).set(String(row.columnName).toLowerCase(), {
      type: String(row.dataType).toLowerCase(),
      length: row.charLength === null ? null : Number(row.charLength),
      nullable: String(row.isNullable).toUpperCase() === 'YES',
    });
  }

  /** 表名 → 索引 */
  const dbIndexes = new Map();
  for (const row of indexRows) {
    const table = String(row.tableName).toLowerCase();
    if (!dbIndexes.has(table)) dbIndexes.set(table, []);
    dbIndexes.get(table).push({
      name: String(row.indexName),
      columns: String(row.columns)
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
      unique: Number(row.nonUnique) === 0,
    });
  }

  /** 「表.列」 → 外键 */
  const dbForeignKeys = new Map();
  /** 表名 → 外键约束名集合 */
  const dbForeignKeyNames = new Map();
  for (const row of foreignKeyRows) {
    const table = String(row.tableName).toLowerCase();
    const column = String(row.columnName).toLowerCase();
    const constraint = String(row.constraintName);
    dbForeignKeys.set(`${table}.${column}`, {
      table,
      column,
      name: constraint,
      refTable: String(row.referencedTable).toLowerCase(),
      refColumn: String(row.referencedColumn).toLowerCase(),
    });
    if (!dbForeignKeyNames.has(table)) dbForeignKeyNames.set(table, new Set());
    dbForeignKeyNames.get(table).add(constraint);
  }

  /* ------------------------- 实体声明 ------------------------- */

  const entitySchema = discoverEntitySchema();
  const entityTables = entitySchema.tables;

  /* ------------------------- 1) 表 ------------------------- */

  for (const table of entityTables.values()) {
    if (dbColumns.has(table.table)) {
      notes.push({
        kind: 'DB_TABLE_OK',
        where: table.table,
        detail: `实体类 \`${table.className}\`（${table.file}）声明的表在库里存在`,
      });
      continue;
    }
    issues.push({
      kind: 'DB_TABLE_MISSING',
      where: table.table,
      detail:
        `实体声明了表 \`${table.table}\`（${table.className}），但**库里没有这张表** —— ` +
        '生产库 `synchronize: false`，跑的是迁移：这张表在库里根本不存在',
    });
  }

  /* ------------------------- 2) 索引 ------------------------- */

  for (const table of entityTables.values()) {
    const indexes = dbIndexes.get(table.table) ?? [];
    const primary = indexes.find((item) => item.name.toUpperCase() === 'PRIMARY');
    for (const index of table.indexes) {
      const found = indexes.find((item) => item.name === index.name);
      if (!found) {
        // ⚠️ **主键等价**：唯一索引的列就是主键 → 主键天然唯一，
        //    不必再建一条同列的唯一索引（重复约束 = 写放大）。
        if (index.unique && primary && keyOf(primary.columns) === keyOf(index.columns)) {
          notes.push({
            kind: 'DB_INDEX_BY_PRIMARY_KEY',
            where: `${table.table}.${index.name}`,
            detail:
              `库里由**主键**（PRIMARY KEY (${primary.columns.join(',')})）提供唯一性 —— ` +
              '等价于这条唯一索引，不需要再建一条同列的（重复约束 = 写放大）',
          });
          continue;
        }
        issues.push({
          kind: 'DB_INDEX_MISSING',
          where: `${table.table}.${index.name}`,
          detail:
            `实体类 \`${table.className}\`（${table.file}）声明了索引 ` +
            `\`${index.name}\`（列：${index.columns.join(',')}${index.unique ? '，唯一' : ''}），` +
            '但**库里没有这条索引** —— 生产库 `synchronize: false`，跑的是迁移：' +
            '按这些列的查询会退化成全表扫（这一层静默变慢，没人报警）',
        });
        continue;
      }
      if (keyOf(found.columns) !== keyOf(index.columns)) {
        issues.push({
          kind: 'DB_INDEX_COLUMN_MISMATCH',
          where: `${table.table}.${index.name}`,
          detail:
            `实体类 \`${table.className}\`（${table.file}）声明的索引 ` +
            `\`${index.name}\` 是（${index.columns.join(',')}），` +
            `库里建的却是（${found.columns.join(',')}）—— 列集合不一致：` +
            '按哪个列组合建的索引，决定了哪些查询能用上它',
        });
        continue;
      }
      if (Boolean(found.unique) !== Boolean(index.unique)) {
        issues.push({
          kind: 'DB_INDEX_UNIQUENESS_MISMATCH',
          where: `${table.table}.${index.name}`,
          detail:
            `实体声明的索引 \`${index.name}\` 是${index.unique ? '**唯一**' : '非唯一'}索引，` +
            `库里建的却是${found.unique ? '**唯一**' : '非唯一'}索引 —— ` +
            '唯一性不同 → 约束强度不同（唯一索引会让撞键直接报错）',
        });
        continue;
      }
      notes.push({
        kind: 'DB_INDEX_OK',
        where: `${table.table}.${index.name}`,
        detail: `库里真实存在索引 \`${index.name}\`（${found.columns.join(',')}）`,
      });
    }
  }

  /* ------------------------- 3) 外键 ------------------------- */

  for (const table of entityTables.values()) {
    for (const relation of table.relations) {
      const found = dbForeignKeys.get(`${table.table}.${relation.column}`);
      if (!found) {
        issues.push({
          kind: 'DB_FOREIGN_KEY_MISSING',
          where: `${table.table}.${relation.column}`,
          detail:
            `实体把 \`${relation.column}\` 声明成指向 \`${relation.targetTable}\` 的关系` +
            `（${relation.kind}，属性 ${relation.prop}），但**库里没有对应的外键** —— ` +
            '引用完整性不再被数据库保证：可以写入指向不存在行的外键，' +
            '删除被引用的行也不会被拦下',
        });
        continue;
      }
      if (found.refTable !== relation.targetTable || found.refColumn !== relation.referencedColumn) {
        issues.push({
          kind: 'DB_FOREIGN_KEY_TARGET_MISMATCH',
          where: `${table.table}.${relation.column}`,
          detail:
            `实体声明 \`${relation.column}\` 指向 \`${relation.targetTable}\`（${relation.referencedColumn ?? '?'}），` +
            `库里的外键 \`${found.name}\` 却指向 \`${found.refTable}\`（${found.refColumn ?? '?'}）—— ` +
            '指向不同的表/列：实体与库里说的不是一回事',
        });
        continue;
      }
      notes.push({
        kind: 'DB_FOREIGN_KEY_OK',
        where: `${table.table}.${relation.column}`,
        detail: `库里 \`${found.name}\` 指向 \`${found.refTable}\`（${found.refColumn}）`,
      });
    }
  }

  /* ------------------------- 4) 列 ------------------------- */

  for (const table of entityTables.values()) {
    const columns = dbColumns.get(table.table);
    if (!columns) continue; // 表缺失已单独报过
    for (const column of table.columns.values()) {
      const found = columns.get(column.column);
      if (!found) {
        issues.push({
          kind: 'DB_COLUMN_MISSING',
          where: `${table.table}.${column.column}`,
          detail:
            `实体声明了列 \`${column.column}\`（${table.className}.${column.prop}），` +
            '但**库里没有这一列** —— 读写这一列会直接报「未知列」',
        });
        continue;
      }
      if (column.type && found.type && !sameType(column.type, found.type)) {
        issues.push({
          kind: 'DB_COLUMN_DEF_MISMATCH',
          where: `${table.table}.${column.column}`,
          detail:
            `实体声明 \`${column.column}\` 是 ${column.type}，` +
            `库里却是 ${found.type} —— 类型不一致：` +
            '读出来的值类型会变（日期变成字符串、数值精度丢失……）',
        });
        continue;
      }
      if (
        isStringType(column.type) &&
        isStringType(found.type) &&
        column.length !== null &&
        found.length !== null &&
        column.length !== found.length
      ) {
        issues.push({
          kind: 'DB_COLUMN_DEF_MISMATCH',
          where: `${table.table}.${column.column}`,
          detail:
            `实体声明 \`${column.column}\` 是 ${column.type}(${column.length})，` +
            `库里却是 ${found.type}(${found.length}) —— 长度不一致：` +
            '库里的上限更小的话，超长写入会被**静默截断**（数据丢失）',
        });
        continue;
      }
      if (column.nullable !== found.nullable) {
        issues.push({
          kind: 'DB_COLUMN_DEF_MISMATCH',
          where: `${table.table}.${column.column}`,
          detail:
            `实体声明 \`${column.column}\` ${column.nullable ? '可空' : 'NOT NULL'}，` +
            `库里却是 ${found.nullable ? '可空' : 'NOT NULL'} —— 可空性不一致：` +
            'NOT NULL 的列写进 NULL 会直接报错，可空的列在实体里却被当成一定有值',
        });
        continue;
      }
      notes.push({
        kind: 'DB_COLUMN_OK',
        where: `${table.table}.${column.column}`,
        detail: `库里 \`${column.column}\` 是 ${found.type}${found.length ? `(${found.length})` : ''}`,
      });
    }
  }

  /* ------------------------- 5) 反向：库里多出来的东西 ------------------------- */

  for (const [tableName, indexes] of dbIndexes) {
    const table = entityTables.get(tableName);
    if (!table) continue; // 没有实体类的表不判（无法判定）
    const foreignKeyNames = dbForeignKeyNames.get(tableName) ?? new Set();
    const foreignKeyColumns = [...dbForeignKeys.values()]
      .filter((item) => item.table === tableName)
      .map((item) => keyOf([item.column]));
    const uniqueColumns = new Set(
      [...table.columns.values()].filter((column) => column.unique).map((column) => column.column),
    );

    for (const index of indexes) {
      if (index.name.toUpperCase() === 'PRIMARY') continue;
      if (table.indexes.some((item) => item.name === index.name)) continue;
      // ⚠️ MySQL 为「没有可用索引的外键」自动建的同名索引 ——
      //    那不是索引契约的一部分（实体里不会声明它），不判为缺陷。
      if (foreignKeyNames.has(index.name)) {
        notes.push({
          kind: 'DB_INDEX_BY_FOREIGN_KEY',
          where: `${tableName}.${index.name}`,
          detail: 'MySQL 为外键自动建的支撑索引（不在索引契约里）',
        });
        continue;
      }
      if (foreignKeyColumns.includes(keyOf(index.columns))) {
        notes.push({
          kind: 'DB_INDEX_BY_FOREIGN_KEY',
          where: `${tableName}.${index.name}`,
          detail: '为外键列建的支撑索引（不在索引契约里）',
        });
        continue;
      }
      // ⚠️ 实体里 `unique: true` 的列由一条唯一索引兜着 ——
      //    唯一性已由列声明表达，不算「实体没声明」。
      if (index.unique && uniqueColumns.has(index.columns[0])) {
        notes.push({
          kind: 'DB_INDEX_BY_UNIQUE_COLUMN',
          where: `${tableName}.${index.name}`,
          detail: '对应实体里的 `unique: true` 列声明（唯一性已由列声明表达）',
        });
        continue;
      }
      issues.push({
        kind: 'DB_INDEX_NOT_DECLARED',
        where: `${tableName}.${index.name}`,
        detail:
          `库里有一条索引 \`${index.name}\`（${index.columns.join(',')}${index.unique ? '，唯一' : ''}），` +
          '但**实体里没有对应的索引声明** —— 库比实体多一道索引：' +
          '（唯一的那些会直接让写入撞键；非唯一的会让查询计划与实体声明对不上）',
      });
    }
  }

  for (const foreignKey of dbForeignKeys.values()) {
    const table = entityTables.get(foreignKey.table);
    if (!table) continue;
    if (table.relations.some((item) => item.column === foreignKey.column)) continue;
    issues.push({
      kind: 'DB_FOREIGN_KEY_NOT_DECLARED',
      where: `${foreignKey.table}.${foreignKey.column}`,
      detail:
        `库里 \`${foreignKey.name}\` 把 \`${foreignKey.column}\`` +
        `约束到 \`${foreignKey.refTable}\`（${foreignKey.refColumn}），` +
        '但**实体里没有对应的关系声明** —— 库比实体多一道外键：' +
        '写入会被库挡下（外键失败），而实体与业务代码没准备这个约束',
    });
  }

  for (const [tableName, columns] of dbColumns) {
    const table = entityTables.get(tableName);
    if (!table) continue;
    for (const column of columns.keys()) {
      if (table.columns.has(column)) continue;
      issues.push({
        kind: 'DB_COLUMN_NOT_DECLARED',
        where: `${tableName}.${column}`,
        detail:
          `库里 \`${tableName}\` 有列 \`${column}\`，但**实体里没有这一列** —— ` +
          '库比实体多一列：任何 `synchronize: true` 的环境都会把它删掉，' +
          '而生产库上它一直在（两边对这一列的理解不一致）',
      });
    }
  }

  /* ------------------------- 报告 ------------------------- */

  const entityIndexCount = [...entityTables.values()].reduce(
    (total, table) => total + table.indexes.length,
    0,
  );
  const entityForeignKeyCount = [...entityTables.values()].reduce(
    (total, table) => total + table.relations.length,
    0,
  );
  const entityColumnCount = [...entityTables.values()].reduce(
    (total, table) => total + table.columns.size,
    0,
  );
  const dbIndexCount = [...dbIndexes.values()].reduce((total, list) => total + list.length, 0);
  const dbForeignKeyCount = dbForeignKeys.size;

  const report = {
    database: connection.database,
    host: connection.host,
    port: connection.port,
    entityTables: entityTables.size,
    entityIndexes: entityIndexCount,
    entityForeignKeys: entityForeignKeyCount,
    entityColumns: entityColumnCount,
    databaseTables: dbColumns.size,
    databaseIndexes: dbIndexCount,
    databaseForeignKeys: dbForeignKeyCount,
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
        `✅ 库内实况对账通过（${connection.database} @ ${connection.host}:${connection.port}）：` +
          `${report.entityTables} 张表 / ${report.entityIndexes} 条实体索引 / ` +
          `${report.entityForeignKeys} 条实体外键 / ${report.entityColumns} 列` +
          '在库里**逐条真实存在**（唯一键那一层由 check-unique-index-db.mjs 守着）\n',
      );
    } else {
      for (const issue of issues) {
        process.stdout.write(`❌ [${issue.kind}] ${issue.where}\n     ${issue.detail}\n`);
      }
      process.stdout.write(`\n❌ 发现 ${issues.length} 处库内实况不一致\n`);
    }
  }

  process.exit(issues.length > 0 ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`库内实况对账失败：${error.message}\n`);
  process.exit(2);
});
