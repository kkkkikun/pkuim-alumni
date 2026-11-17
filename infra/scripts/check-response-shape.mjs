#!/usr/bin/env node
/**
 * 运行时响应结构校验：服务端真实响应体 vs 客户端声明的返回类型。
 *
 * 背景（这是本脚本存在的理由）：
 *   现有的路径类校验器只能保证「没有漂移」，不能保证「语义正确」。
 *   真实的反例（缺陷 #58）：`GET /admin/users` 服务端返回**裸数组**，
 *   而契约 `AdminUserDto` 与前端 `fetchAdminUsers` 都声明为 `PageResult<AdminUserDto>`
 *   （即 `{items, meta}`）。路径完全对得上、契约也完全对得上，
 *   但前端 `usePagedList` 取 `.items` 得到 undefined → 页面直接白屏抛
 *   `TypeError: Cannot read properties of undefined (reading 'length')`。
 *   路径一致性校验、契约路由校验、端点覆盖校验、静态前端校验 **全部查不出**，
 *   只有真实浏览器往返才暴露。
 *
 * 本脚本把那一层补上：
 *   1. 扫描两端客户端的**真实调用点**，连同其**泛型返回类型**一起取出
 *      （`apiGet<PageResult<AdminUserDto>>(...)` / `get<ArticleDto[]>(...)`）；
 *   2. 用契约（packages/contracts）里的 TS 类型定义解析出期望结构；
 *   3. 真实调用服务端（只读 GET），把响应体按客户端声明的类型逐字段核对。
 *
 * 只做只读 GET，不产生任何业务数据。
 *
 * 用法：
 *   node infra/scripts/check-response-shape.mjs --root <repo> \
 *        [--base http://127.0.0.1:18081/api/v1] [--username admin] [--password '***'] \
 *        [--json] [--timeout 15000]
 *   node infra/scripts/check-response-shape.mjs --root <repo> --record <dir>   # 录制基线响应
 *   node infra/scripts/check-response-shape.mjs --root <repo> --fixture <dir>  # 用录制的响应离线校验
 *   node infra/scripts/check-response-shape.mjs --selftest                    # 校验器自测（元自检）
 *
 * 退出码：0 = 结构一致；1 = 存在结构不一致或调用失败；2 = 参数/环境问题。
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
const BASE = String(argValue('--base', 'http://127.0.0.1:18081/api/v1')).replace(/\/+$/, '');
const USERNAME = argValue('--username', process.env.NMG_PROBE_USERNAME || 'admin');
const PASSWORD = argValue('--password', process.env.NMG_PROBE_PASSWORD || 'Admin@2026');
const TIMEOUT = Number(argValue('--timeout', '15000'));
const AS_JSON = args.includes('--json');
const DEBUG_KEYS = args.includes('--debug-keys');
const SELFTEST = args.includes('--selftest');
const RECORD_DIR = argValue('--record', '');
const FIXTURE_DIR = argValue('--fixture', '');
/**
 * 用户态访问令牌（可选）。
 *
 * 小程序的主用户路径（/me/**、通讯录、我的通知等）需要普通校友身份，
 * 没有令牌时这些端点会被跳过 —— 于是**用户侧响应结构**就没人守了。
 * 调用方应传入一个**已存在**的账号的令牌（回归链会用种子里的压测账号换取，
 * 不会新建用户、不污染业务库）。
 */
const USER_TOKEN = argValue('--user-token', process.env.NMG_PROBE_USER_TOKEN || '');

/* ------------------------------ 工具 ------------------------------ */

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      walk(full, out);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** 去掉注释，避免注释里的 `{` `}` 干扰括号配对 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ------------------------------ 类型模型 ------------------------------ */

/**
 * 从 TS 源码中解析类型定义。
 * 返回 Map<name, {kind, extends[], fields[], expr}>：
 *   - kind='interface'：fields 为 [{name, optional, type}]
 *   - kind='alias'：expr 为类型表达式原文
 */
