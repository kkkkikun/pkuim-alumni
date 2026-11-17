#!/usr/bin/env node
/**
 * HTTP 状态码对账：服务端**声明**的成功状态码 ⟷ 集成测试里**断言**的状态码。
 *
 * 背景（缺陷 #129 的根因）：
 *   第 37 阶段把 7 个「不创建资源」的 POST 端点从 201 改成 200（缺陷 #126），
 *   但**既有的**集成测试还在断言 201 —— 那批用例在服务端改完的那一刻就失效了，
 *   直到下一次全量回归才暴露。
 *
 *   这类漂移有三个特点，使得它**必须**由工具兜底：
 *     1) 改服务端语义时，测试文件通常**不在改动清单里**（没人会想到去翻测试）；
 *     2) 报错发生在**别的**套件里（notifications 套件因 read-all 的状态码而红），
 *        离改动点很远；
 *     3) 最危险的不是「红」，而是**没人跑那批测试**时它就静静烂在那里。
 *
 * 判定（R1 ~ R3）：
 *   R1 状态码断言漂移：服务端声明 200、测试断言 201（或其他不一致）→ **失败**。
 *      方向很关键：服务端是 200 而测试期望 201，说明**服务端的语义变了、测试没跟上**，
 *      这是要修的漂移；反过来（服务端 201、测试断言 200）常见于「幂等回放返回 200」，
 *      **只提示不判失败**。
 *   R2 端点未匹配：测试里的路径在服务端找不到对应端点 → **提示**（可能是
 *      故意打的错误路径，也可能是路径写法不一致；不判失败，避免误伤）。
 *   R3 错误语义不在本层范围：4xx / 5xx 的断言不参与对账 ——
 *      「不存在一律 404」「存在但无权限 403」这类语义由响应结构校验器负责。
 *
 * 用法：
 *   node infra/scripts/check-status-code-assertions.mjs --root <repo>
 *
 * 退出码：0 = 对账通过；1 = 存在状态码断言漂移。
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

/* ------------------------------ 工具 ------------------------------ */

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function listFiles(dir, filter, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      listFiles(full, filter, acc);
    } else if (filter(full)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * 归一化路径：去掉重复斜杠、结尾斜杠、查询串，并把**路径参数名统一**。
 *
 * 参数名统一是必需的：服务端写 `:id`、测试写 `:postId` 指的是同一个端点，
 * 不统一就会把「同一个端点」误判成「端点不存在」。
 */
function normalizePath(raw) {
  let value = raw.trim();
  const queryAt = value.indexOf('?');
  if (queryAt >= 0) value = value.slice(0, queryAt);
  value = value.replace(/\/{2,}/g, '/');
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  if (!value.startsWith('/')) value = `/${value}`;
  value = value.replace(/:[A-Za-z_$][\w$]*/g, ':param');
  return value;
}

const HTTP_STATUS_BY_NAME = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  PARTIAL_CONTENT: 206,
  MOVED_PERMANENTLY: 301,
  FOUND: 302,
  NOT_MODIFIED: 304,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
};

const DEFAULT_STATUS = { POST: 201, PUT: 200, PATCH: 200, DELETE: 200, GET: 200 };

/* --------------------- 服务端：解析控制器声明 --------------------- */

const API_SRC = path.join(ROOT, 'apps/api/src');
const CONFIG_FILE = path.join(ROOT, 'apps/api/src/config/configuration.ts');

function resolveGlobalPrefix() {
  try {
    const src = readText(CONFIG_FILE);
    const match = src.match(/apiPrefix:\s*process\.env\.API_PREFIX\s*\?\?\s*'([^']+)'/);
    if (match) return normalizePath(match[1]);
  } catch {
    /* 读不到就用默认值 */
  }
  return '/api/v1';
}

const GLOBAL_PREFIX = resolveGlobalPrefix();

