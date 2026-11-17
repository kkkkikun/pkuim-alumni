#!/usr/bin/env node
/**
 * 契约 ↔ 小程序类型镜像 一致性校验。
 *
 * 背景：
 *   小程序无法在运行时引用工作区包 `@nmg/contracts`，
 *   因此在 `apps/miniprogram/src/types/index.ts` 里**手工镜像**了一份类型
 *   （当前 76 个类型里有 72 个与契约同名）。
 *
 *   这意味着：契约改了、小程序没改，两边就会**静默分叉** ——
 *   小程序的 TypeScript 依然编译通过（它用的是自己那份），
 *   但运行时按着「以为存在」的字段取值，得到 undefined。
 *   契约里的「唯一事实来源」在这条链路上被悄悄架空了。
 *
 * 本脚本逐个对比同名类型：
 *   - interface：字段集合与可选性是否一致；
 *   - type alias：类型表达式是否一致。
 *
 * 用法：node infra/scripts/check-contract-mirror.mjs [--root <repo>] [--json]
 * 退出码：0 = 一致；1 = 存在漂移。
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

const CONTRACT_FILES = [
  path.join(ROOT, 'packages/contracts/src/api.ts'),
  path.join(ROOT, 'packages/contracts/src/domain.ts'),
  path.join(ROOT, 'packages/contracts/src/common.ts'),
];
const MIRROR_FILE = path.join(ROOT, 'apps/miniprogram/src/types/index.ts');

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
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

/** 解析一个文件里的 interface / type alias */
function parseTypes(file) {
  const raw = readFileSafe(file);
  if (!raw) return new Map();
  const src = stripComments(raw);
  const types = new Map();

  const ifaceRe = /export\s+interface\s+(\w+)(?:\s+extends\s+([^{]+?))?\s*\{/g;
  let match;
  while ((match = ifaceRe.exec(src)) !== null) {
    const name = match[1];
    const bodyStart = ifaceRe.lastIndex;
    const bodyEnd = matchBrace(src, bodyStart - 1);
    if (bodyEnd < 0) continue;
    const body = src.slice(bodyStart, bodyEnd);
    const fields = [];
    const fieldRe = /^\s*(\w+)(\?)?\s*:\s*(.+?);/gm;
    let fieldMatch;
    while ((fieldMatch = fieldRe.exec(body)) !== null) {
      fields.push({
        name: fieldMatch[1],
        optional: Boolean(fieldMatch[2]),
        type: fieldMatch[3].trim().replace(/\s+/g, ' '),
      });
    }
    if (!types.has(name)) {
      types.set(name, { kind: 'interface', extends: match[2] ?? '', fields, file });
    }
    ifaceRe.lastIndex = bodyEnd;
  }

  // type alias：表达式里可能含对象字面量（`{ a: X; b: Y }`），
  // 必须按括号深度找结尾的 ';'，否则会在第一个内部分号处截断。
  const aliasRe = /export\s+type\s+(\w+)\s*=\s*/g;
  let aliasMatch;
  while ((aliasMatch = aliasRe.exec(src)) !== null) {
    const name = aliasMatch[1];
    const expr = readTypeExpression(src, aliasRe.lastIndex);
    if (!expr) continue;
    if (!types.has(name)) {
      types.set(name, { kind: 'alias', expr: expr.expr, file });
    }
    aliasRe.lastIndex = expr.endIndex;
  }

  return types;
}

/** 从 start 处读取一个类型表达式（括号深度感知），返回归一化文本 */
function readTypeExpression(src, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[' || ch === '<') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']' || ch === '>') depth -= 1;
    else if (ch === ';' && depth === 0) {
      return {
        expr: src
          .slice(start, i)
          .trim()
          .replace(/\s+/g, ' '),
        endIndex: i,
      };
    }
  }
  return null;
}

function main() {
  const contract = new Map();
  for (const file of CONTRACT_FILES) {
    for (const [name, def] of parseTypes(file)) {
      if (!contract.has(name)) contract.set(name, def);
    }
  }
  const mirror = parseTypes(MIRROR_FILE);

  const drifts = [];
  const shared = [];

  for (const [name, mirrorDef] of mirror) {
    const contractDef = contract.get(name);
    if (!contractDef) continue;
    shared.push(name);

    if (mirrorDef.kind !== contractDef.kind) {
      drifts.push({
        type: name,
        kind: 'KIND_MISMATCH',
        detail: `小程序是 ${mirrorDef.kind}，契约是 ${contractDef.kind}`,
      });
      continue;
    }

    if (mirrorDef.kind === 'interface') {
      const mirrorFields = new Map(mirrorDef.fields.map((f) => [f.name, f]));
      const contractFields = new Map(contractDef.fields.map((f) => [f.name, f]));
      const onlyMirror = [...mirrorFields.keys()].filter((k) => !contractFields.has(k));
      const onlyContract = [...contractFields.keys()].filter((k) => !mirrorFields.has(k));
      const optionalMismatch = [...mirrorFields.keys()].filter((k) => {
        const c = contractFields.get(k);
        return c && c.optional !== mirrorFields.get(k).optional;
      });
      const typeMismatch = [...mirrorFields.keys()].filter((k) => {
        const c = contractFields.get(k);
        return c && c.type !== mirrorFields.get(k).type;
      });
      if (onlyMirror.length || onlyContract.length || optionalMismatch.length || typeMismatch.length) {
        drifts.push({
          type: name,
          kind: 'INTERFACE_DRIFT',
          onlyMirror,
          onlyContract,
          optionalMismatch,
          typeMismatch,
        });
      }
    } else if (mirrorDef.expr !== contractDef.expr) {
      drifts.push({
        type: name,
        kind: 'ALIAS_DRIFT',
        mirrorExpr: mirrorDef.expr,
        contractExpr: contractDef.expr,
      });
    }
  }

  const summary = {
    sharedTypes: shared.length,
    mirrorTypes: mirror.size,
    contractTypes: contract.size,
    drifts: drifts.length,
    detail: drifts,
  };

  if (AS_JSON) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('=== 契约 ↔ 小程序类型镜像 一致性校验 ===');
    for (const item of drifts) {
      console.log(`  ✗ ${item.type}（${item.kind}）`);
      if (item.kind === 'INTERFACE_DRIFT') {
        if (item.onlyMirror.length) console.log(`      小程序多出：${item.onlyMirror.join(', ')}`);
        if (item.onlyContract.length) console.log(`      契约多出：${item.onlyContract.join(', ')}`);
        if (item.optionalMismatch.length) console.log(`      可选性不一致：${item.optionalMismatch.join(', ')}`);
        if (item.typeMismatch.length) console.log(`      类型不一致：${item.typeMismatch.join(', ')}`);
      } else if (item.kind === 'ALIAS_DRIFT') {
        console.log(`      小程序：${item.mirrorExpr}`);
        console.log(`      契约　：${item.contractExpr}`);
      } else {
        console.log(`      ${item.detail}`);
      }
    }
    console.log(
      `共对比 ${shared.length} 个同名类型（小程序 ${summary.mirrorTypes} 个 / 契约 ${summary.contractTypes} 个）：漂移 ${drifts.length}`,
    );
  }

  process.exit(drifts.length ? 1 : 0);
}

main();
