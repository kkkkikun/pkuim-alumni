#!/usr/bin/env node
/**
 * 客户端 ↔ 服务端 路径一致性校验。
 *
 * 背景：`packages/contracts` 的 ApiPaths 是唯一事实来源，但真正发起请求的是
 * 小程序（`apps/miniprogram`，运行时镜像了一份路径表）与管理后台
 * （`apps/admin-web`，直接引用契约包）。历史上出现过「契约里写了，
 * 小程序调用的却是另一个方法 / 另一个路径」的割裂，运行时才暴露为 404/405。
 *
 * 本脚本做三件事：
 *   1. 解析契约 ApiPaths 与小程序镜像路径表，校验镜像与契约一致（键与值都一致）；
 *      小程序若**绕过镜像表直接写字面量路径**，报错（契约变更时不会同步）；
 *   2. 扫描两端客户端源码中的真实调用点，还原出 (HTTP 方法, 路径模板)；
 *   3. 从运行中的 API 拉取 Swagger 文档，得到服务端真实注册的 (方法, 路径) 集合；
 *      比对：路径不存在 → 报错；路径存在但方法未注册 → 报错（最隐蔽的一类）。
 *
 * 职责边界：「契约 ApiPaths ↔ 服务端路由」的**集合级双向比对**由
 * `infra/scripts/check-contract-routes.mjs` 负责（严格 error 级、排除基础设施路径），
 * 本脚本不重复实现，避免两处逻辑各自漂移。
 *
 * 用法：
 *   node infra/scripts/check-client-paths.mjs \
 *     --root . --swagger http://127.0.0.1:18081/docs-json
 *
 * 退出码：0 = 无错误（可能有警告）；1 = 存在错误。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/* ------------------------------ 参数 ------------------------------ */

function parseArgs(argv) {
  const args = { root: process.cwd(), swagger: 'http://127.0.0.1:18081/docs-json' };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--root') args.root = argv[++i];
    else if (token === '--swagger') args.swagger = argv[++i];
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(
    [
      '用法: node infra/scripts/check-client-paths.mjs [--root <repo>] [--swagger <url>] [--json]',
      '',
      '  --root     仓库根目录，默认当前目录',
      '  --swagger  Swagger 文档地址，默认 http://127.0.0.1:18081/docs-json',
      '  --json     以 JSON 输出结果（便于 CI 消费）',
    ].join('\n'),
  );
  process.exit(0);
}

const ROOT = path.resolve(args.root);

