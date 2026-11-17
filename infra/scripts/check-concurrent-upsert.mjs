#!/usr/bin/env node
/**
 * 「先查后插」的并发撞唯一键 —— 静态对账。
 *
 * 背景（缺陷 #137 的根因）：
 *   很多业务写是同一个形态：
 *
 *     const existing = await this.repo.findOne({ where: { ... } });
 *     if (existing) { /* 改 *\/ } else { await this.repo.save(this.repo.create({ ... })); }
 *
 *   单线程下「只发生一次写」没问题；**并发**下两个请求都读不到既有行，
 *   于是都去 INSERT → 后到的那一个撞唯一键 / 主键 → 500。
 *
 *   现实场景：同一用户在两台设备同时打开「联系方式授权」开关；
 *   两个管理员同时保存同一条系统设置；两个人同时申请同一个职位……
 *
 *   这类缺陷有三个特点，使得它**必须**由工具兜底：
 *     1) 单线程下永远测不出来 —— 用例再全也覆盖不到；
 *     2) 复现窗口极窄，线上表现为「偶发 500」，极难定位；
 *     3) 修一处还有下一处 —— 同样的形态在代码里会重复出现。
 *
 * 判定：
 *   R1 并发撞唯一键（**失败**）：方法内出现「先查后插」形态，
 *      且**没有**唯一键兜底（捕获 `ER_DUP_ENTRY` / 1062 后改成更新或转成 409），
 *      也没有行级锁（`FOR UPDATE` / `pessimistic_write`）。
 *   R2 兜底存在（**通过**）：方法内或其调用的方法里出现了重复键兜底。
 *   R3 只提示（**提示**）：形态存在但兜底「看起来」在别处，需人工确认。
 *
 * 判定口径：
 *   - 读操作认 `findOne` / `findOneBy` / `findOneOrFail`；
 *   - 插操作认 `save(x.create(...))` 与 `insert(...)`；
 *   - 「先查后插」要求：读的返回值被**条件判断**过，且同一方法内存在插操作；
 *   - 兜底既认**方法体内**的直接捕获，也认**同类其它方法**里的捕获
 *     （缺陷 #137 的修复就是抽成 `isDuplicateKey()` 复用的）。
 *
 * 用法：
 *   node infra/scripts/check-concurrent-upsert.mjs --root <repo> [--json]
 *
 * 退出码：0 = 通过；1 = 存在并发撞唯一键风险。
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
const AS_JSON = args.includes('--json');

const API_SRC = path.join(ROOT, 'apps/api/src');

/** 读操作方法名 */
const READ_METHODS = ['findOne', 'findOneBy', 'findOneOrFail'];

/** 唯一键兜底的判据（命中任一即认为「撞键被兜住了」） */
const FALLBACK_MARKERS = [
  'ER_DUP_ENTRY',
  '1062',
  'isDuplicateKey',
  'duplicate key',
  'Duplicate entry',
  'ON DUPLICATE KEY',
  'upsert(',
  'insertOrIgnore',
  'orIgnore()',
  'orUpdate()',
];

/** 行级锁判据：加锁后「先查后插」在并发下是安全的 */
const LOCK_MARKERS = ['FOR UPDATE', 'pessimistic_write', 'pessimistic_read', 'setLock('];

/**
 * 判定「这个方法里有没有唯一键兜底」。
 *
 * 两种形态都算兜住了：
 *   1) 显式捕获重复键：`ER_DUP_ENTRY` / `1062` / `isDuplicateKey()` → 改为更新或转 409；
 *   2) 捕获 `QueryFailedError` 并转成 `ConflictException`（409）——
 *      例如 `events.service.ts` 的报名：撞唯一键 → 「报名信息冲突，请重试」。
 *
 * ⚠️ 形态 2 的捕获范围偏宽（把别的 SQL 错误也报成 409），
 *    静态判不准「捕获的是不是重复键」—— 这里只判「有没有把数据库错误转成 409」，
 *    并在提示里说明它偏宽，供人工复核。
 */
function hasDuplicateKeyGuard(text) {
  if (hasAny(text, FALLBACK_MARKERS)) return true;
  const catchesDbError = /catch\s*\([^)]*\)\s*\{[^}]*QueryFailedError/.test(text);
  return catchesDbError && text.includes('ConflictException');
}

/**
 * 已确认安全、显式豁免的形态。
 * 每条都必须写明理由，便于复核。
 */
