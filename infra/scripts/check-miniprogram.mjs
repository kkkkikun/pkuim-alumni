#!/usr/bin/env node
/**
 * 小程序静态校验器。
 *
 * 背景：小程序尚未在微信开发者工具中运行（需真实 AppID），因此「编译通过」不等于
 * 「运行不报错」。小程序有一类**运行期才暴露、且不报错只是没反应**的缺陷，
 * tsc 完全查不出来：
 *   - 页面没在 app.json 注册 → 导航过去白屏；
 *   - 导航目标写错 / 路径不存在 → 跳转失败；
 *   - WXML 绑定了页面上不存在的方法 → 点击无反应；
 *   - WXML 读了页面上不存在的 data 字段 → 永远空白；
 *   - usingComponents 指向不存在的组件 → 组件渲染失败；
 *   - 从 services 引入不存在的导出 → 运行期 undefined。
 *
 * 本脚本对 `apps/miniprogram/src` 做全量静态交叉校验，任何一项不通过即以非 0 退出。
 *
 * 用法：
 *   node infra/scripts/check-miniprogram.mjs [--root <repo>] [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/* ------------------------------ 参数 ------------------------------ */

function parseArgs(argv) {
  const args = { root: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--root') args.root = argv[++i];
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log('用法: node infra/scripts/check-miniprogram.mjs [--root <repo>] [--json]');
  process.exit(0);
}

const ROOT = path.resolve(args.root);
const APP_DIR = path.join(ROOT, 'apps/miniprogram/src');

const errors = [];
const warnings = [];
const stats = {};

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function walk(dir, filter, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}

const rel = (file) => path.relative(ROOT, file);

/* ------------------------------ app.json ------------------------------ */

const appJsonRaw = readFileSafe(path.join(APP_DIR, 'app.json'));
if (!appJsonRaw) {
  console.error('找不到 apps/miniprogram/src/app.json');
  process.exit(2);
}
const appJson = JSON.parse(appJsonRaw);
const declaredPages = (appJson.pages ?? []).map((p) => p.replace(/^\//, ''));
const tabBarPages = new Set((appJson.tabBar?.list ?? []).map((item) => item.pagePath.replace(/^\//, '')));

/* ------------------------------ 页面集合 ------------------------------ */

const pageWxmlFiles = walk(path.join(APP_DIR, 'pages'), (n) => n.endsWith('.wxml'));
const componentWxmlFiles = walk(path.join(APP_DIR, 'components'), (n) => n.endsWith('.wxml'));
const customTabBarWxml = path.join(APP_DIR, 'custom-tab-bar/index.wxml');

/** 页面目录 → 该页面的 TS / WXML / JSON */
function pageFiles(pageDir) {
  return {
    ts: path.join(APP_DIR, `${pageDir}.ts`),
    wxml: path.join(APP_DIR, `${pageDir}.wxml`),
    json: path.join(APP_DIR, `${pageDir}.json`),
  };
}

/* ---------------- 1. 页面注册完整性 ---------------- */

for (const page of declaredPages) {
  const files = pageFiles(page);
  if (!fs.existsSync(files.ts)) {
    errors.push({ kind: 'PAGE_MISSING_TS', message: `app.json 注册了 ${page}，但缺少 .ts 文件` });
  }
  if (!fs.existsSync(files.wxml)) {
    errors.push({ kind: 'PAGE_MISSING_WXML', message: `app.json 注册了 ${page}，但缺少 .wxml 文件` });
  }
}

const declaredSet = new Set(declaredPages);
for (const wxml of pageWxmlFiles) {
  const dir = path
    .relative(APP_DIR, wxml)
    .replace(/\\/g, '/')
    .replace(/\.wxml$/, '');
  if (!declaredSet.has(dir)) {
    errors.push({
      kind: 'PAGE_NOT_REGISTERED',
      message: `页面 ${dir} 未在 app.json 的 pages[] 中注册（无法被导航到）`,
    });
  }
}

/* ---------------- 2. TS 解析工具 ---------------- */

/** 取 `Page({...})` / `Component({...})` 对象的成员名（顶层） */
function extractTopLevelMembers(source) {
  const members = new Set();
  // 顶层成员缩进为 2 空格：`  onLoad(): void {` / `  data: {`
  const re = /^ {2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*[:(]/gm;
  let match;
  while ((match = re.exec(source)) !== null) {
    members.add(match[1]);
  }
  return members;
}

/** 取 `methods: { ... }` / `properties: { ... }` 对象的顶层键 */
function extractBlockKeys(source, blockName) {
  const match = new RegExp(`\\b${blockName}\\s*:\\s*\\{`).exec(source);
  if (!match) return new Set();
  const start = source.indexOf('{', match.index);
  if (start < 0) return new Set();
  let depth = 0;
  let quote = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return extractObjectKeys(source.slice(start, i + 1));
    }
  }
  return new Set();
}

/** 取对象字面量的顶层键 */
function extractObjectKeys(rawText) {
  // 先去掉注释，否则注释里的字符会被误当成键的一部分（导致后面的键漏采）
  const objectText = rawText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const keys = new Set();
  let depth = 0;
  let quote = null;
  let expectKey = true;
  for (let i = 0; i < objectText.length; i += 1) {
    const ch = objectText[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth += 1;
      if (depth === 1) expectKey = true;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth -= 1;
      continue;
    }
    if (depth === 1) {
      if (ch === ',') {
        expectKey = true;
        continue;
      }
      if (expectKey) {
        if (/[A-Za-z_$]/.test(ch)) {
          let j = i;
          while (j < objectText.length && /[\w$]/.test(objectText[j])) j += 1;
          keys.add(objectText.slice(i, j));
          i = j - 1;
          expectKey = false;
          continue;
        }
        if (!/\s/.test(ch)) expectKey = false;
      }
    }
  }
  return keys;
}

/** 找 `data: { ... }` 的完整对象文本（含花括号） */
function extractDataObject(source) {
  const match = /\bdata\s*:\s*\{/.exec(source);
  if (!match) return '';
  const start = source.indexOf('{', match.index);
  if (start < 0) return '';
  let depth = 0;
  let quote = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return '';
}

/** 找所有 `setData({...})` 的键 */
function extractSetDataKeys(source) {
  const keys = new Set();
  const re = /setData\s*\(/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const start = source.indexOf('{', match.index);
    if (start < 0) continue;
    let depth = 0;
    let quote = null;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          for (const key of extractObjectKeys(source.slice(start, i + 1))) keys.add(key);
          break;
        }
      }
    }
  }
  return keys;
}

/* ---------------- 3. WXML 解析工具 ---------------- */

const WXML_KEYWORDS = new Set([
  'true', 'false', 'null', 'undefined', 'this', 'item', 'index', 'value', 'true',
]);

/** 事件绑定：bindtap="x" / bind:retry="x" / catchtap="x" */
function extractEventHandlers(wxml) {
  const handlers = new Set();
  const re = /\b(?:bind|catch)(?::)?[a-zA-Z-]+\s*=\s*"([^"{}\s]+)"/g;
  let match;
  while ((match = re.exec(wxml)) !== null) handlers.add(match[1]);
  return handlers;
}

/** {{ }} 表达式中的顶层标识符 */
function extractTemplateIdentifiers(wxml) {
  const ids = new Set();
  const re = /\{\{([\s\S]*?)\}\}/g;
  let match;
  while ((match = re.exec(wxml)) !== null) {
    let expr = match[1];
    // 去掉字符串字面量
    expr = expr.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
    // 去掉属性访问的右侧（.foo）
    expr = expr.replace(/\.\s*[A-Za-z_$][\w$]*/g, '');
    const idRe = /[A-Za-z_$][\w$]*/g;
    let idMatch;
    while ((idMatch = idRe.exec(expr)) !== null) {
      const name = idMatch[0];
      if (!WXML_KEYWORDS.has(name)) ids.add(name);
    }
  }
  return ids;
}

/** wx:for 的循环变量 */
function extractLoopVars(wxml) {
  const vars = new Set(['item', 'index']);
  const re = /wx:for-(?:item|index)\s*=\s*"([^"]+)"/g;
  let match;
  while ((match = re.exec(wxml)) !== null) vars.add(match[1]);
  return vars;
}

