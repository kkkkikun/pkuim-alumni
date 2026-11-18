#!/usr/bin/env node
/**
 * 第 19 层校验：**类名对账** —— WXML 里用到的类，必须在某个 WXSS 里有定义。
 *
 * ⚠️ 缺陷 #154（真机「和 HTML 原型差很远」的根因）：
 *   小程序首页 WXML 用了 **32 个类**（.home / .hero* / .home-tabs / .shortcut* /
 *   .notice-row / .state-wrap / .loading-line …），
 *   而这些类**在所有 WXSS 里都没有定义** → 真机上页面上半部分全是**裸文字**，
 *   与 `prototype/html-v1` 的「精致」版本差得很远。
 *
 *   为什么没人发现：
 *   - 页面**能打开**、数据**能加载**（数据层没问题）；
 *   - 底部文章卡片、tabBar **有样式**（它们是自定义组件，各带自己的 wxss）
 *     → 一眼看过去「好像是有样式的」，只是上半截裸了；
 *   - 没有任何校验在问「这个类名有人管吗」。
 *
 * 判定口径：
 *   - 样式来源 = `app.wxss` + 该文件所在页面/组件的 wxss + 其 `@import` 的 wxss；
 *   - WXML 里的 `{{...}}` 模板表达式先剥掉再取类名；
 *   - 只认合法的类名 token（字母/数字/下划线/连字符，且以字母开头）。
 *
 * 用法：node check-miniprogram-styles.mjs <小程序源码目录>
 * 退出码：0 全部有样式；1 存在「用了没样式」的类
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, posix } from 'node:path';

const srcDir = resolve(process.argv[2] || 'apps/miniprogram/src');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

if (!statSync(srcDir, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`源码目录不存在：${srcDir}`);
  process.exit(1);
}

const all = walk(srcDir);
const rel = (f) => posix.relative(srcDir, f);

/** 解析一个 wxss 文件（含它 @import 的文件）里定义的全部类名 */
function classesOf(wxssFile, seen = new Set()) {
  const key = rel(wxssFile);
  if (seen.has(key)) return new Set();
  seen.add(key);
  const src = readFileSync(wxssFile, 'utf8');
  const classes = new Set();
  for (const m of src.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) classes.add(m[1]);
  // 跟随 @import
  for (const m of src.matchAll(/@import\s+["']([^"']+)["']/g)) {
    const target = resolve(dirname(wxssFile), m[1]);
    if (statSync(target, { throwIfNoEntry: false })?.isFile()) {
      for (const c of classesOf(target, seen)) classes.add(c);
    }
  }
  return classes;
}

const appWxss = resolve(srcDir, 'app.wxss');
const globalClasses = statSync(appWxss, { throwIfNoEntry: false })?.isFile()
  ? classesOf(appWxss)
  : new Set();

/** 页面/组件的 wxss（同名 index.wxss） */
function ownWxssOf(wxmlFile) {
  const candidate = wxmlFile.replace(/\.wxml$/, '.wxss');
  return statSync(candidate, { throwIfNoEntry: false })?.isFile() ? candidate : null;
}

const problems = [];
let checkedFiles = 0;
let checkedClasses = 0;

for (const wxml of all.filter((f) => f.endsWith('.wxml'))) {
  const text = readFileSync(wxml, 'utf8');
  const own = ownWxssOf(wxml);
  const known = new Set(globalClasses);
  if (own) for (const c of classesOf(own)) known.add(c);

  const used = new Set();
  for (const m of text.matchAll(/class="([^"]*)"/g)) {
    const raw = m[1];
    const value = raw.replace(/\{\{[^}]*\}\}/g, ' ');
    for (const token of value.split(/\s+/)) {
      if (!token) continue;
      /**
       * 动态类名：`class="tab-icon icon-{{item.icon}}"` →
       * 剥掉表达式后剩下 `icon-`（前缀），真正的类名运行时才拼出来。
       * 这类**不能按字面判定**，改为「有没有任何已定义的类以它开头」。
       */
      if (token.endsWith('-')) {
        used.add({ dynamic: token });
        continue;
      }
      if (!/^[a-zA-Z][\w-]*$/.test(token)) continue;
      used.add({ cls: token });
    }
  }
  checkedFiles++;
  for (const item of used) {
    checkedClasses++;
    if (item.dynamic) {
      // 前缀匹配：只要有一个已定义的类以它开头，就算有样式
      const hit = [...known].some((k) => k.startsWith(item.dynamic));
      if (!hit) problems.push({ file: rel(wxml), cls: `${item.dynamic}*（动态前缀）` });
      continue;
    }
    if (!known.has(item.cls)) {
      problems.push({ file: rel(wxml), cls: item.cls });
    }
  }
}

if (problems.length > 0) {
  console.error(`发现 ${problems.length} 处「WXML 用了、但没有任何 WXSS 定义」的类：`);
  const byFile = new Map();
  for (const p of problems) {
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file).push(p.cls);
  }
  for (const [file, list] of byFile) {
    console.error(`\n  ${file}  （${list.length} 个）`);
    console.error(`    ${list.join(', ')}`);
  }
  console.error('\n这些元素在真机上会渲染成「没有样式的裸文字」。');
  console.error('修法：把样式补到该页面的 index.wxss，或加进 app.wxss / styles/blocks.wxss（再 @import 进来）。');
  process.exit(1);
}

console.log(
  `✅ 类名对账通过：${checkedFiles} 个 WXML、${checkedClasses} 处类名引用，全部有对应的 WXSS 定义`
);
process.exit(0);
