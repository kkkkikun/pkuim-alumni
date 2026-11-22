#!/usr/bin/env node
/**
 * 「**结论**逐条对账」—— 静态层与库内层的差异集比对（第十七轮）。
 *
 * 背景（第十六轮 → 第十七轮）：
 *   第十六轮把两层的**判定口径**对齐了（实体 ↔ 迁移 与 实体 ↔ 库
 *   判同样的维度：类型 / 长度 / 可空性 / 默认值 / `unsigned` / 枚举取值）。
 *   但**口径一致 ≠ 结论一致** —— 两层各自报出的**差异集**
 *   此前从未被自动比对过：
 *     - 「静态层说迁移里没有这道索引，库内层说库里**有**」→
 *       对**同一个对象**给出了互相矛盾的结论（其中一层解析错了，
 *       或者库不是按迁移建的 / 建完被人手工改过）；
 *     - 「静态层判了这一列，库内层**根本没判这一列**」→
 *       一层**遗漏**了某个对象（口径分叉了，但没人知道）。
 *   这两类分叉此前**没有任何机制会报警**。
 *
 * 本脚本做四件事：
 *   1) **同时**跑两层（`check-error-semantics.mjs` 静态层、
 *      `check-db-reality.mjs` 库内层），各自吐出**结论台账**
 *      （`layer-conclusion-ledger.mjs` 定义的公共格式）；
 *   2) 逐个维度、逐个对象**比对**两层的结论：
 *        - 同一对象、结论相反 → **互相矛盾**（`LAYER_VERDICT_CONFLICT`）；
 *        - 同一对象、一层跳过、另一层判了 → **覆盖面不同**
 *          （`LAYER_SKIPPED_DIVERGENCE`）；
 *        - 同一对象、**一层压根没判** → **互相遗漏**
 *          （`LAYER_VERDICT_OMISSION`）；
 *   3) 比对两层的**判定统计**（每个维度判了多少 / 跳过多少 / 不一致多少）——
 *      数字对不上，说明两层的**口径**又分叉了（哪怕此刻还没出结论）；
 *   4) 有出入就报错、退出码非 0。
 *
 * ⚠️ **为什么「一层没判」有时不算缺陷**（父级已报的分叉要能解释它）：
 *   若静态层判了「迁移里没有这张表」，那它**必然**不会判这张表的列
 *   （表都不存在，列无从判起）。此时库内层判了那些列**不是漏判** ——
 *   它只是**不知道**静态层在表这一层已经报了不一致。
 *   所以：对「一层没判」的对象，若**缺判的那一层**在这一维度上
 *   已经有 MISMATCH 结论，则视为**已被父级结论解释**，不重复报。
 *   （分维度：表 → 列 / 索引 / 外键 / 唯一键，表是它们的父级。）
 *
 * 用法：
 *   node infra/scripts/check-layer-conclusion-reconciliation.mjs [--root <repo>] [--json]
 *
 *   ⚠️ 需要**测试库**（库内层要连库）。连接参数与
 *   `check-db-reality.mjs` 完全一致（`DATABASE_URL` 或
 *   `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME`）。
 *
 * 退出码：0 = 两层结论一致；1 = 存在矛盾 / 遗漏 / 覆盖面分叉；2 = 脚本自身失败。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  LEDGER_DIMENSIONS,
  RECONCILABLE_DIMENSIONS,
  STATIC_ISSUE_DIMENSION,
  DB_ISSUE_DIMENSION,
  VERDICT,
  NON_RECONCILABLE_CODES,
} from './layer-conclusion-ledger.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------ 参数 ------------------------------ */

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const ROOT = path.resolve(argValue('--root', process.cwd()));
const AS_JSON = args.includes('--json');

/**
 * 维度 → **父级维度**。
 *
 * ⚠️ 只列「列级」维度：表是列 / 索引 / 外键 / 唯一键的父级。
 *   表本身没有父级（它是根）。
 */
