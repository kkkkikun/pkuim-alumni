#!/usr/bin/env node
/**
 * 「**库内实况**」对账 —— 实体 ↔ 迁移 ↔ **真实数据库**的最后一层。
 *
 * 背景（第十轮 → 第十五轮）：
 *   静态对账（`check-error-semantics.mjs` 的 R5 / R7 / R8 / R9）能证明
 *   「迁移里**写了**创建那道索引 / 外键 / 列」——
 *   但它证明不了「**这个库里真的有**」。
 *   生产库 `synchronize: false`，跑的是**迁移**：
 *   迁移是否真的被应用过、库是不是从旧备份恢复的、有没有人手工 DROP 过 ——
 *   静态脚本**一律看不见**。而这一层的失败同样是**静默**的：
 *     - 索引没建 → 按该列的查询退化成全表扫（生产上只是「慢」，没人报警）；
 *     - 外键没建 → 引用完整性不再被数据库保证（可以写入指向不存在行的外键）；
 *     - 列定义对不上 → 超长写入被**静默截断**（数据丢失）；
 *     - 唯一约束没建 → 撞键不报错，数据库**静默写出重复行**。
 *
 * 第十五轮起，本脚本**把这一层合成一支**：
 *   此前是 `check-unique-index-db.mjs`（唯一键那一半）与
 *   `check-migration-schema-db.mjs`（实体 ↔ 库那一半）两支 ——
 *   同一层对账被拆成两半，跑两遍、报两套口径。
 *   现在只有**一支** `check-db-reality.mjs`，两半的判定口径写在同一处。
 *
 * 本脚本做六件事（**只读**，全程只执行 SELECT / SHOW / SET SESSION）：
 *   1) 从 `information_schema` 读出库里**真实存在**的表 / 索引 / 外键 / 列；
 *   2) **唯一键**那一半：登记表（`UNIQUE_KEY_REGISTRY`）↔ 迁移 ↔ 库三方对账；
 *   3) **实体 ↔ 库**那一半：表 / 索引（列集合 + 唯一性）/ 外键（指向）/
 *      列（类型 / 长度 / 可空性 / **默认值** / **`unsigned`** / **枚举取值**）；
 *   4) **正反两个方向**都查：库里多出来的索引 / 外键 / 列同样报；
 *   5) 有出入就报错、退出码非 0；
 *   6) 顺带把**当前账号的权限**（`SHOW GRANTS`）打印出来 ——
 *      人工在生产库上跑这一支时，第一眼就能确认「这个账号能不能写库」。
 *
 * ⚠️ **只读是怎么保证的**（不是口头承诺，是三重护栏）：
 *   1) 脚本里所有 SQL 都经过 `runQuery()` —— 它**只放行**
 *      `SELECT` / `SHOW` / `SET SESSION`，其余一律抛错退出（不会执行）。
 *   2) 连接建立后**第一件事**就是 `SET SESSION TRANSACTION READ ONLY`，
 *      并回读 `@@session.transaction_read_only` 确认为 1 ——
 *      之后这个会话里任何写语句都会被 MySQL 拒绝。
 *   3) 全程不建索引、不跑迁移、不写数据、不改表。
 *   ⚠️ 因此在**业务库（生产库）**上跑这一支是**安全**的：
 *      它只读 `information_schema`，不碰业务表。
 *
 * ⚠️ 口径与局限（写在这里，免得被当成万能护栏）：
 *   - 对账的**基线**是**实体声明**；实体 ↔ 迁移的静态一致性由
 *     `check-error-semantics.mjs` 负责（它先跑，本脚本后跑）。
 *   - **不判**的项：精度（`precision`）、`ON DELETE` 行为。
 *   - **默认值**：只在实体**显式声明** `default:` 时判定；
 *     库侧是 `CURRENT_TIMESTAMP(3)` 这类**表达式**时**不判**
 *     （`@CreateDateColumn` 就是它 —— 实体侧本来就不写 `default`）。
 *   - **`unsigned`**：只在实体**显式声明** `unsigned:` 时判定，
 *     且**布尔位**（实体类型是 `tinyint` 的那些开关列）**不判** ——
 *     无符号对布尔位没有意义（取值只有 0/1）。
 *     （第十五轮的误报率实测：可判定的 79 列里有 **9** 列是
 *     「实体写了 `unsigned: true`、迁移与库里却是 `tinyint(1)`」的布尔位 ——
 *     按现状纳入会产生 9 处常驻误报，故**只对非布尔位的数值列**判定。）
 *   - **枚举取值**：只在实体**显式声明** `enum:`、且取值**解析得出来**时判定
 *     （取值写在 `export const X = [...]` 里，解析不出来就**不判**，绝不猜）。
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
 *   # 测试库（CI 里就是这么跑的）
 *   DATABASE_URL=mysql://user:pass@host:3306/nmg_alumni_test \
 *     node infra/scripts/check-db-reality.mjs
 *   # 业务库 / 生产库（只读，安全）
 *   DATABASE_URL=mysql://user:pass@host:3306/nmg_alumni \
 *     node infra/scripts/check-db-reality.mjs
 *   # 其它参数：--db <库名>  --json  --root <repo>
 *
 * 退出码：0 = 库里与实体 / 登记表一致；1 = 存在出入；2 = 脚本自身失败（连不上库等）。
 */

