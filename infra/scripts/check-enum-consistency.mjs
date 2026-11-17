#!/usr/bin/env node
/**
 * 枚举一致性对账 —— 状态值在「数据库 ENUM / DTO / 契约」之间不许漂移。
 *
 * 背景（本轮人工审计发现的问题）：
 *   管理端 5 个列表的状态筛选（认证 / 资源 / 资讯 / 公告 / 活动）写的是
 *   `status?: string` + `@IsString()` —— **没有任何枚举校验**。
 *   后果：传 `status=bogus` 不报错，直接查库 → 返回空列表 →
 *   用户看到「筛选后没数据」，很容易误判成「功能坏了 / 数据丢了」。
 *   同一批字段里，`userStatus` 却是 `@IsIn([...])` —— 不一致本身就是信号。
 *
 *   更深一层：状态值要在**四个地方**对得上，任何一处漂移都会出事：
 *     1. 数据库 ENUM      —— 决定能落库的值
 *     2. DTO @IsIn 列表   —— 决定服务端接受的值（DTO 放行 DB 不接受的值 → 500）
 *     3. 契约联合类型     —— 决定客户端会传的值（契约声明了 DB 不接受的值 → 500）
 *     4. DTO 的状态字段本身 —— 必须是枚举校验的，不能是裸 string
 *
 * 本脚本做三条检查：
 *   R1 DTO 的每个 `@IsIn([...])` 列表，必须被**某个**数据库 ENUM 完全包含
 *      （否则存在「DTO 放行、数据库拒绝」→ 500 的值）
 *   R2 DTO 里名为 status / action / type / stage / visibility / source /
 *      level / channel / kind 的字段，若是 `string` 类型，
 *      **必须**有 `@IsIn`（状态类字段不许是裸字符串）
 *   R3 契约里的枚举联合类型（`'a' | 'b'`），必须被某个数据库 ENUM 完全包含
 *      （否则客户端照契约传值 → 落库 500）
 *
 * 用法：
 *   node infra/scripts/check-enum-consistency.mjs --root <repo> [--json]
 *
 * 退出码：0 = 三方一致；1 = 存在漂移。
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

const API_SRC = path.join(ROOT, 'apps/api/src');
const MIGRATIONS = path.join(API_SRC, 'database/migrations');
const CONTRACTS = path.join(ROOT, 'packages/contracts/src');

/** class-validator 装饰器（用于识别「真正的请求 DTO 类」） */
const VALIDATOR_DECORATORS = [
  'IsString',
  'IsNumber',
  'IsInt',
  'IsBoolean',
  'IsArray',
  'IsEnum',
  'IsIn',
  'IsObject',
  'IsOptional',
  'IsNotEmpty',
  'Min',
  'Max',
  'MinLength',
  'MaxLength',
  'Validate',
  'ValidateNested',
];

/**
 * 自由文本列豁免清单。
 *
 * 有些「状态类」字段其实落在 **VARCHAR** 列上 —— 取值是开放集合，
 * 本来就不该用 @IsIn 枚举化（枚举会随功能增长而不断过期）。
 * 每一条都必须写明理由与对应列的类型，便于复核。
 */
const FREE_TEXT_EXEMPTIONS = [
  {
    className: 'AdminActionLogQueryDto',
    field: 'action',
    reason: 'admin_action_logs.action 是 VARCHAR(64) —— 审计操作码是开放集合（user.status.change / admin.user.create …）',
  },
  {
    className: 'CreateEventBodyDto',
    field: 'kind',
    reason: 'events.kind 是 VARCHAR(32) —— 活动类型是自由文本（沙龙 / 讲座 / 聚会 …）',
  },
  {
    className: 'UpdateEventBodyDto',
    field: 'kind',
    reason: 'events.kind 是 VARCHAR(32) —— 活动类型是自由文本（沙龙 / 讲座 / 聚会 …）',
  },
];

/** 状态类字段名（这些字段不允许是裸 string） */
const STATE_FIELD_NAMES = [
  'status',
  'action',
  'type',
  'stage',
  'visibility',
  'source',
  'level',
  'channel',
  'kind',
];

