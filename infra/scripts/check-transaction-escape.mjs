#!/usr/bin/env node
/**
 * 事务逃逸对账 —— 「包了事务，却没写进那个事务」不许发生。
 *
 * 背景（缺陷 #99 / #115 / #118 / #119 的共同教训）：
 *   TypeORM 里 `dataSource.transaction(async (manager) => {...})` 里的 `manager`
 *   绑定的是**事务自己的 queryRunner**；而通过 `@InjectRepository(X)` 注入的
 *   默认仓储走的是**另一条连接**。
 *   于是下面这段代码看起来是事务、实际**不是**：
 *
 *     await this.dataSource.transaction(async (manager) => {
 *       await manager.getRepository(A).save(a);   // ✅ 在事务里
 *       await this.bs.save(b);                   // ❌ 跳出事务（另一条连接）
 *     });
 *
 *   后果：跳出事务的那次写**立刻提交**，事务随后回滚也回滚不掉它 ——
 *   于是留下「一半提交、一半回滚」的半成品状态，而且**没有任何报错**。
 *   #118（补交材料）与 #119（个人资料）修复前就是这个形态。
 *
 * 判定：
 *   R1 事务逃逸（**失败**）：事务回调内出现跳出事务的写入：
 *      - `this.<repo>.save/update/delete/insert(...)`
 *      - `this.<repo>.createQueryBuilder().update/insert/delete(...)`
 *      - `this.dataSource.query('UPDATE ...')`
 *   R2 多步写候选（**提示**）：同一个方法里有 2 次以上写入、且方法体内**没有**
 *      `transaction(` —— 「该不该同事务」取决于业务语义，静态判不了，
 *      所以只提示、人工复核；但豁免清单每次运行都打印，避免悄悄放过。
 *   R3 跨方法的多步写候选（**提示**）：方法自己写一次，又调用同类里**会写库**的
 *      其它方法（如 `update()` → `replaceAttachments()`），同样没有事务 ——
 *      R2 看不见这种形态，缺陷 #131 / #132 就是它。
 *
 * 判定口径：
 *   - 写操作既认 `this.posts.save(...)`，也认**局部别名**
 *     （`const attachments = manager.getRepository(X)` 之后的 `attachments.save(...)`）——
 *     缺陷 #131 / #132 的两次写都在别名写法里；
 *   - 方法识别支持 `private` 修饰与**跨行签名**。
 *
 * 用法：
 *   node infra/scripts/check-transaction-escape.mjs --root <repo> [--json]
 *
 * 退出码：0 = 通过；1 = 存在事务逃逸。
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

/** 仓储上的写方法 */
const REPO_WRITE_METHODS = ['save', 'update', 'delete', 'insert', 'softDelete'];

/**
 * R2 的豁免清单：确认无害的「多次写」形态。
 * 每条都必须写明理由，便于复核。
 */
const MULTI_STEP_EXEMPTIONS = [
  {
    file: 'apps/api/src/modules/content/content.service.ts',
    method: 'upsertSetting',
    reason:
      'if/else 二选一：设置已存在则 update，不存在则 insert —— 运行时只会发生一次写',
  },
  {
    file: 'apps/api/src/modules/connections/connections.service.ts',
    method: 'setContactGrant',
    reason:
      'if/else 二选一：授权已存在则 update，否则 insert —— 运行时只会发生一次写',
  },
];

/* ------------------------------ 工具 ------------------------------ */

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
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

/** 从 `{` 处取出配平的代码块（含起始括号） */
function sliceBlock(src, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(openIndex, i + 1);
    }
  }
  return null;
}

/* ------------------------------ 扫描 ------------------------------ */

/**
 * 找出所有 `transaction(async (manager) => { ... })` 的回调体。
 * 返回 [{ manager, body, line }]
 */
function collectTransactionBlocks(src) {
  const blocks = [];
  const re = /transaction\(\s*async\s*\(\s*(\w+)\s*\)\s*=>\s*\{/g;
  let match;
  while ((match = re.exec(src)) !== null) {
    const open = src.indexOf('{', match.index + match[0].length - 1);
    const body = sliceBlock(src, open);
    if (!body) continue;
    blocks.push({
      manager: match[1],
      body,
      line: src.slice(0, match.index).split('\n').length,
    });
  }
  return blocks;
}

/**
 * 取 `(` 之后到**配对** `)` 之间的实参文本（跳过嵌套括号与字符串）。
 * 用于判断「这次调用有没有把 manager 传进去」。
 */
function readCallArgs(src, openParenIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openParenIndex; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(openParenIndex + 1, i);
    }
  }
  return src.slice(openParenIndex + 1);
}

