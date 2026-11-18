#!/usr/bin/env node
/**
 * 第 18 层校验：源码里**不得出现指向目录的 import**。
 *
 * ⚠️ 缺陷 #153（真机白屏的**真根因**）：
 *   微信小程序的运行时**不做「目录 → index.js」的回退**。
 *   源码里写 `import ... from '../../../services'`，
 *   编译产物里就是 `require("../../../services")`，
 *   真机运行时会把它解析成模块 `services.js` —— **找不到**：
 *
 *     MiniProgramError
 *     module 'services.js' is not defined, require args is '../../../services'
 *
 *   → 页面 JS 加载失败 → **页面全白**；
 *     而自定义 tabBar 没有 import，能正常渲染 →
 *     现场表现为「**只剩底部 tabBar 的文字，图标和页面内容全没有**」，
 *     极具迷惑性（连我都被带着先怀疑了打包完整性）。
 *
 *   编译器的离线自检**查不出它**：
 *   - 「源模块 1:1 入包」查的是**文件在不在包里** —— `services/index.js` 确实在；
 *   - 「产物里每条 require 都能解析」查的是**按 Node 规则能不能解析** —— 也能解析；
 *   - 只有**微信运行时自己的规则**（目录不回落 index）才会失败。
 *
 *   所以这一层必须**在源码层**查：凡是指向目录的相对 import，一律判失败。
 *
 * 用法：node check-miniprogram-imports.mjs <小程序源码目录>
 * 退出码：0 全部通过；1 发现目录导入
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, posix } from 'node:path';

const srcDir = resolve(process.argv[2] || 'apps/miniprogram/src');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

if (!statSync(srcDir, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`源码目录不存在：${srcDir}`);
  process.exit(1);
}

const files = walk(srcDir);
/**
 * 所有「目录」：里面存在 index.ts 的路径。
 * ⚠️ 必须存**相对 srcDir 的路径** —— 与下面 target 的相对路径口径一致，
 *    否则两边永远对不上，校验器会变成「恒过」（反向验证当场抓过这个坑）。
 */
const directorySet = new Set(
  files
    .filter((f) => f.endsWith(`${posix.sep}index.ts`))
    .map((f) => posix.relative(srcDir, f).slice(0, -'index.ts'.length).replace(/\/$/, ''))
);

/** 相对路径的 import / require 字面量 */
const SPEC_RE = /(['"])(\.\.?\/[^'"]+)\1/g;

const offenders = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const rel = file.slice(srcDir.length + 1);
  for (const m of text.matchAll(SPEC_RE)) {
    const spec = m[2];
    const target = posix.normalize(posix.join(posix.dirname(rel), spec));
    if (directorySet.has(target)) {
      offenders.push({ file: rel, spec, target });
    }
  }
}

if (offenders.length > 0) {
  console.error(
    `发现 ${offenders.length} 处指向目录的 import —— 微信运行时不做 index 回退，真机上会直接白屏：`
  );
  const grouped = new Map();
  for (const o of offenders) {
    if (!grouped.has(o.target)) grouped.set(o.target, []);
    grouped.get(o.target).push(o);
  }
  for (const [target, list] of grouped) {
    console.error(`\n  ${target}/  （${list.length} 处）`);
    for (const o of list.slice(0, 3)) {
      console.error(`    ${o.file}  →  '${o.spec}'   应写成 '${o.spec}/index'`);
    }
    if (list.length > 3) console.error(`    …… 还有 ${list.length - 3} 处`);
  }
  console.error('\n修法：把目录导入改成显式指向 index 文件（services → services/index）。');
  process.exit(1);
}

console.log(`✅ 目录导入检查通过：${files.length} 个源文件，0 处指向目录的 import`);
process.exit(0);
