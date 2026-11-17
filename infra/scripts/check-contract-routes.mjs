#!/usr/bin/env node
/**
 * 契约 ↔ 服务端路由 全量双向一致性校验。
 *
 * 背景：
 *   `packages/contracts/src/api.ts` 的 `ApiPaths` 是前后端唯一事实来源。
 *   此前已有两类校验：
 *     - `contract-routes.e2e-spec.ts`：契约路径是否存在（集成测试内，样本是部分键）
 *     - `check-client-paths.mjs`：两端客户端的**真实调用点**是否与服务端匹配
 *   但仍有一块空白：**契约里既没有客户端调用、服务端也没实现的路径键**，
 *   以及**服务端注册了、契约里却完全没有的路径**——两者都不会被上面任何机制发现。
 *   这类漂移的后果是：调用方照契约写代码，运行时 404。
 *
 * 本脚本做两件事：
 *   1. 契约声明的每个路径 → 服务端必须真实注册（否则 CONTRACT_ROUTE_MISSING）
 *   2. 服务端注册的每个业务路径 → 契约必须声明（否则 SERVER_ROUTE_NOT_IN_CONTRACT）
 *
 * 基础设施路径（/healthz 等）不参与第 2 项比对。
 *
 * 用法：
 *   node infra/scripts/check-contract-routes.mjs [--root <repo>] [--swagger <url>] [--json]
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
const SWAGGER_URL = argValue('--swagger', 'http://127.0.0.1:18081/docs-json');
const AS_JSON = args.includes('--json');

const CONTRACT_FILE = path.join(ROOT, 'packages/contracts/src/api.ts');

/** 基础设施路径：服务端注册但不属于业务契约，不参与反向比对 */
const INFRA_ROUTES = new Set(['/healthz', '/health', '/metrics', '/docs', '/docs-json']);

/** 归一化：去掉 /api/v1 前缀、去掉尾部斜杠、${id} → {id} */
function normalizePath(value) {
  let result = String(value ?? '').trim();
  result = result.replace(/^\/api\/v1/, '');
  // 归一化**所有** `${占位符}`（多参数路径如
  // `/admin/verifications/${id}/attachments/${mediaId}/url` 也要能对上服务端路由）
  result = result.replace(/\$\{\s*(\w+)\s*\}/g, '{$1}');
  result = result.replace(/^['"`]|['"`]$/g, '');
  result = result.split('?')[0];
  if (result.length > 1) result = result.replace(/\/+$/, '');
  return result === '' ? '/' : result;
}

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/* ------------------------------ 解析 ApiPaths ------------------------------ */

/**
 * 解析 `export const ApiPaths = { ... } as const;`
 * 返回 Map<key, template>，模板中的 ${id} 保持参数化（与服务端路由模板同口径）。
 */
function parseApiPaths(file) {
  const src = readFileSafe(file);
  if (!src) return null;
  const start = src.indexOf('export const ApiPaths');
  if (start < 0) return null;
  const end = src.indexOf('as const', start);
  const body = src.slice(start, end > 0 ? end : src.length);

  const map = new Map();

  // 函数型：key: (id: number) => `/users/${id}`
  const fnRe = /(\w+)\s*:\s*\([^)]*\)(?:\s*:\s*string)?\s*=>\s*`([^`]+)`/g;
  let match;
  while ((match = fnRe.exec(body)) !== null) {
    map.set(match[1], normalizePath(match[2]));
  }

  // 静态型：key: '/users'
  const staticRe = /(\w+)\s*:\s*'([^']*)'/g;
  while ((match = staticRe.exec(body)) !== null) {
    if (!map.has(match[1])) map.set(match[1], normalizePath(match[2]));
  }

  return map;
}

/* ------------------------------ 服务端路由表 ------------------------------ */

async function loadServerRoutes(swaggerUrl) {
  let document;
  if (/^https?:\/\//i.test(swaggerUrl)) {
    const response = await fetch(swaggerUrl);
    if (!response.ok) {
      throw new Error(`拉取 Swagger 失败：${response.status} ${response.statusText} (${swaggerUrl})`);
    }
    document = await response.json();
  } else {
    const raw = readFileSafe(path.resolve(swaggerUrl));
    if (!raw) throw new Error(`无法读取 Swagger 文件：${swaggerUrl}`);
    document = JSON.parse(raw);
  }

  /** @type {Map<string, Set<string>>} 归一化路径 → 方法集合 */
  const routes = new Map();
  for (const [rawPath, operations] of Object.entries(document.paths ?? {})) {
    const normalized = normalizePath(rawPath);
    const methods = new Set(
      Object.keys(operations ?? {}).filter((key) =>
        ['get', 'post', 'put', 'patch', 'delete'].includes(key.toLowerCase()),
      ),
    );
    routes.set(normalized, methods);
  }
  return routes;
}

/* ------------------------------ 主流程 ------------------------------ */

const errors = [];
const warnings = [];
const stats = {};

try {
  const contractPaths = parseApiPaths(CONTRACT_FILE);
  if (!contractPaths || contractPaths.size === 0) {
    throw new Error(`无法从 ${CONTRACT_FILE} 解析 ApiPaths`);
  }

  const serverRoutes = await loadServerRoutes(SWAGGER_URL);

  stats.contractKeys = contractPaths.size;
  stats.serverRoutes = serverRoutes.size;

  /* 1. 契约声明的路径必须被服务端注册 */
  const matched = new Set();
  for (const [key, template] of contractPaths) {
    if (serverRoutes.has(template)) {
      matched.add(template);
    } else {
      errors.push({
        kind: 'CONTRACT_ROUTE_MISSING',
        message: `契约 ApiPaths.${key} = ${template}，服务端没有注册这条路径`,
      });
    }
  }

  /* 2. 服务端注册的业务路径必须在契约里声明 */
  const contractTemplates = new Set(contractPaths.values());
  for (const [routePath] of serverRoutes) {
    if (INFRA_ROUTES.has(routePath)) continue;
    if (contractTemplates.has(routePath)) continue;
    errors.push({
      kind: 'SERVER_ROUTE_NOT_IN_CONTRACT',
      message: `服务端注册了 ${routePath}，但契约 ApiPaths 里没有这个路径`,
    });
  }

  stats.matched = matched.size;
  stats.infraRoutes = [...serverRoutes.keys()].filter((p) => INFRA_ROUTES.has(p)).length;
} catch (error) {
  errors.push({ kind: 'CHECK_FAILED', message: error.message });
}

/* ------------------------------ 输出 ------------------------------ */

if (AS_JSON) {
  console.log(JSON.stringify({ errors, warnings, stats }, null, 2));
} else {
  console.log('=== 契约 ↔ 服务端路由 一致性校验 ===');
  console.log(
    `契约 ApiPaths ${stats.contractKeys ?? 0} 键 / 服务端路由 ${stats.serverRoutes ?? 0} 条 / ` +
      `基础设施路径 ${stats.infraRoutes ?? 0} 条（不参与反向比对）`,
  );
  console.log('');

  if (errors.length === 0) {
    console.log('未发现契约与服务端之间的路径不一致问题。');
  } else {
    console.log(`-- 错误 ${errors.length} 条 --`);
    for (const item of errors) {
      console.log(`  [ERROR] ${item.kind} ${item.message}`);
    }
  }

  if (warnings.length > 0) {
    console.log(`-- 警告 ${warnings.length} 条 --`);
    for (const item of warnings) {
      console.log(`  [WARN] ${item.kind} ${item.message}`);
    }
  }
}

process.exit(errors.length > 0 ? 1 : 0);
