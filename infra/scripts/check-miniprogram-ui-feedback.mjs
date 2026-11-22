#!/usr/bin/env node
/**
 * 第 23 层校验：**真机反馈回归守卫**。
 *
 * ⚠️ 缺陷 #161（2026-11-22 客户真机体验，12 张截图）：
 *   客户在真机上一次性报了 4 类问题，而**当时 24 步回归链全绿**：
 *     1. 输入框里的文字被**垂直裁切**（下半截看不见）；
 *     2. 底部固定按钮**压住了正文**（最后一段说明文字、最后一个输入框被盖住）；
 *     3. 筛选 / 搜索**看起来完全不生效**（标签变了、列表没变、计数也没变）；
 *     4. 筛选过一次再取消，页面**卡在空列表**出不来。
 *
 *   这四类问题的共同点：**都不违反任何契约**。
 *   接口 200、类型检查过、样式校验过、单元测试全绿、24 步回归链全绿 ——
 *   因为「文字被裁掉一截」「按钮压住最后一段」「筛选后列表没刷新」
 *   在机器上都是**合法的**，只有人拿在手里才能看出来。
 *   所以必须有**一层专门盯这些的校验**，否则下次改样式/改页面又会漏。
 *
 * 本层的判定口径（与真机截图一一对应）：
 *   R1 凡用到底部固定栏（.fixed-bar）的页面，正文必须留出底栏高度；
 *   R2 单行输入框必须有显式 height + line-height，且不得有纵向 padding；
 *   R3 通讯录 / 连接列表页在「筛选条件变化」后必须重新拉数据；
 *   R4 列表为空时必须提供「清空筛选条件」的出路；
 *   R5 生效中的筛选条件必须在页面上**看得见**（年份 / 类型不能是幽灵条件）；
 *   R6 演示数据里，地区字典的每一个地区都至少要有 1 条资源。
 *
 * ⚠️ 第二轮真机反馈（2026-11-22 16:29 / 16:31，3 张截图）追加三条：
 *   R7 校友认证页底部的两个按钮必须**左右并排**（上下堆叠显得笨重）；
 *   R8 连接栏目的二级筛选页**不得再出现「信息类型」**（列表页已有 chip，重复入口）；
 *   R9 连接栏目的行业筛选必须**收进二级筛选页**，列表页只保留一个可见的行业入口。
 *
 * 用法：node check-miniprogram-ui-feedback.mjs <小程序源码目录>
 * 退出码：0 全部通过；1 发现真机可见问题
 */

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

const srcDir = resolve(process.argv[2] || 'apps/miniprogram/src');
const appWxss = resolve(srcDir, 'app.wxss');
const datasetFile = resolve(srcDir, 'demo/dataset.data.ts');
const filterUtil = resolve(srcDir, 'utils/filter.ts');

if (!statSync(srcDir, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`源码目录不存在：${srcDir}`);
  process.exit(1);
}
for (const f of [appWxss, datasetFile, filterUtil]) {
  if (!statSync(f, { throwIfNoEntry: false })?.isFile()) {
    console.error(`必需文件不存在：${f}`);
    process.exit(1);
  }
}

/** 违例清单 */
const offenders = [];

function add(rule, message, detail) {
  offenders.push({ rule, message, detail });
}

/** 递归收集目录下所有文件 */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