/**
 * 字段 ↔ 表列 的**显式绑定**清单（缺陷 #117）。
 *
 * 为什么必须显式绑定：
 *   R1 只要求「DTO 的取值集合被**某个**数据库 ENUM 包含」，
 *   **不关心这个字段对应的是哪张表**。于是：
 *     `AdminUserListQueryDto.status`（对应 `admin_users.status`）
 *     写成了 ['active','disabled','locked']，
 *     而 `users.status` 那个 ENUM 恰好也是这三个值 → R1 判过。
 *   但 `admin_users.status` 的 ENUM 只有 ('active','disabled')，
 *   于是「已锁定」这个筛选项**永远筛不出任何行**（摆设筛选项，缺陷 #114）。
 *
 * 每条绑定都必须写明理由，便于复核；漏绑不会报错（属于覆盖不全），
 * 绑错则会直接判失败。
 */
const TABLE_BINDINGS = [
  {
    kind: 'dto',
    owner: 'AdminUserListQueryDto',
    field: 'status',
    table: 'admin_users',
    column: 'status',
    reason: '管理端「管理员账号」列表的状态筛选',
  },
  {
    kind: 'dto',
    owner: 'CreateAdminUserBodyDto',
    field: 'status',
    table: 'admin_users',
    column: 'status',
    reason: '新建管理员时的账号状态',
  },
  {
    kind: 'dto',
    owner: 'UpdateAdminUserBodyDto',
    field: 'status',
    table: 'admin_users',
    column: 'status',
    reason: '更新管理员时的账号状态',
  },
  {
    kind: 'dto',
    owner: 'AdminAlumniListQueryDto',
    field: 'status',
    table: 'users',
    column: 'status',
    reason: '管理端「校友管理」列表的状态筛选（普通账号确有 locked）',
  },
  {
    kind: 'dto',
    owner: 'UpdateUserStatusBodyDto',
    field: 'status',
    table: 'users',
    column: 'status',
    reason: '启用 / 停用普通账号',
  },
  {
    kind: 'contract',
    owner: 'AdminUserDto',
    field: 'status',
    table: 'admin_users',
    column: 'status',
    reason: '契约里管理员账号的状态字段',
  },
  {
    kind: 'contract',
    owner: 'UserProfile',
    field: 'status',
    table: 'users',
    column: 'status',
    reason: '契约里普通用户的状态字段',
  },
];

/* ------------------------------ 基础工具 ------------------------------ */

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function walk(dir, out = [], filter = /\.ts$/) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, out, filter);
    } else if (entry.isFile() && filter.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ------------------------------ 数据库 ENUM ------------------------------ */

/**
 * 收集迁移里所有 `ENUM('a','b')` 定义。
 * 返回 [{ values: [...], column, table, file, line }]
 *
 * ⚠️ `table` 字段是**表绑定规则（R4/R5）的前提**：
 *   光知道「有个 ENUM 叫 status」是不够的 ——
 *   必须知道「**哪张表的** status 列」。
 *   迁移用 `this.createTable(queryRunner, '表名', '列定义…')` 建表，
 *   所以这里按 createTable 调用块切分，逐块解析表名与列定义。
 */
function collectDbEnums() {
  const result = [];
  const files = walk(MIGRATIONS);
  for (const file of files) {
    const raw = readFileSafe(file);
    if (!raw) continue;
    const src = stripComments(raw);
    const relative = path.relative(ROOT, file);

    const createRe = /createTable\(\s*queryRunner\s*,\s*'(\w+)'\s*,([\s\S]*?)\n\s*\);/g;
    const covered = [];
    let block;
    while ((block = createRe.exec(src)) !== null) {
      const table = block[1];
      const body = block[2];
      const blockLine = src.slice(0, block.index).split('\n').length;
      covered.push([block.index, block.index + block[0].length]);
      const re = /`(\w+)`\s+ENUM\(([^)]*)\)/g;
      let match;
      while ((match = re.exec(body)) !== null) {
        const values = [...match[2].matchAll(/'([^']*)'/g)].map((m) => m[1]);
        if (!values.length) continue;
        result.push({
          values,
          column: match[1],
          table,
          file: relative,
          line: blockLine + body.slice(0, match.index).split('\n').length - 1,
        });
      }
    }

    // 没被 createTable 覆盖的 ENUM（例如 ALTER TABLE ADD COLUMN）→ table 未知
    const looseRe = /`(\w+)`\s+ENUM\(([^)]*)\)/g;
    let loose;
    while ((loose = looseRe.exec(src)) !== null) {
      if (covered.some(([start, end]) => loose.index >= start && loose.index < end)) continue;
      const values = [...loose[2].matchAll(/'([^']*)'/g)].map((m) => m[1]);
      if (!values.length) continue;
      result.push({
        values,
        column: loose[1],
        table: null,
        file: relative,
        line: src.slice(0, loose.index).split('\n').length,
      });
    }
  }
  return result;
}