/* ------------------------------ 通用工具 ------------------------------ */

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
      if (['node_modules', 'dist', 'coverage', '.git'].includes(entry.name)) continue;
      walk(full, out);
    } else if (/\.(ts|tsx|js|vue)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** 去掉查询串与结尾斜杠，并统一前缀占位 */
function normalizePath(raw) {
  let value = String(raw).trim();
  value = value.replace(/^['"`]|['"`]$/g, '');
  value = value.split('?')[0];
  // 归一化**所有** `${占位符}`（多参数路径如
  // `/admin/verifications/${id}/attachments/${mediaId}/url` 也要能对上服务端路由）
  value = value.replace(/\$\{\s*(\w+)\s*\}/g, '{$1}');
  value = value.replace(/\/(\d+)(?=\/|$)/g, '/{id}');
  if (value.length > 1) value = value.replace(/\/+$/, '');
  return value;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/* ------------------------------ 解析 ApiPaths ------------------------------ */

/**
 * 从 TS 源码中解析 `export const ApiPaths = { ... } as const;`
 * 返回 Map<key, { kind: 'static'|'fn', template: string }>
 */
function parseApiPaths(file) {
  const src = readFileSafe(file);
  if (!src) return null;
  const start = src.indexOf('export const ApiPaths');
  if (start < 0) return null;
  const end = src.indexOf('as const', start);
  const body = src.slice(start, end > 0 ? end : src.length);

  const map = new Map();

  const fnRe = /(\w+)\s*:\s*\([^)]*\)(?:\s*:\s*string)?\s*=>\s*`([^`]+)`/g;
  let match;
  while ((match = fnRe.exec(body)) !== null) {
    map.set(match[1], { kind: 'fn', template: match[2] });
  }

  const staticRe = /(\w+)\s*:\s*'([^']*)'/g;
  while ((match = staticRe.exec(body)) !== null) {
    if (!map.has(match[1])) map.set(match[1], { kind: 'static', template: match[2] });
  }

  return map;
}

/** 取路径模板：函数型按 id=1 求值（与契约一致性测试一致的口径） */
function resolveTemplate(entry) {
  if (!entry) return null;
  if (entry.kind === 'static') return entry.template;
  return entry.template.replace(/\$\{\s*id\s*\}/g, '1');
}

/* ------------------------------ 服务端路由表 ------------------------------ */

async function loadServerRoutes(swaggerUrl) {
  // 支持本地文件路径（离线校验 / 排查问题）
  if (!/^https?:\/\//i.test(swaggerUrl)) {
    const raw = readFileSafe(path.resolve(swaggerUrl));
    if (!raw) throw new Error(`无法读取 Swagger 文件：${swaggerUrl}`);
    return buildRoutes(JSON.parse(raw));
  }
  const response = await fetch(swaggerUrl);
  if (!response.ok) {
    throw new Error(`拉取 Swagger 失败：${response.status} ${response.statusText} (${swaggerUrl})`);
  }
  const document = await response.json();
  return buildRoutes(document);
}

function buildRoutes(document) {
  /** @type {Map<string, Set<string>>} */
  const routes = new Map();
  for (const [rawPath, operations] of Object.entries(document.paths ?? {})) {
    const normalized = normalizePath(rawPath.replace(/^\/api\/v1/, ''));
    const methods = new Set(
      Object.keys(operations ?? {}).filter((key) => HTTP_METHODS.includes(key.toLowerCase())),
    );
    routes.set(normalized, methods);
  }
  return routes;
}

/* ------------------------------ 客户端调用点扫描 ------------------------------ */

const CLIENTS = [
  {
    name: '小程序',
    dir: path.join(ROOT, 'apps/miniprogram/src'),
    pathsFile: path.join(ROOT, 'apps/miniprogram/src/services/paths.ts'),
    // 传输层自身（请求封装）不是业务调用点，单独用字面量规则检查
    exclude: ['services/request.ts'],
    methods: { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', del: 'DELETE' },
  },
  {
    name: '管理后台',
    dir: path.join(ROOT, 'apps/admin-web/src'),
    pathsFile: path.join(ROOT, 'packages/contracts/src/api.ts'),
    exclude: ['api/http.ts'],
    methods: {
      apiGet: 'GET',
      apiPost: 'POST',
      apiPut: 'PUT',
      apiPatch: 'PATCH',
      apiDelete: 'DELETE',
    },
  },
];

/** 匹配调用点的方法名（不带参数，参数由线性解析器取出） */
const METHOD_TOKEN_RE = /\b(apiGet|apiPost|apiPut|apiPatch|apiDelete|get|post|put|patch|del|rawRequest)\b/g;

/**
 * 从方法名之后线性解析出「第一个实参」。
 *
 * 用正则直接匹配 `method<...>(arg` 在长行（.vue 模板、压缩代码）上会触发
 * 灾难性回溯，实测可让进程空转数分钟，因此改为手工扫描：
 * 跳过可选泛型 → 定位 '(' → 读到第一个顶层逗号/右括号为止。
 */
function readFirstArgument(src, index) {
  let i = index;
  const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

  while (i < src.length && isSpace(src[i])) i += 1;

  // 跳过泛型 <...>（允许嵌套）
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

/**
 * 把调用点里的路径表达式还原成路径模板。
 * 支持：`ApiPaths.key`、`ApiPaths.key(arg)`、`${ApiPaths.key}/x`、字面量字符串。
 */
function resolveCallPath(expr, pathTable) {
  const text = expr.trim();

  // 1) 直接是 ApiPaths.key
  const direct = /^ApiPaths\.(\w+)/.exec(text);
  if (direct) {
    const entry = pathTable.get(direct[1]);
    if (!entry) return { missingKey: direct[1] };
    return { path: normalizePath(resolveTemplate(entry)) };
  }

  // 2) 模板字面量：`${ApiPaths.key}/xxx/${id}`
  if (text.startsWith('`')) {
    const inner = text.replace(/^`/, '').replace(/`$/, '');
    const pieces = inner.split(/\$\{([^}]+)\}/g);
    let out = '';
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i];
      if (i % 2 === 1) {
        const keyMatch = /^ApiPaths\.(\w+)/.exec(piece.trim());
        if (keyMatch) {
          const entry = pathTable.get(keyMatch[1]);
          if (!entry) return { missingKey: keyMatch[1] };
          out += resolveTemplate(entry);
        } else {
          out += '{id}';
        }
      } else {
        out += piece;
      }
    }
    return { path: normalizePath(out) };
  }

  // 3) 普通字符串字面量
  const literal = /^['"`]([^'"`]+)['"`]$/.exec(text);
  if (literal) return { path: normalizePath(literal[1]), literal: true };

  return { unresolved: text };
}

function scanClient(client, pathTable) {
  const calls = [];
  for (const file of walk(client.dir)) {
    const src = readFileSafe(file);
    if (!src) continue;
    const relative = path.relative(ROOT, file);
    const excluded = (client.exclude ?? []).some((item) => relative.endsWith(item));

    METHOD_TOKEN_RE.lastIndex = 0;
    let match;
    while ((match = METHOD_TOKEN_RE.exec(src)) !== null) {
      const methodName = match[1];
      const parsed = readFirstArgument(src, match.index + methodName.length);
      if (!parsed) continue;
      const expr = parsed.expr;

      // rawRequest('/path', { method: 'POST' }) —— 请求层内部的字面量调用
      if (methodName === 'rawRequest') {
        const literal = /^['"`]([^'"`]+)['"`]$/.exec(expr);
        if (!literal) continue;
        const options = src.slice(parsed.end, parsed.end + 400);
        const methodMatch = /method:\s*'(\w+)'/.exec(options);
        calls.push({
          file: relative,
          method: methodMatch ? methodMatch[1].toUpperCase() : 'GET',
          path: normalizePath(literal[1]),
          line: lineOf(src, match.index),
        });
        continue;
      }

      if (excluded) continue;

      const method = client.methods[methodName];
      if (!method) continue;
      const resolved = resolveCallPath(expr, pathTable);
      calls.push({ file: relative, method, ...resolved, line: lineOf(src, match.index) });
    }
  }
  return calls;
}

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i += 1) {
    if (src[i] === '\n') line += 1;
  }
  return line;
}

