#!/usr/bin/env node
/**
 * 第 20 层校验：WXML 里**不得直接渲染原始时间戳字段**。
 *
 * ⚠️ 缺陷 #154（真机截图暴露的「显示 bug」）：
 *   页面上直接显示 `2026-01-08T08:00:00.000Z` 这种后端原始 ISO 串。
 *   根因不是「后端返回错了」—— DTO 里的时间字段本来就该是 ISO 串，
 *   是**展示层没有做格式化**：WXML 数据绑定只取值，不会调用 JS 函数，
 *   于是直接把 DTO 丢给 WXML 就等于把原始串显示给用户。
 *
 *   这个缺陷的特点是**静默的**：
 *   接口返回 200、类型检查通过、样式校验通过、单测全绿，
 *   只有真机截图才看得到 —— 也就是说，**没有任何既有校验层能发现它**。
 *
 *   本层的判定口径与运行时一致：
 *   WXML 里凡是出现 `xxxAt` 这类**原始时间字段**的插值，一律判失败；
 *   必须由 `src/utils/view.ts` 预先算好展示字段（`dateText` / `timeText`）再渲染。
 *
 *   注意白名单形如 `createdText` / `dateText` 的字段**不算违规** ——
 *   它们是格式化后的展示字段，与原始字段是两个不同的名字。
 *
 * 用法：node check-miniprogram-dates.mjs <小程序源码目录>
 * 退出码：0 全部通过；1 发现原始时间戳渲染
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const srcDir = resolve(process.argv[2] || 'apps/miniprogram/src');

/**
 * 原始时间字段名白名单。
 *
 * 只收 DTO 里**确实是时间戳**的字段；
 * 展示字段（dateText / timeText / updateText …）不在其中，天然不误报。
 */
const RAW_TIME_FIELDS = [
  'publishedAt',
  'createdAt',
  'updatedAt',
  'startsAt',
  'endsAt',
  'submittedAt',
  'decidedAt',
  'establishedAt',
  'verifiedAt',
  'lastLoginAt',
  'reviewedAt',
  'appliedAt',
  'registeredAt',
  'expiredAt',
  'deletedAt',
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (full.endsWith('.wxml')) out.push(full);
  }
  return out;
}

if (!statSync(srcDir, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`源码目录不存在：${srcDir}`);
  process.exit(1);
}

/** 取出所有 {{ ... }} 插值 */
function interpolations(text) {
  const out = [];
  const re = /\{\{([\s\S]*?)\}\}/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

const offenders = [];
for (const file of walk(srcDir)) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(srcDir, file);
  const lines = text.split('\n');

  lines.forEach((line, idx) => {
    for (const expr of interpolations(line)) {
      for (const field of RAW_TIME_FIELDS) {
        // 后面不能再跟标识符字符，避免把 createdAt 误判成 createdAtRaw 之类
        const re = new RegExp(`\\b${field}\\b(?![A-Za-z0-9_])`);
        if (re.test(expr)) {
          offenders.push({
            file: rel,
            line: idx + 1,
            field,
            expr: expr.trim(),
          });
        }
      }
    }
  });
}

if (offenders.length > 0) {
  console.error(`❌ 发现 ${offenders.length} 处原始时间戳渲染（应改用 utils/view.ts 的展示字段）：\n`);
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  [${o.field}]  {{${o.expr}}}`);
  }
  console.error(
    '\n修复方式：在页面 ts 里用 toArticleView / toEventView / toNoticeView 等映射函数' +
      '\n预先算好展示字段（dateText / timeText），WXML 只绑定展示字段。'
  );
  process.exit(1);
}

const count = walk(srcDir).length;
console.log(`✅ 时间戳渲染对账通过：${count} 个 WXML，无原始时间字段插值`);
process.exit(0);
