#!/usr/bin/env node
/**
 * 错误码对账：契约 `ErrorCode` ⟷ 服务端 `ResponseCode` ⟷ 服务端实际引用。
 *
 * 背景（缺陷 #103 / #109 / #110 的共同根因）：
 *   契约（packages/contracts/src/common.ts）是「客户端按什么判断」的**唯一事实来源**。
 *   契约里声明的错误码，只要服务端**从不返回**，它就是**死码** ——
 *   客户端按契约写的判断分支永远走不到，而且**没有任何报错**：
 *     - #103 `IDEMPOTENCY_CONFLICT`：幂等冲突实际返回通用 `CONFLICT`；
 *     - #109 `VERIFICATION_REQUIRED`：身份阶段不够实际返回通用 `FORBIDDEN`
 *       → 客户端无法区分「你没认证 → 去认证页」与「你没权限」
 *         （这是两种完全不同的用户引导）；
 *     - #110 `AUTH_FAILED`：凭据无效实际返回 `AUTH_REQUIRED`
 *       → 「没带令牌」与「令牌无效」被混为一谈。
 *
 *   反过来，服务端返回了契约里**没有**的错误码，客户端按契约判断同样会失配 ——
 *   而契约是唯一事实来源，所以这同样必须报。
 *
 * 判定：
 *   R1 死错误码：契约里有、服务端源码里**没有任何引用** → 失败
 *   R2 契约缺码：服务端有、契约里没有 → 失败
 *   R3 客户端未消费：契约里有、但客户端代码里从未出现 → **提示**（不判失败：
 *      契约可以先声明后消费；但它会提醒「这个码目前没人用」）
 *
 * 「引用」的判定口径：服务端源码中出现 `ResponseCode.<键名>`，或出现该错误码的
 * 字面量字符串（`'AUTH_FAILED'`）。两者都算「服务端真的会返回它」。
 *
 * 用法：
 *   node infra/scripts/check-dead-error-code.mjs --root <repo>
 *
 * 退出码：0 = 对账通过；1 = 存在死错误码或契约缺码。
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
 * 从 `export const XXX = { KEY: 'VALUE', ... } as const;` 里提取键值对。
 * 只认**字符串字面量**的值（枚举里的值都是字符串）。
 */
function parseConstObject(file, constName) {
  if (!fs.existsSync(file)) return null;
  const src = readText(file);
  const start = src.indexOf(`const ${constName} = {`);
  if (start < 0) return null;
  const end = src.indexOf('} as const;', start);
  if (end < 0) return null;
  const body = src.slice(start, end);
  const out = new Map();
  const re = /([A-Z][A-Z0-9_]*)\s*:\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    out.set(m[1], m[2]);
  }
  return out;
}

/* ------------------------------ 采集 ------------------------------ */

const CONTRACT_FILE = path.join(ROOT, 'packages/contracts/src/common.ts');
const SERVER_CONST_FILE = path.join(ROOT, 'apps/api/src/common/constants.ts');
const API_SRC = path.join(ROOT, 'apps/api/src');

const contractCodes = parseConstObject(CONTRACT_FILE, 'ErrorCode');
const serverCodes = parseConstObject(SERVER_CONST_FILE, 'ResponseCode');

if (!contractCodes || contractCodes.size === 0) {
  console.error(`[dead-error-code] 无法从契约解析 ErrorCode：${CONTRACT_FILE}`);
  process.exit(2);
}
if (!serverCodes || serverCodes.size === 0) {
  console.error(`[dead-error-code] 无法从服务端解析 ResponseCode：${SERVER_CONST_FILE}`);
  process.exit(2);
}

// 服务端源码（排除常量定义文件本身，否则每个码都会「自引用」）
const serverFiles = listFiles(API_SRC, (f) => f.endsWith('.ts') && f !== SERVER_CONST_FILE);
const serverSource = serverFiles.map((f) => readText(f)).join('\n');