import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createLedger,
  recordVerdict,
  LEDGER_DIMENSIONS,
  VERDICT,
  objectKeyTable,
  objectKeyIndex,
  objectKeyColumn,
  objectKeyUnique,
} from './layer-conclusion-ledger.mjs';

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

/* -------------------------- 只读护栏 -------------------------- */

/**
 * 放行的语句：**只有**读语句与「会话级只读开关」。
 *
 * ⚠️ 为什么要有这道护栏：这一支脚本会被人在**生产库**上跑。
 *   一旦哪天有人往里加了一句 `UPDATE`（或者从别处复制粘贴进来），
 *   护栏会**当场拦下**并退出码 2 —— 而不是把数据改了。
 */
const READ_ONLY_STATEMENT = /^\s*(select|show|set\s+session)\b/i;

/** 明确禁止出现的写关键字（双保险：即使正则被绕过也会被拦下）。 */
const WRITE_KEYWORD =
  /\b(insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|call|load\s+data|rename|lock|unlock|outfile|dumpfile)\b/i;

/**
 * 执行一条**只读**语句；不是读语句就抛错（脚本退出码 2，不会执行）。
 */
async function runQuery(client, sql) {
  if (!READ_ONLY_STATEMENT.test(sql)) {
    throw new Error(`拒绝执行非只读语句：${sql.slice(0, 120)}`);
  }
  if (WRITE_KEYWORD.test(sql)) {
    throw new Error(`语句里出现了写关键字：${sql.slice(0, 120)}`);
  }
  return client.query(sql);
}

/* -------------------------- 依赖与连接 -------------------------- */

/**
 * 载入「实体 / 迁移解析」—— **从 `--root` 指向的仓库里**载入。
 *
 * ⚠️ 为什么要动态 import 而不是顶层静态 import：
 *   反向验证（`check-migration-schema-db-selftest.sh` /
 *   `check-unique-index-db-selftest.sh`）会在**临时副本**里
 *   注入缺陷（往实体里塞一条库里并不存在的索引 / 往登记表里塞一条唯一键），
 *   然后用 `--root <副本>` 跑本脚本 ——
 *   静态 import 拿到的永远是**本脚本所在仓库**的声明，注入就白注了。
 */
async function loadCheckerModule() {
  const modulePath = path.join(ROOT, 'infra/scripts/check-error-semantics.mjs');
  return import(pathToFileURL(modulePath).href);
}

/**
 * 载入 mysql2 —— 它是 `@nmg/api` 的依赖（pnpm 下不会提升到仓库根目录）。
 *
 * 不引新依赖、不动锁文件：按 `apps/api/package.json` 去 require。
 * 候选路径按顺序试：
 *   ① 环境变量 `NMG_MYSQL_PACKAGE_JSON`（**对账脚本用它**）；
 *   ② 脚本所在仓库；
 *   ③ `--root` 指向的仓库。
 *
 * ⚠️ **为什么要有 ①**：反向验证时会把仓库整份拷到临时目录再注入缺陷，
 *   而临时副本里**没有 `node_modules`** —— 从副本里跑这个脚本会报
 *   「Cannot find module 'mysql2/promise'」。
 *   ① 让调用方（对账脚本）**显式指��**带依赖的那个仓库，
 *   这样「脚本从哪来」与「依赖从哪来」两件事互不牵连。
 *
 * @param {string} rootArg `--root` 指向的仓库
 */
