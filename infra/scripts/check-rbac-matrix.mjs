#!/usr/bin/env node
/**
 * RBAC 三方对账：契约 ⟷ 种子数据 ⟷ 前端硬编码矩阵 ⟷ 服务端端点实际要求。
 *
 * 背景：
 *   管理后台的「角色 × 权限矩阵」页面把角色与权限点的对应关系**硬编码**在
 *   `apps/admin-web/src/stores/auth.ts` 里（小程序/管理端不能运行时读工作区包），
 *   而服务端真正生效的是 `role_permissions` 表 —— 两者都是「事实来源」，
 *   任何一处不同步，服务端按表放行、前端按代码显示，管理员看到的矩阵就是错的。
 *
 *   更危险的是「**没有任何角色被授予**某个权限」：
 *   端点上写着 `@RequirePermissions('x')`，但没有一个角色带 'x' ——
 *   那么这个端点对**所有管理员**都不可达，功能等于不存在，且没有任何报错提示。
 *
 * 本脚本对账 6 件事：
 *   1. 权限点集合：契约 `AdminPermission` 联合 ≡ 种子 `PERMISSION_FIXTURES`；
 *   2. 角色集合：契约 `AdminRole` 联合 ≡ 种子角色 ≡ 前端 ROLE_PERMISSIONS 的键；
 *   3. 角色↔权限矩阵：种子 `ROLE_FIXTURES` ≡ 前端 `ROLE_PERMISSIONS`；
 *   4. 服务端端点引用的权限点必须在权限集合里（否则拼写错误 = 端点对所有人关闭）；
 *   5. 每个权限点至少被一个角色授予（否则有端点不可达）；
 *   6. 每个 `/admin` 端点都必须有 `@RequirePermissions`（否则任何管理员都能调用）。
 *
 * 用法：node infra/scripts/check-rbac-matrix.mjs [--root <repo>] [--json]
 * 退出码：0 = 一致；1 = 存在不一致。
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

/** 取 `export type X = 'a' | 'b' | ...;` 的字面量联合 */
function parseUnion(src, name) {
  const match = new RegExp(`export\\s+type\\s+${name}\\s*=\\s*([^;]+);`).exec(src);
  if (!match) return [];
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** 取 `export const NAME: Record<...> = { key: [...] }` 的键与数组 */
function parseRecordOfArrays(src, name) {
  const start = src.indexOf(`export const ${name}`);
  if (start < 0) return new Map();
  const open = src.indexOf('{', start);
  if (open < 0) return new Map();
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = src.slice(open + 1, end > 0 ? end : src.length);
  const result = new Map();
  const re = /(\w+)\s*:\s*\[([^\]]*)\]/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    result.set(match[1], [...match[2].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  }
  return result;
}

/** 取种子里的 `PERMISSION_FIXTURES` / `ROLE_FIXTURES` */
function parseSeed(src) {
  const permissions = [];
  const permBlock = /PERMISSION_FIXTURES\s*=\s*\[([\s\S]*?)\n\]/.exec(src);
  if (permBlock) {
    for (const m of permBlock[1].matchAll(/code:\s*'([^']+)'/g)) permissions.push(m[1]);
  }

  const roles = new Map();
  const roleBlock = /ROLE_FIXTURES\s*=\s*\[([\s\S]*?)\n\] as const;/.exec(src);
  if (roleBlock) {
    const body = roleBlock[1];
    const re = /code:\s*'([^']+)'[\s\S]*?permissions:\s*(\[[^\]]*\]|PERMISSION_FIXTURES\.map\([^)]*\))/g;
    let match;
    while ((match = re.exec(body)) !== null) {
      const codes = [...match[2].matchAll(/'([^']+)'/g)].map((m) => m[1]);
      roles.set(match[1], codes);
    }
    // super_admin 用的是 PERMISSION_FIXTURES.map(...) → 展开成全部权限
    if (roles.has('super_admin') && roles.get('super_admin').length === 0) {
      roles.set('super_admin', permissions);
    }
  }
  return { permissions, roles };
}

/**
 * 扫描服务端控制器：端点 → 所需权限。
 *
 * ⚠️ **按行扫描**、且把路由装饰器**上下**紧邻的装饰器块**一起**看：
 *   `@RequirePermissions()` 与 `@Public()` 相对路由装饰器的**先后顺序不固定** ——
 *   `admin.controller.ts` 是「权限点在后」，`admin-ops.controller.ts` 是「权限点在前」。
 *   只扫一侧的话，`admin-ops.controller.ts` 那个端点会被判成
 *   「没有 @RequirePermissions」——而它其实有（误报）；
 *   反过来，只按固定顺序扫也可能**漏掉**真的没写权限点的端点（漏报）。
 *   两种错法都会让「管理端端点必须声明权限点」这条判定失去意义。
 *
 * ⚠️ 对外路径一律**带前导斜杠**（`/admin/alumni`）：
 *   控制器前缀写的是 `admin`（**没有**斜杠），直接拼出来的是 `admin/alumni` ——
 *   拿它去和 `/admin` 比会**永远不相等**，
 *   规则 6（每个管理端端点都必须有 @RequirePermissions）就成了一条**恒过**的判定。
 */