const EXEMPTIONS = [
  {
    file: 'apps/api/src/modules/connections/connections.service.ts',
    method: 'setContactGrant',
    reason: '已捕获 ER_DUP_ENTRY 并改为更新既有行（缺陷 #137 修复）',
  },
  {
    file: 'apps/api/src/modules/content/content.service.ts',
    method: 'upsertSetting',
    reason: '已捕获 ER_DUP_ENTRY 并改为更新既有行（缺陷 #137 修复）',
  },
];

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
 * 粗粒度地切出方法体。
 *
 * 不用 AST：校验器本身要能在**注入的临时副本**上跑，样本形态多变，
 * 宁可宽松一点，也不要因为「解析不出来」而漏判。
 */
function collectMethods(src) {
  const lines = src.split('\n');
  const methods = [];
  const headerRe =
    /^\s{2}(?:(?:public|private|protected|static|async|readonly|override)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^{;]+)?\{\s*$/;

  for (let i = 0; i < lines.length; i += 1) {
    const match = headerRe.exec(lines[i]);
    if (!match) continue;
    const name = match[1];
    if (['if', 'for', 'while', 'switch', 'catch', 'constructor', 'return'].includes(name)) {
      continue;
    }
    // 从这一行开始做括号配对，找到方法体结束
    let depth = 0;
    let started = false;
    let body = '';
    for (let j = i; j < lines.length; j += 1) {
      const line = lines[j];
      body += `${line}\n`;
      for (const ch of line) {
        if (ch === '{') {
          depth += 1;
          started = true;
        } else if (ch === '}') {
          depth -= 1;
        }
      }
      if (started && depth <= 0) break;
    }
    methods.push({ name, line: i + 1, body });
    i += body.split('\n').length - 1;
  }
  return methods;
}

function hasAny(text, markers) {
  return markers.some((marker) => text.includes(marker));
}

/* ------------------------------ 核心判定 ------------------------------ */

/**
 * 归一化文本，同时保留「归一化后的每个字符对应原文哪一行」。
 *
 * 为什么要归一化：`save(\n  repo.create({...})\n)` 这种**跨行**写法很常见 ——
 * 缺陷 #137 修复后的 `upsertSetting()` 就是跨行的。
 * 逐行匹配会直接漏掉它。
 */
function normalizeWithLines(text) {
  let out = '';
  const lineOf = [];
  let line = 1;
  for (const ch of text) {
    if (ch === '\n') {
      line += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (out.endsWith(' ')) continue;
      out += ' ';
      lineOf.push(line);
      continue;
    }
    out += ch;
    lineOf.push(line);
  }
  return { text: out, lineOf };
}

/**
 * 找出方法里的「先查后插」形态。
 *
 * 判据（三条都要满足，避免误报）：
 *   1) 有一次**读**（`findOne` / `findOneBy` / `findOneOrFail`），且读的是某个仓储；
 *   2) 读的返回值被**条件判断**过（`if (x)` / `if (!x)`）——
 *      否则那只是「读一下做校验」，不是 upsert 语义；
 *   3) 同一方法里有一次**插**，且**插在同一个仓储上** ——
 *      「读 A 表做校验、往 B 表插子行」（如读帖子校验、再插评论）是安全的，
 *      只有「读 A 再插 A」才是撞唯一键的形态。
 *
 * 返回 null 表示没有这个形态；否则返回命中的读/写位置。
 */
function detectReadThenInsert(method) {
  const { text, lineOf } = normalizeWithLines(method.body);
  const lineAt = (index) => lineOf[index] ?? method.line;

  // 1) 读
  const readRe =
    /([A-Za-z_$][\w$]*)\s*=\s*await\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\([^()]*\))?)\.(findOne|findOneBy|findOneOrFail)\s*\(/g;
  const reads = [];
  let match;
  while ((match = readRe.exec(text)) !== null) {
    reads.push({
      varName: match[1],
      receiver: match[2],
      end: match.index + match[0].length,
    });
  }
  if (reads.length === 0) return null;

  const guarded = reads.filter((read) => {
    const window = text.slice(read.end, read.end + 300);
    return new RegExp(`if\\s*\\(\\s*!?\\s*${read.varName}\\b`).test(window);
  });
  if (guarded.length === 0) return null;

  // 2) 插：同一个 receiver 上的 save(create(...)) 或 insert(...)
  const saveRe =
    /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\([^()]*\))?)\.(save|insert)\s*\(/g;
  let insertHit = null;
  while ((match = saveRe.exec(text)) !== null) {
    const receiver = match[1];
    const kind = match[2];
    // 3) receiver 必须与某次「读」一致
    const read = guarded.find((item) => item.receiver === receiver);
    if (!read) continue;
    if (kind === 'insert') {
      insertHit = { read, lineIndex: match.index, kind: 'insert()' };
      break;
    }
    // save：同一语句里必须出现 create(...) 才是「插入新行」，否则是更新既有行
    const statementEnd = text.indexOf(';', match.index);
    const statement = text.slice(match.index, statementEnd > 0 ? statementEnd : match.index + 400);
    if (!/\.create\s*\(/.test(statement)) continue;
    insertHit = { read, lineIndex: match.index, kind: 'save(create())' };
    break;
  }
  if (!insertHit) return null;

  return {
    readVar: insertHit.read.varName,
    receiver: insertHit.read.receiver,
    readLine: lineAt(insertHit.read.end),
    insertLine: lineAt(insertHit.lineIndex),
    insertKind: insertHit.kind,
  };
}

/** 判定一个文件里「哪些方法带唯一键兜底」 */
function collectFallbackMethods(methods) {
  const map = new Map();
  for (const method of methods) {
    map.set(method.name, hasDuplicateKeyGuard(method.body));
  }
  return map;
}

/* ------------------------------ 主流程 ------------------------------ */

function main() {
  const files = listFiles(API_SRC, (file) => file.endsWith('.service.ts'));
  const issues = [];
  const notes = [];

  for (const file of files) {
    const src = readText(file);
    if (!src) continue;
    const relative = path.relative(ROOT, file);
    const methods = collectMethods(src);
    const fallbackMethods = collectFallbackMethods(methods);

    for (const method of methods) {
      const hit = detectReadThenInsert(method);
      if (!hit) continue;

      // 豁免清单
      const exemption = EXEMPTIONS.find(
        (item) => item.file === relative && item.method === method.name,
      );
      if (exemption) {
        notes.push({
          kind: 'CONCURRENT_UPSERT_EXEMPTION',
          where: `${relative} · ${method.name}`,
          detail: `豁免：${exemption.reason}`,
          file: relative,
          line: method.line,
        });
        continue;
      }

      // 方法体内直接有兜底 → 通过
      if (hasDuplicateKeyGuard(method.body)) {
        notes.push({
          kind: 'CONCURRENT_UPSERT_GUARDED',
          where: `${relative} · ${method.name}`,
          detail: '方法体内有唯一键兜底（捕获重复键后改为更新/转 409）',
          file: relative,
          line: method.line,
        });
        continue;
      }

      // 行级锁 → 并发下「先查后插」是安全的
      if (hasAny(method.body, LOCK_MARKERS)) {
        notes.push({
          kind: 'CONCURRENT_UPSERT_LOCKED',
          where: `${relative} · ${method.name}`,
          detail: '方法内有行级锁（FOR UPDATE / pessimistic_write）→ 并发下安全',
          file: relative,
          line: method.line,
        });
        continue;
      }

      // 兜底在**同类其它方法**里（如抽成 isDuplicateKey() 后由别处调用）
      const callsGuarded = [...fallbackMethods.entries()]
        .filter(([name, guarded]) => guarded && name !== method.name)
        .filter(([name]) => new RegExp(`this\\.${name}\\s*\\(`).test(method.body))
        .map(([name]) => name);
      if (callsGuarded.length > 0) {
        notes.push({
          kind: 'CONCURRENT_UPSERT_GUARDED_BY_HELPER',
          where: `${relative} · ${method.name}`,
          detail: `调用了带唯一键兜底的方法：${callsGuarded.join('、')}`,
          file: relative,
          line: method.line,
        });
        continue;
      }

      issues.push({
        kind: 'CONCURRENT_UPSERT',
        where: `${relative} · ${method.name}`,
        detail:
          `「先查后插」形态：先 findOne 读 ${hit.readVar}（第 ${hit.readLine} 行），` +
          `再 ${hit.insertKind} 写入（第 ${hit.insertLine} 行）—— ` +
          `并发下两个请求都读不到既有行 → 都去 INSERT → 后到的撞唯一键 → 500。` +
          `必须捕获 ER_DUP_ENTRY（1062）后改为**更新**既有行，或转成 409。`,
        file: relative,
        line: method.line,
      });
    }
  }

  const report = { issues, notes, scannedFiles: files.length };
  if (AS_JSON) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const note of notes) {
      process.stdout.write(`  [提示] ${note.where}\n         ${note.detail}\n`);
    }
    if (issues.length === 0) {
      process.stdout.write(
        `✅ 并发撞唯一键对账通过：扫描 ${files.length} 个 service 文件，未发现「先查后插」缺口\n`,
      );
    } else {
      for (const issue of issues) {
        process.stdout.write(`❌ [${issue.kind}] ${issue.where}\n     ${issue.detail}\n`);
      }
      process.stdout.write(
        `\n❌ 发现 ${issues.length} 处「先查后插」缺口（扫描 ${files.length} 个 service 文件）\n`,
      );
    }
  }

  process.exit(issues.length > 0 ? 1 : 0);
}

main();