// 客户端源码（小程序 + 管理后台）
const CLIENT_DIRS = [
  path.join(ROOT, 'apps/miniprogram/src'),
  path.join(ROOT, 'apps/admin-web/src'),
];
const clientFiles = CLIENT_DIRS.flatMap((dir) =>
  listFiles(dir, (f) => f.endsWith('.ts') || f.endsWith('.vue')),
);
const clientSource = clientFiles.map((f) => readText(f)).join('\n');

/* ------------------------------ 判定 ------------------------------ */

/**
 * **非错误码豁免清单**（每次运行都会打印，避免「悄悄放过」）。
 *
 * `OK` 是**成功信封**的业务码（响应 `{code:'OK', message, data}`），
 * 契约的 `ErrorCode` 只描述**失败**语义，因此它不该出现在错误码对账里。
 * 契约的成功信封用 `code: string` 声明（packages/contracts/src/common.ts）。
 */
const NON_ERROR_CODES = new Set(['OK']);

const failures = [];
const hints = [];

/** 服务端是否真的会返回这个错误码 */
function serverReferences(key, value) {
  if (serverSource.includes(`ResponseCode.${key}`)) return true;
  if (serverSource.includes(`'${value}'`) || serverSource.includes(`"${value}"`)) return true;
  return false;
}

/** R1：死错误码 —— 契约声明了，服务端从不返回 */
for (const [key, value] of contractCodes) {
  if (!serverReferences(key, value)) {
    failures.push({
      code: 'DEAD_ERROR_CODE',
      detail: `${key}（'${value}'）在契约 ErrorCode 中声明，但服务端没有任何地方会返回它`,
      hint: `客户端按契约写 code === '${value}' 的判断永远走不到；要么在服务端返回它，要么从契约里删掉`,
    });
  }
}

/** R2：契约缺码 —— 服务端会返回，但契约里没有 */
for (const [key, value] of serverCodes) {
  if (NON_ERROR_CODES.has(key)) {
    hints.push(`${key}（'${value}'）：非错误码（成功信封业务码），已豁免对账`);
    continue;
  }
  if (!contractCodes.has(key)) {
    failures.push({
      code: 'CONTRACT_MISSING_CODE',
      detail: `服务端 ResponseCode.${key}（'${value}'）会被返回，但契约 ErrorCode 里没有这一项`,
      hint: '契约是唯一事实来源：补进 packages/contracts/src/common.ts 的 ErrorCode',
    });
  }
}

/** R3：客户端从未消费（提示级） */
for (const [, value] of contractCodes) {
  if (!clientSource.includes(`'${value}'`) && !clientSource.includes(`"${value}"`)) {
    hints.push(`${value}：契约声明了，但客户端代码里从未出现（暂时无人消费）`);
  }
}

/* ------------------------------ 输出 ------------------------------ */

console.log('=== 错误码对账（契约 ErrorCode ⟷ 服务端 ResponseCode ⟷ 实际引用）===');
console.log(
  `契约错误码 ${contractCodes.size} 个 / 服务端错误码 ${serverCodes.size} 个 / ` +
    `服务端源码 ${serverFiles.length} 个文件 / 客户端源码 ${clientFiles.length} 个文件`,
);

for (const f of failures) {
  console.log(`  ✗ ${f.code}  ${f.detail}`);
  console.log(`      → ${f.hint}`);
}
for (const h of hints) {
  console.log(`  · 提示：${h}`);
}

console.log(
  `死错误码 ${failures.filter((f) => f.code === 'DEAD_ERROR_CODE').length} 个 / ` +
    `契约缺码 ${failures.filter((f) => f.code === 'CONTRACT_MISSING_CODE').length} 个 / ` +
    `未消费提示 ${hints.length} 条`,
);

if (failures.length > 0) {
  process.exit(1);
}
console.log('错误码对账通过 ✅');