/** 取出 CSS 规则块的内容（按选择器匹配） */
function cssBlock(css, selector) {
  const re = new RegExp(`(^|[}\\s])${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
  const m = css.match(re);
  return m ? m[2] : null;
}

/**
 * 读取 WXML 源码并**剥掉注释**。
 *
 * ⚠️ 为什么要剥：页面上经常用注释记录「这里原来是什么、为什么这么改」，
 *   注释里出现「信息类型」「按行业方向查看」这类字眼是**正常的**。
 *   如果校验器直接对原文做子串匹配，就会把注释当成页面内容 → 误报。
 *   注释不是用户能看到的界面，必须先剥掉再判断。
 */
function readWxml(file) {
  return readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
}

/** 读取 TS 源码并剥掉注释（块注释 + 行注释） */
function readTs(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

/**
 * 取出 WXML 里某个 class 的所有 `<view>` 块（按标签配对，支持嵌套）。
 * 用来判断「某个结构是不是在另一个结构里面」，而不是只做子串匹配。
 */
function extractViewBlocks(text, className) {
  const re = new RegExp(`<view class="${className}"[^>]*>`, 'g');
  const blocks = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    const tagRe = /<view\b[^>]*>|<\/view>/g;
    tagRe.lastIndex = match.index + match[0].length;
    let depth = 1;
    let tag;
    while ((tag = tagRe.exec(text)) !== null) {
      if (tag[0].startsWith('</')) {
        depth -= 1;
        if (depth === 0) {
          blocks.push(text.slice(match.index, tag.index + tag[0].length));
          break;
        }
      } else {
        depth += 1;
      }
    }
  }
  return blocks;
}

/**
 * 解析 padding 简写的上下值。
 * 返回 [top, bottom]；解析不了返回 null（表示「未声明」）。
 */
function paddingVertical(value) {
  const parts = String(value).trim().split(/\s+/);
  const nums = parts.map((p) => parseFloat(p));
  if (nums.some((n) => Number.isNaN(n))) return null;
  if (nums.length === 1) return [nums[0], nums[0]];
  if (nums.length === 2) return [nums[0], nums[0]];
  if (nums.length === 3) return [nums[0], nums[2]];
  return [nums[0], nums[3]];
}

// ---------------------------------------------------------------------------
// R1：固定底栏必须留出正文空间
// ---------------------------------------------------------------------------
const wxmlFiles = walk(resolve(srcDir, 'pages')).filter((f) => f.endsWith('.wxml'));
for (const file of wxmlFiles) {
  const text = readWxml(file);
  if (!text.includes('fixed-bar')) {
    continue;
  }
  const rootMatch = text.match(/<view\s+class="([^"]*)"/);
  const rootClasses = rootMatch ? rootMatch[1].split(/\s+/) : [];
  if (!rootClasses.includes('page-with-fixed-bar')) {
    add(
      'R1',
      '固定底栏遮挡正文：页面用了 .fixed-bar，但根节点没有留出底栏高度',
      `${relative(srcDir, file)}（根节点 class="${rootClasses.join(' ')}"，缺少 page-with-fixed-bar）`
    );
  }
}

// ---------------------------------------------------------------------------
// R2：单行输入框不得被裁切
// ---------------------------------------------------------------------------
const appCss = readFileSync(appWxss, 'utf8');
const formInput = cssBlock(appCss, '.form-input');
if (!formInput) {
  add('R2', '找不到 .form-input 的样式定义', relative(srcDir, appWxss));
} else {
  if (!/(^|[;{\s])height\s*:/m.test(formInput)) {
    add('R2', '输入框文字被裁切：.form-input 没有显式 height', relative(srcDir, appWxss));
  }
  if (!/(^|[;{\s])line-height\s*:/m.test(formInput)) {
    add('R2', '输入框文字被裁切：.form-input 没有显式 line-height', relative(srcDir, appWxss));
  }
  const paddingMatch = formInput.match(/(^|[;{\s])padding\s*:\s*([^;}]+)/);
  if (paddingMatch) {
    const vertical = paddingVertical(paddingMatch[2]);
    if (vertical && (vertical[0] !== 0 || vertical[1] !== 0)) {
      add(
        'R2',
        '输入框文字被裁切：.form-input 仍有纵向 padding（小程序 input 的纵向 padding 撑不开原生输入框）',
        `${relative(srcDir, appWxss)}（padding: ${paddingMatch[2].trim()}）`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// R3 / R4 / R5：列表页的筛选闭环
// ---------------------------------------------------------------------------
/** 带筛选的列表页：页面目录 → 页面标题（失败信息里用中文点名） */
const FILTER_PAGES = [
  { dir: 'pages/directory/index', title: '通讯录' },
  { dir: 'pages/connect/index', title: '连接' },
];

for (const page of FILTER_PAGES) {
  const tsFile = resolve(srcDir, `${page.dir}/index.ts`);
  const wxmlFile = resolve(srcDir, `${page.dir}/index.wxml`);
  if (!statSync(tsFile, { throwIfNoEntry: false })?.isFile()) {
    add('R3', `${page.title}列表页源码缺失`, relative(srcDir, tsFile));
    continue;
  }
  const ts = readTs(tsFile);
  const wxml = statSync(wxmlFile, { throwIfNoEntry: false })?.isFile()
    ? readWxml(wxmlFile)
    : '';

  // R3：筛选条件变化后必须重载（定义 + 调用，至少出现两次）
  const reloadHits = (ts.match(/reloadIfFilterChanged/g) || []).length;
  if (reloadHits < 2) {
    add(
      'R3',
      `${page.title}列表页的筛选条件变化后没有重新拉数据（筛选看起来不生效）`,
      `${relative(srcDir, tsFile)}（reloadIfFilterChanged 出现 ${reloadHits} 次，需要定义 + 调用各 1 次）`
    );
  }

  // R4：空列表必须给出路
  if (!wxml.includes('empty-action') || !wxml.includes('onClearFilters')) {
    add(
      'R4',
      `${page.title}列表页空结果时没有「清空筛选条件」的出路（用户会被卡在空列表）`,
      relative(srcDir, wxmlFile)
    );
  }
}

// R5：生效中的筛选条件必须看得见
//     ⚠️ 判据要卡「真正被渲染出来的那个变量」——
//        要求它在**插值表达式里作为独立标识符**出现，
//        而不是只看名字里有没有这几个字母：
//        否则把它改名成 yearLabelHidden 就能糊弄过去（子串匹配会中招）。
// R5：生效中的筛选条件必须看得见
//     ⚠️ 判据要卡「真正被渲染出来的那个变量」——
//        要求它在**插值表达式里作为独立标识符**出现，
//        而不是只看名字里有没有这几个字母：
//        否则把它改名成 yearLabelHidden 就能糊弄过去（子串匹配会中招）。
const IDENT_CHARS = 'A-Za-z0-9_';

/** WXML 的插值表达式里是否把变量当成独立标识符用（而不是名字里恰好含这几个字母） */
function usesMustacheVar(wxml, name) {
  const expressions = [...wxml.matchAll(/\{\{([^}]*)\}\}/g)].map((m) => m[1]);
  const re = new RegExp(`(^|[^${IDENT_CHARS}])${name}([^${IDENT_CHARS}]|$)`);
  return expressions.some((expr) => re.test(expr));
}

const directoryWxml = readWxml(resolve(srcDir, 'pages/directory/index/index.wxml'));
if (!usesMustacheVar(directoryWxml, 'yearLabel')) {
  add('R5', '通讯录列表页没有展示毕业年份筛选（年份成了看不见的幽灵条件）', 'pages/directory/index/index.wxml');
}
const connectWxml = readWxml(resolve(srcDir, 'pages/connect/index/index.wxml'));
if (!usesMustacheVar(connectWxml, 'typeLabel') || !connectWxml.includes('onTypeTap')) {
  add('R5', '连接列表页没有展示信息类型筛选（类型成了看不见的幽灵条件）', 'pages/connect/index/index.wxml');
}

// ---------------------------------------------------------------------------
// R6：演示数据里每个地区都要有资源
// ---------------------------------------------------------------------------
function parseRawDataset(file) {
  const text = readFileSync(file, 'utf8');
  const marker = 'export const RAW_DATASET =';
  const at = text.indexOf(marker);
  if (at < 0) throw new Error('找不到 RAW_DATASET 导出');
  const body = text.slice(at + marker.length);
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return JSON.parse(body.slice(start, end + 1));
}

let dataset;
try {
  dataset = parseRawDataset(datasetFile);
} catch (err) {
  console.error(`❌ 演示数据集解析失败：${err.message}`);
  process.exit(1);
}
const covered = new Set((dataset.resources || []).map((item) => item.regionCode));
const missing = (dataset.regions || []).filter((region) => !covered.has(region.code));
if (missing.length > 0) {
  add(
    'R6',
    `演示数据里有 ${missing.length} 个地区一条资源都没有（客户选这些地区会看到 0 条）`,
    missing.map((region) => region.name).join('、')
  );
}

// ---------------------------------------------------------------------------
// R7：校友认证页底部的两个按钮必须左右并排
//     （真机反馈 16:29「下面的两个按键左右布局更好看」：
//       原来「开始认证」在上、「查看认证进度」在下的上下堆叠，又笨重又占高度）
// ---------------------------------------------------------------------------
const verifyIntroFile = resolve(srcDir, 'pages/me/verify-intro/index.wxml');
if (!statSync(verifyIntroFile, { throwIfNoEntry: false })?.isFile()) {
  add('R7', '校友认证介绍页源码缺失', relative(srcDir, verifyIntroFile));
} else {
  const verifyWxml = readWxml(verifyIntroFile);
  const fixedBars = extractViewBlocks(verifyWxml, 'fixed-bar');
  if (fixedBars.length === 0) {
    add('R7', '校友认证页没有找到底部固定栏', relative(srcDir, verifyIntroFile));
  } else {
    const bar = fixedBars[0];
    const rows = extractViewBlocks(bar, 'btn-row');
    const sideBySide = rows.some(
      (row) => row.includes('onStartTap') && row.includes('onProgressTap')
    );
    if (!sideBySide) {
      add(
        'R7',
        '认证页底部两个按钮没有左右并排（客户要求左右布局，上下堆叠显得笨重）',
        relative(srcDir, verifyIntroFile)
      );
    }
    // 防「并排容器之外还留着按钮」——那等于又变回上下堆叠
    const outside = rows.length > 0 ? bar.replace(rows.join(''), '') : bar;
    if (/<button\b/.test(outside)) {
      add(
        'R7',
        '认证页底部按钮又变回上下堆叠（并排容器之外还有按钮）',
        relative(srcDir, verifyIntroFile)
      );
    }
  }
}

// ---------------------------------------------------------------------------
// R8：连接栏目的二级筛选页不得再出现「信息类型」
//     （真机反馈 16:31「去掉二级页面的信息类型筛选，外面已经有了」：
//       列表页的「按类型查看」chip 才是类型筛选的入口，二级页再放一份就是重复入口）
// ---------------------------------------------------------------------------
const connectFilterWxmlFile = resolve(srcDir, 'pages/connect/filter/index.wxml');
const connectFilterTsFile = resolve(srcDir, 'pages/connect/filter/index.ts');
for (const f of [connectFilterWxmlFile, connectFilterTsFile]) {
  if (!statSync(f, { throwIfNoEntry: false })?.isFile()) {
    add('R8', '连接栏目二级筛选页源码缺失', relative(srcDir, f));
  }
}
if (statSync(connectFilterWxmlFile, { throwIfNoEntry: false })?.isFile()) {
  const cfWxml = readWxml(connectFilterWxmlFile);
  // ⚠️ 判据要精确：说明文案里出现「信息类型」四个字是允许的
  //   （比如「信息类型可在连接列表页直接切换」这句提示），
  //   真正要禁的是**一个叫「信息类型」的筛选区块**以及它的绑定。
  const typeSection = /<text class="section-title">\s*信息类型\s*<\/text>/.test(cfWxml);
  const typeBinding = /onTypeTap/.test(cfWxml);
  if (typeSection || typeBinding) {
    add(
      'R8',
      '连接二级筛选页又出现了「信息类型」筛选（外面列表页已经有了，属于重复入口）',
      `${relative(srcDir, connectFilterWxmlFile)}（区块标题：${typeSection}；类型绑定：${typeBinding}）`
    );
  }
}
if (statSync(connectFilterTsFile, { throwIfNoEntry: false })?.isFile()) {
  const cfTs = readTs(connectFilterTsFile);
  if (/onTypeTap/.test(cfTs) || /type\s*:\s*'all'/.test(cfTs)) {
    add(
      'R8',
      '连接二级筛选页仍在处理信息类型（会与列表页的类型 chip 互相覆盖）',
      relative(srcDir, connectFilterTsFile)
    );
  }
}

// ---------------------------------------------------------------------------
// R9：行业筛选收进二级筛选页，列表页只留一个可见入口
//     （真机反馈 16:31「有点乱，可以把按行业筛选收到二级页面里」）
// ---------------------------------------------------------------------------
const connectIndexWxmlFile = resolve(srcDir, 'pages/connect/index/index.wxml');
if (!statSync(connectIndexWxmlFile, { throwIfNoEntry: false })?.isFile()) {
  add('R9', '连接列表页源码缺失', relative(srcDir, connectIndexWxmlFile));
} else {
  const ciWxml = readWxml(connectIndexWxmlFile);
  // ⚠️ 判据同样要精确：工具栏上的「行业：{{industryLabel}}」入口是**必须保留**的，
  //   要禁的是列表页里那条「按行业…查看」的横向 chip 行（以及它的直接选择绑定）。
  const industrySection = /<text class="section-title">\s*按行业/.test(ciWxml);
  const industryBinding = /onIndustryTap/.test(ciWxml);
  if (industrySection || industryBinding) {
    add(
      'R9',
      '连接列表页还留着「按行业…查看」的横向 chip 行（太乱，应收进二级筛选页）',
      `${relative(srcDir, connectIndexWxmlFile)}（区块标题：${industrySection}；行业直选绑定：${industryBinding}）`
    );
  }
  const filterBlocks = extractViewBlocks(ciWxml, 'connect-filters');
  if (filterBlocks.length === 0 || !usesMustacheVar(filterBlocks[0], 'industryLabel')) {
    add(
      'R9',
      '连接列表页没有可见的行业筛选入口（行业筛选收进二级页后，入口必须留在工具栏上）',
      relative(srcDir, connectIndexWxmlFile)
    );
  }
  if (statSync(connectFilterWxmlFile, { throwIfNoEntry: false })?.isFile()) {
    const cfWxml = readWxml(connectFilterWxmlFile);
    if (!cfWxml.includes('所在行业') || !cfWxml.includes('onIndustryTap')) {
      add(
        'R9',
        '连接二级筛选页没有行业筛选区块（行业筛选被收进来后必须真的能选）',
        relative(srcDir, connectFilterWxmlFile)
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 结论
// ---------------------------------------------------------------------------
if (offenders.length > 0) {
  console.error(`❌ 真机反馈回归守卫未通过：发现 ${offenders.length} 处问题\n`);
  for (const o of offenders) {
    console.error(`  [${o.rule}] ${o.message}`);
    console.error(`      ${o.detail}`);
  }
  console.error(
    '\n这九条对应的都是**真机上才看得见**的问题（客户 2026-11-22 两次共报了 15 张截图）：\n' +
      '  R1 底部固定按钮压住正文 → 根节点加 page-with-fixed-bar；\n' +
      '  R2 输入框文字被裁掉一截 → .form-input 用显式 height + line-height，去掉纵向 padding；\n' +
      '  R3 筛选/搜索看起来不生效 → onShow 里比对筛选签名，变了就重新加载；\n' +
      '  R4 筛选后卡在空列表 → 空状态提供「清空筛选条件」；\n' +
      '  R5 幽灵筛选条件 → 页面上把年份 / 类型显示出来；\n' +
      '  R6 选某个地区 0 条 → 演示内容库补齐各地区资源；\n' +
      '  R7 认证页按钮上下堆叠 → 两个按钮放进同一个 .btn-row 左右并排；\n' +
      '  R8 二级筛选页重复提供信息类型 → 类型筛选只留在列表页的 chip 上；\n' +
      '  R9 列表页行业 chip 行太乱 → 行业筛选收进二级页，列表页只留一个可见入口。'
  );
  process.exit(1);
}

const pages = wxmlFiles.length;
console.log(
  `✅ 真机反馈回归守卫通过：${pages} 个页面；固定底栏页面均已留白；输入框高度合法；` +
    '通讯录/连接筛选闭环完整；演示资源覆盖全部地区；认证页按钮左右并排；' +
    '连接二级筛选页无重复类型入口、行业筛选已收进二级页'
);
process.exit(0);