const PARENT_DIMENSION = {
  [LEDGER_DIMENSIONS.COLUMN]: LEDGER_DIMENSIONS.TABLE,
  [LEDGER_DIMENSIONS.COLUMN_DEFAULT]: LEDGER_DIMENSIONS.TABLE,
  [LEDGER_DIMENSIONS.COLUMN_UNSIGNED]: LEDGER_DIMENSIONS.TABLE,
  [LEDGER_DIMENSIONS.COLUMN_ENUM]: LEDGER_DIMENSIONS.TABLE,
  [LEDGER_DIMENSIONS.INDEX]: LEDGER_DIMENSIONS.TABLE,
  [LEDGER_DIMENSIONS.FOREIGN_KEY]: LEDGER_DIMENSIONS.TABLE,
  [LEDGER_DIMENSIONS.UNIQUE]: LEDGER_DIMENSIONS.TABLE,
};

/**
 * **列的三个子维度**（默认值 / 无符号性 / 枚举）—— 它们的前提是「这一列本身对得上」。
 *
 * ⚠️ 为什么要单独标出来：列本身不一致时（如「迁移里没这一列」），
 *   静态层**判不了**这一列的默认值（列都不存在了），
 *   而库内层可能判得了 —— 那不是「库内层多判了」，
 *   而是**列本身**的结论已经解释了它。
 */
const COLUMN_SUB_DIMENSIONS = new Set([
  LEDGER_DIMENSIONS.COLUMN_DEFAULT,
  LEDGER_DIMENSIONS.COLUMN_UNSIGNED,
  LEDGER_DIMENSIONS.COLUMN_ENUM,
]);

/**
 * 取对象标识里的**表名**部分（父级对象的标识）。
 *
 * ⚠️ 对象标识的格式是 `表.其余`（唯一键是 `表.列1+列2`）——
 *   表名本身不含 `.`，所以按**第一个** `.` 切即可。
 */
function tableOf(object) {
  const index = object.indexOf('.');
  return index < 0 ? object : object.slice(0, index);
}

/* --------------------------- 跑两层取台账 --------------------------- */

/**
 * 跑一层校验器，取它的**结论台账**与**判定统计**。
 *
 * ⚠️ 为什么用**子进程**而不是 import：
 *   两层都是「跑一次就结束」的脚本（库内层还会连库），import 会把它们的
 *   `main()` 一起跑起来，且库内层在 import 时就会去连库。
 *   子进程跑法与 CI 里实际执行的方式**完全一致** ——
 *   对账的就是**门禁真正跑的那两份结论**。
 *
 * ⚠️ **两层各自的脚本，都要取「被对账的那份仓库」里的**：
 *   两层必须读**同一个** `--root` 下的实体 / 迁移 / 登记表 ——
 *   静态层读 `--root` 的实体与迁移，库内层读 `--root` 的实体与迁移，
 *   若有一层读的是别处的（比如本仓库），两层就在比**两份不同的代码**，
 *   比出来的「一致」是假的。
 *   库内层要 `mysql2`（`apps/api` 的依赖），副本里通常**没有** `node_modules` ——
 *   所以用 `NMG_MYSQL_PACKAGE_JSON` 把**带依赖的那个仓库**告诉它。
 *
 * @param {string} scriptName 脚本文件名
 */
function runLayer(scriptName) {
  // 优先用「被对账的那份仓库」里的脚本；没有就用本仓库的。
  const inRoot = path.join(ROOT, 'infra/scripts', scriptName);
  const scriptPath = fs.existsSync(inRoot) ? inRoot : path.join(SCRIPT_DIR, scriptName);
  const result = spawnSync(
    process.execPath,
    [scriptPath, '--root', ROOT, '--json'],
    {
      cwd: path.dirname(scriptPath),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        // 告诉库内层「mysql2 在哪找」——副本里没有 node_modules。
        NMG_MYSQL_PACKAGE_JSON: path.join(SCRIPT_DIR, '../../apps/api/package.json'),
      },
    },
  );

  if (result.error) {
    throw new Error(`${scriptName} 跑不起来：${result.error.message}`);
  }
  const stdout = (result.stdout ?? '').trim();
  if (!stdout) {
    throw new Error(
      `${scriptName} 没有输出（退出码 ${result.status}）：${(result.stderr ?? '').trim().slice(0, 400)}`,
    );
  }
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error(`${scriptName} 的输出不是合法 JSON（退出码 ${result.status}）`);
  }
  if (!Array.isArray(report.ledger)) {
    throw new Error(`${scriptName} 的 JSON 报告里没有 ledger 字段 —— 台账对账无从做起`);
  }

  // 台账按「维度 → 对象」归并（同一对象判多次取**最严重**的那条）。
  const byDimension = new Map();
  for (const item of report.ledger) {
    if (!byDimension.has(item.dimension)) byDimension.set(item.dimension, new Map());
    byDimension.get(item.dimension).set(item.object, item);
  }

  return { report, byDimension };
}