/** 事务体里跳出事务的写法 */
function findEscapeWrites(body, managerName = 'manager') {
  const hits = [];
  const repoWrite = new RegExp(
    `this\\.(\\w+)\\.(${REPO_WRITE_METHODS.join('|')})\\s*\\(`,
    'g',
  );
  let match;
  while ((match = repoWrite.exec(body)) !== null) {
    // ⚠️ 别误报：如果这次调用把**事务的 manager** 当参数传下去了，
    //    被调方就能加入同一个事务 —— 那不是「逃逸」。
    //    （管理端把「业务写 + 审计日志」放进同一事务时就是这种写法：
    //      `this.eventsService.update(id, body, manager)`）
    const args = readCallArgs(body, match.index + match[0].length - 1);
    if (new RegExp(`\\b${managerName}\\b`).test(args)) continue;
    hits.push({ kind: 'repo_write', detail: `this.${match[1]}.${match[2]}(…)` });
  }
  const qbWrite =
    /this\.(\w+)\s*\n?\s*\.createQueryBuilder\(\)([\s\S]{0,160}?)\.(update|insert|delete)\s*\(/g;
  while ((match = qbWrite.exec(body)) !== null) {
    hits.push({
      kind: 'qb_write',
      detail: `this.${match[1]}.createQueryBuilder().${match[3]}(…)`,
    });
  }
  const rawSql = /this\.dataSource\.query\(\s*[`'"][^`'"]*\b(INSERT|UPDATE|DELETE)\b/gi;
  while ((match = rawSql.exec(body)) !== null) {
    hits.push({ kind: 'raw_sql', detail: `this.dataSource.query('${match[1]} …')` });
  }
  return hits;
}

/**
 * 找出方法体里的**写操作表达式**。
 *
 * 除了 `this.posts.save(...)` 这种直接写法，还要认**局部别名**：
 *   const attachments = manager.getRepository(X);  // 或 = this.attachments
 *   await attachments.save(...) / attachments.delete(...)
 * 缺陷 #131 / #132 就藏在这种写法里 ——
 * `replaceAttachments()` 里的两次写用的是局部别名，R2 完全看不见。
 */
function findWriteExpressions(body) {
  const writes = [];
  const re = new RegExp(`this\\.(\\w+)\\.(${REPO_WRITE_METHODS.join('|')})\\s*\\(`, 'g');
  let match;
  while ((match = re.exec(body)) !== null) {
    writes.push(`this.${match[1]}.${match[2]}()`);
  }

  const aliasRe = /const\s+(\w+)\s*=\s*([\s\S]{0,200}?);/g;
  const aliases = new Set();
  while ((match = aliasRe.exec(body)) !== null) {
    const [, name, initializer] = match;
    if (!/getRepository\(|this\.\w+/.test(initializer)) continue;
    const aliasWriteRe = new RegExp(
      `\\b${name}\\.(${REPO_WRITE_METHODS.join('|')})\\s*\\(`,
    );
    if (aliasWriteRe.test(body)) aliases.add(name);
  }
  for (const alias of aliases) {
    const aliasWriteRe = new RegExp(
      `\\b${alias}\\.(${REPO_WRITE_METHODS.join('|')})\\s*\\(`,
      'g',
    );
    while ((match = aliasWriteRe.exec(body)) !== null) {
      writes.push(`${alias}.${match[1]}()`);
    }
  }
  return writes;
}

/**
 * 方法是不是「**事务感知**」的：签名里收了一个 EntityManager（或同类），
 * 并且写操作走的是那个 manager。
 *
 * 这类方法**由调用方开事务**（典型：`syncRoles(manager, …)`、
 * `replaceAttachments(postId, mediaIds, manager?)`），
 * 它自己不需要再开事务 —— 拿它去判「多步写无事务」是**误报**。
 */
function isTransactionAware(method) {
  const signature = method.body.split('{')[0];
  const open = signature.indexOf('(');
  if (open < 0) return false;
  const inner = signature.slice(open + 1);
  const params = [];
  for (const part of inner.split(',')) {
    const match = part.trim().match(/^(\w+)\??\s*:/);
    if (match) params.push(match[1]);
  }
  return params.some((param) =>
    new RegExp(`\\b${param}\\s*\\.getRepository\\s*\\(`).test(method.body),
  );
}

/**
 * 找出「类方法」定义：缩进 2 空格的 `async name(...)` / `name(...)`。
 * 返回 [{ name, body, line }]
 */
function collectMethods(src) {
  const methods = [];
  const lines = src.split('\n');
  // 方法头：缩进 2 空格 +（可选修饰符）+（可选 async）+ 名字 + (
  // ⚠️ 签名可能**跨行**（参数多时会换行），所以这里只匹配到左括号，
  //    再往下累积到出现 '{' 才算一个方法。
  const headRe = /^ {2}(?:(?:public|private|protected)\s+)?(?:async\s+)?(\w+)\s*\(/;
  for (let i = 0; i < lines.length; i += 1) {
    const match = headRe.exec(lines[i]);
    if (!match) continue;
    // 跳过构造函数与明显不是方法的东西
    if (match[1] === 'constructor') continue;

    let signatureEnd = i;
    let signature = lines[i];
    while (!signature.includes('{') && signatureEnd + 1 < lines.length) {
      signatureEnd += 1;
      signature += `\n${lines[signatureEnd]}`;
    }
    if (!signature.includes('{')) continue;

    const bodyLines = [signature];
    for (let j = signatureEnd + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') {
        bodyLines.push(line);
        continue;
      }
      // 方法体内的行至少缩进 4 空格（更深缩进的分支体也算）。
      // ⚠️ 不能用 `/^ {4}\S/`：那样 6 空格的分支体会被误判成「方法结束」。
      if (!line.startsWith('    ')) break;
      bodyLines.push(line);
    }
    methods.push({ name: match[1], body: bodyLines.join('\n'), line: i + 1 });
  }
  return methods;
}

/* ------------------------------ 主流程 ------------------------------ */

function main() {
  const files = listFiles(API_SRC, (file) => file.endsWith('.ts'));
  const issues = [];
  const notes = [];

  for (const file of files) {
    const src = readText(file);
    if (!src) continue;
    const relative = path.relative(ROOT, file);

    // R1：事务逃逸
    for (const block of collectTransactionBlocks(src)) {
      for (const hit of findEscapeWrites(block.body, block.manager)) {
        const line =
          block.line + src.slice(0, src.indexOf(block.body)).split('\n').length - 1;
        issues.push({
          kind: 'TRANSACTION_ESCAPE',
          where: relative,
          detail:
            `事务回调内出现 ${hit.detail} —— 它走的是注入仓储的**另一条连接**，` +
            `会**跳出事务**（立刻提交，事务回滚也回滚不掉它）。` +
            `事务内必须用 ${block.manager}.getRepository(...)`,
          file: relative,
          line,
        });
      }
    }

    // R2：多步写候选（提示）
    for (const method of collectMethods(src)) {
      // ⚠️ 写操作识别必须**认局部别名**（`const articles = ...` 后的 `articles.save(...)`）——
      //    否则「两次写分写在不同形态里」的方法会被漏掉（缺陷 #132 就是这种形态）。
      const writes = findWriteExpressions(method.body);
      if (writes.length < 2) continue;
      if (method.body.includes('transaction(')) continue;
      // 事务感知的从属方法：由调用方开事务，自己不需要再开 —— 不算候选
      if (isTransactionAware(method)) continue;
      const exemption = MULTI_STEP_EXEMPTIONS.find(
        (item) => item.file === relative && item.method === method.name,
      );
      if (exemption) {
        notes.push({
          kind: 'MULTI_STEP_EXEMPTION',
          where: `${relative} · ${method.name}`,
          detail: `豁免：${exemption.reason}`,
          file: relative,
          line: method.line,
        });
        continue;
      }
      notes.push({
        kind: 'MULTI_STEP_WRITE_WITHOUT_TRANSACTION',
        where: `${relative} · ${method.name}`,
        detail:
          `方法内有 ${writes.length} 次写入（${writes.join('、')}）且**没有事务** —— ` +
          `「该不该同生共死」取决于业务语义，静态判不了，请人工确认` +
          `（若中途失败需要整体回滚，就必须进事务）`,
        file: relative,
        line: method.line,
      });
    }

    // R3：跨方法的多步写候选（提示）
    //
    // R2 只看得见「同一个方法里的两次写」。但多步写经常被拆到**别的方法**里 ——
    //   `update()` 自己写一次内容，再调 `replaceAttachments()` 写一次附件。
    // 这种形态 R2 完全看不见（缺陷 #131 / #132 就是这个形态）：
    //   附件那一步失败时，内容写入**已经提交** → 留下半成品。
    const methodWrites = new Map();
    for (const method of collectMethods(src)) {
      const writes = findWriteExpressions(method.body);
      if (writes.length > 0) methodWrites.set(method.name, writes);
    }
    for (const method of collectMethods(src)) {
      if (method.body.includes('transaction(')) continue;
      if (isTransactionAware(method)) continue;
      const ownWrites = methodWrites.get(method.name) ?? [];
      // 调用了同类里**会写库**的其它方法 → 至少两步写
      const calledWriters = [];
      const callRe = /this\.(\w+)\s*\(/g;
      let call;
      while ((call = callRe.exec(method.body)) !== null) {
        const name = call[1];
        if (name === method.name) continue;
        const targetWrites = methodWrites.get(name);
        if (targetWrites) calledWriters.push(`${name}()（${targetWrites.join('、')}）`);
      }
      if (ownWrites.length === 0 || calledWriters.length === 0) continue;
      const exemption = MULTI_STEP_EXEMPTIONS.find(
        (item) => item.file === relative && item.method === method.name,
      );
      if (exemption) {
        notes.push({
          kind: 'MULTI_STEP_EXEMPTION',
          where: `${relative} · ${method.name}`,
          detail: `豁免：${exemption.reason}`,
          file: relative,
          line: method.line,
        });
        continue;
      }
      notes.push({
        kind: 'MULTI_STEP_WRITE_ACROSS_METHODS',
        where: `${relative} · ${method.name}`,
        detail:
          `方法内写了 ${ownWrites.join('、')}，又调用了同样会写库的 ${calledWriters.join('、')}，` +
          `且**没有事务** —— 这些写分散在不同方法里，R2 看不见。` +
          `若中途失败需要整体回滚，就必须把它们放进同一个事务`,
        file: relative,
        line: method.line,
      });
    }

    // R4：事务感知的方法里**绕过 manager** 的写入（提示）
    //
    // 这类方法由调用方开事务（`manager ? manager.getRepository(X) : this.x` 这种写法），
    // 于是「走 manager 的那次写」在事务里，「走 this.x 的那次写」**不在** ——
    // 后者会立刻提交，调用方的事务回滚也回滚不掉它。
    // 形如 `this.<repo>.save(...)` 的写入即命中。
    for (const method of collectMethods(src)) {
      if (!isTransactionAware(method)) continue;
      const bypassWrites = findWriteExpressions(method.body).filter((write) =>
        write.startsWith('this.'),
      );
      if (bypassWrites.length === 0) continue;
      notes.push({
        kind: 'TRANSACTION_AWARE_BYPASS',
        where: `${relative} · ${method.name}`,
        detail:
          `方法接受事务的 manager（由调用方开事务），但这里还有 ${bypassWrites.join('、')} —— ` +
          `它们走的是**注入仓储**，不在调用方的事务里，事务回滚会回滚不掉它们。` +
          `请改成走 manager 的那个仓储`,
        file: relative,
        line: method.line,
      });
    }
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ issues, notes }, null, 2));
  } else {
    console.log('=== 事务逃逸对账（包了事务却写不进事务）===');
    for (const issue of issues) {
      console.log(`  ✗ ${issue.where}  [${issue.kind}] ${issue.detail}`);
      console.log(`      ${issue.file}:${issue.line}`);
    }
    for (const note of notes) {
      console.log(`  · ${note.where}  [${note.kind}] ${note.detail}`);
      console.log(`      ${note.file}:${note.line}`);
    }
    console.log(
      `扫描 ${files.length} 个源文件：事务逃逸 ${issues.length} 处 / 多步写候选 ${notes.length} 处`,
    );
  }

  process.exit(issues.length ? 1 : 0);
}

main();
