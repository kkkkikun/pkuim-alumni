#!/usr/bin/env node
/**
 * 请求契约对账：客户端**实际发送**的查询参数 / 请求字段 ↔ 服务端**实际接受**的。
 *
 * 背景（缺陷 #59 的另一半）：
 *   管理后台「校友管理」页面提供 6 个筛选条件（关键字 / 学院 / 认证状态 /
 *   账号状态 / 行业 / 毕业年份），服务端只声明并实现了 2 个。
 *   其余 4 个参数被服务端**静默丢弃**：请求照发、状态码 200、结果不受影响 ——
 *   筛选框看起来能用，实际上是个摆设。
 *
 *   同一类问题在请求体上也存在：全局 ValidationPipe 开了 `whitelist: true`，
 *   客户端多传的字段会被**直接剥掉**，不报错。
 *
 * 这两类缺陷不会抛异常，路径一致性、端点覆盖、响应结构校验全都查不出来
 * （响应结构校验只看「返回了什么」，不看「请求带了什么」）。
 *
 * 本脚本做三方对账：
 *   1. 客户端调用点的**查询参数键** / **请求体字段**（静态解析，来源真实代码）；
 *   2. 服务端在 **Swagger** 里声明的查询参数与请求体 schema（唯一的服务端事实来源）；
 *   3. 结论：客户端发了但服务端没声明 → **会被静默忽略**（必须报）。
 *
 * 反方向（服务端声明了但客户端没发）只作提示，不算失败 ——
 * 服务端可以支持更多参数（分页、兼容旧客户端等）。
 *
 * 用法：
 *   node infra/scripts/check-request-contract.mjs --root <repo> \
 *        [--swagger http://127.0.0.1:18081/docs-json | --swagger-file <path>] [--json]
 *
 * 退出码：0 = 对账通过；1 = 存在「客户端发了、服务端不接」的参数/字段。
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
const SWAGGER_URL = argValue('--swagger', '');
const SWAGGER_FILE = argValue('--swagger-file', '');
const AS_JSON = args.includes('--json');

/* ------------------------------ 基础工具 ------------------------------ */

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

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ------------------------------ 类型模型 ------------------------------ */

/**
 * 解析 interface / type alias，得到「类型名 → 字段名集合」。
 * 只用于回答「这个参数类型会带哪些字段」。
 */
function parseTypes(files) {
  const types = new Map();

  for (const file of files) {
    const raw = readFileSafe(file);
    if (!raw) continue;
    const src = stripComments(raw);

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
      const fields = [];
      const fieldRe = /^\s*(\w+)(\?)?\s*:\s*(.+?);/gm;
      let fieldMatch;
      while ((fieldMatch = fieldRe.exec(body)) !== null) {
        fields.push({ name: fieldMatch[1], optional: Boolean(fieldMatch[2]), type: fieldMatch[3].trim() });
      }
      // 先到先得：客户端自己的类型定义优先于契约里的同名类型
      if (!types.has(name)) types.set(name, { kind: 'interface', extends: parents, fields });
      ifaceRe.lastIndex = bodyEnd;
    }

    const aliasRe = /export\s+type\s+(\w+)\s*=\s*([^;]+);/g;
    while ((match = aliasRe.exec(src)) !== null) {
      if (!types.has(match[1])) {
        types.set(match[1], { kind: 'alias', extends: [], fields: [], expr: match[2].trim() });
      }
    }
  }

  return types;
}

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

/** 取类型（含父接口）的字段名集合；解析不出来时返回 null */
function fieldsOf(typeName, types, seen = new Set()) {
  if (!typeName || seen.has(typeName)) return null;
  seen.add(typeName);
  const def = types.get(typeName);
  if (!def) return null;
  if (def.kind === 'alias') {
    // 别名直接展开成对象类型的情况很少，这里只处理 `A & B` / `A[]` 之类
    const names = new Set();
    const parts = def.expr.split('&').map((s) => s.trim());
    for (const part of parts) {
      const simple = part.replace(/\[\]$/, '').trim();
      const sub = fieldsOf(simple, types, seen);
      if (!sub) return null;
      for (const name of sub) names.add(name);
    }
    return names;
  }
  const names = new Set();
  for (const parent of def.extends ?? []) {
    const sub = fieldsOf(parent, types, seen);
    if (!sub) return null;
    for (const name of sub) names.add(name);
  }
  for (const field of def.fields) names.add(field.name);
  return names;
}

/* ------------------------------ 契约路径表 ------------------------------ */

/** 解析 `export const ApiPaths = { ... } as const;`（手写扫描，避免正则吞条目） */
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

/* ------------------------------ Swagger ------------------------------ */