/* ------------------------------ 主流程 ------------------------------ */

function main() {
  const staticLayer = runLayer('check-error-semantics.mjs');
  const dbLayer = runLayer('check-db-reality.mjs');

  const findings = [];
  const dimensionStats = [];

  /* --- 1) 逐维度、逐对象比对两层的结论 ----------------------------------- */
  for (const dimension of RECONCILABLE_DIMENSIONS) {
    const staticObjects = staticLayer.byDimension.get(dimension) ?? new Map();
    const dbObjects = dbLayer.byDimension.get(dimension) ?? new Map();

    let agreed = 0;
    let conflicts = 0;
    let omissions = 0;
    let skippedDiverge = 0;

    // --- 交集：同一对象，两层都判了 -------------------------------------
    for (const [object, staticEntry] of staticObjects) {
      const dbEntry = dbObjects.get(object);
      if (!dbEntry) continue; // 缺判在下面统一处理
      const staticStatus = staticEntry.status;
      const dbStatus = dbEntry.status;

      if (staticStatus === dbStatus) {
        // ✅ 两层**同一个结论**（都一致 / 都不一致 / 都判不了）。
        // ⚠️ 「都不一致」也算**结论一致** —— 两层说的是**同一件事**：
        //   静态层说「实体与迁移对不上」，库内层说「实体与库对不上」；
        //   库是迁移建出来的，迁移与库本就该一致，
        //   所以「两层都判不一致」恰恰说明**迁移与库已经分叉**。
        //   那种分叉在**对象层**（列 / 索引 …）上会被报成矛盾 ——
        //   因为「静态层判迁移对不上」与「库内层判库对得上」正是矛盾。
        agreed += 1;
        continue;
      }

      // --- 两层结论不同 → 分叉 ------------------------------------------
      if (staticStatus === VERDICT.SKIPPED || dbStatus === VERDICT.SKIPPED) {
        // ⚠️ 一层「**判不了**」、另一层「**判了**」——
        //   这**不是**矛盾（没有互相打架），而是**覆盖面不同**：
        //   同一件事，一层跳过了、另一层判了。
        skippedDiverge += 1;
        const staticSkipped = staticStatus === VERDICT.SKIPPED;
        findings.push({
          kind: 'LAYER_SKIPPED_DIVERGENCE',
          where: `${dimension} ${object}`,
          detail:
            `${staticSkipped ? '静态层' : '库内层'}「**判不了**」（${(staticSkipped ? staticEntry : dbEntry).codes.join(' / ') || '无判定码'}），` +
            `${staticSkipped ? '库内层' : '静态层'}「**判了**」（${(staticSkipped ? dbEntry : staticEntry).codes.join(' / ') || '无判定码'}）—— ` +
            '两层的**判定覆盖面**不同：同一个对象，一层跳过了、另一层判了',
        });
        continue;
      }

      // --- 一层「一致」、另一层「不一致」→ 真正的矛盾 --------------------
      conflicts += 1;
      const staticOk = staticStatus === VERDICT.OK;
      const dbOk = dbStatus === VERDICT.OK;
      findings.push({
        kind: 'LAYER_VERDICT_CONFLICT',
        where: `${dimension} ${object}`,
        detail:
          `静态层判「**${staticOk ? '一致' : '不一致'}**」（${staticEntry.codes.join(' / ') || '无判定码'}），` +
          `库内层判「**${dbOk ? '一致' : '不一致'}**」（${dbEntry.codes.join(' / ') || '无判定码'}）—— ` +
          '两层对**同一个对象**给出了互相矛盾的结论：' +
          '要么其中一层解析错了，要么**迁移与真实的库已经不是一回事**' +
          '（迁移改过没重跑、或库被手工改过、或库不是按这份迁移建的）',
      });
    }

    // --- 一层判了、另一层没判 → 互相遗漏 --------------------------------
    const reportOmission = (missingLayerName, missingLayer, presentLayerName, presentEntry) => {
      // ⚠️ **已被父级结论解释的，不算遗漏**（否则同一个根因会被报两遍）：
      //   ① 缺判的那一层在这一维度上**已经**报了不一致
      //      （例：静态层判了「迁移里没这张表」，那它必然不判这张表的列）；
      //   ② 列的三个子维度（默认值 / 无符号性 / 枚举）——
      //      若缺判的那一层在**这一列本身**上已经报了不一致，
      //      那它「判不了默认值」是**列本身**的结论决定的，不是覆盖面分叉。
      const parentDimension = PARENT_DIMENSION[dimension];
      if (parentDimension) {
        const parentObject = tableOf(presentEntry.object);
        const parentEntry = missingLayer.byDimension.get(parentDimension)?.get(parentObject);
        if (parentEntry && parentEntry.status === 'MISMATCH') return null; // 已被父级解释
      }
      if (COLUMN_SUB_DIMENSIONS.has(dimension)) {
        const columnEntry = missingLayer.byDimension.get(LEDGER_DIMENSIONS.COLUMN)?.get(
          presentEntry.object,
        );
        if (columnEntry && columnEntry.status === 'MISMATCH') return null; // 已被列本身解释
      }
      omissions += 1;
      return {
        kind: 'LAYER_VERDICT_OMISSION',
        where: `${dimension} ${presentEntry.object}`,
        detail:
          `${presentLayerName}判了这一项（${presentEntry.codes.join(' / ') || '无判定码'}），` +
          `${missingLayerName}**压根没判这一项** —— ` +
          '一层**遗漏**了某个对象：两层的判定覆盖面分叉了' +
          '（要么某一层漏了这条判定路径，要么某一层多判了）',
      };
    };

    for (const [object, staticEntry] of staticObjects) {
      if (dbObjects.has(object)) continue;
      const finding = reportOmission('库内层', dbLayer, '静态层', staticEntry);
      if (finding) findings.push(finding);
    }
    for (const [object, dbEntry] of dbObjects) {
      if (staticObjects.has(object)) continue;
      const finding = reportOmission('静态层', staticLayer, '库内层', dbEntry);
      if (finding) findings.push(finding);
    }

    dimensionStats.push({
      dimension,
      staticJudged: staticObjects.size,
      dbJudged: dbObjects.size,
      agreed,
      conflicts,
      omissions,
      skippedDiverge,
    });
  }

  /* --- 2) 比对两层的判定统计（口径是否还一致） --------------------------- */
  const staticDimensions = staticLayer.report.dimensions ?? {};
  const dbDimensions = dbLayer.report.dimensions ?? {};
  const driftFindings = [];
  for (const key of ['default', 'unsigned', 'enum']) {
    const left = staticDimensions[key];
    const right = dbDimensions[key];
    if (!left || !right) continue;
    for (const field of ['checked', 'skipped', 'mismatch']) {
      if (left[field] === right[field]) continue;
      driftFindings.push({
        kind: 'LAYER_DIMENSION_STATS_DRIFT',
        where: `dimensions.${key}.${field}`,
        detail:
          `静态层 ${field}=${left[field]}，库内层 ${field}=${right[field]} —— ` +
          '两层的**判定口径**又分叉了（同一个维度上，两层判的列数不一样）',
      });
    }
  }
  findings.push(...driftFindings);

  /* --- 3) 判定码的**归属完整性**（每个判定码都有明确归属） ---------------- */
  //
  // ⚠️ 这一步查的是「**这一层能报出的每一个判定码**」，不是「这次报出来的」——
  //   静态扫源码，把每个 `issues.push({ kind: 'X' })` 的 `X` 拿出来，
  //   要求它要么落在**可对账的维度**上，要么落在**明确列出的「不跨层比」清单**里。
  //
  //   为什么要静态扫（而不是只看这次报出来的）：
  //     - 「这次报出来的」只在**已经有缺陷**时才看得到 ——
  //       门禁平时是绿的，那种检查**平时根本不生效**；
  //     - 静态扫能回答一个更要紧的问题：
  //       「这个判定码的结论，**跨层对账比得到吗**？」
  //       比不到 = 它的结论永远不会被另一层交叉验证 = **漏判**。
  //       新增一个判定码却忘了归维度，就是这种漏判。
  const unmappedFindings = [];
  for (const [layerName, scriptName, dimensionMap] of [
    ['静态层', 'check-error-semantics.mjs', STATIC_ISSUE_DIMENSION],
    ['库内层', 'check-db-reality.mjs', DB_ISSUE_DIMENSION],
  ]) {
    const scriptPath = path.join(ROOT, 'infra/scripts', scriptName);
    if (!fs.existsSync(scriptPath)) continue;
    const source = fs.readFileSync(scriptPath, 'utf8');
    // 只取 `issues.push` 里的判定码（`notes.push` 的是「判了没问题」的提示）。
    const codes = new Set();
    const codeRe = /issues\.push\(\{\s*\n\s*kind:\s*.([A-Z_]+)./g;
    let matched;
    while ((matched = codeRe.exec(source)) !== null) codes.add(matched[1]);
    for (const kind of codes) {
      if (dimensionMap[kind]) continue; // 已归维度 ✓
      if (NON_RECONCILABLE_CODES[kind]) continue; // 明确「不跨层比」✓
      unmappedFindings.push({
        kind: 'LAYER_ISSUE_CODE_UNMAPPED',
        where: `${layerName} ${kind}`,
        detail:
          `${layerName}能报出判定码 \`${kind}\`，但它**既没有归到任何维度**、` +
          '**也没有**列入「明确不跨层比」的清单 —— ' +
          '这个判定码的结论**永远不会被跨层对账比到**（漏判）：' +
          '要么给它归一个维度，要么明确写进清单说明「它本就不该跨层比」',
      });
    }
  }
  findings.push(...unmappedFindings);

  /* --- 4) 报告 ---------------------------------------------------------- */
  const report = {
    database: dbLayer.report.database ?? null,
    readOnlySession: dbLayer.report.readOnlySession ?? null,
    staticIssues: staticLayer.report.issues ?? null,
    dbIssues: dbLayer.report.issues ?? null,
    dimensions: dimensionStats,
    conflicts: findings.filter((item) => item.kind === 'LAYER_VERDICT_CONFLICT').length,
    omissions: findings.filter((item) => item.kind === 'LAYER_VERDICT_OMISSION').length,
    skippedDiverge: findings.filter((item) => item.kind === 'LAYER_SKIPPED_DIVERGENCE').length,
    statsDrift: driftFindings.length,
    unmappedCodes: unmappedFindings.length,
    findings: findings.length,
    detail: findings,
  };

  if (AS_JSON) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const finding of findings) {
      process.stdout.write(`❌ [${finding.kind}] ${finding.where}\n     ${finding.detail}\n`);
    }
    if (findings.length === 0) {
      process.stdout.write(
        `✅ 两层结论逐条一致：` +
          `${dimensionStats.length} 个维度、` +
          `${dimensionStats.reduce((total, item) => total + item.agreed, 0)} 个对象` +
          '静态层与库内层给出了**同一个结论**；' +
          '判定统计（判了多少 / 跳过多少 / 不一致多少）也逐项相同\n',
      );
    } else {
      process.stdout.write(
        `\n❌ 发现 ${findings.length} 处两层结论分叉` +
          `（矛盾 ${report.conflicts} / 遗漏 ${report.omissions} / ` +
          `覆盖面不同 ${report.skippedDiverge} / 口径统计漂移 ${report.statsDrift}）\n`,
      );
    }
  }

  process.exit(findings.length > 0 ? 1 : 0);
}

try {
  main();
} catch (error) {
  process.stderr.write(`两层结论对账失败：${error.message}\n`);
  process.exit(2);
}
