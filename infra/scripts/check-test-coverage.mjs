#!/usr/bin/env node
/**
 * 服务端端点 ←→ 集成测试 覆盖分析。
 *
 * 背景：一次人工统计发现，管理后台的一批接口（管理端文章 / 公告 / 分类 / 角色 /
 *       权限 / 审计日志 / 系统设置）以及联系申请的**拒绝 / 撤回**分支
 *       **从未被任何测试调用过**。「没人调用过」的功能最容易藏着真实缺陷
 *       （此前上传接口的 500 就是这么被发现的）。
 *       但人工统计不可重复 —— 本脚本把它变成随时可跑的检查。
 *
 * 做法：
 *   1. 解析服务端控制器，得到全部 (方法, 路径模板)；
 *   2. 扫描集成测试源码，还原出真实调用过的 (方法, 路径)；
 *   3. 路径归一化（`${xxx}` → `:param`），按段数与占位符匹配；
 *   4. 输出未被覆盖的端点 —— **写操作端点（POST/PUT/PATCH/DELETE）单独列出**，
 *      因为它们的副作用（建数据、审状态、发通知）最容易出回归。
 *
 * 用法：
 *   node infra/scripts/check-test-coverage.mjs [--root <repo>] [--json] [--fail-on-write] [--fail-on-uncovered]
 *
 * 退出码：0 正常输出；1 存在未覆盖的**写操作**端点（仅 --fail-on-write 时）
 *         或存在任何未覆盖端点（仅 --fail-on-uncovered 时）。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const ROOT = path.resolve(argValue('--root', process.cwd()));
const AS_JSON = args.includes('--json');
const FAIL_ON_WRITE = args.includes('--fail-on-write');
const FAIL_ON_UNCOVERED = args.includes('--fail-on-uncovered');

const MODULES_DIR = path.join(ROOT, 'apps/api/src/modules');
const TEST_DIR = path.join(ROOT, 'apps/api/test');

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/* ------------------------------ 工具 ------------------------------ */

function walk(dir, filter) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, filter));
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}

function readSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 归一化路径：去掉前后斜杠差异，把 ${xxx} 变成 :param */
function normalizePath(value) {
  let result = String(value ?? '').trim();
  result = result.replace(/\$\{[^}]+\}/g, ':param');
  result = result.replace(/^\/+/, '').replace(/\/+$/, '');
  return result;
}

/**
 * 把测试里写出的调用路径归一到与服务端路由同一口径：
 *   - 去掉 query string（`?status=draft`）
 *   - 去掉硬编码的 `/api/v1` 前缀（部分测试没用 `${API}` 常量）
 *   - `${...}` 动态段 → `:param`
 */
function normalizeCallPath(value) {
  let result = String(value ?? '').trim();
  result = result.split('?')[0];
  result = result.replace(/\$\{API\}/g, '');
  result = result.replace(/^\/api\/v1(?=\/|$)/, '');
  result = result.replace(/\$\{[^}]+\}/g, ':param');
  result = result.replace(/^\/+/, '').replace(/\/+$/, '');
  return result;
}

/* ------------------------------ 服务端路由 ------------------------------ */

/**
 * 解析控制器：`@Controller('base')` + `@Get('sub')` 等。
 * 兼容空参数形式（`@Get()`），此时子路径为空。
 */