function parseTypes(files) {
  const types = new Map();

  for (const file of files) {
    const raw = readFileSafe(file);
    if (!raw) continue;
    const src = stripComments(raw);

    // interface
    const ifaceRe = /export\s+interface\s+(\w+)(?:\s+extends\s+([^{]+?))?\s*\{/g;
    let match;
    while ((match = ifaceRe.exec(src)) !== null) {
      const name = match[1];
      const parents = (match[2] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.replace(/<.*>$/, '').trim());
      const bodyStart = ifaceRe.lastIndex;
      const bodyEnd = matchBrace(src, bodyStart - 1);
      if (bodyEnd < 0) continue;
      const body = src.slice(bodyStart, bodyEnd);
      types.set(name, {
        kind: 'interface',
        extends: parents,
        fields: parseFields(body),
        expr: null,
      });
      ifaceRe.lastIndex = bodyEnd;
    }

    // type alias
    const aliasRe = /export\s+type\s+(\w+)\s*=\s*/g;
    while ((match = aliasRe.exec(src)) !== null) {
      const name = match[1];
      const start = aliasRe.lastIndex;
      const end = findStatementEnd(src, start);
      if (end < 0) continue;
      const expr = src.slice(start, end).trim().replace(/;$/, '').trim();
      if (!types.has(name)) types.set(name, { kind: 'alias', extends: [], fields: [], expr });
      aliasRe.lastIndex = end;
    }
  }

  return types;
}

/** 找到与 src[openIndex] 处 '{' 配对的 '}' 下标 */
function matchBrace(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 找到类型表达式结束位置（顶层 ';'） */
function findStatementEnd(src, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ';' && depth === 0) return i;
  }
  return -1;
}

/** 解析 interface 体的字段列表 */
function parseFields(body) {
  const fields = [];
  const re = /^\s*(\w+)(\?)?\s*:\s*(.+?);/gm;
  let match;
  while ((match = re.exec(body)) !== null) {
    fields.push({ name: match[1], optional: Boolean(match[2]), type: match[3].trim() });
  }
  return fields;
}

/* ------------------------------ 类型求值与校验 ------------------------------ */

const PRIMITIVES = new Set(['string', 'number', 'boolean', 'unknown', 'any', 'void', 'never', 'null', 'undefined', 'Date']);

/** 按顶层 '|' 切分联合类型（忽略尖括号 / 括号内的竖线） */
function splitUnion(expr) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const ch of expr) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '<' || ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === '>' || ch === ')' || ch === '}' || ch === ']') depth -= 1;
    if (ch === '|' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** 取泛型实参：`PageResult<X>` → X */
function genericArg(expr) {
  const start = expr.indexOf('<');
  const end = expr.lastIndexOf('>');
  if (start < 0 || end <= start) return null;
  return expr.slice(start + 1, end).trim();
}

function typeName(expr) {
  return String(expr).trim().replace(/<.*>$/s, '').trim();
}

function isLiteralUnion(expr) {
  const parts = splitUnion(expr);
  return parts.length > 0 && parts.every((p) => /^['"`].*['"`]$/.test(p));
}

/**
 * 校验一个值是否符合类型表达式。返回错误描述数组（空数组 = 通过）。
 */
function validateValue(value, expr, ctx, where, depth = 0) {
  const errors = [];
  if (depth > 5) return errors;

  let type = String(expr ?? '').trim();
  if (!type) return errors;

  // Promise<T> → T
  if (typeName(type) === 'Promise') {
    const inner = genericArg(type);
    return inner ? validateValue(value, inner, ctx, where, depth + 1) : errors;
  }

  // PageResult<T> → { items: T[], meta: PageMeta }
  if (typeName(type) === 'PageResult') {
    const inner = genericArg(type);
    if (!inner) return errors;
    if (!isPlainObject(value)) {
      errors.push(`${where}：期望 PageResult 对象（含 items/meta），实际是 ${describe(value)}`);
      return errors;
    }
    if (!Array.isArray(value.items)) {
      errors.push(`${where}.items：期望数组，实际是 ${describe(value.items)}`);
    } else {
      const sample = value.items.slice(0, 5);
      sample.forEach((item, index) => {
        errors.push(...validateValue(item, inner, ctx, `${where}.items[${index}]`, depth + 1));
      });
    }
    if (!isPlainObject(value.meta)) {
      errors.push(`${where}.meta：期望分页信息对象，实际是 ${describe(value.meta)}`);
    } else {
      for (const key of ['page', 'pageSize', 'total', 'totalPages']) {
        if (typeof value.meta[key] !== 'number') {
          errors.push(`${where}.meta.${key}：期望数字，实际是 ${describe(value.meta[key])}`);
        }
      }
    }
    return errors;
  }

  // T[] / Array<T>
  if (type.endsWith('[]')) {
    const inner = type.slice(0, -2).trim();
    if (!Array.isArray(value)) {
      errors.push(`${where}：期望数组，实际是 ${describe(value)}`);
      return errors;
    }
    noteArraySample(value, inner, ctx, where);
    pickSamples(value).forEach((item, index) => {
      errors.push(...validateValue(item, inner, ctx, `${where}[${index}]`, depth + 1));
    });
    return errors;
  }
  if (typeName(type) === 'Array') {
    const inner = genericArg(type);
    if (!inner) return errors;
    if (!Array.isArray(value)) {
      errors.push(`${where}：期望数组，实际是 ${describe(value)}`);
      return errors;
    }
    noteArraySample(value, inner, ctx, where);
    pickSamples(value).forEach((item, index) => {
      errors.push(...validateValue(item, inner, ctx, `${where}[${index}]`, depth + 1));
    });
    return errors;
  }

  // 字面量联合（枚举）
  if (isLiteralUnion(type)) {
    const allowed = splitUnion(type).map((p) => p.replace(/^['"`]|['"`]$/g, ''));
    if (typeof value !== 'string' || !allowed.includes(value)) {
      errors.push(`${where}：期望取值为 ${allowed.join(' / ')} 之一，实际是 ${JSON.stringify(value)}`);
    }
    return errors;
  }

  // 联合类型
  const parts = splitUnion(type);
  if (parts.length > 1) {
    const nullable = parts.some((p) => p === 'null');
    const optional = parts.some((p) => p === 'undefined');
    const rest = parts.filter((p) => p !== 'null' && p !== 'undefined');
    if (value === null) {
      if (!nullable) errors.push(`${where}：不允许为 null（期望 ${type}）`);
      return errors;
    }
    if (value === undefined) {
      if (!optional) errors.push(`${where}：不允许为 undefined（期望 ${type}）`);
      return errors;
    }
    if (rest.length === 1) return validateValue(value, rest[0], ctx, where, depth + 1);
    const branchErrors = rest.map((branch) => validateValue(value, branch, ctx, where, depth + 1));
    if (branchErrors.some((list) => list.length === 0)) return [];
    errors.push(`${where}：不符合 ${type}（${describe(value)}）`);
    return errors;
  }

  // 基础类型
  if (PRIMITIVES.has(type)) {
    if (type === 'unknown' || type === 'any' || type === 'void' || type === 'never') return errors;
    if (type === 'null') {
      if (value !== null) errors.push(`${where}：期望 null，实际是 ${describe(value)}`);
      return errors;
    }
    if (type === 'undefined') {
      if (value !== undefined) errors.push(`${where}：期望 undefined，实际是 ${describe(value)}`);
      return errors;
    }
    if (type === 'Date') {
      if (!(value instanceof Date) && typeof value !== 'string') {
        errors.push(`${where}：期望日期字符串，实际是 ${describe(value)}`);
      }
      return errors;
    }
    const actual = typeof value;
    if (actual !== type) {
      errors.push(`${where}：期望 ${type}，实际是 ${actual}`);
    }
    return errors;
  }

  // 内联对象类型
  if (type.startsWith('{')) {
    const body = type.slice(1, type.lastIndexOf('}'));
    return validateObject(value, parseFields(body), ctx, where, depth + 1);
  }

  // 别名
  const alias = ctx.types.get(type);
  if (!alias) {
    // 解析不到的未知类型：放过（避免误报），但记录到 unknown 列表
    ctx.unknownTypes.add(type);
    return errors;
  }
  if (alias.kind === 'alias') return validateValue(value, alias.expr, ctx, where, depth + 1);

  // interface：展开父接口字段
  if (!isPlainObject(value)) {
    errors.push(`${where}：期望对象，实际是 ${describe(value)}`);
    return errors;
  }
  return validateObject(
    value,
    collectFields(alias, ctx),
    ctx,
    where,
    depth + 1,
    alias.name ?? '',
  );
}

/** 收集 interface 及其父接口的全部字段 */
function collectFields(alias, ctx, seen = new Set()) {
  const fields = [];
  for (const parent of alias.extends) {
    if (seen.has(parent)) continue;
    seen.add(parent);
    const parentType = ctx.types.get(parent);
    if (!parentType) continue;
    if (parentType.kind === 'interface') {
      fields.push(...collectFields(parentType, ctx, seen));
    }
  }
  fields.push(...alias.fields);
  return fields;
}

function validateObject(value, fields, ctx, where, depth, typeLabel = '') {
  const errors = [];
  for (const field of fields) {
    const present = Object.prototype.hasOwnProperty.call(value, field.name);
    // 统计口径是「**类型.字段**」而不是「字段名」——
    // 按字段名统计会互相掩盖：`note` 在 A 类型里从不出现、
    // 在 B 类型里一直出现 → A 的问题被 B 掩盖掉了。
    const key = typeLabel ? `${typeLabel}.${field.name}` : field.name;
    if (!present || value[field.name] === undefined) {
      if (!field.optional) {
        errors.push(`${where}.${field.name}：缺失必填字段`);
      } else {
        // 诊断：可选字段缺席。若**所有**样本里都没出现过，
        // 说明服务端根本不给这个字段 → 客户端读到的是恒定的 undefined。
        const stat = ctx.optionalStats.get(key) ?? { absent: 0, present: 0, field: field.name, type: typeLabel };
        stat.absent += 1;
        ctx.optionalStats.set(key, stat);
      }
      continue;
    }
    const stat = ctx.optionalStats.get(key) ?? { absent: 0, present: 0, field: field.name, type: typeLabel };
    stat.present += 1;
    ctx.optionalStats.set(key, stat);
    errors.push(...validateValue(value[field.name], field.type, ctx, `${where}.${field.name}`, depth + 1));
  }
  return errors;
}

/**
 * 数组采样：优先挑「内部含非空数组 / 对象」的条目。
 *
 * 为什么不能只取前 5 条（缺陷 #76）：
 *   列表里排在前面的条目往往字段更少（例如新记录还没上传附件），
 *   嵌套数组若恰好都是空的 → 元素类型根本不会被校验，
 *   契约与实现的形状不一致会被**完全掩盖**。
 *   附件列表的形状就是这样漏检的（服务端只给 {id, mediaId}，契约要求 6 个字段）。
 */
function pickSamples(list, limit = 5) {
  if (!Array.isArray(list)) return [];
  if (list.length <= limit) return list;
  const rich = [];
  const plain = [];
  for (const item of list) {
    if (isRichItem(item)) rich.push(item);
    else plain.push(item);
    if (rich.length >= limit) break;
  }
  if (!rich.length) return list.slice(0, limit);
  return rich.concat(plain.slice(0, Math.max(0, limit - rich.length)));
}

/** 条目里是否含有非空数组或非空对象（这类条目才能暴露嵌套结构问题） */
function isRichItem(item) {
  if (!isPlainObject(item)) return false;
  return Object.values(item).some(
    (value) =>
      (Array.isArray(value) && value.length > 0) ||
      (isPlainObject(value) && Object.keys(value).length > 0),
  );
}

/**
 * 登记一个数组样本，最终算出「元素结构从未被校验」的盲点清单。
 *
 * 盲点的准确含义是：**该路径上所有样本的数组都是空的** →
 * 元素类型一次都没被校验过，契约与实现的形状分歧会被完全掩盖。
 *
 * ⚠️ 这里曾经把条件写反了（`if (!value.length) return;` ——
 * 数组**非空**时反而登记盲点），后果有两个：
 *   1. 报出一堆「所有样本里该数组都是空的」的**假盲点**（数组明明有 12 个元素）；
 *   2. 真正的盲点（数组确实全空）**永远不会被报出来** ——
 *      #76 修复的核心能力实际上是失效的。
 * 现在按「空样本 / 非空样本」两路登记，收尾时再取差集：
 * 只要**任何一个**样本非空，元素结构就已被校验过 → 不算盲点。
 */
function noteArraySample(value, inner, ctx, where) {
  if (!Array.isArray(value)) return;
  const innerType = typeName(inner);
  const isShapeType = Boolean(innerType) && !PRIMITIVES.has(inner) && innerType !== 'Array';
  if (!isShapeType) return;
  if (value.length) {
    // 这个**元素类型**至少被一条非空样本校验过 → 结构已知
    ctx.validatedElementTypes.add(innerType);
    return;
  }
  if (!ctx.emptyArraySamples.has(innerType)) {
    ctx.emptyArraySamples.set(innerType, new Set());
  }
  ctx.emptyArraySamples.get(innerType).add(where);
}

/**
 * 收尾：算出真正的盲点清单。
 *
 * 判定口径是「**元素类型**」，不是「某一条路径」：
 *   只要该元素类型在**任意一条样本**里非空过，元素结构就已被校验过 → 不是盲点；
 *   只有「该类型出现过的每一个样本都是空数组」时，才说明它**从未被校验**。
 *   （按路径判定会误报：列表里第 1 条为空、第 2 条有内容时，
 *     元素结构其实已经校验过了。）
 */
function finalizeEmptyArrayTypes(ctx) {
  const result = new Set();
  for (const [innerType, wheres] of ctx.emptyArraySamples) {
    if (ctx.validatedElementTypes.has(innerType)) continue;
    result.add(
      `${innerType}（出现在 ${[...wheres].join('、')}，所有样本里该数组都是空的 —— 元素结构从未被校验）`,
    );
  }
  return result;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  return typeof value;
}

/* ------------------------------ 调用点扫描 ------------------------------ */

const CLIENTS = [
  {
    name: '管理后台',
    dir: path.join(ROOT, 'apps/admin-web/src'),
    pathsFile: path.join(ROOT, 'packages/contracts/src/api.ts'),
    typeFiles: [path.join(ROOT, 'packages/contracts/src/api.ts')],
    methods: ['apiGet'],
  },
  {
    name: '小程序',
    dir: path.join(ROOT, 'apps/miniprogram/src'),
    pathsFile: path.join(ROOT, 'apps/miniprogram/src/services/paths.ts'),
    typeFiles: [],
    methods: ['get'],
  },
];

/**
 * 解析 `export const ApiPaths = { ... } as const;`
 *
 * 必须手写扫描：正则方案里 `[^`]*` 会贪婪跨过下一个模板串的开引号，
 * 把「adminAlumniItem 后面那两项」整段吞进同一个匹配，
 * 导致这些路径**静默丢失**（曾经因此漏检 4 个管理端列表端点）。
 */
function parseApiPaths(file) {
  const src = readFileSafe(file);
  if (!src) return new Map();
  const start = src.indexOf('export const ApiPaths');
  if (start < 0) return new Map();
  const end = src.indexOf('as const', start);
  const body = src.slice(start, end > 0 ? end : src.length);
  const table = new Map();

  const re = /(\w+)\s*:/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    const key = match[1];
    let i = match.index + match[0].length;
    while (i < body.length && /\s/.test(body[i])) i += 1;

    if (body[i] === "'" || body[i] === '"') {
      const quote = body[i];
      const close = body.indexOf(quote, i + 1);
      if (close < 0) continue;
      table.set(key, { template: body.slice(i + 1, close), hasParam: false });
      re.lastIndex = close + 1;
    } else if (body[i] === '`') {
      const close = body.indexOf('`', i + 1);
      if (close < 0) continue;
      table.set(key, { template: body.slice(i + 1, close), hasParam: false });
      re.lastIndex = close + 1;
    } else if (body[i] === '(') {
      // 函数形式：`(id: number) => \`...\``，小程序侧为 `(id: number): string => \`...\``
      let depth = 0;
      let j = i;
      for (; j < body.length; j += 1) {
        if (body[j] === '(') depth += 1;
        else if (body[j] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (j >= body.length) continue;
      const tick = body.indexOf('`', j);
      if (tick < 0) continue;
      const close = body.indexOf('`', tick + 1);
      if (close < 0) continue;
      table.set(key, { template: body.slice(tick + 1, close), hasParam: true });
      re.lastIndex = close + 1;
    }
  }
  return table;
}

/**
 * 扫描调用点，返回 [{client, method, path, pathKey, typeExpr, file, line}]
 * 只取带泛型返回类型的 GET 调用（只有它们声明了期望结构）。
 */
function scanCallSites() {
  const calls = [];
  for (const client of CLIENTS) {
    const table = parseApiPaths(client.pathsFile);
    for (const file of walk(client.dir)) {
      const src = readFileSafe(file);
      if (!src) continue;
      const relative = path.relative(ROOT, file);
      if (relative.endsWith('api/mock.ts') || relative.endsWith('services/request.ts')) continue;
      for (const methodName of client.methods) {
        const re = new RegExp(`\\b${methodName}\\s*<`, 'g');
        let match;
        while ((match = re.exec(src)) !== null) {
          const genericStart = match.index + match[0].length - 1;
          const genericEnd = matchAngle(src, genericStart);
          if (genericEnd < 0) continue;
          const typeExpr = src.slice(genericStart + 1, genericEnd).trim();
          const arg = readFirstArgument(src, genericEnd + 1);
          if (!arg) continue;
          const resolved = resolveCallPath(arg.expr, table);
          if (!resolved || !resolved.path) continue;
          calls.push({
            client: client.name,
            method: 'GET',
            path: resolved.path,
            pathKey: resolved.key,
            hasParam: Boolean(resolved.hasParam),
            typeExpr,
            file: relative,
            line: lineOf(src, match.index),
          });
        }
      }
    }
  }
  return calls;
}

/** 找到与 src[openIndex] 处 '<' 配对的 '>' */
function matchAngle(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '<') depth += 1;
    else if (ch === '>') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 线性读取第一个实参（不触发灾难性回溯） */
function readFirstArgument(src, index) {
  let i = index;
  const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
  while (i < src.length && isSpace(src[i])) i += 1;
  if (src[i] !== '(') return null;
  i += 1;
  const start = i;
  let depth = 0;
  let quote = null;
  while (i < src.length) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      break;
    }
    i += 1;
  }
  return { expr: src.slice(start, i).trim(), end: i };
}

/** 把调用实参还原成路径模板 */
function resolveCallPath(expr, table) {
  const text = expr.trim();
  const direct = /^ApiPaths\.(\w+)/.exec(text);
  if (direct) {
    const entry = table.get(direct[1]);
    if (!entry) return null;
    return { path: entry.template, key: direct[1], hasParam: entry.hasParam };
  }
  if (text.startsWith('`')) {
    const inner = text.replace(/^`/, '').replace(/`$/, '');
    const pieces = inner.split(/\$\{([^}]+)\}/g);
    let out = '';
    let hasParam = false;
    for (let i = 0; i < pieces.length; i += 1) {
      if (i % 2 === 1) {
        const keyMatch = /^ApiPaths\.(\w+)/.exec(pieces[i].trim());
        if (keyMatch) {
          const entry = table.get(keyMatch[1]);
          if (!entry) return null;
          out += entry.template;
          if (entry.hasParam) hasParam = true;
        } else {
          out += '{id}';
          hasParam = true;
        }
      } else {
        out += pieces[i];
      }
    }
    return { path: out, key: null, hasParam };
  }
  const literal = /^['"`]([^'"`]+)['"`]$/.exec(text);
  if (literal) return { path: literal[1], key: null, hasParam: false };
  return null;
}

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i += 1) {
    if (src[i] === '\n') line += 1;
  }
  return line;
}

/* ------------------------------ HTTP ------------------------------ */

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

/** 解包统一响应信封，取出客户端真正消费的 data */
function unwrap(body) {
  if (isPlainObject(body) && 'code' in body && 'data' in body) return body.data;
  return body;
}

async function loginAdmin() {
  const res = await request(`${BASE}/auth/admin/login`, {
    method: 'POST',
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (res.status !== 200 || !isPlainObject(res.body)) {
    throw new Error(`管理员登录失败：HTTP ${res.status} ${res.text?.slice(0, 200) ?? ''}`);
  }
  const data = unwrap(res.body);
  const token = data?.accessToken ?? data?.token;
  if (!token) throw new Error(`管理员登录响应里没有访问令牌：${JSON.stringify(data).slice(0, 200)}`);
  return token;
}

/* ------------------------------ 夹具 ------------------------------ */

function fixtureName(method, urlPath) {
  return `${method}_${urlPath.replace(/^\/+/, '').replace(/[^a-zA-Z0-9]+/g, '_') || 'root'}.json`;
}

/**
 * 带路径参数的详情端点 → 从哪个列表端点采集真实 id。
 *
 * 详情端点的 DTO 往往比列表端点更复杂（例如后台校友详情 AdminAlumniDetail
 * 额外要求 `verifications` 审核历史），而列表端点校验完全覆盖不到它们。
 * 这里不做「随便编一个 id」（404 会掩盖真实结构问题），
 * 而是从对应列表的真实响应里取第一条记录的 id。
 */
const PARAM_SOURCE = {
  '/admin/alumni/:id': { list: '/admin/alumni', idField: 'userId' },
  '/admin/verifications/:id': { list: '/admin/verifications', idField: 'id' },
  '/admin/resources/:id': { list: '/admin/resources', idField: 'id' },
  '/admin/events/:id': { list: '/admin/events', idField: 'id' },
  '/admin/events/:id/registrations': { list: '/admin/events', idField: 'id' },
  '/admin/articles/:id': { list: '/admin/articles', idField: 'id' },
  '/admin/notices/:id': { list: '/admin/notices', idField: 'id' },
  '/admin/users/:id': { list: '/admin/users', idField: 'id' },
  '/articles/:id': { list: '/articles', idField: 'id' },
  '/notices/:id': { list: '/notices', idField: 'id' },
  '/events/:id': { list: '/events', idField: 'id' },
  '/resources/:id': { list: '/resources', idField: 'id' },
};

/** 把路径模板里的 `${id}` 归一化成 `:id` */
function normalizeTemplatePath(raw) {
  return String(raw).replace(/\$\{\s*id\s*\}/g, ':id').replace(/\/+$/, '');
}

/* ------------------------------ 主流程 ------------------------------ */

function collectTypeFiles() {
  const files = [
    path.join(ROOT, 'packages/contracts/src/common.ts'),
    path.join(ROOT, 'packages/contracts/src/domain.ts'),
    path.join(ROOT, 'packages/contracts/src/api.ts'),
  ];
  const adminApi = path.join(ROOT, 'apps/admin-web/src/api/admin.ts');
  if (readFileSafe(adminApi)) files.push(adminApi);
  const miniTypes = path.join(ROOT, 'apps/miniprogram/src/types/index.ts');
  if (readFileSafe(miniTypes)) files.push(miniTypes);
  return files;
}

async function main() {
  const typeFiles = collectTypeFiles();
  const types = parseTypes(typeFiles);
  const calls = scanCallSites();

  // 分成两类：列表端点（无路径参数）与详情端点（带路径参数）
  const listTargets = new Map();
  const paramTargets = new Map();
  for (const call of calls) {
    if (!call.path.startsWith('/')) continue;
    const key = `${call.method} ${call.path}`;
    const bucket = call.hasParam ? paramTargets : listTargets;
    if (!bucket.has(key)) bucket.set(key, { ...call, typeExprs: new Set() });
    bucket.get(key).typeExprs.add(call.typeExpr);
  }

  if (DEBUG_KEYS) {
    console.error('--- 列表端点 key ---');
    for (const k of listTargets.keys()) console.error('  ' + k);
    console.error('--- 详情端点 key ---');
    for (const k of paramTargets.keys()) console.error('  ' + k);
  }
  const results = [];
  const ctx = {
    types,
    unknownTypes: new Set(),
    optionalStats: new Map(),
    emptyArrayTypes: new Set(),
    emptyArraySamples: new Map(),
    validatedElementTypes: new Set(),
  };
  const harvested = new Map(); // listPath → 解包后的列表数据
  let token = null;
  const userToken = USER_TOKEN;

  const probe = async (target, urlPath) => {
    const headers = {};
    if (token && urlPath.startsWith('/admin/')) headers.authorization = `Bearer ${token}`;
    else if (userToken) headers.authorization = `Bearer ${userToken}`;
    const res = await request(`${BASE}${urlPath}`, { method: 'GET', headers });
    if (res.status === 401 || res.status === 403) {
      return { status: 'SKIP', errors: [`HTTP ${res.status}（需要其他身份令牌，跳过结构校验）`] };
    }
    if (res.status === 404) {
      return { status: 'FAIL', errors: ['HTTP 404（端点不存在）'] };
    }
    if (res.status < 200 || res.status >= 300) {
      return { status: 'FAIL', errors: [`HTTP ${res.status} ${res.text?.slice(0, 200) ?? ''}`] };
    }
    const data = unwrap(res.body);
    const errors = [];
    for (const typeExpr of target.typeExprs) {
      errors.push(...validateValue(data, typeExpr, ctx, `${target.method} ${urlPath}`, 0));
    }
    return { status: errors.length ? 'FAIL' : 'OK', errors, data, body: res.body };
  };

  const saveFixture = (urlPath, body) => {
    if (!RECORD_DIR) return;
    fs.mkdirSync(RECORD_DIR, { recursive: true });
    fs.writeFileSync(path.join(RECORD_DIR, fixtureName('GET', urlPath)), JSON.stringify(body, null, 2));
  };

  if (FIXTURE_DIR) {
    // 离线模式：读取录制的响应体。
    // 若夹具目录带 manifest.json，则**只校验清单里列出的端点**——
    // 这样仓库里可以只保存少量合成夹具（反向验证用），不必提交业务数据。
    const manifestFile = path.join(FIXTURE_DIR, 'manifest.json');
    const manifestRaw = readFileSafe(manifestFile);
    let only = null;
    if (manifestRaw) {
      try {
        const parsed = JSON.parse(manifestRaw);
        if (Array.isArray(parsed.endpoints)) only = new Set(parsed.endpoints);
      } catch {
        only = null;
      }
    }

    for (const [key, target] of listTargets) {
      if (only && !only.has(key)) continue;
      const file = path.join(FIXTURE_DIR, fixtureName('GET', target.path));
      const body = readFileSafe(file);
      if (body === null) {
        results.push({ key, target, status: 'MISSING', errors: [`缺少夹具文件 ${path.basename(file)}`] });
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (error) {
        results.push({ key, target, status: 'BROKEN', errors: [`夹具不是合法 JSON：${error.message}`] });
        continue;
      }
      const data = unwrap(parsed);
      harvested.set(target.path, data);
      const errors = [];
      for (const typeExpr of target.typeExprs) {
        errors.push(...validateValue(data, typeExpr, ctx, `${target.method} ${target.path}`, 0));
      }
      results.push({ key, target, status: errors.length ? 'FAIL' : 'OK', errors });
    }
  } else {
    // 在线模式：真实调用服务端

    const needAdmin = [...listTargets.values(), ...paramTargets.values()].some((t) => t.path.startsWith('/admin/'));
    if (needAdmin) {
      token = await loginAdmin();
    }
    for (const [key, target] of listTargets) {
      const outcome = await probe(target, target.path);
      if (outcome.data !== undefined) {
        harvested.set(target.path, outcome.data);
        saveFixture(target.path, outcome.body ?? unwrap(outcome.data));
      }
      results.push({ key, target, status: outcome.status, errors: outcome.errors });
    }
  }

  // 第二轮：带路径参数的详情端点，用列表响应里采集的真实 id 探测
  for (const [key, target] of paramTargets) {
    const template = normalizeTemplatePath(target.path);
    if (FIXTURE_DIR) {
      const manifestFile = path.join(FIXTURE_DIR, 'manifest.json');
      const manifestRaw = readFileSafe(manifestFile);
      let only = null;
      if (manifestRaw) {
        try {
          const parsed = JSON.parse(manifestRaw);
          if (Array.isArray(parsed.endpoints)) only = new Set(parsed.endpoints);
        } catch {
          only = null;
        }
      }
      if (only && !only.has(key)) continue;
    }
    const source = PARAM_SOURCE[template];
    if (!source) {
      results.push({ key, target, status: 'SKIP', errors: ['未登记 id 来源，跳过（避免用假 id 造成 404 误报）'] });
      continue;
    }
    const listData = harvested.get(source.list);
    const first = Array.isArray(listData?.items) ? listData.items[0] : Array.isArray(listData) ? listData[0] : null;
    const idValue = first?.[source.idField];
    if (idValue === undefined || idValue === null) {
      results.push({ key, target, status: 'SKIP', errors: [`来源列表 ${source.list} 没有可用 id，跳过`] });
      continue;
    }
    const urlPath = template.replace(':id', String(idValue));
    if (FIXTURE_DIR) {
      const file = path.join(FIXTURE_DIR, fixtureName('GET', urlPath));
      const body = readFileSafe(file);
      if (body === null) {
        results.push({ key, target, status: 'MISSING', errors: [`缺少夹具文件 ${path.basename(file)}`] });
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (error) {
        results.push({ key, target, status: 'BROKEN', errors: [`夹具不是合法 JSON：${error.message}`] });
        continue;
      }
      const data = unwrap(parsed);
      const errors = [];
      for (const typeExpr of target.typeExprs) {
        errors.push(...validateValue(data, typeExpr, ctx, `${target.method} ${urlPath}`, 0));
      }
      results.push({ key, target, status: errors.length ? 'FAIL' : 'OK', errors });
    } else {
      const outcome = await probe(target, urlPath);
      if (outcome.data !== undefined) saveFixture(urlPath, outcome.body ?? unwrap(outcome.data));
      results.push({ key, target, status: outcome.status, errors: outcome.errors });
    }
  }

  if (RECORD_DIR) {
    fs.writeFileSync(
      path.join(RECORD_DIR, 'manifest.json'),
      JSON.stringify({ base: BASE, recordedAt: new Date().toISOString(), endpoints: results.map((r) => r.key) }, null, 2),
    );
  }

  // 盲点清单必须在**所有端点都校验完之后**再算 ——
  // 同一个路径可能有多条样本，只有全部为空才算「元素结构从未被校验」。
  ctx.emptyArrayTypes = finalizeEmptyArrayTypes(ctx);

  const failures = results.filter((r) => r.status === 'FAIL' || r.status === 'BROKEN' || r.status === 'MISSING');
  const summary = {
    checked: results.length,
    ok: results.filter((r) => r.status === 'OK').length,
    skipped: results.filter((r) => r.status === 'SKIP').length,
    failed: failures.length,
    unknownTypes: [...ctx.unknownTypes],
    emptyArrayTypes: [...ctx.emptyArrayTypes],
    optionalFieldStats: [...ctx.optionalStats.entries()].map(([key, stat]) => ({
      key,
      present: stat.present,
      absent: stat.absent,
    })),
    neverReturnedOptionalFields: [...ctx.optionalStats.entries()]
      .filter(([, stat]) => stat.present === 0 && stat.absent > 0)
      .map(([key, stat]) => ({ key, type: stat.type ?? '', field: stat.field ?? key })),
    results: results.map((r) => ({ key: r.key, status: r.status, typeExprs: [...r.target.typeExprs], errors: r.errors })),
  };

  if (AS_JSON) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('=== 运行时响应结构校验 ===');
    for (const r of results) {
      const mark = r.status === 'OK' ? '✓' : r.status === 'SKIP' ? '·' : '✗';
      console.log(`  ${mark} ${r.key.padEnd(40)} [${r.status}] ${[...r.target.typeExprs].join(' | ')}`);
      for (const error of r.errors) console.log(`      ${error}`);
    }
    console.log(`共校验 ${summary.checked} 个端点：通过 ${summary.ok}，跳过 ${summary.skipped}，失败 ${summary.failed}`);
    if (summary.unknownTypes.length) {
      console.log(`  注：以下类型未解析到定义，已跳过其内部校验：${summary.unknownTypes.join(', ')}`);
    }
    if (summary.emptyArrayTypes.length) {
      console.log('  注：以下类型的**元素结构从未被校验**（所有样本里对应数组都是空的）：');
      for (const item of summary.emptyArrayTypes) console.log(`    · ${item}`);
      console.log('    → 需要一条带该字段真实数据的样本，才能验证契约声明的元素结构。');
    }
    // 诊断：可选字段在**所有**样本里都没出现过 → 服务端根本不给这个字段。
    // 统计口径是「类型.字段」—— 按字段名统计会互相掩盖。
    const neverReturned = [...ctx.optionalStats.entries()]
      .filter(([, stat]) => stat.present === 0 && stat.absent > 0)
      .map(([key, stat]) => ({ key, ...stat }));
    if (neverReturned.length) {
      console.log('  注：以下可选字段服务端从未返回（客户端读到的是恒定 undefined）：');
      for (const item of neverReturned) {
        console.log(`    · ${item.type ? `${item.type}.` : ''}${item.field}`);
      }
    }
  }

  process.exit(failures.length ? 1 : 0);
}

/* ------------------------------ 自测（元自检） ------------------------------ */

/**
 * 校验器自测：用**构造的响应体**验证核心判定逻辑，
 * 证明「结构不符一定被抓出」，且断言函数本身不是恒过的。
 *
 * 覆盖的关键用例（含真实缺陷 #58 的形状）：
 *   1. 正确的 PageResult → 通过
 *   2. 裸数组冒充 PageResult（缺陷 #58 原形）→ 失败
 *   3. PageResult 缺 meta → 失败
 *   4. 列表项缺必填字段（缺陷 #58 第二形：roles）→ 失败
 *   5. 字段类型不符 → 失败
 *   6. 可选字段缺失 → 通过
 *   7. 枚举值非法 → 失败
 */
function runSelftest() {
  const types = parseTypes([
    path.join(ROOT, 'packages/contracts/src/common.ts'),
    path.join(ROOT, 'packages/contracts/src/domain.ts'),
  ]);
  const ctx = {
    types,
    unknownTypes: new Set(),
    optionalStats: new Map(),
    emptyArrayTypes: new Set(),
    emptyArraySamples: new Map(),
    validatedElementTypes: new Set(),
  };

  const cases = [
    {
      name: '正确分页结构',
      expect: 'pass',
      value: { items: [{ id: 1, name: 'x' }], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } },
      expr: 'PageResult<DemoDto>',
    },
    {
      name: '裸数组冒充分页结构（缺陷 #58 原形）',
      expect: 'fail',
      value: [{ id: 1, name: 'x' }],
      expr: 'PageResult<DemoDto>',
    },
    {
      name: '分页结构缺 meta',
      expect: 'fail',
      value: { items: [] },
      expr: 'PageResult<DemoDto>',
    },
    {
      name: '列表项缺必填字段',
      expect: 'fail',
      value: { items: [{ id: 1 }], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } },
      expr: 'PageResult<DemoDto>',
    },
    {
      name: '字段类型不符',
      expect: 'fail',
      value: { items: [{ id: '1', name: 'x' }], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } },
      expr: 'PageResult<DemoDto>',
    },
    {
      name: '可选字段缺失应当放行',
      expect: 'pass',
      value: { items: [{ id: 1, name: 'x' }], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } },
      expr: 'PageResult<DemoDemoDto>',
    },
    {
      name: '枚举值非法',
      expect: 'fail',
      value: { items: [{ id: 1, name: 'x', status: 'weird' }], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } },
      expr: 'PageResult<DemoEnumDto>',
    },
  ];

  let failed = 0;
  console.log('=== 响应结构校验器自测 ===');

  // 元自检：断言函数必须能识破「永远通过」的判定器
  const metaAlwaysPass = () => [];
  const metaAlwaysFail = () => ['恒失败'];
  const metaExpect = (result, expect) => (expect === 'pass' ? result.length === 0 : result.length > 0);
  if (metaExpect(metaAlwaysPass(), 'fail')) {
    console.log('  ✗ 元自检失败：断言函数把「恒过判定器」判成了通过');
    failed += 1;
  } else if (!metaExpect(metaAlwaysFail(), 'fail')) {
    console.log('  ✗ 元自检失败：断言函数把「恒失败判定器」判成了通过');
    failed += 1;
  } else {
    console.log('  ✓ 元自检通过：恒过的判定器被正确判为失败');
  }

  for (const item of cases) {
    // 为自测注入最小类型定义
    ctx.types.set('DemoDto', { kind: 'interface', extends: [], fields: [{ name: 'id', optional: false, type: 'number' }, { name: 'name', optional: false, type: 'string' }], expr: null });
    ctx.types.set('DemoDemoDto', { kind: 'interface', extends: [], fields: [{ name: 'id', optional: false, type: 'number' }, { name: 'name', optional: false, type: 'string' }, { name: 'note', optional: true, type: 'string' }], expr: null });
    ctx.types.set('DemoEnumDto', { kind: 'interface', extends: [], fields: [{ name: 'id', optional: false, type: 'number' }, { name: 'name', optional: false, type: 'string' }, { name: 'status', optional: false, type: "'a' | 'b'" }], expr: null });

    const errors = validateValue(item.value, item.expr, ctx, 'selftest', 0);
    const passed = metaExpect(errors, item.expect);
    if (passed) {
      console.log(`  ✓ ${item.name}`);
    } else {
      console.log(`  ✗ ${item.name}：期望 ${item.expect}，实际 ${errors.length ? 'fail' : 'pass'}（${errors.join('; ')}）`);
      failed += 1;
    }
  }

  console.log(failed ? `=== 自测失败（${failed} 项）===` : '=== 自测通过 ✅（校验器非恒过）===');
  process.exit(failed ? 1 : 0);
}

if (SELFTEST) {
  runSelftest();
} else {
  main().catch((error) => {
    console.error(`响应结构校验异常：${error.message}`);
    process.exit(2);
  });
}