/* ------------------------------ DTO 解析 ------------------------------ */

/**
 * 解析 DTO 类里的字段：
 *   { name, type, decorators: string[], file, line }
 */
function collectDtoFields() {
  const fields = [];
  const files = walk(API_SRC);
  for (const file of files) {
    const raw = readFileSafe(file);
    if (!raw) continue;
    const src = stripComments(raw);
    const relative = path.relative(ROOT, file);

    // 以 `export class X {` 开头，逐个类切块
    const classRe = /export\s+class\s+(\w+)[^{]*\{/g;
    let classMatch;
    while ((classMatch = classRe.exec(src)) !== null) {
      const open = src.indexOf('{', classMatch.index);
      const body = sliceBlock(src, open);
      if (!body) continue;
      const bodyStart = open + 1;

      // 字段：`@Decorator(...)` 若干行 + `name?: type;`
      const classFields = [];
      // 注意：这里**不能**先剥装饰器 ——
      // 装饰器名（IsIn / IsString …）本身就是判定依据。
      // 字段正则的 `[^;\n]+` 不跨行，多行装饰器里的 `enum: [...]`（没有分号）
      // 自然不会被误当成字段。
      // ⚠️ `name!:` 的**确定赋值断言**也必须能匹配 ——
      // 漏掉它会让整个字段对校验器**不可见**（盲点，见缺陷 #117）。
      const fieldRe = /((?:\s*@[^\n]*\n)*)\s*(\w+)(\?|!)?\s*:\s*([^;\n]+);/g;
      let fieldMatch;
      while ((fieldMatch = fieldRe.exec(body)) !== null) {
        const decorators = [...fieldMatch[1].matchAll(/@(\w+)/g)].map((m) => m[1]);
        classFields.push({
          className: classMatch[1],
          name: fieldMatch[2],
          optional: Boolean(fieldMatch[3]),
          type: fieldMatch[4].trim(),
          decorators,
          file: relative,
          // 行号必须按**字段名**算，而不是正则匹配起点 ——
          // 装饰器组前面的 `\s*` 会吃掉换行，匹配起点可能落在上一个字段那一行。
          line: src
            .slice(0, bodyStart + fieldMatch.index + fieldNameOffset(fieldMatch))
            .split('\n').length,
        });
      }
      // 只有**带 class-validator 装饰器的类**才是请求 DTO；
      // service 里的返回结构 interface 不参与 R2（它们不是入参）。
      const isRequestDto = classFields.some((field) =>
        field.decorators.some((name) => VALIDATOR_DECORATORS.includes(name)),
      );
      for (const field of classFields) {
        fields.push({ ...field, isRequestDto });
      }
    }
  }
  return fields;
}

/**
 * 字段名在正则匹配文本中的偏移。
 * 匹配文本形如 "\n\n  @ApiProperty(...)\n  @IsIn([...])\n  status?: ...;"，
 * 字段名在**尾部**（取最后一个「名字 + 可选 ? + :」）。
 */
function fieldNameOffset(match) {
  const tail = /(\w+)(\?|!)?\s*:\s*[^;\n]+;$/.exec(match[0]);
  if (!tail) return 0;
  const index = match[0].lastIndexOf(tail[0]);
  return index >= 0 ? index : 0;
}

/** 从 `{` 处取出配平的类体 */
function sliceBlock(src, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(openIndex + 1, i);
    }
  }
  return null;
}

/** 取出 `@IsIn([...])` 的字面量列表 */
function isInValues(decorators, body, fieldIndex) {
  return null;
}

/* ------------------------------ 契约枚举 ------------------------------ */

/**
 * 收集契约里的枚举联合类型：
 *   export type VerificationStatus = 'a' | 'b';
 */