/* ---------------- 4. 逐页校验 ---------------- */

const NAV_RE =
  /(?:navigateTo|redirectTo|switchTab|reLaunch)\s*\(\s*\{[\s\S]{0,200}?url\s*:\s*[`'"]([^`'"]+)[`'"]/g;

function checkTarget(fromPage, target, api) {
  const clean = target.split('?')[0].split('#')[0];
  if (!clean) return null;
  let resolved;
  if (clean.startsWith('/')) {
    resolved = clean.replace(/^\//, '');
  } else if (clean.startsWith('.')) {
    resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromPage), clean));
  } else {
    return { dynamic: true };
  }
  if (!declaredSet.has(resolved)) {
    return { missing: resolved };
  }
  if (api === 'switchTab' && !tabBarPages.has(resolved)) {
    return { notTab: resolved };
  }
  return null;
}

/**
 * 共享 helper（如 utils/dialog.ts）会通过 `page.setData({...})` 写入页面字段，
 * 这些字段不在页面自己的 TS 里，需要单独收集，避免误报。
 */
const sharedSetDataKeys = new Set();
for (const file of walk(path.join(APP_DIR, 'utils'), (n) => n.endsWith('.ts'))) {
  const source = readFileSafe(file);
  if (!source) continue;
  for (const key of extractSetDataKeys(source)) sharedSetDataKeys.add(key);
}

let handlerCount = 0;
let identifierCount = 0;

for (const wxmlFile of [...pageWxmlFiles, ...componentWxmlFiles, customTabBarWxml]) {
  const wxml = readFileSafe(wxmlFile);
  if (!wxml) continue;
  const isComponent = wxmlFile.includes(`${path.sep}components${path.sep}`);
  const base = path
    .relative(APP_DIR, wxmlFile)
    .replace(/\\/g, '/')
    .replace(/\.wxml$/, '');
  const tsFile = path.join(APP_DIR, `${base}.ts`);

  /* 4.1 事件处理函数是否存在于对应 TS */
  const ts = readFileSafe(tsFile);
  if (!ts) {
    errors.push({ kind: 'WXML_WITHOUT_TS', message: `${base}.wxml 没有对应的 .ts 文件`, file: rel(wxmlFile) });
    continue;
  }
  const members = extractTopLevelMembers(ts);
  for (const name of extractBlockKeys(ts, 'methods')) members.add(name);
  for (const handler of extractEventHandlers(wxml)) {
    handlerCount += 1;
    if (!members.has(handler)) {
      errors.push({
        kind: 'HANDLER_MISSING',
        message: `${base}.wxml 绑定了 ${handler}，但 ${base}.ts 中没有同名方法`,
        file: rel(wxmlFile),
      });
    }
  }

  /* 4.2 WXML 使用的 data 字段是否存在 */
  const dataObject = extractDataObject(ts);
  const known = new Set([
    ...extractObjectKeys(dataObject),
    ...extractSetDataKeys(ts),
    ...extractBlockKeys(ts, 'properties'),
    ...sharedSetDataKeys,
  ]);
  const loopVars = extractLoopVars(wxml);
  for (const id of extractTemplateIdentifiers(wxml)) {
    if (loopVars.has(id)) continue;
    identifierCount += 1;
    if (!known.has(id)) {
      warnings.push({
        kind: 'DATA_FIELD_UNKNOWN',
        message: `${base}.wxml 引用了 ${id}，但 ${base}.ts 的 data / setData 中没有该字段`,
        file: rel(wxmlFile),
      });
    }
  }

  /* 4.4 usingComponents 指向是否存在 */
  const jsonFile = path.join(APP_DIR, `${base}.json`);
  const jsonRaw = readFileSafe(jsonFile);
  if (jsonRaw) {
    try {
      const pageJson = JSON.parse(jsonRaw);
      for (const [name, target] of Object.entries(pageJson.usingComponents ?? {})) {
        const resolved = path.resolve(path.dirname(jsonFile), `${target}.wxml`);
        if (!fs.existsSync(resolved)) {
          errors.push({
            kind: 'COMPONENT_MISSING',
            message: `${base}.json 的 usingComponents.${name} → ${target} 不存在`,
            file: rel(jsonFile),
          });
        }
      }
    } catch (error) {
      errors.push({ kind: 'PAGE_JSON_INVALID', message: `${base}.json 解析失败：${error.message}` });
    }
  }
}

/* ---------------- 4.4 全局页面路径字面量校验 ---------------- */

/**
 * 小程序的跳转地址有三种来源：直接 `wx.navigateTo({url})`、`utils/navigate.ts` 的
 * URL 构造函数、以及页面内的路由表对象。逐个页面找调用点会漏掉后两种，
 * 因此这里直接扫描**全部** TS 源码里的 `/pages/...` 字面量。
 */
const PAGE_LITERAL_RE = /['"`](\/pages\/[A-Za-z0-9_\-/]*)['"`]/g;
const SWITCH_TAB_RE = /(?:wx\.)?switchTab\s*\(\s*(?:\{\s*url\s*:\s*)?['"`]([^'"`]+)['"`]/g;

let pageLiteralCount = 0;
for (const tsFile of walk(APP_DIR, (n) => n.endsWith('.ts'))) {
  const source = readFileSafe(tsFile);
  if (!source) continue;
  PAGE_LITERAL_RE.lastIndex = 0;
  let literal;
  while ((literal = PAGE_LITERAL_RE.exec(source)) !== null) {
    const target = literal[1].replace(/^\//, '').replace(/\/$/, '');
    pageLiteralCount += 1;
    if (!declaredSet.has(target)) {
      errors.push({
        kind: 'NAV_TARGET_MISSING',
        message: `${rel(tsFile)} 中的跳转地址 ${target} 未在 app.json 的 pages[] 中注册`,
        file: rel(tsFile),
      });
    }
  }
  SWITCH_TAB_RE.lastIndex = 0;
  let tab;
  while ((tab = SWITCH_TAB_RE.exec(source)) !== null) {
    const target = tab[1].split('?')[0].replace(/^\//, '').replace(/\/$/, '');
    if (target && !tabBarPages.has(target)) {
      errors.push({
        kind: 'NAV_NOT_TAB',
        message: `${rel(tsFile)} 用 switchTab 跳到 ${target}，但它不是 tabBar 页面`,
        file: rel(tsFile),
      });
    }
  }
}
stats.pageLiterals = pageLiteralCount;

/* ---------------- 5. 服务层导出校验 ---------------- */

const servicesDir = path.join(APP_DIR, 'services');
const serviceFiles = fs.existsSync(servicesDir)
  ? fs.readdirSync(servicesDir).filter((n) => n.endsWith('.ts') && n !== 'index.ts')
  : [];

/** 收集服务模块的所有导出名 */
const serviceExports = new Map();
for (const file of serviceFiles) {
  const source = readFileSafe(path.join(servicesDir, file));
  const names = new Set();
  const re = /export\s+(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  let match;
  while ((match = re.exec(source)) !== null) names.add(match[1]);
  serviceExports.set(file.replace(/\.ts$/, ''), names);
}

/** 页面/组件从 services 引入的名字必须真实存在 */
const allServiceNames = new Set();
for (const names of serviceExports.values()) for (const n of names) allServiceNames.add(n);

for (const tsFile of walk(APP_DIR, (n) => n.endsWith('.ts'))) {
  const source = readFileSafe(tsFile);
  if (!source) continue;
  const re = /import\s*\{([^}]*)\}\s*from\s*'([^']*services[^']*)'/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!allServiceNames.has(name)) {
        errors.push({
          kind: 'SERVICE_EXPORT_MISSING',
          message: `${rel(tsFile)} 从 services 引入了 ${name}，但服务层没有这个导出`,
          file: rel(tsFile),
        });
      }
    }
  }
}

/* ---------------- 6. services 桶文件是否导出了全部模块 ---------------- */

const barrel = readFileSafe(path.join(servicesDir, 'index.ts')) ?? '';
for (const mod of serviceExports.keys()) {
  if (!new RegExp(`export\\s*\\*\\s*from\\s*['"]\\./${mod}['"]`).test(barrel)) {
    errors.push({
      kind: 'SERVICE_BARREL_MISSING',
      message: `services/index.ts 没有导出 ./${mod}`,
      file: 'apps/miniprogram/src/services/index.ts',
    });
  }
}

/* ---------------- 7. tabBar / 自定义 tabBar ---------------- */

for (const tab of appJson.tabBar?.list ?? []) {
  if (!declaredSet.has(tab.pagePath)) {
    errors.push({
      kind: 'TABBAR_PAGE_MISSING',
      message: `tabBar 指向 ${tab.pagePath}，但该页面未在 app.json 注册`,
    });
  }
}
if (appJson.tabBar?.custom && !fs.existsSync(customTabBarWxml)) {
  errors.push({
    kind: 'CUSTOM_TABBAR_MISSING',
    message: 'app.json 声明 custom tabBar，但缺少 custom-tab-bar/index.wxml',
  });
}

/* ---------------- 输出 ---------------- */

stats.pages = declaredPages.length;
stats.pageWxml = pageWxmlFiles.length;
stats.components = componentWxmlFiles.length;
stats.eventBindings = handlerCount;
stats.templateIdentifiers = identifierCount;
stats.serviceModules = serviceExports.size;

if (args.json) {
  console.log(JSON.stringify({ stats, errors, warnings }, null, 2));
} else {
  console.log('=== 小程序静态校验 ===');
  console.log(
    `页面 ${stats.pages} 个 / 组件 ${stats.components} 个 / 事件绑定 ${stats.eventBindings} 处 / 模板字段引用 ${stats.templateIdentifiers} 处 / 服务模块 ${stats.serviceModules} 个`,
  );
  if (warnings.length) {
    console.log(`\n-- 警告 ${warnings.length} 条 --`);
    for (const item of warnings) console.log(`  [WARN] ${item.kind} ${item.message}`);
  }
  if (errors.length) {
    console.log(`\n-- 错误 ${errors.length} 条 --`);
    for (const item of errors) console.log(`  [ERROR] ${item.kind} ${item.message}`);
  } else {
    console.log('\n未发现静态一致性问题。');
  }
}

process.exit(errors.length ? 1 : 0);
