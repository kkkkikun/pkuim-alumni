#!/usr/bin/env node
/**
 * 管理后台静态校验器。
 *
 * 与小程序静态校验器同源的目标：把「编译期查不出来、运行时才白屏/报错」的缺陷挡在 CI 之前。
 *
 * 校验内容：
 *  1. 路由表里 `component: () => import('@/views/X.vue')` 指向的文件必须存在；
 *  2. `src/views` 下每个 .vue 必须被路由引用（否则是死页面，或漏注册）；
 *  3. 路由 `meta.requiredPermission` 必须是契约里声明的权限点（拼错的权限点会
 *     导致该页面**永远**被 `requiredPermission` 守卫拦下）；
 *  4. 菜单表（utils/menu.ts）里出现的路由名必须在路由表中存在；
 *  5. 组件内 `router.push({ name: 'xxx' })` 的 name 必须在路由表中存在。
 *
 * 用法：
 *   node infra/scripts/check-admin-web.mjs [--root <repo>] [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const args = { root: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--root') args.root = argv[++i];
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('用法: node infra/scripts/check-admin-web.mjs [--root <repo>] [--json]');
  process.exit(0);
}

const ROOT = path.resolve(args.root);
const APP_DIR = path.join(ROOT, 'apps/admin-web/src');
const errors = [];
const warnings = [];
const stats = {};

const rel = (file) => path.relative(ROOT, file);

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function walk(dir, filter, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}

/* ---------------- 1. 路由表 ---------------- */

const routerFile = path.join(APP_DIR, 'router/index.ts');
const routerSrc = readFileSafe(routerFile);
if (!routerSrc) {
  console.error('找不到 apps/admin-web/src/router/index.ts');
  process.exit(2);
}

/**
 * 路由表解析：分别收集「组件 / 名称 / 路径 / 权限点」。
 * 不做对象级配对 —— 各项校验只关心集合成员是否存在，配对反而容易因嵌套 children 解析错。
 */
const collect = (re, text) => {
  const out = new Set();
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return out;
};

const referencedComponents = collect(/import\('([^']+)'\)/g, routerSrc);
const routeNames = collect(/name:\s*'([^']+)'/g, routerSrc);
const routePaths = collect(/path:\s*'([^']+)'/g, routerSrc);
const routePermissions = collect(/requiredPermission:\s*'([^']+)'/g, routerSrc);