function loadMysql(rootArg) {
  const candidates = [
    process.env.NMG_MYSQL_PACKAGE_JSON,
    path.join(SCRIPT_DIR, '../../apps/api/package.json'),
    path.join(rootArg, 'apps/api/package.json'),
  ].filter(Boolean);
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
 *
 * ⚠️ 库名**必须**由环境变量或 `--db` 显式给出（默认值是业务库 `nmg_alumni`，
 *    与 `docker-compose.prod.yml` 的 `MYSQL_DATABASE` 默认值一致）。
 *    这一支会被人在**生产库**上跑，所以「连的是哪个库」必须一眼可见 ——
 *    报告里会把库名与主机一起打出来。
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
    database: argValue('--db', process.env.DB_NAME ?? 'nmg_alumni'),
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

/**
 * 库侧的**默认值**是不是「表达式」（`CURRENT_TIMESTAMP(3)` 这类）。
 *
 * ⚠️ 表达式**判不了**：库里的形态与 DDL 原文不一定逐字相同
 *   （`CURRENT_TIMESTAMP(3)` 与 `current_timestamp(3)`）。
 *   判不了就不判 —— 不猜。
 */
function isExpressionDefault(value) {
  if (value === null || value === undefined) return false;
  const text = String(value).trim();
  if (!text) return false;
  return /current_timestamp|now\s*\(|localtime|uuid\s*\(|^\(/i.test(text);
}

/** 库侧的默认值归一成字符串（数字与字符串按同一形态比，避免假红）。 */
function normalizeDbDefault(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === 'NULL') return null;
  return text;
}

/** 从 `information_schema.columns.column_type` 里取出枚举取值。 */
function parseDbEnumValues(columnType) {
  const matched = /\benum\(([^)]*)\)/i.exec(String(columnType ?? ''));
  if (!matched) return null;
  return [...matched[1].matchAll(/'((?:[^']|'')*)'/g)].map((item) => item[1].replace(/''/g, "'"));
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const {
    UNIQUE_KEY_REGISTRY,
    discoverMigrationSchema,
    discoverEntitySchema,
    analyzeDdlColumnDef,
  } = await loadCheckerModule();

  const mysql = loadMysql(ROOT);

  const connection = resolveConnection();
  const issues = [];
  const notes = [];
  /** 结论台账（第十七轮）：逐个对象记下这一层判出了什么结论，供跨层对账。 */
  const ledger = createLedger();

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
  let uniqueRows;
  let identityRows;
  let grants = [];
  let readOnly = false;

  try {
    // --- 只读会话（三重护栏的第 2 条）--------------------------------------
    await runQuery(client, 'SET SESSION TRANSACTION READ ONLY');
    await runQuery(client, 'SET SESSION autocommit = 1');
    const [readOnlyRows] = await runQuery(
      client,
      'SELECT @@session.transaction_read_only AS readOnly',
    );
    readOnly = Number(readOnlyRows?.[0]?.readOnly) === 1;
    if (!readOnly) {
      throw new Error('没能把会话设成只读（@@session.transaction_read_only ≠ 1）—— 拒绝继续');
    }

    // 当前账号的权限：人工在生产库上跑这一支时，第一眼就能确认
    // 「这个账号能不能写库」（只读账号跑这一支最理想）。
    const [grantRows] = await runQuery(client, 'SHOW GRANTS FOR CURRENT_USER()');
    grants = grantRows.map((row) => Object.values(row)[0]).map(String);

    [columnRows] = await runQuery(
      client,
      'SELECT table_name AS tableName, column_name AS columnName, data_type AS dataType, ' +
        'character_maximum_length AS charLength, is_nullable AS isNullable, ' +
        'column_type AS columnType, column_default AS columnDefault ' +
        'FROM information_schema.columns ' +
        'WHERE table_schema = DATABASE() ' +
        'ORDER BY table_name, ordinal_position',
    );
    [indexRows] = await runQuery(
      client,
      'SELECT table_name AS tableName, index_name AS indexName, ' +
        'GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns, ' +
        'MAX(non_unique) AS nonUnique ' +
        'FROM information_schema.statistics ' +
        'WHERE table_schema = DATABASE() ' +
        'GROUP BY table_name, index_name ' +
        'ORDER BY table_name, index_name',
    );
    [foreignKeyRows] = await runQuery(
      client,
      'SELECT constraint_name AS constraintName, table_name AS tableName, ' +
        'column_name AS columnName, referenced_table_name AS referencedTable, ' +
        'referenced_column_name AS referencedColumn ' +
        'FROM information_schema.key_column_usage ' +
        'WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL ' +
        'ORDER BY table_name, constraint_name',
    );
    [uniqueRows] = await runQuery(
      client,
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
    [identityRows] = await runQuery(
      client,
      'SELECT table_name AS tableName, column_name AS columnName ' +
        'FROM information_schema.columns ' +
        "WHERE table_schema = DATABASE() AND extra LIKE '%auto_increment%'",
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
      columnType: String(row.columnType ?? ''),
      default: normalizeDbDefault(row.columnDefault),
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

  /** 库里真实存在的唯一约束 */
  const dbUniques = uniqueRows.map((row) => ({
    table: String(row.tableName).toLowerCase(),
    name: String(row.indexName),
    columns: String(row.columns)
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
    primary: String(row.indexName).toUpperCase() === 'PRIMARY',
  }));

  const identityColumns = new Set(
    identityRows.map(
      (row) =>
        `${String(row.tableName).toLowerCase()}.${String(row.columnName).toLowerCase()}`,
    ),
  );

  /* ------------------------- 实体 / 迁移声明 ------------------------- */

  const entitySchema = discoverEntitySchema();
  const entityTables = entitySchema.tables;
  const migrationSchema = discoverMigrationSchema();

  /** 「表.列」 → 迁移里的列定义解析结果（用于在报错文案里给出「迁移说是什么」） */
  function migrationColumn(table, column) {
    const def = migrationSchema.tables.get(table)?.get(column);
    if (!def) return null;
    return analyzeDdlColumnDef(def);
  }

  /* ==================================================================== */
  /* 第一半：唯一键（登记表 ↔ 迁移 ↔ 库）                                   */
  /* ==================================================================== */

  const registryKeys = UNIQUE_KEY_REGISTRY.map((entry) => ({
    table: entry.entity.toLowerCase(),
    columns: entry.columns.map((column) => column.toLowerCase()),
    source: `登记表 ${entry.entity}.${entry.columns.join(',')}`,
  }));

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
    // 台账里的对象标识（两层必须一致）—— 唯一键按「表 + 排序后的列」标识。
    const ledgerObject = objectKeyUnique(expected.table, expected.columns);
    if (!found) {
      issues.push({
        kind: 'DB_UNIQUE_MISSING',
        where: `${expected.table}.${expected.columns.join(',')}`,
        detail:
          `${expected.source} 要求这道唯一约束，但**库里没有** —— ` +
          '生产库 `synchronize: false`，撞键不会报错，数据库会**静默写出重复行**',
      });
      recordVerdict(
        ledger,
        LEDGER_DIMENSIONS.UNIQUE,
        ledgerObject,
        VERDICT.MISMATCH,
        'DB_UNIQUE_MISSING',
      );
      continue;
    }
    notes.push({
      kind: 'DB_UNIQUE_OK',
      where: `${expected.table}.${expected.columns.join(',')}`,
      detail: `库里由 \`${found.name}\` 提供唯一性（${found.columns.join(',')}）`,
    });
    recordVerdict(
      ledger,
      LEDGER_DIMENSIONS.UNIQUE,
      ledgerObject,
      VERDICT.OK,
      'DB_UNIQUE_OK',
    );
  }

  // --- 反向：库里多出来的唯一约束 ----------------------------------------
  //   迁移层与登记表都认可、但**实体没声明**的那些，由静态校验器负责；
  //   这里只报「登记表与迁移都没有」的（来源不明的约束）。
  for (const item of dbUniques) {
    const known =
      registryKeys.some(
        (expected) =>
          expected.table === item.table && keyOf(expected.columns) === keyOf(item.columns),
      ) ||
      migrationKeys.some(
        (expected) =>
          expected.table === item.table && keyOf(expected.columns) === keyOf(item.columns),
      );
    if (known) continue;
    if (item.primary && item.columns.length === 1) {
      // 单列主键：要么是自增 id（业务唯一键口径外），要么是自然键
      //   （`system_settings.key` / `private_contacts.user_id` 等）——
      //   后者都在登记表里，已在上面判过。
      if (identityColumns.has(`${item.table}.${item.columns[0]}`)) continue;
    }
    issues.push({
      kind: 'DB_UNIQUE_NOT_DECLARED',
      where: `${item.table}.${item.columns.join(',')}`,
      detail:
        `库里有一条唯一约束 \`${item.name}\`（${item.columns.join(',')}），` +
        '但**登记表与迁移里都没有** —— 来源不明的约束，' +
        '写入会被它挡下（撞键），而代码没准备这条唯一键的失败语义',
    });
  }

  /* ==================================================================== */
  /* 第二半：实体 ↔ 库（表 / 索引 / 外键 / 列）                             */
  /* ==================================================================== */

  /* ------------------------- 1) 表 ------------------------- */

  for (const table of entityTables.values()) {
    if (dbColumns.has(table.table)) {
      notes.push({
        kind: 'DB_TABLE_OK',
        where: table.table,
        detail: `实体类 \`${table.className}\`（${table.file}）声明的表在库里存在`,
      });
      recordVerdict(
        ledger,
        LEDGER_DIMENSIONS.TABLE,
        objectKeyTable(table.table),
        VERDICT.OK,
        'DB_TABLE_OK',
      );
      continue;
    }
    issues.push({
      kind: 'DB_TABLE_MISSING',
      where: table.table,
      detail:
        `实体声明了表 \`${table.table}\`（${table.className}），但**库里没有这张表** —— ` +
        '生产库 `synchronize: false`，跑的是迁移：这张表在库里根本不存在',
    });
    recordVerdict(
      ledger,
      LEDGER_DIMENSIONS.TABLE,
      objectKeyTable(table.table),
      VERDICT.MISMATCH,
      'DB_TABLE_MISSING',
    );
  }

  /* ------------------------- 2) 索引 ------------------------- */

  for (const table of entityTables.values()) {
    const indexes = dbIndexes.get(table.table) ?? [];
    const primary = indexes.find((item) => item.name.toUpperCase() === 'PRIMARY');
    for (const index of table.indexes) {
      const found = indexes.find((item) => item.name === index.name);
      const ledgerObject = objectKeyIndex(table.table, index.name);
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
          recordVerdict(
            ledger,
            LEDGER_DIMENSIONS.INDEX,
            ledgerObject,
            VERDICT.OK,
            'DB_INDEX_BY_PRIMARY_KEY',
          );
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
        recordVerdict(
          ledger,
          LEDGER_DIMENSIONS.INDEX,
          ledgerObject,
          VERDICT.MISMATCH,
          'DB_INDEX_MISSING',
        );
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
        recordVerdict(
          ledger,
          LEDGER_DIMENSIONS.INDEX,
          ledgerObject,
          VERDICT.MISMATCH,
          'DB_INDEX_COLUMN_MISMATCH',
        );
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
        recordVerdict(
          ledger,
          LEDGER_DIMENSIONS.INDEX,
          ledgerObject,
          VERDICT.MISMATCH,
          'DB_INDEX_UNIQUENESS_MISMATCH',
        );
        continue;
      }
      notes.push({
        kind: 'DB_INDEX_OK',
        where: `${table.table}.${index.name}`,
        detail: `库里真实存在索引 \`${index.name}\`（${found.columns.join(',')}）`,
      });
      recordVerdict(
        ledger,
        LEDGER_DIMENSIONS.INDEX,
        ledgerObject,
        VERDICT.OK,
        'DB_INDEX_OK',
      );
    }
  }

  /* ------------------------- 3) 外键 ------------------------- */

  for (const table of entityTables.values()) {
    for (const relation of table.relations) {
      const found = dbForeignKeys.get(`${table.table}.${relation.column}`);
      const ledgerObject = objectKeyColumn(table.table, relation.column);
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
        recordVerdict(
          ledger,
          LEDGER_DIMENSIONS.FOREIGN_KEY,
          ledgerObject,
          VERDICT.MISMATCH,
          'DB_FOREIGN_KEY_MISSING',
        );
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
        recordVerdict(
          ledger,
          LEDGER_DIMENSIONS.FOREIGN_KEY,
          ledgerObject,
          VERDICT.MISMATCH,
          'DB_FOREIGN_KEY_TARGET_MISMATCH',
        );
        continue;
      }
      notes.push({
        kind: 'DB_FOREIGN_KEY_OK',
        where: `${table.table}.${relation.column}`,
        detail: `库里 \`${found.name}\` 指向 \`${found.refTable}\`（${found.refColumn}）`,
      });
      recordVerdict(
        ledger,
        LEDGER_DIMENSIONS.FOREIGN_KEY,
        ledgerObject,
        VERDICT.OK,
        'DB_FOREIGN_KEY_OK',
      );
    }
  }

  /* ------------------------- 4) 列 ------------------------- */

  /** 三个新维度的「判了多少 / 跳过多少」计数（写进报告，便于复核口径） */
  const dimensionStats = {
    default: { checked: 0, skipped: 0, mismatch: 0 },
    unsigned: { checked: 0, skipped: 0, mismatch: 0 },
    enum: { checked: 0, skipped: 0, mismatch: 0 },
  };

  // --- 4.1 类型 / 长度 / 可空性 -------------------------------------------
  for (const table of entityTables.values()) {
    const columns = dbColumns.get(table.table);
    if (!columns) continue; // 表缺失已单独报过
    for (const column of table.columns.values()) {
      const found = columns.get(column.column);
      const ledgerObject = objectKeyColumn(table.table, column.column);
      if (!found) {
        issues.push({
          kind: 'DB_COLUMN_MISSING',
          where: `${table.table}.${column.column}`,
          detail:
            `实体声明了列 \`${column.column}\`（${table.className}.${column.prop}），` +
            '但**库里没有这一列** —— 读写这一列会直接报「未知列」',
        });
        recordVerdict(
          ledger,
          LEDGER_DIMENSIONS.COLUMN,
          ledgerObject,
          VERDICT.MISMATCH,
          'DB_COLUMN_MISSING',
        );
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
        recordVerdict(
          ledger,
          LEDGER_DIMENSIONS.COLUMN,
          ledgerObject,
          VERDICT.MISMATCH,
          'DB_COLUMN_DEF_MISMATCH',
        );
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
        recordVerdict(
          ledger,
          LEDGER_DIMENSIONS.COLUMN,
          ledgerObject,
          VERDICT.MISMATCH,
          'DB_COLUMN_DEF_MISMATCH',
        );
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
        recordVerdict(
          ledger,
          LEDGER_DIMENSIONS.COLUMN,
          ledgerObject,
          VERDICT.MISMATCH,
          'DB_COLUMN_DEF_MISMATCH',
        );
        continue;
      }
      // 台账：这一列的类型 / 长度 / 可空性三者都与库里一致。
      recordVerdict(
        ledger,
        LEDGER_DIMENSIONS.COLUMN,
        ledgerObject,
        VERDICT.OK,
        'DB_COLUMN_OK',
      );

      notes.push({
        kind: 'DB_COLUMN_OK',
        where: `${table.table}.${column.column}`,
        detail: `库里 \`${column.column}\` 是 ${found.type}${found.length ? `(${found.length})` : ''}`,
      });
    }
  }

  // --- 4.2 默认值 / `unsigned` / 枚举取值：**单独**遍历一遍列 ------------------
  //
  // ⚠️ **为什么要单独遍历**（与静态层的 6.6 节完全同构）：
  //   上面那个循环在「类型 / 长度 / 可空性」不一致时会 `continue` ——
  //   若把三个新维度并进去，那一列的默认值 / 无符号性 / 枚举就**永远不会被判**。
  //   静态层（`check-error-semantics.mjs` 的 6.6 节）早已为此**单独遍历**
  //   （那里有一段专门的注释说明为什么），两层的**判定覆盖面**才真正一致。
  //   覆盖面不一致 → 两层对**同一列**给出的结论条数不同 ——
  //   而结论台账对账（`check-layer-reconciliation.mjs`）比的就是这个。
  for (const table of entityTables.values()) {
    const columns = dbColumns.get(table.table);
    if (!columns) continue; // 表缺失已单独报过
    for (const column of table.columns.values()) {
      const found = columns.get(column.column);
      if (!found) continue; // 列缺失已单独报过
      const ledgerObject = objectKeyColumn(table.table, column.column);

      /* --- 4.2.1 默认值 --- */
      if (column.defaultValue !== null && column.defaultValue !== undefined) {
        if (isExpressionDefault(found.default)) {
          // 库侧是表达式 → 判不了，不判（不猜）。
          dimensionStats.default.skipped += 1;
          // 台账：**跳过也要留痕** —— 否则「这一层判不了」与「这一层判了没问题」分不开。
          recordVerdict(
            ledger,
            LEDGER_DIMENSIONS.COLUMN_DEFAULT,
            ledgerObject,
            VERDICT.SKIPPED,
            'DB_COLUMN_DEFAULT_EXPRESSION',
          );
        } else {
          dimensionStats.default.checked += 1;
          const entityDefault = String(column.defaultValue);
          const dbDefault = found.default === null ? null : String(found.default);
          const same =
            dbDefault !== null && normalizeNumeric(entityDefault) === normalizeNumeric(dbDefault);
          if (!same) {
            dimensionStats.default.mismatch += 1;
            const migration = migrationColumn(table.table, column.column);
            issues.push({
              kind: 'DB_COLUMN_DEFAULT_MISMATCH',
              where: `${table.table}.${column.column}`,
              detail:
                `实体声明 \`${column.column}\` 的默认值是 ${entityDefault}，` +
                `库里却是 ${dbDefault === null ? '**没有默认值**' : `\`${dbDefault}\``}` +
                (migration?.defaultValue
                  ? `，迁移里写的是 \`${migration.defaultValue}\``
                  : '') +
                ' —— 实体与库对「这一列没传值时填什么」的理解不一致：' +
                '走实体的写入会带上默认值，走库默认值的写入（原生 SQL / 报表）会带上另一个',
            });
            recordVerdict(
              ledger,
              LEDGER_DIMENSIONS.COLUMN_DEFAULT,
              ledgerObject,
              VERDICT.MISMATCH,
              'DB_COLUMN_DEFAULT_MISMATCH',
            );
          } else {
            recordVerdict(
              ledger,
              LEDGER_DIMENSIONS.COLUMN_DEFAULT,
              ledgerObject,
              VERDICT.OK,
              'DB_COLUMN_DEFAULT_OK',
            );
          }
        }
      } else {
        dimensionStats.default.skipped += 1;
      }

      /* --- 4.2.2 unsigned --- */
      if (column.unsigned !== null && column.unsigned !== undefined) {
        const entityType = normalizeType(column.type);
        if (entityType === 'tinyint' || entityType === 'boolean') {
          // ⚠️ 布尔位（实体类型是 `tinyint` / `boolean` 的开关列）：无符号对它没有意义
          //   （取值只有 0/1）。第十五轮的误报率实测：可判定的 79 列里有 9 列
          //   属于这一类（实体写了 `unsigned: true`，迁移与库里是 `tinyint(1)`）——
          //   纳入判定会产生 9 处常驻误报，故**不判**（记进 KNOWN-ISSUES）。
          dimensionStats.unsigned.skipped += 1;
          // 台账：布尔位**有意不判**（口径上跳过，不是漏判）。
          recordVerdict(
            ledger,
            LEDGER_DIMENSIONS.COLUMN_UNSIGNED,
            ledgerObject,
            VERDICT.SKIPPED,
            'DB_COLUMN_UNSIGNED_BOOLEAN_NOT_JUDGED',
          );
        } else {
          dimensionStats.unsigned.checked += 1;
          const dbUnsigned = /unsigned/i.test(found.columnType);
          if (dbUnsigned !== column.unsigned) {
            dimensionStats.unsigned.mismatch += 1;
            const migration = migrationColumn(table.table, column.column);
            issues.push({
              kind: 'DB_COLUMN_UNSIGNED_MISMATCH',
              where: `${table.table}.${column.column}`,
              detail:
                `实体声明 \`${column.column}\` 是${
                  column.unsigned ? '**无符号**' : '**有符号**'
                }，` +
                `库里却是${dbUnsigned ? '**无符号**' : '**有符号**'}（${found.columnType}）` +
                (migration ? `，迁移里写的是${migration.unsigned ? '无符号' : '有符号'}` : '') +
                ' —— 有符号性与实体不一致：' +
                '**外键两侧的有符号性必须一致**（MySQL 要求外键列与被引用列类型完全相同），' +
                '不一致时那一列连外键都建不出来',
            });
            recordVerdict(
              ledger,
              LEDGER_DIMENSIONS.COLUMN_UNSIGNED,
              ledgerObject,
              VERDICT.MISMATCH,
              'DB_COLUMN_UNSIGNED_MISMATCH',
            );
          } else {
            recordVerdict(
              ledger,
              LEDGER_DIMENSIONS.COLUMN_UNSIGNED,
              ledgerObject,
              VERDICT.OK,
              'DB_COLUMN_UNSIGNED_OK',
            );
          }
        }
      } else {
        dimensionStats.unsigned.skipped += 1;
      }

      /* --- 4.2.3 枚举取值 --- */
      if (column.enumValues !== null && column.enumValues !== undefined) {
        const dbValues = parseDbEnumValues(found.columnType);
        if (!dbValues) {
          dimensionStats.enum.checked += 1;
          dimensionStats.enum.mismatch += 1;
          issues.push({
            kind: 'DB_COLUMN_ENUM_MISMATCH',
            where: `${table.table}.${column.column}`,
            detail:
              `实体声明 \`${column.column}\` 是枚举（取值：${column.enumValues.join(',')}），` +
              `库里却是 ${found.columnType} —— 不是枚举列：` +
              '实体能写进去的取值，库那一列可能直接拒收（严格模式报 1265）',
          });
          recordVerdict(
            ledger,
            LEDGER_DIMENSIONS.COLUMN_ENUM,
            ledgerObject,
            VERDICT.MISMATCH,
            'DB_COLUMN_ENUM_MISMATCH',
          );
        } else {
          dimensionStats.enum.checked += 1;
          const entityValues = [...column.enumValues].sort().join('|');
          const dbValuesSorted = [...dbValues].sort().join('|');
          if (entityValues !== dbValuesSorted) {
            dimensionStats.enum.mismatch += 1;
            const migration = migrationColumn(table.table, column.column);
            const missing = column.enumValues.filter((item) => !dbValues.includes(item));
            const extra = dbValues.filter((item) => !column.enumValues.includes(item));
            issues.push({
              kind: 'DB_COLUMN_ENUM_MISMATCH',
              where: `${table.table}.${column.column}`,
              detail:
                `实体声明 \`${column.column}\` 的枚举取值是（${column.enumValues.join(',')}），` +
                `库里却是（${dbValues.join(',')}）` +
                (migration?.enumValues
                  ? `，迁移里写的是（${migration.enumValues.join(',')}）`
                  : '') +
                (missing.length ? ` —— 实体允许但**库里不允许**的取值：${missing.join(',')}` : '') +
                (extra.length ? ` —— 库里允许但**实体不允许**的取值：${extra.join(',')}` : '') +
                ' —— 枚举取值不一致：写入会被数据库拒收（严格模式报 1265），' +
                '而实体的类型检查放过去了',
            });
            recordVerdict(
              ledger,
              LEDGER_DIMENSIONS.COLUMN_ENUM,
              ledgerObject,
              VERDICT.MISMATCH,
              'DB_COLUMN_ENUM_MISMATCH',
            );
          } else {
            recordVerdict(
              ledger,
              LEDGER_DIMENSIONS.COLUMN_ENUM,
              ledgerObject,
              VERDICT.OK,
              'DB_COLUMN_ENUM_OK',
            );
          }
        }
      } else {
        dimensionStats.enum.skipped += 1;
      }
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
    readOnlySession: readOnly,
    grants,
    entityTables: entityTables.size,
    entityIndexes: entityIndexCount,
    entityForeignKeys: entityForeignKeyCount,
    entityColumns: entityColumnCount,
    databaseTables: dbColumns.size,
    databaseIndexes: dbIndexCount,
    databaseForeignKeys: dbForeignKeyCount,
    registryUniqueKeys: registryKeys.length,
    migrationUniqueConstraints: migrationKeys.length,
    databaseUniqueConstraints: dbUniques.length,
    dimensions: dimensionStats,
    issues: issues.length,
    notes: notes.length,
    detail: issues,
    notesDetail: notes,
    // ⚠️ **结论台账**（第十七轮）：逐个对象记下这一层判出了什么结论。
    //    静态层（`check-error-semantics.mjs`）输出**同名同义**的台账，
    //    `check-layer-reconciliation.mjs` 据此把两层的结论**逐条对齐**。
    ledger: [...ledger.values()],
  };

  if (AS_JSON) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    // ⚠️ 只打印**值得人看**的提示（「等价形态」的说明），
    //    逐条对齐的 `*_OK` 提示有几百条，全打出来会把 CI 日志淹掉 ——
    //    它们的数量在下面的汇总行里。
    for (const note of notes) {
      if (note.kind.endsWith('_OK')) continue;
      process.stdout.write(`  [提示] ${note.where}：${note.detail}\n`);
    }
    if (issues.length === 0) {
      process.stdout.write(
        `✅ 库内实况对账通过（${connection.database} @ ${connection.host}:${connection.port}，` +
          `只读会话=${readOnly ? '是' : '否'}）：` +
          `${report.entityTables} 张表 / ${report.entityIndexes} 条实体索引 / ` +
          `${report.entityForeignKeys} 条实体外键 / ${report.entityColumns} 列` +
          '在库里**逐条真实存在**；' +
          `${report.registryUniqueKeys} 个登记唯一键也全部真实存在；` +
          `新增维度：默认值判了 ${dimensionStats.default.checked} 列、` +
          `unsigned 判了 ${dimensionStats.unsigned.checked} 列、` +
          `枚举取值判了 ${dimensionStats.enum.checked} 列\n`,
      );
    } else {
      for (const issue of issues) {
        process.stdout.write(`❌ [${issue.kind}] ${issue.where}\n     ${issue.detail}\n`);
      }
      process.stdout.write(`\n❌ 发现 ${issues.length} 处库内实况不一致\n`);
    }
  }

  // ⚠️ **用 `process.exitCode` 而不是 `process.exit()`**：
  //   `process.exit()` 会**立刻**终止进程，**尚未 flush 的 stdout 会被丢弃** ——
  //   本脚本的 `--json` 报告约 170 KB，一旦被**管道**接走，
  //   输出会在 64 KB（管道缓冲区）处**被截断**，下游拿到的是**残缺的 JSON**。
  //   设 `exitCode` 让 Node **自然退出**，stdout 会被完整 flush。
  process.exitCode = issues.length > 0 ? 1 : 0;
}

/**
 * 把默认值归一成「可比较」的形态：数字按数字比，其余按字符串比。
 *
 * ⚠️ 为什么需要：实体写 `default: 0`，库里回来的是字符串 `'0'`；
 *   不归一就会把 `'0'` 与 `0` 判成不一致（那是假红）。
 */
function normalizeNumeric(value) {
  const text = String(value).trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) return String(Number(text));
  return text;
}

main().catch((error) => {
  process.stderr.write(`库内实况对账失败：${error.message}\n`);
  // ⚠️ 同样用 `exitCode`（见上面的说明）：stderr 也要 flush 完再退出。
  process.exitCode = 2;
});