function collectContractEnums() {
  const result = [];
  const files = walk(CONTRACTS);
  for (const file of files) {
    const raw = readFileSafe(file);
    if (!raw) continue;
    const src = stripComments(raw);
    const relative = path.relative(ROOT, file);
    const re = /export\s+type\s+(\w+)\s*=\s*([^;]+);/g;
    let match;
    while ((match = re.exec(src)) !== null) {
      const values = [...match[2].matchAll(/'([^']*)'/g)].map((m) => m[1]);
      if (values.length < 2) continue;
      // 只取「纯字面量联合」：表达式里不能出现别的类型名
      const cleaned = match[2].replace(/'[^']*'/g, '').replace(/[|\s]/g, '');
      if (cleaned) continue;
      result.push({
        name: match[1],
        values,
        file: relative,
        line: src.slice(0, match.index).split('\n').length,
      });
    }
  }
  return result;
}

/* ------------------------------ 契约字段 ------------------------------ */

/**
 * 收集契约 interface 里的字段：{ interfaceName, name, type, file, line }
 *
 * R5 需要它：契约里「某个字段的取值」必须能落到**具体的表列**上，
 * 而契约字段的类型可能写成内联联合（`'a' | 'b'`），
 * 也可能写成**具名类型别名**（`UserStatus`）—— 两者都要能解析。
 */