async function loadSwagger() {
  if (SWAGGER_FILE) {
    const raw = readFileSafe(SWAGGER_FILE);
    if (!raw) throw new Error(`无法读取 swagger 文件：${SWAGGER_FILE}`);
    return JSON.parse(raw);
  }
  const url = SWAGGER_URL || 'http://127.0.0.1:18081/docs-json';
  // --swagger 既可以是 URL，也可以是本地已保存的 swagger 文件（离线自测用）
  if (!/^https?:\/\//.test(url)) {
    const raw = readFileSafe(url);
    if (!raw) throw new Error(`无法读取 swagger 文件：${url}`);
    return JSON.parse(raw);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`拉取 swagger 失败：HTTP ${response.status}（${url}）`);
  return response.json();
}

/** 解析 swagger → Map<`${METHOD} ${path}`, {query:Set, body:Set|null}> */
function buildOperations(swagger) {
  const schemas = swagger.components?.schemas ?? {};
  const operations = new Map();

  const resolveProps = (schema) => {
    if (!schema) return null;
    if (schema.$ref) {
      const name = String(schema.$ref).split('/').pop();
      return new Set(Object.keys(schemas[name]?.properties ?? {}));
    }
    if (schema.type === 'array' && schema.items) return resolveProps(schema.items);
    if (schema.properties) return new Set(Object.keys(schema.properties));
    return null;
  };

  for (const [rawPath, methods] of Object.entries(swagger.paths ?? {})) {
    const p = rawPath.replace(/^\/api\/v1/, '') || '/';
    for (const [method, operation] of Object.entries(methods)) {
      if (method === 'parameters') continue;
      const query = new Set();
      for (const parameter of operation.parameters ?? []) {
        if (parameter.in === 'query') query.add(parameter.name);
      }
      let body = null;
      const content = operation.requestBody?.content;
      if (content) {
        const json = content['application/json'] ?? Object.values(content)[0];
        body = resolveProps(json?.schema);
      }
      operations.set(`${method.toUpperCase()} ${p}`, { query, body });
    }
  }
  return operations;
}

/* ------------------------------ 客户端调用点 ------------------------------ */

/** 契约包里的类型：两端客户端都从 @nmg/contracts 取请求体类型 */
const CONTRACT_TYPE_FILES = [
  path.join(ROOT, 'packages/contracts/src/api.ts'),
  path.join(ROOT, 'packages/contracts/src/domain.ts'),
  path.join(ROOT, 'packages/contracts/src/common.ts'),
];

const CLIENTS = [
  {
    name: '管理后台',
    dir: path.join(ROOT, 'apps/admin-web/src'),
    pathsFile: path.join(ROOT, 'packages/contracts/src/api.ts'),
    typeFiles: [
      path.join(ROOT, 'apps/admin-web/src/api/admin.ts'),
      path.join(ROOT, 'apps/admin-web/src/api/auth.ts'),
      path.join(ROOT, 'apps/admin-web/src/api/system.ts'),
      ...CONTRACT_TYPE_FILES,
    ],
    methods: { apiGet: 'GET', apiPost: 'POST', apiPut: 'PUT', apiPatch: 'PATCH', apiDelete: 'DELETE' },
    exclude: ['api/http.ts', 'api/mock.ts'],
  },
  {
    name: '小程序',
    dir: path.join(ROOT, 'apps/miniprogram/src'),
    pathsFile: path.join(ROOT, 'apps/miniprogram/src/services/paths.ts'),
    typeFiles: [
      path.join(ROOT, 'apps/miniprogram/src/types/index.ts'),
      ...CONTRACT_TYPE_FILES,
    ],
    methods: { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', del: 'DELETE' },
    exclude: ['services/request.ts'],
  },
];

/** 跳过方法名后的可选泛型，返回实参括号 '(' 的下标；不是 '(' 则返回 -1 */
function skipGeneric(src, index) {
  let i = index;
  const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
  while (i < src.length && isSpace(src[i])) i += 1;
  if (src[i] === '<') {
    let depth = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '<') depth += 1;
      else if (ch === '>') {
        depth -= 1;
        i += 1;
        if (depth === 0) break;
        continue;
      }
      i += 1;
    }
    while (i < src.length && isSpace(src[i])) i += 1;
  }
  return src[i] === '(' ? i : -1;
}

/** 读取函数实参（线性扫描，避免灾难性回溯） */
function readArguments(src, index) {
  let i = index;
  const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
  while (i < src.length && isSpace(src[i])) i += 1;
  if (src[i] !== '(') return [];
  i += 1;
  const args = [];
  let start = i;
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
      args.push(src.slice(start, i).trim());
      start = i + 1;
    }
    i += 1;
  }
  args.push(src.slice(start, i).trim());
  return args;
}