function collectRoutes() {
  const routes = [];
  for (const file of walk(MODULES_DIR, (name) => name.endsWith('.controller.ts'))) {
    const src = readSafe(file);
    const controllerMatch = src.match(/@Controller\(\s*[`'"]([^`'" ]*)[`'"]/);
    const base = controllerMatch ? controllerMatch[1] : '';

    const routeRe = /@(Get|Post|Put|Patch|Delete)\(\s*([^)]*)\)/g;
    let match;
    while ((match = routeRe.exec(src)) !== null) {
      const method = match[1].toUpperCase();
      const rawArgs = match[2];
      const literal = /[`'"]([^`'" ]*)[`'"]/.exec(rawArgs);
      const sub = literal ? literal[1] : '';
      const full = normalizePath(`${base}/${sub}`);
      routes.push({
        method,
        path: full,
        file: path.relative(ROOT, file),
      });
    }
  }
  // 去重（同一路由可能在多个控制器注册）
  const seen = new Set();
  return routes.filter((route) => {
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ------------------------------ 测试调用点 ------------------------------ */

/**
 * 扫描测试源码中的 `.get('/path')` / `.post(...)` 等调用。
 * 只取字面量路径（模板字符串与 ${API}/... 也一并处理）。
 */
function collectTestCalls() {
  const calls = [];
  for (const file of walk(TEST_DIR, (name) => name.endsWith('.ts'))) {
    const src = readSafe(file);
    // .get(`...`) / .get('...') / .get(`${API}/x`)
    const callRe = /\.\s*(get|post|put|patch|delete)\(\s*[`'"]([^`'"]*)[`'"]/g;
    let match;
    while ((match = callRe.exec(src)) !== null) {
      calls.push({
        method: match[1].toUpperCase(),
        path: normalizeCallPath(match[2]),
        file: path.relative(ROOT, file),
      });
    }
  }
  return calls;
}

/* ------------------------------ 匹配 ------------------------------ */

function matches(routePath, callPath) {
  const routeParts = routePath.split('/').filter(Boolean);
  const callParts = callPath.split('/').filter(Boolean);
  if (routeParts.length !== callParts.length) return false;
  return routeParts.every((segment, index) => {
    if (segment.startsWith(':') || segment.includes('{')) return true;
    return segment === callParts[index];
  });
}

const routes = collectRoutes();
const calls = collectTestCalls();

const uncovered = [];
const covered = [];
for (const route of routes) {
  const hit = calls.some(
    (call) => call.method === route.method && matches(route.path, call.path),
  );
  if (hit) covered.push(route);
  else uncovered.push(route);
}

const uncoveredWrites = uncovered.filter((route) => WRITE_METHODS.has(route.method));

/* ------------------------------ 输出 ------------------------------ */

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        stats: {
          routes: routes.length,
          covered: covered.length,
          uncovered: uncovered.length,
          uncoveredWrites: uncoveredWrites.length,
        },
        uncovered,
      },
      null,
      2,
    ),
  );
} else {
  console.log('=== 端点 ←→ 集成测试 覆盖分析 ===');
  console.log(
    `服务端端点 ${routes.length} 条 / 测试调用点 ${calls.length} 处 / ` +
      `已覆盖 ${covered.length} 条 / 未覆盖 ${uncovered.length} 条（含写操作 ${uncoveredWrites.length} 条）`,
  );
  console.log('');

  if (uncoveredWrites.length > 0) {
    console.log(`-- 未覆盖的写操作端点 ${uncoveredWrites.length} 条（副作用最易回归，优先补测）--`);
    for (const route of uncoveredWrites) {
      console.log(`  [WRITE] ${route.method.padEnd(6)} ${route.path}`);
    }
    console.log('');
  }

  const uncoveredReads = uncovered.filter((route) => !WRITE_METHODS.has(route.method));
  if (uncoveredReads.length > 0) {
    console.log(`-- 未覆盖的读操作端点 ${uncoveredReads.length} 条 --`);
    for (const route of uncoveredReads) {
      console.log(`  [READ ] ${route.method.padEnd(6)} ${route.path}`);
    }
    console.log('');
  }

  if (uncovered.length === 0) {
    console.log('所有服务端端点均已被集成测试触达 ✅');
  }
}

process.exit(
  (FAIL_ON_WRITE && uncoveredWrites.length > 0) ||
    (FAIL_ON_UNCOVERED && uncovered.length > 0)
    ? 1
    : 0,
);
