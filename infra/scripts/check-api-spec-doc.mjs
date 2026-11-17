#!/usr/bin/env node
/**
 * API-SPEC 文档 ↔ 服务端实现 一致性校验。
 *
 * 背景：`docs/API-SPEC.md` 是对外的接口说明书，`packages/contracts` 是前后端契约，
 * 三者必须与服务端真实路由一致。此前只有「契约路径是否存在」被测试覆盖，
 * **文档里写了但服务端没有的端点**（以及反过来的）没有任何机制能发现 ——
 * 上一轮就手工发现过一处：API-SPEC 写着 `GET /resources/:id/reviews`，服务端根本没有这个端点。
 *
 * 本脚本解析 API-SPEC 的接口表，还原出每个 (方法, 路径)，与运行中 API 的 Swagger 比对：
 *   - 文档写了但服务端没注册 → DOC_ENDPOINT_MISSING
 *   - 服务端注册了但文档没写 → DOC_ENDPOINT_UNDOCUMENTED
 *
 * 用法：
 *   node infra/scripts/check-api-spec-doc.mjs [--root <repo>] [--swagger <url>] [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    swagger: 'http://127.0.0.1:18081/docs-json',
    json: false,
  };
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
    '用法: node infra/scripts/check-api-spec-doc.mjs [--root <repo>] [--swagger <url>] [--json]',
  );
  process.exit(0);
}

const ROOT = path.resolve(args.root);
const errors = [];
const warnings = [];
const stats = {};

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/* ---------------- 规范化 ---------------- */

/** 把 `/connections/:id` 与 `/connections/{id}` 统一成 `/connections/{}` */
function canonical(raw) {
  return String(raw)
    .trim()
    .replace(/^\/api\/v1/, '')
    .split('?')[0]
    .replace(/\{[^}]+\}/g, '{}')
    .replace(/:[A-Za-z0-9_]+/g, '{}')
    .replace(/\/+$/, '');
}

/* ---------------- 解析 API-SPEC ---------------- */

const specFile = path.join(ROOT, 'docs/API-SPEC.md');
const specRaw = fs.readFileSync(specFile, 'utf8');
const specLines = specRaw.split('\n');

/** 文档里声明的 (方法, 路径) 集合 */
const documented = new Set();

for (const line of specLines) {
  if (!line.trim().startsWith('|')) continue;
  const cells = line.split('|').map((c) => c.trim());
  if (cells.length < 3) continue;
  const methodCell = cells[1];
  const pathCell = cells[2];
  // 表头与分隔行跳过
  if (!HTTP_METHODS.some((m) => methodCell.includes(m))) continue;
  if (!pathCell.includes('`')) continue;

  const cellMethods = methodCell
    .split('/')
    .map((m) => m.trim().toUpperCase())
    .filter((m) => HTTP_METHODS.includes(m));

  // 路径单元格里可能有多段，用「、」分隔；每段可能自带方法前缀
  const segments = pathCell.split('、');
  for (const segment of segments) {
    const paths = [...segment.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    for (const rawPath of paths) {
      const prefix = segment.slice(0, segment.indexOf('`'));
      const inlineMethods = prefix
        .split('/')
        .map((m) => m.trim().toUpperCase())
        .filter((m) => HTTP_METHODS.includes(m));
      const methods = inlineMethods.length ? inlineMethods : cellMethods;
      if (!methods.length) continue;

      // `/admin/events[/:id]` → 基础路径 + 带 id 的路径
      // REST 约定：GET/POST 作用于集合，PUT/PATCH/DELETE 作用于单项
      const variants = [];
      const optional = rawPath.match(/^(.*)\[\/([^[\]]+)\]$/);
      if (optional) {
        const collection = optional[1];
        const item = `${optional[1]}/${optional[2]}`;
        for (const method of methods) {
          if (method === 'GET' || method === 'POST') variants.push({ method, path: collection });
          else variants.push({ method, path: item });
        }
      } else {
        for (const method of methods) variants.push({ method, path: rawPath });
      }

      for (const variant of variants) {
        documented.add(`${variant.method} ${canonical(variant.path)}`);
      }
    }
  }
}

/* ---------------- 服务端路由 ---------------- */

async function loadServerRoutes(swaggerUrl) {
  const raw = fs.existsSync(path.resolve(swaggerUrl))
    ? fs.readFileSync(path.resolve(swaggerUrl), 'utf8')
    : null;
  const document = raw
    ? JSON.parse(raw)
    : await (async () => {
        const response = await fetch(swaggerUrl);
        if (!response.ok) {
          throw new Error(`拉取 Swagger 失败：${response.status} ${response.statusText}`);
        }
        return response.json();
      })();

  const routes = new Map();
  for (const [rawPath, operations] of Object.entries(document.paths ?? {})) {
    const key = canonical(rawPath);
    const methods = Object.keys(operations ?? {}).filter((m) =>
      HTTP_METHODS.includes(m.toUpperCase()),
    );
    routes.set(key, new Set(methods.map((m) => m.toUpperCase())));
  }
  return routes;
}

let serverRoutes = new Map();
try {
  serverRoutes = await loadServerRoutes(args.swagger);
} catch (error) {
  errors.push({ kind: 'SWAGGER_UNAVAILABLE', message: error.message });
}

/* ---------------- 比对 ---------------- */

/** 文档声明 → 服务端 */
for (const entry of documented) {
  const [method, routePath] = entry.split(' ');
  const methods = serverRoutes.get(routePath);
  if (!methods) {
    errors.push({
      kind: 'DOC_ENDPOINT_MISSING',
      message: `API-SPEC 写了 ${method} ${routePath}，但服务端没有这条路由`,
    });
    continue;
  }
  if (!methods.has(method)) {
    errors.push({
      kind: 'DOC_METHOD_MISSING',
      message: `API-SPEC 写了 ${method} ${routePath}，但服务端该路径只注册了 ${[...methods].join('/')}`,
    });
  }
}

/**
 * 服务端 → 文档。
 * 排除纯运维端点（健康检查）与 Swagger 自身，它们不属于业务接口说明书。
 */
const IGNORED_ROUTES = new Set(['/healthz', '/docs-json', '/docs']);

for (const [routePath, methods] of serverRoutes) {
  if (IGNORED_ROUTES.has(routePath)) continue;
  for (const method of methods) {
    if (!documented.has(`${method} ${routePath}`)) {
      warnings.push({
        kind: 'DOC_ENDPOINT_UNDOCUMENTED',
        message: `服务端注册了 ${method} ${routePath}，但 API-SPEC 没有写`,
      });
    }
  }
}

stats.documented = documented.size;
stats.serverRoutes = serverRoutes.size;

if (args.json) {
  console.log(JSON.stringify({ stats, errors, warnings }, null, 2));
} else {
  console.log('=== API-SPEC 文档 ↔ 服务端路由 一致性校验 ===');
  console.log(`文档声明 ${stats.documented} 条 / 服务端路由 ${stats.serverRoutes} 条`);
  if (warnings.length) {
    console.log(`\n-- 警告 ${warnings.length} 条 --`);
    for (const item of warnings) console.log(`  [WARN] ${item.kind} ${item.message}`);
  }
  if (errors.length) {
    console.log(`\n-- 错误 ${errors.length} 条 --`);
    for (const item of errors) console.log(`  [ERROR] ${item.kind} ${item.message}`);
  } else {
    console.log('\n文档与实现一致。');
  }
}

process.exit(errors.length ? 1 : 0);
