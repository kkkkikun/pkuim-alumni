#!/usr/bin/env node
/**
 * 需求覆盖矩阵校验。
 *
 * 背景：`docs/top.md` 是需求基线，但基线里的「页面体系」「API 分组」此前只存在于文档里，
 * 没有任何机制保证它们真的被实现。实际发生过一次：服务端与契约都有通知接口，
 * 小程序却**一个通知页面都没有**，而需求清单里明确写着「完成通知中心」。
 *
 * 本脚本把需求基线落成可校验的矩阵（`docs/SPEC-COVERAGE.json`），并校验：
 *   1. 矩阵里的每个小程序页面都真实存在（app.json 注册 + .ts + .wxml）；
 *   2. app.json 里没有「矩阵未覆盖」的孤儿页面（防止加了页面却没登记需求出处）；
 *   3. 矩阵里的每个管理后台视图文件都存在，且被路由引用；
 *   4. `top.md` §4.3 要求的每个 API 分组在服务端**至少注册了一条路由**
 *      （路由表来自运行中 API 的 Swagger 文档）。
 *
 * 用法：
 *   node infra/scripts/check-spec-coverage.mjs [--root <repo>] [--swagger <url>] [--json]
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
    '用法: node infra/scripts/check-spec-coverage.mjs [--root <repo>] [--swagger <url>] [--json]',
  );
  process.exit(0);
}

const ROOT = path.resolve(args.root);
const MINI_DIR = path.join(ROOT, 'apps/miniprogram/src');
const ADMIN_DIR = path.join(ROOT, 'apps/admin-web/src');
const errors = [];
const warnings = [];
const stats = {};

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/* ---------------- 需求矩阵 ---------------- */

const matrixFile = path.join(ROOT, 'docs/SPEC-COVERAGE.json');
const matrixRaw = readFileSafe(matrixFile);
if (!matrixRaw) {
  console.error('找不到 docs/SPEC-COVERAGE.json');
  process.exit(2);
}
let matrix;
try {
  matrix = JSON.parse(matrixRaw);
} catch (error) {
  console.error(`docs/SPEC-COVERAGE.json 解析失败：${error.message}`);
  process.exit(2);
}

/* ---------------- 1/2. 小程序页面 ---------------- */

const appJson = JSON.parse(readFileSafe(path.join(MINI_DIR, 'app.json')) ?? '{}');
const registeredPages = new Set((appJson.pages ?? []).map((p) => p.replace(/^\//, '')));

const coveredPages = new Set();
for (const row of matrix.miniprogramPages ?? []) {
  const page = (row.page ?? '').replace(/^\//, '');
  if (!page) {
    errors.push({ kind: 'MATRIX_ROW_INVALID', message: `矩阵行缺少 page：${row.requirement}` });
    continue;
  }
  coveredPages.add(page);
  if (!registeredPages.has(page)) {
    errors.push({
      kind: 'PAGE_NOT_REGISTERED',
      message: `需求「${row.section} · ${row.requirement}」对应的页面 ${page} 未在 app.json 注册`,
    });
    continue;
  }
  for (const ext of ['ts', 'wxml']) {
    const file = path.join(MINI_DIR, `${page}.${ext}`);
    if (!fs.existsSync(file)) {
      errors.push({
        kind: 'PAGE_FILE_MISSING',
        message: `需求「${row.requirement}」对应的页面缺少 .${ext} 文件：${page}`,
      });
    }
  }
}

for (const page of registeredPages) {
  if (!coveredPages.has(page)) {
    errors.push({
      kind: 'PAGE_NOT_IN_MATRIX',
      message: `页面 ${page} 已注册但需求矩阵未覆盖（新增页面要同步登记需求出处）`,
    });
  }
}

/* ---------------- 3. 管理后台视图 ---------------- */

const routerSrc = readFileSafe(path.join(ADMIN_DIR, 'router/index.ts')) ?? '';
const routedComponents = new Set(
  [...routerSrc.matchAll(/import\('([^']+)'\)/g)].map((m) => m[1]),
);

for (const row of matrix.adminViews ?? []) {
  const view = row.view ?? '';
  const file = path.join(ADMIN_DIR, view);
  if (!fs.existsSync(file)) {
    errors.push({
      kind: 'ADMIN_VIEW_MISSING',
      message: `需求「${row.requirement}」对应的视图不存在：${view}`,
    });
    continue;
  }
  const alias = `@/${view}`;
  if (!routedComponents.has(alias)) {
    errors.push({
      kind: 'ADMIN_VIEW_NOT_ROUTED',
      message: `需求「${row.requirement}」的视图 ${view} 未被路由引用`,
    });
  }
}

/* ---------------- 4. API 分组 ---------------- */

async function loadRoutes(swaggerUrl) {
  const raw = readFileSafe(path.resolve(swaggerUrl));
  if (raw) return new Set(Object.keys(JSON.parse(raw).paths ?? {}));
  const response = await fetch(swaggerUrl);
  if (!response.ok) {
    throw new Error(`拉取 Swagger 失败：${response.status} ${response.statusText}`);
  }
  const document = await response.json();
  return new Set(Object.keys(document.paths ?? {}));
}

let routePaths = new Set();
try {
  routePaths = await loadRoutes(args.swagger);
} catch (error) {
  errors.push({ kind: 'SWAGGER_UNAVAILABLE', message: error.message });
}

for (const row of matrix.apiGroups ?? []) {
  const prefix = (row.path ?? '').replace(/\/$/, '');
  const matched = [...routePaths].some((p) => {
    const normalized = p.replace(/^\/api\/v1/, '');
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
  if (!matched) {
    errors.push({
      kind: 'API_GROUP_NOT_IMPLEMENTED',
      message: `需求「${row.requirement}」要求的接口分组 ${prefix} 在服务端没有任何路由`,
    });
  }
}

/* ---------------- 统计 ---------------- */

stats.miniprogramPages = matrix.miniprogramPages?.length ?? 0;
stats.registeredPages = registeredPages.size;
stats.adminViews = matrix.adminViews?.length ?? 0;
stats.apiGroups = matrix.apiGroups?.length ?? 0;
stats.serverRoutes = routePaths.size;

if (args.json) {
  console.log(JSON.stringify({ stats, errors, warnings }, null, 2));
} else {
  console.log('=== 需求覆盖矩阵校验 ===');
  console.log(
    `需求条目：页面 ${stats.miniprogramPages} 条（已注册页面 ${stats.registeredPages} 个）/ 后台视图 ${stats.adminViews} 个 / API 分组 ${stats.apiGroups} 个 · 服务端路由 ${stats.serverRoutes} 条`,
  );
  if (warnings.length) {
    console.log(`\n-- 警告 ${warnings.length} 条 --`);
    for (const item of warnings) console.log(`  [WARN] ${item.kind} ${item.message}`);
  }
  if (errors.length) {
    console.log(`\n-- 错误 ${errors.length} 条 --`);
    for (const item of errors) console.log(`  [ERROR] ${item.kind} ${item.message}`);
  } else {
    console.log('\n需求基线与实现一致。');
  }
}

process.exit(errors.length ? 1 : 0);