function collectContractFields() {
  const result = [];
  const files = walk(CONTRACTS);
  for (const file of files) {
    const raw = readFileSafe(file);
    if (!raw) continue;
    const src = stripComments(raw);
    const relative = path.relative(ROOT, file);
    const ifaceRe = /export\s+interface\s+(\w+)[^{]*\{/g;
    let ifaceMatch;
    while ((ifaceMatch = ifaceRe.exec(src)) !== null) {
      const open = src.indexOf('{', ifaceMatch.index);
      const body = sliceBlock(src, open);
      if (!body) continue;
      const bodyStart = open + 1;
      const fieldRe = /(\w+)(\?)?\s*:\s*([^;\n]+);/g;
      let fieldMatch;
      while ((fieldMatch = fieldRe.exec(body)) !== null) {
        result.push({
          interfaceName: ifaceMatch[1],
          name: fieldMatch[1],
          optional: Boolean(fieldMatch[2]),
          type: fieldMatch[3].trim(),
          file: relative,
          line: src.slice(0, bodyStart + fieldMatch.index).split('\n').length,
        });
      }
    }
  }
  return result;
}

/**
 * 把契约字段的类型解析成**字面量取值集合**。
 * 先看内联联合（`'a' | 'b'`），再看具名别名（`UserStatus`）。
 */
function resolveContractValues(type, aliasMap) {
  const inline = [...type.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  if (inline.length) return inline;
  const alias = aliasMap.get(type.trim());
  return alias ?? null;
}

/* ------------------------------ 主流程 ------------------------------ */

function main() {
  const dbEnums = collectDbEnums();
  const dtoFields = collectDtoFields();
  const contractEnums = collectContractEnums();
  const contractFields = collectContractFields();
  const aliasMap = new Map(contractEnums.map((item) => [item.name, item.values]));

  const issues = [];
  const notes = [];

  // R1：DTO 的 @IsIn 列表必须被某个 DB ENUM 完全包含
  for (const field of dtoFields) {
    if (!field.decorators.includes('IsIn')) continue;
    const values = extractIsInValues(field);
    if (!values) continue;
    const covered = dbEnums.some((item) => values.every((v) => item.values.includes(v)));
    if (!covered) {
      issues.push({
        kind: 'DTO_ENUM_NOT_IN_DB',
        where: `${field.className}.${field.name}`,
        detail:
          `@IsIn 的值 [${values.join(', ')}] 没有任何数据库 ENUM 完全包含它们` +
          ` → 这些值能通过校验，但落库时会被数据库拒绝（500）`,
        file: field.file,
        line: field.line,
      });
    }
  }

  // R2：状态类字段必须是枚举校验的
  for (const field of dtoFields) {
    if (!field.isRequestDto) continue;
    if (!STATE_FIELD_NAMES.includes(field.name)) continue;
    if (field.decorators.includes('IsIn')) continue;
    // ⚠️ TS 的类型标注在运行时**毫无约束力** ——
    // `status?: 'pending' | 'approved'` 和 `status?: string` 一样，运行时都只是字符串。
    // 所以判定依据是「有没有 @IsIn」，而不是「TS 类型写得像不像枚举」。
    const type = field.type ?? '';
    const isStringLike = type === 'string' || type.includes("'") || type.includes('"');
    if (!isStringLike) continue;
    const exemption = FREE_TEXT_EXEMPTIONS.find(
      (item) => item.className === field.className && item.field === field.name,
    );
    if (exemption) {
      notes.push({
        kind: 'FREE_TEXT_EXEMPTION',
        where: `${field.className}.${field.name}`,
        detail: `豁免：${exemption.reason}`,
        file: field.file,
        line: field.line,
      });
      continue;
    }
    issues.push({
      kind: 'STATE_FIELD_NOT_ENUM_VALIDATED',
      where: `${field.className}.${field.name}`,
      detail:
        `状态类字段 \`${field.name}\`（类型标注 \`${type}\` 在运行时无约束力）` +
        ` 没有 @IsIn → 传非法值不报错、查询静默返回空列表（用户会误判成「没数据」）`,
      file: field.file,
      line: field.line,
    });
  }

  // R3：契约枚举与数据库 ENUM 的关系（**提示级**）
  //   - 完全被某个 ENUM 包含 → 一致；
  //   - 与某个 ENUM **有交集但不完全覆盖** → 提示（例如 AlumniStage 多了 'guest'，
  //     它表示「未登录」，本来就不会落库）；
  //   - 与任何 ENUM **无交集** → 不是落库枚举（排序方向 asc/desc、角色与权限编码等），
  //     不提示、不判失败。
  for (const item of contractEnums) {
    const covered = dbEnums.some((db) => item.values.every((v) => db.values.includes(v)));
    if (covered) continue;
    const partial = dbEnums.find(
      (db) => item.values.some((v) => db.values.includes(v)),
    );
    if (!partial) continue;
    notes.push({
      kind: 'CONTRACT_ENUM_PARTIAL',
      where: item.name,
      detail:
        `契约枚举 [${item.values.join(', ')}] 与数据库列 ${partial.column}` +
        ` 的 ENUM [${partial.values.join(', ')}] 部分重叠` +
        `（多出的值通常表示「不落库」的状态，需确认是有意为之）`,
      file: item.file,
      line: item.line,
    });
  }

  // R4 / R5：**字段 ↔ 表列**的绑定对账（缺陷 #117）
  //
  //   R4：绑定到具体列的 DTO 字段，其取值必须被**该列**的 ENUM 包含；
  //       （此前只看「某个 ENUM」，绑错表也能蒙混过关 —— #114 就是这么漏过去的）
  //   R5：绑定到具体列的契约字段同理；并且该列的每个取值都必须在契约里出现
  //       （服务端能返回、客户端却没声明 → 客户端无法处理）
  for (const binding of TABLE_BINDINGS) {
    const dbEnum = dbEnums.find(
      (item) => item.table === binding.table && item.column === binding.column,
    );
    if (!dbEnum) {
      issues.push({
        kind: 'BOUND_COLUMN_ENUM_NOT_FOUND',
        where: `${binding.owner}.${binding.field}`,
        detail:
          `绑定声明指向 ${binding.table}.${binding.column}，但迁移里找不到该列的 ENUM 定义` +
          `（${binding.reason}）`,
        file: path.relative(ROOT, path.join(MIGRATIONS, '..')),
        line: 0,
      });
      continue;
    }

    if (binding.kind === 'dto') {
      const field = dtoFields.find(
        (item) => item.className === binding.owner && item.name === binding.field,
      );
      if (!field) {
        notes.push({
          kind: 'BOUND_DTO_FIELD_NOT_FOUND',
          where: `${binding.owner}.${binding.field}`,
          detail: `绑定声明的字段不存在（${binding.reason}）`,
          file: binding.table,
          line: 0,
        });
        continue;
      }
      const values = extractIsInValues(field);
      if (!values) {
        notes.push({
          kind: 'BOUND_DTO_FIELD_NO_ISIN',
          where: `${binding.owner}.${binding.field}`,
          detail: `绑定字段没有 @IsIn，无法对账（${binding.reason}）`,
          file: field.file,
          line: field.line,
        });
        continue;
      }
      const extra = values.filter((value) => !dbEnum.values.includes(value));
      if (extra.length) {
        issues.push({
          kind: 'DTO_ENUM_WRONG_TABLE',
          where: `${binding.owner}.${binding.field}`,
          detail:
            `@IsIn 的值 [${values.join(', ')}] 里有 [${extra.join(', ')}] 不属于` +
            ` ${binding.table}.${binding.column} 的 ENUM [${dbEnum.values.join(', ')}]` +
            ` → 这些值能通过校验，但该列根本存不了（${binding.reason}）`,
          file: field.file,
          line: field.line,
        });
      }
      const missing = dbEnum.values.filter((value) => !values.includes(value));
      if (missing.length) {
        notes.push({
          kind: 'DTO_ENUM_MISSING_VALUE',
          where: `${binding.owner}.${binding.field}`,
          detail:
            `${binding.table}.${binding.column} 的 ENUM 有 [${missing.join(', ')}]，` +
            `但接口的取值集合里没有（该值永远筛不出来）`,
          file: field.file,
          line: field.line,
        });
      }
      continue;
    }

    // 契约侧
    const field = contractFields.find(
      (item) => item.interfaceName === binding.owner && item.name === binding.field,
    );
    if (!field) {
      notes.push({
        kind: 'BOUND_CONTRACT_FIELD_NOT_FOUND',
        where: `${binding.owner}.${binding.field}`,
        detail: `绑定声明的契约字段不存在（${binding.reason}）`,
        file: binding.table,
        line: 0,
      });
      continue;
    }
    const values = resolveContractValues(field.type, aliasMap);
    if (!values) {
      notes.push({
        kind: 'BOUND_CONTRACT_FIELD_UNRESOLVED',
        where: `${binding.owner}.${binding.field}`,
        detail: `契约字段类型 \`${field.type}\` 既不是字面量联合，也不是可解析的类型别名（${binding.reason}）`,
        file: field.file,
        line: field.line,
      });
      continue;
    }
    const extra = values.filter((value) => !dbEnum.values.includes(value));
    if (extra.length) {
      issues.push({
        kind: 'CONTRACT_ENUM_WRONG_TABLE',
        where: `${binding.owner}.${binding.field}`,
        detail:
          `契约声明的 [${values.join(', ')}] 里有 [${extra.join(', ')}] 不属于` +
          ` ${binding.table}.${binding.column} 的 ENUM [${dbEnum.values.join(', ')}]` +
          ` → 契约承诺了服务端永远给不出的值（${binding.reason}）`,
        file: field.file,
        line: field.line,
      });
    }
    const missing = dbEnum.values.filter((value) => !values.includes(value));
    if (missing.length) {
      issues.push({
        kind: 'CONTRACT_ENUM_MISSING_VALUE',
        where: `${binding.owner}.${binding.field}`,
        detail:
          `${binding.table}.${binding.column} 的 ENUM 有 [${missing.join(', ')}]，` +
          `但契约没有声明 → 服务端返回这些值时客户端无从处理（${binding.reason}）`,
        file: field.file,
        line: field.line,
      });
    }
  }

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        {
          dbEnumCount: dbEnums.length,
          dtoFieldCount: dtoFields.length,
          contractEnumCount: contractEnums.length,
          issues,
          notes,
        },
        null,
        2,
      ),
    );
  } else {
    console.log('=== 枚举一致性对账（数据库 ENUM ⟷ DTO ⟷ 契约）===');
    for (const issue of issues) {
      console.log(`  ✗ ${issue.where}  [${issue.kind}] ${issue.detail}`);
      console.log(`      ${issue.file}:${issue.line}`);
    }
    for (const note of notes) {
      console.log(`  · ${note.where}  [${note.kind}] ${note.detail}`);
      console.log(`      ${note.file}:${note.line}`);
    }
    console.log(
      `数据库 ENUM ${dbEnums.length} 个 / DTO 字段 ${dtoFields.length} 个 / 契约枚举 ${contractEnums.length} 个：不一致 ${issues.length}`,
    );
  }

  process.exit(issues.length ? 1 : 0);
}

/**
 * 从字段的源码位置取出 `@IsIn([...])` 的字面量。
 * （字段对象里已记录类型，但 @IsIn 的参数在装饰器行上，需要按行回查。）
 */
function extractIsInValues(field) {
  const raw = readFileSafe(path.join(ROOT, field.file));
  if (!raw) return null;
  const src = stripComments(raw);
  const lines = src.split('\n');
  // 从字段所在行往上找最近的 @IsIn
  for (let i = field.line - 1; i >= 0 && i >= field.line - 12; i -= 1) {
    const match = /@IsIn\(\s*\[([^\]]*)\]/.exec(lines[i] ?? '');
    if (match) {
      return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
    }
  }
  return null;
}

main();