/**
 * 解析一个控制器文件 → [{ method, path, status, file }]
 *
 * 做法：按**方法签名**切块（块内恰好有一个路由装饰器，至多一个 @HttpCode），
 * 这样多行装饰器（@ApiOperation({...})）与装饰器顺序都不会干扰判定。
 */
function parseController(file) {
  const src = readText(file);
  const routes = [];

  const prefixMatch = src.match(/@Controller\(\s*(['"])(.*?)\1\s*\)/);
  const controllerPrefix = prefixMatch ? prefixMatch[2] : '';

  // 方法签名：类成员缩进 2 空格
  const signatureRe = /^ {2}(?:public\s+|private\s+|protected\s+)?(?:async\s+)?[A-Za-z_$][\w$]*\s*\(/gm;
  const signatures = [];
  let m;
  while ((m = signatureRe.exec(src)) !== null) {
    signatures.push({ start: m.index, end: signatureRe.lastIndex });
  }

  const routeRe = /@(Get|Post|Put|Patch|Delete)\s*\(\s*(?:(['"])(.*?)\2)?\s*\)/g;
  const httpCodeRe = /@HttpCode\s*\(\s*HttpStatus\.([A-Z_]+)\s*\)/g;

  for (let i = 0; i < signatures.length; i += 1) {
    const chunkStart = i === 0 ? 0 : signatures[i - 1].end;
    const chunk = src.slice(chunkStart, signatures[i].start);

    routeRe.lastIndex = 0;
    httpCodeRe.lastIndex = 0;
    let routeMatch = null;
    let route;
    while ((route = routeRe.exec(chunk)) !== null) {
      routeMatch = { method: route[1].toUpperCase(), subPath: route[3] ?? '' };
    }
    let httpCodeMatch = null;
    let code;
    while ((code = httpCodeRe.exec(chunk)) !== null) {
      httpCodeMatch = code[1];
    }
    if (!routeMatch) continue;

    const declared =
      httpCodeMatch && HTTP_STATUS_BY_NAME[httpCodeMatch] !== undefined
        ? HTTP_STATUS_BY_NAME[httpCodeMatch]
        : DEFAULT_STATUS[routeMatch.method];

    const fullPath = normalizePath(
      [GLOBAL_PREFIX, controllerPrefix, routeMatch.subPath].filter(Boolean).join('/'),
    );
    routes.push({
      method: routeMatch.method,
      path: fullPath,
      status: declared,
      file: path.relative(ROOT, file),
    });
  }
  return routes;
}

const controllerFiles = listFiles(API_SRC, (f) => f.endsWith('.controller.ts'));
const serverRoutes = controllerFiles.flatMap(parseController);
const serverIndex = new Map();
for (const route of serverRoutes) {
  serverIndex.set(`${route.method} ${route.path}`, route);
}

/* --------------------- 测试：解析状态码断言 --------------------- */

const TEST_DIR = path.join(ROOT, 'apps/api/test');

/** 收集文件里的字符串常量别名（如 `const API = '/api/v1';`）。 */
function collectAliases(src) {
  const aliases = new Map();
  const re = /const\s+([A-Z_][A-Z0-9_]*)\s*=\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    aliases.set(m[1], m[2]);
  }
  return aliases;
}

/**
 * 把测试里的路径字面量归一化成服务端能对上的形态：
 *   `${API}/notifications/${id}/read` → `/api/v1/notifications/:id/read`
 */
function normalizeTestPath(raw, aliases) {
  let value = raw;
  value = value.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (whole, name) => {
    const alias = aliases.get(name);
    return alias !== undefined ? alias : `:${name}`;
  });
  value = value.replace(/\$\{[^}]*\}/g, ':param');
  return normalizePath(value);
}

/**
 * 解析一个测试文件 → [{ method, path, expected, file, line }]
 *
 * 只认「请求方法调用之后、下一条请求方法调用之前」的链上第一个 `.expect(NNN)`。
 */
function parseTestFile(file) {
  const src = readText(file);
  const aliases = collectAliases(src);
  const results = [];

  const callRe = /\.(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]*)\2/g;
  let m;
  while ((m = callRe.exec(src)) !== null) {
    const method = m[1].toUpperCase();
    const rawPath = m[3];
    if (!rawPath.includes('/')) continue; // 不是路径字面量（如 `.get(url)`）→ 跳过

    const chainStart = m.index + m[0].length;
    // 链的结束：下一条请求方法调用
    const nextCall = /\.(get|post|put|patch|delete)\s*\(/g;
    nextCall.lastIndex = chainStart;
    const next = nextCall.exec(src);
    const chainEnd = next ? next.index : Math.min(src.length, chainStart + 1200);
    const chain = src.slice(chainStart, chainEnd);

    const expectMatch = chain.match(/\.expect\s*\(\s*(\d{3})\s*\)/);
    if (!expectMatch) continue;

    const line = src.slice(0, m.index).split('\n').length;
    results.push({
      method,
      path: normalizeTestPath(rawPath, aliases),
      expected: Number(expectMatch[1]),
      file: path.relative(ROOT, file),
      line,
    });
  }
  return results;
}

const testFiles = listFiles(TEST_DIR, (f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
const assertions = testFiles.flatMap(parseTestFile);

/* ------------------------------ 判定 ------------------------------ */

const failures = [];
const warnings = [];

for (const assertion of assertions) {
  // R3：4xx / 5xx 不在本层范围
  if (assertion.expected < 200 || assertion.expected >= 300) continue;

  let route = serverIndex.get(`${assertion.method} ${assertion.path}`);
  if (!route && assertion.path.endsWith(':param')) {
    // 形如 `${API}/directory${query}` —— 末位占位符其实是**查询串**
    // （query 里带 '?'，静态看不出来），退一步按「去掉末位占位符」再找一次。
    route = serverIndex.get(
      `${assertion.method} ${assertion.path.slice(0, -':param'.length)}`,
    );
  }
  if (!route) {
    warnings.push(
      `STATUS_ENDPOINT_NOT_FOUND  ${assertion.file}:${assertion.line}  ` +
        `${assertion.method} ${assertion.path}（服务端没有同名端点，跳过对账）`,
    );
    continue;
  }
  if (route.status === assertion.expected) continue;

  if (route.status === 201 && assertion.expected === 200) {
    // R1-例外：服务端默认 201、测试断言 200 —— 常见于「幂等回放返回 200」
    warnings.push(
      `STATUS_REPLAY_HINT  ${assertion.file}:${assertion.line}  ` +
        `${assertion.method} ${assertion.path}：服务端声明 201，测试断言 200（若非幂等回放请修正）`,
    );
    continue;
  }

  failures.push(
    `STATUS_ASSERTION_MISMATCH  ${assertion.file}:${assertion.line}  ` +
      `${assertion.method} ${assertion.path}：服务端声明 ${route.status}，测试断言 ${assertion.expected}`,
  );
}

/* ------------------------------ 输出 ------------------------------ */

console.log(`[status-code-assertions] 服务端端点 ${serverRoutes.length} 个，测试状态码断言 ${assertions.length} 条`);
console.log(`[status-code-assertions] 失败 ${failures.length} 条，提示 ${warnings.length} 条`);

for (const warning of warnings.slice(0, 40)) {
  console.log(`  ⚠ ${warning}`);
}
if (warnings.length > 40) {
  console.log(`  ⚠ …… 另有 ${warnings.length - 40} 条提示未显示`);
}
for (const failure of failures) {
  console.log(`  ✗ ${failure}`);
}

if (failures.length > 0) {
  console.error(
    '[status-code-assertions] 存在状态码断言漂移：服务端的成功状态码变了，测试断言没跟上。',
  );
  process.exit(1);
}

console.log('[status-code-assertions] 对账通过 ✅');
process.exit(0);