for (const component of referencedComponents) {
  const resolved = path.resolve(APP_DIR, component.replace(/^@\//, ''));
  if (!fs.existsSync(resolved)) {
    errors.push({
      kind: 'ROUTE_COMPONENT_MISSING',
      message: `路由引用了不存在的组件 ${component}`,
      file: rel(routerFile),
    });
  }
}

/* ---------------- 2. 视图文件是否都被引用 ---------------- */

const viewFiles = walk(path.join(APP_DIR, 'views'), (n) => n.endsWith('.vue'));
for (const file of viewFiles) {
  const alias = `@/${path.relative(APP_DIR, file).replace(/\\/g, '/')}`;
  if (!referencedComponents.has(alias)) {
    warnings.push({
      kind: 'VIEW_NOT_ROUTED',
      message: `视图 ${alias} 未被路由表引用（死页面或漏注册）`,
      file: rel(file),
    });
  }
}

/* ---------------- 3. 权限点必须是契约里声明的 ---------------- */

const contractsFile = path.join(ROOT, 'packages/contracts/src/domain.ts');
const contractsSrc = readFileSafe(contractsFile) ?? '';
// 契约把权限点定义成联合类型：export type AdminPermission = | 'dashboard:view' | ...
const permissionTypeMatch = /export type AdminPermission\s*=\s*([\s\S]*?);/.exec(contractsSrc);
const contractPermissions = new Set(
  permissionTypeMatch
    ? [...permissionTypeMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    : [],
);
if (contractPermissions.size) {
  for (const permission of routePermissions) {
    if (!contractPermissions.has(permission)) {
      errors.push({
        kind: 'PERMISSION_NOT_IN_CONTRACT',
        message: `路由声明的权限点 ${permission} 不在契约 AdminPermission 中`,
        file: rel(routerFile),
      });
    }
  }
} else {
  warnings.push({
    kind: 'PERMISSION_CHECK_SKIPPED',
    message: '未能在契约包中找到权限点清单，跳过权限点校验',
  });
}

/* ---------------- 4. 菜单表里的路由名必须存在 ---------------- */

const menuFile = path.join(APP_DIR, 'utils/menu.ts');
const menuSrc = readFileSafe(menuFile);
if (menuSrc) {
  const menuRouteRe = /route:\s*'([^']+)'/g;
  let menuMatch;
  while ((menuMatch = menuRouteRe.exec(menuSrc)) !== null) {
    const target = menuMatch[1].replace(/^\//, '');
    const known = [...routePaths].some((p) => p.replace(/^\//, '') === target);
    if (!known) {
      errors.push({
        kind: 'MENU_ROUTE_MISSING',
        message: `菜单指向 ${menuMatch[1]}，但路由表中没有该路径`,
        file: rel(menuFile),
      });
    }
  }
}

/* ---------------- 5. router.push 的 name 必须存在 ---------------- */

let namePushCount = 0;
for (const file of walk(APP_DIR, (n) => n.endsWith('.ts') || n.endsWith('.vue'))) {
  const source = readFileSafe(file);
  if (!source) continue;
  const pushRe = /(?:router|router_?)\s*\.push\s*\(\s*\{[^}]*?name:\s*'([^']+)'/g;
  let pushMatch;
  while ((pushMatch = pushRe.exec(source)) !== null) {
    namePushCount += 1;
    if (!routeNames.has(pushMatch[1])) {
      errors.push({
        kind: 'PUSH_NAME_MISSING',
        message: `跳转使用了不存在的路由名 ${pushMatch[1]}`,
        file: rel(file),
      });
    }
  }
}

/* ---------------- 6. router.push('/path') 的路径必须存在 ---------------- */

/** 路由表里的相对子路径（'events'）需要补成绝对路径（'/events'） */
const absoluteRoutePaths = new Set(
  [...routePaths].map((p) => (p.startsWith('/') ? p : `/${p}`)),
);
const hasCatchAll = [...absoluteRoutePaths].some((p) => p.includes(':pathMatch'));
// 通配路由不参与匹配，否则任何路径都会被它「匹配上」，拼写错误就查不出来了
const concreteRoutePaths = [...absoluteRoutePaths].filter((p) => !p.includes(':pathMatch'));

/** 结构匹配：路由段是 :param 时视为通配 */
function pathMatches(routePath, literal) {
  const r = routePath.split('/').filter(Boolean);
  const l = literal.split('/').filter(Boolean);
  if (r.length !== l.length) return false;
  return r.every((seg, i) => seg.startsWith(':') || seg === l[i]);
}

const pushPathRe = /(?:router|router_?)\.(?:push|replace)\s*\(\s*['"`]([^'"`]+)['"`]/g;
let pushPathCount = 0;
for (const file of walk(APP_DIR, (n) => n.endsWith('.ts') || n.endsWith('.vue'))) {
  const source = readFileSafe(file);
  if (!source) continue;
  let m;
  pushPathRe.lastIndex = 0;
  while ((m = pushPathRe.exec(source)) !== null) {
    pushPathCount += 1;
    const literal = m[1].split('?')[0].replace(/\$\{[^}]*\}/g, ':param');
    const matched = concreteRoutePaths.some((route) => pathMatches(route, literal));
    if (!matched) {
      const record = {
        kind: 'PUSH_PATH_MISSING',
        message: `跳转路径 ${m[1]} 没有对应的路由`,
        file: rel(file),
      };
      if (hasCatchAll) warnings.push(record);
      else errors.push(record);
    }
  }
}
stats.pathPushes = pushPathCount;

stats.routes = routePaths.size;
stats.views = viewFiles.length;
stats.namedPushes = namePushCount;
stats.contractPermissions = contractPermissions.size;

if (args.json) {
  console.log(JSON.stringify({ stats, errors, warnings }, null, 2));
} else {
  console.log('=== 管理后台静态校验 ===');
  console.log(
    `路由 ${stats.routes} 条 / 视图 ${stats.views} 个 / 具名跳转 ${stats.namedPushes} 处 / 路径跳转 ${stats.pathPushes} 处 / 契约权限点 ${stats.contractPermissions} 个`,
  );
  if (warnings.length) {
    console.log(`\n-- 警告 ${warnings.length} 条 --`);
    for (const item of warnings) console.log(`  [WARN] ${item.kind} ${item.message}`);
  }
  if (errors.length) {
    console.log(`\n-- 错误 ${errors.length} 条 --`);
    for (const item of errors) console.log(`  [ERROR] ${item.kind} ${item.message}`);
  } else {
    console.log('\n未发现静态一致性问题。');
  }
}

process.exit(errors.length ? 1 : 0);