/* ------------------------------ 校验 ------------------------------ */

const errors = [];
const warnings = [];
const notes = [];

function loadAllowlist() {
  const file = path.join(ROOT, 'infra/scripts/client-path-allowlist.json');
  const raw = readFileSafe(file);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    errors.push({ kind: 'ALLOWLIST_PARSE', message: `${file} 不是合法 JSON` });
    return [];
  }
}

async function main() {
  const contractPaths = parseApiPaths(path.join(ROOT, 'packages/contracts/src/api.ts'));
  if (!contractPaths) {
    console.error('无法解析 packages/contracts/src/api.ts 中的 ApiPaths');
    process.exit(1);
  }

  const serverRoutes = await loadServerRoutes(args.swagger);
  const allowlist = loadAllowlist();
  const allowKey = (method, path) => `${method.toUpperCase()} ${path}`;

  const clients = [];

  for (const client of CLIENTS) {
    const table = parseApiPaths(client.pathsFile);
    if (!table) {
      errors.push({ kind: 'PATHS_PARSE', message: `无法解析 ${path.relative(ROOT, client.pathsFile)}` });
      continue;
    }

    /* 1) 镜像表 vs 契约（仅小程序需要镜像校验） */
    if (client.name === '小程序') {
      for (const [key, entry] of table) {
        const contract = contractPaths.get(key);
        if (!contract) {
          errors.push({
            kind: 'MIRROR_EXTRA_KEY',
            message: `小程序镜像包含契约中不存在的路径键：${key}`,
            file: path.relative(ROOT, client.pathsFile),
          });
          continue;
        }
        if (normalizePath(resolveTemplate(entry)) !== normalizePath(resolveTemplate(contract))) {
          errors.push({
            kind: 'MIRROR_VALUE_MISMATCH',
            message: `小程序镜像 ${key} = ${resolveTemplate(entry)}，契约为 ${resolveTemplate(contract)}`,
            file: path.relative(ROOT, client.pathsFile),
          });
        }
      }
      const missingKeys = [];
      for (const key of contractPaths.keys()) {
        if (!table.has(key)) missingKeys.push(key);
      }
      // 说明：小程序镜像表是契约的**子集**是正常现象——契约里还有管理后台与
      // 服务端专用路径。因此「契约有键但镜像表没有」本身不是缺陷，
      // 真正的缺陷是客户端**绕过镜像表直接写字面量路径**（见 MIRROR_LITERAL_PATH）。
      // 这里只做统计说明，不作为警告，避免淹没真问题。
      if (missingKeys.length) {
        notes.push(
          `契约 ${contractPaths.size} 个路径键中，小程序镜像 ${table.size} 个；` +
            `其余 ${missingKeys.length} 个为管理后台 / 服务端专用，不参与镜像校验`,
        );
      }
    }

    /* 2) 客户端调用点 ↔ 服务端路由 */
    const calls = scanClient(client, table);
    for (const call of calls) {
      if (call.missingKey) {
        errors.push({
          kind: 'CALL_UNKNOWN_KEY',
          message: `${client.name} 引用了未定义的路径键 ApiPaths.${call.missingKey}`,
          file: call.file,
          line: call.line,
        });
        continue;
      }
      // 小程序绕过契约镜像表、直接写字面量路径：契约一旦改路径，客户端不会跟着改
      if (client.name === '小程序' && call.literal) {
        errors.push({
          kind: 'MIRROR_LITERAL_PATH',
          message: `${client.name} 在 ${call.method} 调用中直接写了字面量路径 ${call.path}，` +
            `应改用 services/paths.ts 里的 ApiPaths 镜像键（契约变更才能同步）`,
          file: call.file,
          line: call.line,
        });
        continue;
      }
      if (!call.path) {
        if (call.unresolved) {
          warnings.push({
            kind: 'CALL_UNRESOLVED',
            message: `${client.name} 调用路径无法静态解析：${call.unresolved}`,
            file: call.file,
            line: call.line,
          });
        }
        continue;
      }

      const methods = serverRoutes.get(call.path);
      if (!methods) {
        const record = {
          kind: 'ROUTE_NOT_FOUND',
          message: `${client.name} 调用 ${call.method} ${call.path}，服务端未注册该路径`,
          file: call.file,
          line: call.line,
        };
        const hit = allowlist.find((item) => item.method === call.method && item.path === call.path);
        if (hit) {
          warnings.push({ ...record, note: hit.reason ?? '已在豁免清单中' });
        } else {
          errors.push(record);
        }
        continue;
      }

      if (!methods.has(call.method.toLowerCase())) {
        const record = {
          kind: 'METHOD_NOT_ALLOWED',
          message: `${client.name} 调用 ${call.method} ${call.path}，服务端该路径只注册了 ${[...methods]
            .map((m) => m.toUpperCase())
            .join('/')}`,
          file: call.file,
          line: call.line,
        };
        const hit = allowlist.find((item) => item.method === call.method && item.path === call.path);
        if (hit) {
          warnings.push({ ...record, note: hit.reason ?? '已在豁免清单中' });
        } else {
          errors.push(record);
        }
      }
    }

    clients.push({ name: client.name, callCount: calls.length });
  }

  /* 3) 契约 ↔ 服务端路由的集合比对由 infra/scripts/check-contract-routes.mjs 负责
   *    （严格 error 级、排除基础设施路径），此处不重复实现，避免两处逻辑各自漂移。 */

  const result = {
    serverRoutes: serverRoutes.size,
    clients,
    errors,
    warnings,
    notes,
    allowlistKey: allowKey,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('=== 客户端 ↔ 服务端 路径一致性校验 ===');
    console.log(`服务端路由数：${serverRoutes.size}`);
    for (const client of clients) console.log(`${client.name} 调用点：${client.callCount}`);
    for (const note of notes) {
      console.log(`\n-- 说明 --\n  [INFO] ${note}`);
    }
    if (warnings.length) {
      console.log(`\n-- 警告 ${warnings.length} 条 --`);
      for (const item of warnings) {
        console.log(`  [WARN] ${item.kind} ${item.message}${item.file ? ` (${item.file}:${item.line ?? '-'})` : ''}`);
        if (item.note) console.log(`         豁免原因：${item.note}`);
      }
    }
    if (errors.length) {
      console.log(`\n-- 错误 ${errors.length} 条 --`);
      for (const item of errors) {
        console.log(`  [ERROR] ${item.kind} ${item.message}${item.file ? ` (${item.file}:${item.line ?? '-'})` : ''}`);
      }
    } else {
      console.log('\n未发现路径不一致问题。');
    }
  }

  process.exit(errors.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`校验失败：${error.message}`);
  process.exit(2);
});