function parseControllers(files) {
  const endpoints = [];
  for (const file of files) {
    const src = readFileSafe(file);
    if (!src) continue;
    const relative = path.relative(ROOT, file);
    const lines = src.split('\n');

    // 控制器前缀
    const prefixes = [];
    for (const line of lines) {
      const matched = /@Controller\(([^)]*)\)/.exec(line);
      if (matched) prefixes.push(matched[1].replace(/['"`]/g, '').trim());
    }
    const prefix = prefixes[0] ?? '';

    for (let index = 0; index < lines.length; index += 1) {
      // ⚠️ 路径可以**省略**（`@Get()` = 控制器前缀本身）。
      const matched = /^\s*@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/.exec(lines[index]);
      if (!matched) continue;
      const method = matched[1].toUpperCase();
      const rawPath = (matched[2] ?? '').trim();

      // 路由装饰器**上下**紧邻的装饰器块（注释行跳过，空行是分界）。
      const decorators = [];
      for (let j = index - 1; j >= 0; j -= 1) {
        const text = lines[j].trim();
        if (text.startsWith('@')) decorators.unshift(text);
        else if (text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')) continue;
        else break;
      }
      for (let j = index + 1; j < lines.length; j += 1) {
        const text = lines[j].trim();
        if (text.startsWith('@')) decorators.push(text);
        else if (text === '' || text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')) {
          continue;
        } else break;
      }

      const permissions = [];
      for (const decorator of decorators) {
        const permMatch = /@RequirePermissions\(([^)]*)\)/.exec(decorator);
        if (!permMatch) continue;
        for (const code of permMatch[1].matchAll(/'([^']+)'/g)) permissions.push(code[1]);
      }
      const isPublic = decorators.some((item) => /@Public\(\)/.test(item));

      let fullPath = prefix;
      if (rawPath && rawPath !== '') fullPath = `${prefix}/${rawPath}`;
      fullPath = fullPath.replace(/\/+$/, '') || '/';
      if (!fullPath.startsWith('/')) fullPath = `/${fullPath}`;
      endpoints.push({
        method,
        path: fullPath,
        permissions,
        isPublic,
        file: relative,
        line: index + 1,
      });
    }
  }
  return endpoints;
}

function diff(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    onlyA: [...setA].filter((x) => !setB.has(x)),
    onlyB: [...setB].filter((x) => !setA.has(x)),
  };
}

function main() {
  const contractSrc = readFileSafe(path.join(ROOT, 'packages/contracts/src/domain.ts')) ?? '';
  const seedSrc = readFileSafe(path.join(ROOT, 'apps/api/src/database/seeds/seed.ts')) ?? '';
  const authStoreSrc = readFileSafe(path.join(ROOT, 'apps/admin-web/src/stores/auth.ts')) ?? '';

  const contractPermissions = parseUnion(contractSrc, 'AdminPermission');
  const contractRoles = parseUnion(contractSrc, 'AdminRole');
  const seed = parseSeed(seedSrc);
  const frontendMatrix = parseRecordOfArrays(authStoreSrc, 'ROLE_PERMISSIONS');
  const endpoints = parseControllers(walk(path.join(ROOT, 'apps/api/src')));

  const issues = [];

  // 1) 权限点集合
  const permDiff = diff(contractPermissions, seed.permissions);
  if (permDiff.onlyA.length || permDiff.onlyB.length) {
    issues.push({
      kind: 'PERMISSION_SET_DRIFT',
      message: `权限点集合不一致：契约独有 ${permDiff.onlyA.join(', ') || '无'}；种子独有 ${permDiff.onlyB.join(', ') || '无'}`,
    });
  }

  // 2) 角色集合
  const roleDiff = diff(contractRoles, [...seed.roles.keys()]);
  if (roleDiff.onlyA.length || roleDiff.onlyB.length) {
    issues.push({
      kind: 'ROLE_SET_DRIFT',
      message: `角色集合不一致：契约独有 ${roleDiff.onlyA.join(', ') || '无'}；种子独有 ${roleDiff.onlyB.join(', ') || '无'}`,
    });
  }
  const frontRoleDiff = diff([...seed.roles.keys()], [...frontendMatrix.keys()]);
  if (frontRoleDiff.onlyA.length || frontRoleDiff.onlyB.length) {
    issues.push({
      kind: 'FRONTEND_ROLE_SET_DRIFT',
      message: `前端矩阵角色与种子不一致：种子独有 ${frontRoleDiff.onlyA.join(', ') || '无'}；前端独有 ${frontRoleDiff.onlyB.join(', ') || '无'}`,
    });
  }

  // 3) 角色 ↔ 权限矩阵
  for (const [role, seedPerms] of seed.roles) {
    const frontPerms = frontendMatrix.get(role);
    if (!frontPerms) continue;
    const d = diff(seedPerms, frontPerms);
    if (d.onlyA.length || d.onlyB.length) {
      issues.push({
        kind: 'ROLE_MATRIX_DRIFT',
        message: `角色 ${role} 的权限矩阵不一致：种子独有 ${d.onlyA.join(', ') || '无'}；前端独有 ${d.onlyB.join(', ') || '无'}`,
      });
    }
  }

  // 4) 服务端引用的权限点必须在集合里
  const known = new Set(seed.permissions);
  const usedPermissions = new Set();
  for (const endpoint of endpoints) {
    for (const permission of endpoint.permissions) {
      usedPermissions.add(permission);
      if (!known.has(permission)) {
        issues.push({
          kind: 'UNKNOWN_PERMISSION',
          message: `端点 ${endpoint.method} ${endpoint.path} 要求权限 '${permission}'，但它不在权限点集合里（拼写错误？该端点对所有管理员都不可达）`,
          file: endpoint.file,
          line: endpoint.line,
        });
      }
    }
  }

  // 5) 每个权限点至少被一个角色授予
  for (const permission of seed.permissions) {
    const granted = [...seed.roles.values()].some((perms) => perms.includes(permission));
    if (!granted) {
      issues.push({
        kind: 'PERMISSION_NOT_GRANTED',
        message: `权限点 '${permission}' 没有任何角色被授予（若有端点要求它，该端点对所有管理员都不可达）`,
      });
    }
  }

  // 6) 管理端端点必须有权限校验
  for (const endpoint of endpoints) {
    if (!endpoint.path.startsWith('/admin')) continue;
    if (endpoint.isPublic) {
      issues.push({
        kind: 'ADMIN_ENDPOINT_PUBLIC',
        message: `管理端端点 ${endpoint.method} ${endpoint.path} 标了 @Public()（不应公开）`,
        file: endpoint.file,
        line: endpoint.line,
      });
      continue;
    }
    if (endpoint.permissions.length === 0) {
      issues.push({
        kind: 'ADMIN_ENDPOINT_NO_PERMISSION',
        message: `管理端端点 ${endpoint.method} ${endpoint.path} 没有 @RequirePermissions（任何管理员都能调用）`,
        file: endpoint.file,
        line: endpoint.line,
      });
    }
  }

  // 提示：被授予角色、却没有任何端点引用的权限点（悬空能力）
  const unusedPermissions = seed.permissions.filter((permission) => !usedPermissions.has(permission));

  const summary = {
    adminEndpoints: endpoints
      .filter((endpoint) => endpoint.path.startsWith('/admin'))
      .map((endpoint) => ({
        method: endpoint.method,
        path: endpoint.path,
        permissions: endpoint.permissions,
      }))
      .sort((left, right) =>
        left.path === right.path
          ? left.method.localeCompare(right.method)
          : left.path.localeCompare(right.path),
      ),
    permissions: seed.permissions.length,
    roles: seed.roles.size,
    endpointsScanned: endpoints.length,
    permissionsUsed: usedPermissions.size,
    unusedPermissions,
    issues: issues.length,
    detail: issues,
  };

  if (AS_JSON) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('=== RBAC 三方对账（契约 ⟷ 种子 ⟷ 前端矩阵 ⟷ 服务端端点）===');
    for (const item of issues) {
      console.log(`  ✗ [${item.kind}] ${item.message}`);
      if (item.file) console.log(`      ${item.file}:${item.line}`);
    }
    console.log(
      `权限点 ${summary.permissions} 个 / 角色 ${summary.roles} 个 / 服务端端点 ${summary.endpointsScanned} 条，实际用到权限点 ${summary.permissionsUsed} 个：不一致 ${issues.length}`,
    );
    if (unusedPermissions.length) {
      console.log(
        `  注：以下权限点已授予角色但没有任何端点引用（悬空能力，详见 KNOWN-ISSUES #71）：${unusedPermissions.join(', ')}`,
      );
    }
  }

  process.exit(issues.length ? 1 : 0);
}

main();
