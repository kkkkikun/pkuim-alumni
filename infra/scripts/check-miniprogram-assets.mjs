#!/usr/bin/env node
/**
 * 第 21 层校验：小程序**本地图片资源引用必须有效**，且**不得再有单字占位图标**。
 *
 * ⚠️ 缺陷 #154（用户反馈「细节没有 HTML 那么精致」的真根因之一）：
 *   小程序端**不支持 SVG data URI**（WXSS 里 `url("data:image/svg+xml,...")`
 *   在真机上不渲染），所以原型的 Feather 风格描边图标与塔楼线描插画
 *   必须先栅格化成 PNG 才能用。
 *
 *   但项目此前**根本没有图片资源**，所有图标都是：
 *     - 用 CSS 伪元素手绘的三角形 / 圆圈（tabBar）；
 *     - 直接拿一个汉字当图标（首页快捷入口「人/连/历/燕」、
 *       我的页菜单「名/历/连/知/发/隐/燕/设」、通知类型「认/连/审/活/通」）。
 *   两者都与原型对不上 —— 原型是 `stroke="currentColor"` 的描边 SVG。
 *
 *   这类缺陷同样是**静默的**：不报错、不断言失败、不影响任何接口，
 *   只有真机截图才看得出来。
 *
 * 本层的两条判定：
 *   1) WXML / WXSS 里引用的每一个本地图片路径，**磁盘上必须真的存在** ——
 *      不存在的路径在真机上表现为「图标位置一片空白」，不会报任何错；
 *   2) 不允许再有「用单个汉字冒充图标」的写法 ——
 *      类名带 icon / glyph / shield / badge / mark / symbol 的 `<text>`
 *      如果内容是单个汉字，一律判失败。
 *
 * 用法：node check-miniprogram-assets.mjs <小程序源码目录>
 * 退出码：0 全部通过；1 发现资产引用失效或残留占位图标
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

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

const allFiles = walk(srcDir);
const offenders = [];

/* ---------------------------------------------------------------- 1. 资源引用 */

const problems = [];

/** WXML：<image src="..."> / <video poster> 等本地图片引用 */
const WXML_SRC_RE = /<(?:image|video|cover-image)\b[^>]*?\bsrc\s*=\s*"([^"]+)"/g;
/** WXSS：background-image: url(...) */
const WXSS_URL_RE = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
/** TS：形如 '/assets/icons/xxx.png' 的字面量（动态 src 的真实取值来源） */
const TS_ASSET_RE = /['"](\/assets\/[^'"]+?)['"]/g;

/** 解析引用路径 → 磁盘绝对路径 */
function resolveRef(fromFile, ref) {
  // 远程地址、base64、内联 svg 一律不管
  if (/^(https?:)?\/\//.test(ref) || ref.startsWith('data:') || ref.startsWith('blob:')) return null;
  if (ref.startsWith('/')) return resolve(srcDir, `.${ref}`);
  return resolve(dirname(fromFile), ref);
}

for (const file of allFiles) {
  const rel = relative(srcDir, file);
  const text = readFileSync(file, 'utf8');

  const check = (ref, kind, lineNo) => {
    const target = resolveRef(file, ref);
    if (!target) return;
    if (!existsSync(target)) {
      problems.push({ kind, file: rel, line: lineNo, ref, target: relative(srcDir, target) });
    }
  };

  if (file.endsWith('.wxml')) {
    let m;
    WXML_SRC_RE.lastIndex = 0;
    while ((m = WXML_SRC_RE.exec(text)) !== null) {
      const ref = m[1].trim();
      // 动态 src（{{...}}）无法静态解析 —— 它的取值由 TS 里的字面量决定，
      // 由下面的 TS_ASSET_RE 规则统一兜底。
      if (ref.includes('{{')) continue;
      check(ref, 'wxml', text.slice(0, m.index).split('\n').length);
    }
  } else if (file.endsWith('.wxss')) {
    let m;
    WXSS_URL_RE.lastIndex = 0;
    while ((m = WXSS_URL_RE.exec(text)) !== null) {
      const ref = m[1].trim();
      if (ref.includes('{{')) continue;
      check(ref, 'wxss', text.slice(0, m.index).split('\n').length);
    }
  } else if (file.endsWith('.ts')) {
    let m;
    TS_ASSET_RE.lastIndex = 0;
    while ((m = TS_ASSET_RE.exec(text)) !== null) {
      const ref = m[1].trim();
      check(ref, 'ts', text.slice(0, m.index).split('\n').length);
    }
  }
}

/* ------------------------------------------------- 2. 单字占位图标 */

const PLACEHOLDER_CLASS_RE = /(^|[-_])(icon|glyph|shield|badge|mark|symbol)([-_]|$)/;
const TEXT_TAG_RE = /<text\b([^>]*)>([^<]*)<\/text>/g;
const CLASS_RE = /class\s*=\s*"([^"]*)"/;
const CJK_SINGLE_RE = /^[一-龥]{1,2}$/;

for (const file of allFiles) {
  if (!file.endsWith('.wxml')) continue;
  const rel = relative(srcDir, file);
  const text = readFileSync(file, 'utf8');
  let m;
  while ((m = TEXT_TAG_RE.exec(text)) !== null) {
    const attrs = m[1] || '';
    const content = (m[2] || '').trim();
    if (!content) continue;
    const classMatch = CLASS_RE.exec(attrs);
    if (!classMatch) continue;
    const classes = classMatch[1].split(/\s+/);
    if (!classes.some((c) => PLACEHOLDER_CLASS_RE.test(c))) continue;
    if (!CJK_SINGLE_RE.test(content)) continue;
    const lineNo = text.slice(0, m.index).split('\n').length;
    offenders.push({
      file: rel,
      line: lineNo,
      detail: `<text class="${classMatch[1]}">${content}</text>`,
    });
  }
}

/* ---------------------------------------------------------------- 汇总 */

if (problems.length > 0) {
  console.error(`❌ 发现 ${problems.length} 处失效的本地图片引用：\n`);
  for (const p of problems) {
    console.error(`  ${p.file}:${p.line}  ${p.kind} → ${p.ref}  (期望存在：${p.target})`);
  }
  console.error('');
}

if (offenders.length > 0) {
  console.error(`❌ 发现 ${offenders.length} 处「单字占位图标」：\n`);
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  ${o.detail}`);
  }
  console.error('\n占位图标应换成 /assets/icons/ 下的 SVG 栅格化 PNG（见 infra/scripts/generate-miniprogram-assets.py）。');
  console.error('');
}

if (problems.length > 0 || offenders.length > 0) {
  process.exit(1);
}

const pngCount = allFiles.filter((f) => f.endsWith('.png')).length;
console.log(
  `✅ 资产对账通过：${allFiles.filter((f) => f.endsWith('.wxml')).length} 个 WXML / ` +
    `${allFiles.filter((f) => f.endsWith('.wxss')).length} 个 WXSS 的图片引用全部有效，` +
    `无单字占位图标（本地 PNG ${pngCount} 个）`
);
process.exit(0);