/** 对象字面量的顶层键 */
function literalKeys(expr) {
  const text = expr.trim();
  if (!text.startsWith('{')) return null;
  const keys = new Set();
  let depth = 0;
  let quote = null;
  let pending = '';
  for (let i = 1; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      pending += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      pending += ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    if (ch === ':' && depth === 1) {
      const key = pending.trim().replace(/^['"`]|['"`]$/g, '');
      if (key) keys.add(key);
      pending = '';
      // 跳过值部分，直到下一个顶层逗号
      let j = i + 1;
      let vdepth = 1;
      let vquote = null;
      while (j < text.length) {
        const c = text[j];
        if (vquote) {
          if (c === '\\') j += 1;
          else if (c === vquote) vquote = null;
        } else if (c === '"' || c === "'" || c === '`') {
          vquote = c;
        } else if (c === '{' || c === '[' || c === '(') vdepth += 1;
        else if (c === '}' || c === ']' || c === ')') vdepth -= 1;
        else if (c === ',' && vdepth === 1) break;
        j += 1;
      }
      i = j;
      pending = '';
      continue;
    }
    if (depth === 1 && ch === ',') {
      pending = '';
      continue;
    }
    if (depth === 1 && ch !== ' ') pending += ch;
  }
  return keys;
}

/** 找出调用点所在函数的参数类型表：{ 参数名: 类型名 } */
function enclosingFunctionParams(src, index) {
  // 向前找最近的 `function NAME(` / `=>` 之前的方法头
  const head = src.slice(0, index);
  const fnMatch = /function\s+(\w+)\s*\(/.exec(head.slice(-2000));
  let paramsSrc = '';
  if (fnMatch) {
    const openIndex = head.lastIndexOf('(', head.length - fnMatch[0].length + fnMatch[0].length);
    const args = readArguments(src, openIndex);
    paramsSrc = args.join(', ');
  }
  const params = new Map();
  const re = /(\w+)\s*(\?)?\s*:\s*([A-Za-z_$][\w$.<>[\]|&\s]*)/g;
  let match;
  while ((match = re.exec(paramsSrc)) !== null) {
    params.set(match[1], match[3].trim());
  }
  return params;
}

/**
 * 扫描一个客户端的所有调用点，产出
 *   [{method, path, queryKeys:Set|null, bodyKeys:Set|null, file, line}]
 */
function scanClient(client, types, pathTable) {
  const calls = [];
  for (const file of walk(client.dir)) {
    const raw = readFileSafe(file);
    if (!raw) continue;
    const src = stripComments(raw);
    const relative = path.relative(ROOT, file);
    if (client.exclude.some((item) => relative.endsWith(item))) continue;

    for (const [methodName, method] of Object.entries(client.methods)) {
      const re = new RegExp(`\\b${methodName}\\b`, 'g');
      let match;
      while ((match = re.exec(src)) !== null) {
        // 方法名与实参括号之间可能夹着泛型：apiGet<PageResult<X>>(...)
        const openIndex = skipGeneric(src, match.index + methodName.length);
        if (openIndex < 0) continue;
        const args = readArguments(src, openIndex);
        if (args.length === 0) continue;
        const resolved = resolveCallPath(args[0], pathTable);
        if (!resolved) continue;

        const params = enclosingFunctionParams(src, match.index);
        const second = args[1] ?? '';
        const third = args[2] ?? '';

        let queryKeys = null;
        let bodyKeys = null;

        if (method === 'GET' || method === 'DELETE') {
          queryKeys = keysOf(second, params, types);
        } else {
          // 写操作：第一个数据参数是请求体，第二个是查询参数（少数接口如此）
          const bodyExpr = second;
          const queryExpr = third;
          bodyKeys = keysOf(bodyExpr, params, types);
          queryKeys = queryExpr ? keysOf(queryExpr, params, types) : null;
        }

        calls.push({
          client: client.name,
          method,
          path: resolved.path,
          queryKeys,
          bodyKeys,
          file: relative,
          line: lineOf(src, match.index),
        });
      }
    }
  }
  return calls;
}

/** 从实参表达式推出「会带哪些键」：字面量 → 直接取键；标识符 → 查参数类型 */
function keysOf(expr, params, types) {
  const text = (expr ?? '').trim();
  if (!text) return null;
  const literal = literalKeys(text);
  if (literal) return literal;
  const identifier = /^([A-Za-z_$][\w$]*)$/.exec(text);
  if (identifier) {
    const typeName = params.get(identifier[1]);
    if (!typeName) return null;
    return fieldsOf(typeName.replace(/\[\]$/, '').trim(), types);
  }
  // 展开表达式：{ ...query, keyword: 'x' }
  if (text.startsWith('{')) {
    const spreadRe = /\.\.\.(\w+)/g;
    let match;
    while ((match = spreadRe.exec(text)) !== null) {
      const typeName = params.get(match[1]);
      if (typeName) {
        const fields = fieldsOf(typeName.replace(/\[\]$/, '').trim(), types);
        if (fields) {
          const merged = new Set(fields);
          for (const key of literalKeys(text) ?? []) merged.add(key);
          return merged;
        }
      }
    }
  }
  return null;
}

function resolveCallPath(expr, table) {
  const text = expr.trim();
  const direct = /^ApiPaths\.(\w+)/.exec(text);
  if (direct) {
    const entry = table.get(direct[1]);
    if (!entry) return null;
    // 归一化**所有** `${占位符}`（多参数路径也要能对上 swagger 操作）
    return { path: entry.template.replace(/\$\{\s*(\w+)\s*\}/g, '{$1}') };
  }
  if (text.startsWith('`')) {
    const inner = text.replace(/^`/, '').replace(/`$/, '');
    const pieces = inner.split(/\$\{([^}]+)\}/g);
    let out = '';
    for (let i = 0; i < pieces.length; i += 1) {
      if (i % 2 === 1) {
        const keyMatch = /^ApiPaths\.(\w+)/.exec(pieces[i].trim());
        if (keyMatch) {
          const entry = table.get(keyMatch[1]);
          if (!entry) return null;
          out += entry.template;
        } else {
          out += '{id}';
        }
      } else {
        out += pieces[i];
      }
    }
    return { path: out };
  }
  const literal = /^['"`]([^'"`]+)['"`]$/.exec(text);
  if (literal) return { path: literal[1] };
  return null;
}

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i += 1) {
    if (src[i] === '\n') line += 1;
  }
  return line;
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const swagger = await loadSwagger();
  const operations = buildOperations(swagger);

  const issues = [];
  const notes = [];
  let checkedCalls = 0;
  let matchedOps = 0;

  for (const client of CLIENTS) {
    const pathTable = parseApiPaths(client.pathsFile);
    const types = parseTypes(client.typeFiles);
    const calls = scanClient(client, types, pathTable);

    for (const call of calls) {
      checkedCalls += 1;
      const key = `${call.method} ${call.path}`;
      const operation = operations.get(key);
      if (!operation) {
        notes.push({ kind: 'NO_SWAGGER_OPERATION', key, file: call.file, line: call.line });
        continue;
      }
      matchedOps += 1;

      // 查询参数：客户端发了但服务端没声明 → 静默忽略
      if (call.queryKeys) {
        for (const key2 of call.queryKeys) {
          if (!operation.query.has(key2)) {
            issues.push({
              kind: 'UNDECLARED_QUERY_PARAM',
              key,
              field: key2,
              message: `客户端发送了查询参数 ${key2}，服务端没有声明（swagger 参数：${
                [...operation.query].join(', ') || '无'
              }）→ 会被静默忽略`,
              file: call.file,
              line: call.line,
            });
          }
        }
      }

      // 请求体：客户端发了但服务端 schema 里没有 → 被 whitelist 剥掉
      if (call.bodyKeys && operation.body) {
        for (const field of call.bodyKeys) {
          if (!operation.body.has(field)) {
            issues.push({
              kind: 'UNDECLARED_BODY_FIELD',
              key,
              field,
              message: `客户端发送了请求体字段 ${field}，服务端 schema 里没有（已知字段：${
                [...operation.body].join(', ') || '无'
              }）→ 会被 ValidationPipe 的 whitelist 剥掉`,
              file: call.file,
              line: call.line,
            });
          }
        }
      }
    }
  }

  const summary = {
    checkedCalls,
    matchedOperations: matchedOps,
    issues: issues.length,
    notes: notes.length,
    detail: issues,
  };

  if (AS_JSON) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('=== 请求契约对账（客户端发送 ↔ 服务端声明）===');
    for (const item of issues) {
      console.log(`  ✗ ${item.key}  ${item.message}`);
      console.log(`      ${item.file}:${item.line}`);
    }
    console.log(
      `共检查 ${checkedCalls} 个调用点，匹配 ${matchedOps} 个服务端操作：不一致 ${issues.length}，提示 ${notes.length}`,
    );
    if (notes.length) {
      console.log('  注：以下调用点在 swagger 里没有对应操作（多为路径模板写法差异）：');
      for (const note of notes.slice(0, 10)) console.log(`    · ${note.key}  ${note.file}:${note.line}`);
    }
  }

  process.exit(issues.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`请求契约对账异常：${error.message}`);
  process.exit(2);
});
