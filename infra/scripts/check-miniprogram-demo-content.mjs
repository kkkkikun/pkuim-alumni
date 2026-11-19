#!/usr/bin/env node
/**
 * 第 22 层校验：离线演示数据集的**内容卫生**。
 *
 * ⚠️ 缺陷 #159（客户体验自查发现，老板反馈「没做好自查」）：
 *   演示版小程序包是**发给客户看**的，但导出数据集里混着内部调试残留：
 *     - 活动标题「调试校友沙龙」「FK修复验证活动」—— 明显是开发期的测试产物；
 *     - 资讯正文「…用于首页与资讯列表联调」「…仅用于联调与自动化测试」；
 *     - 通讯录昵称「校友 A」「校友 B」… —— 占位式字母代号，不像给客户看的内容；
 *     - 列表内容单薄且高度重复（「校友会资讯第 N 期」「绿色算力机房资源」×4）。
 *
 *   这类缺陷的特点是**完全静默**的：
 *     接口 200、类型检查过、样式校验过、单元测试全绿、回归链 24 步全绿 ——
 *     因为它们不违反任何契约，**只违反「给客户看」这件事本身**。
 *     没有专门的校验层，就只能靠人眼再点一遍，而人眼不可能每次都点全。
 *
 * 本层的判定口径（与人工评审看到的完全一致）：
 *   1. 对外可见内容的**标题**不得含任何内部痕迹词（调试 / 测试 / 联调 / FK修复 / …）；
 *   2. 对外可见内容的**正文**不得出现「联调 / 自动化测试 / 仅用于测试」这类
 *      「这东西其实只是个测试」的表述；
 *   3. 每一篇对外可见内容都必须带「【虚构】」标记 —— 既不伪装真实数据，
 *      也让客户一眼看出这是演示内容；
 *   4. 各集合条目数不得低于下限（列表页不能一滑到底）；
 *   5. 同一集合内标题不得重复（重复标题在列表页看起来像卡死）；
 *   6. 通讯录昵称不得是「校友 X」这类占位代号。
 *
 * 用法：node check-miniprogram-demo-content.mjs <小程序源码目录>
 * 退出码：0 全部通过；1 发现内容卫生问题
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

/** 小程序源码目录（默认取仓库内标准位置） */
const srcDir = resolve(process.argv[2] || 'apps/miniprogram/src');
const datasetFile = resolve(srcDir, 'demo/dataset.data.ts');
const directoryFile = resolve(srcDir, 'demo/directory.ts');

if (!statSync(srcDir, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`源码目录不存在：${srcDir}`);
  process.exit(1);
}
for (const f of [datasetFile, directoryFile]) {
  if (!statSync(f, { throwIfNoEntry: false })?.isFile()) {
    console.error(`演示数据文件不存在：${f}`);
    process.exit(1);
  }
}

/**
 * 内部痕迹词表。
 *
 * 分两级：
 *  - TITLE_FORBIDDEN：标题里出现就是调试产物，直接判失败；
 *  - BODY_FORBIDDEN：正文里出现就说明「这东西只是个测试」，判失败。
 *
 * 注意「测试」只在标题级生效：正文里允许出现「【虚构测试数据】」这个
 * 历史遗留的前缀标记 —— 它是**免责标记**而不是调试痕迹。
 */
const TITLE_FORBIDDEN = [
  '调试',
  '联调',
  'FK修复',
  'FK 修复',
  'FK',
  '验证活动',
  '测试活动',
  '测试数据',
  'smoke',
  'mock',
  'debug',
  'TEST',
  'Debug',
];
const BODY_FORBIDDEN = ['联调', '自动化测试', '仅用于测试', '仅用于联调', '单元测试'];

/** 各集合的最小条目数（列表页不能一滑到底） */
const MIN_COUNTS = {
  events: 8,
  articles: 12,
  notices: 6,
  resources: 20,
};

/** 必须是虚构标记开头的内容集合 */
const FICTION_MARKED = ['events', 'articles', 'notices', 'resources'];

/** 虚构标记前缀 */
const FICTION_PREFIX = '【虚构】';

const offenders = [];

/**
 * 规范化标题（用于判重）。
 *
 * 剥掉：
 *  - 尾部编号 `#32`
 *  - 期号 `第 8 期` / `第 4 号`
 *  - 虚构标记前缀
 *  - 空白与常见分隔符
 */
function normalizeTitle(title) {
  return String(title)
    .replace(/#[0-9]+/g, '')
    .replace(/第\s*[0-9]+\s*[期号]/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/[\s·、,，:：\-—_]+/g, '')
    .trim();
}

function add(collection, field, message, detail) {
  offenders.push({ collection, field, message, detail });
}

// ---------------------------------------------------------------------------
// 解析 dataset.data.ts 里的 JSON 字面量
// ---------------------------------------------------------------------------
function parseRawDataset(file) {
  const text = readFileSync(file, 'utf8');
  const marker = 'export const RAW_DATASET =';
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`找不到 RAW_DATASET 导出：${file}`);
  const body = text.slice(at + marker.length);
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error(`RAW_DATASET 不是对象字面量：${file}`);
  return JSON.parse(body.slice(start, end + 1));
}

let dataset;
try {
  dataset = parseRawDataset(datasetFile);
} catch (err) {
  console.error(`❌ 演示数据集解析失败：${err.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 规则 1~5：对外可见内容
// ---------------------------------------------------------------------------
for (const collection of FICTION_MARKED) {
  const items = Array.isArray(dataset[collection]) ? dataset[collection] : [];
  const seenTitles = new Map();

  items.forEach((item, idx) => {
    const title = String(item?.title ?? '');
    const body = String(item?.body ?? '');
    const summary = String(item?.summary ?? '');
    const where = `${collection}[${idx}] id=${item?.id}`;

    // 规则 1：标题内部痕迹
    for (const word of TITLE_FORBIDDEN) {
      if (title.includes(word)) {
        add(collection, 'title', `标题含内部痕迹词「${word}」`, `${where} → ${title}`);
      }
    }

    // 规则 2：正文内部痕迹
    for (const word of BODY_FORBIDDEN) {
      if (body.includes(word) || summary.includes(word)) {
        add(collection, 'body', `正文含内部痕迹词「${word}」`, `${where} → ${title}`);
      }
    }

    // 规则 3：虚构标记
    if (!title.startsWith(FICTION_PREFIX)) {
      add(collection, 'title', `标题缺少「${FICTION_PREFIX}」标记`, `${where} → ${title}`);
    }

    // 规则 5：标题重复（按**规范化标题**判重）
    //
    // 注意不能直接比原始标题：资源标题带 `#32` 这类编号，原始串互不相同，
    // 但客户在列表里看到的是「绿色算力机房资源」连着出现 4 条 —— 那才是
    // 真正的「看起来重复」。所以先剥掉编号与期号再判重。
    if (title) {
      const key = normalizeTitle(title);
      if (seenTitles.has(key)) {
        add(collection, 'title', `标题与 ${seenTitles.get(key)} 重复`, `${where} → ${title}`);
      } else {
        seenTitles.set(key, where);
      }
    }

    // 规则 8：事件类型不得是纯英文枚举
    //
    // 客户端 `utils/view.ts` 的 `eventArt()` 按**中文关键词**匹配图标
    // （参访|企业|产业|开放日 → 楼宇；交流|沙龙|分享 → 群像）。
    // 线上库里存过 `charity` / `industry` / `reunion` 这种英文自由文本，
    // 一个都匹配不上 → 全部落到兜底的日历图标，
    // 客户会看到 4 张一模一样的活动图标。
    if (collection === 'events') {
      const kind = String(item?.kind ?? '').trim();
      if (kind && /^[a-zA-Z][a-zA-Z_\-]*$/.test(kind)) {
        add(collection, 'kind', `事件类型是英文枚举「${kind}」，图标会退化成兜底样式`, where);
      }
    }
  });

  // 规则 4：条目数下限
  const min = MIN_COUNTS[collection];
  if (min && items.length < min) {
    add(collection, 'count', `条目数 ${items.length} 低于下限 ${min}`, collection);
  }
}

// ---------------------------------------------------------------------------
// 规则 7：分类计数必须与实际文章数一致
//
// 分类页会显示「校友动态（2 篇）」这类角标。articleCount 是导出时的快照，
// 一旦演示文章被扩充/剔除，这个数就会对不上 —— 客户点进去数一数就知道错了。
// ---------------------------------------------------------------------------
const categories = Array.isArray(dataset.articleCategories) ? dataset.articleCategories : [];
const articleCount = Array.isArray(dataset.articles) ? dataset.articles.length : 0;
const countedSum = categories.reduce((sum, c) => sum + (Number(c?.articleCount) || 0), 0);
if (categories.length > 0 && countedSum !== articleCount) {
  add(
    'articleCategories',
    'articleCount',
    `分类计数合计 ${countedSum} 与实际文章数 ${articleCount} 不一致`,
    categories.map((c) => `${c?.name}=${c?.articleCount}`).join(', ')
  );
}

// ---------------------------------------------------------------------------
// 规则 6：通讯录占位式昵称
// ---------------------------------------------------------------------------
const dirText = readFileSync(directoryFile, 'utf8');
const nameMatches = [...dirText.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
if (nameMatches.length === 0) {
  add('directory', 'name', '通讯录种子里没有解析到任何昵称', relative(srcDir, directoryFile));
}
for (const name of nameMatches) {
  if (/^校友\s*[A-Z]$/.test(name)) {
    add('directory', 'name', `昵称是占位式代号「${name}」`, relative(srcDir, directoryFile));
  }
}

// ---------------------------------------------------------------------------
// 结论
// ---------------------------------------------------------------------------
if (offenders.length > 0) {
  console.error(`❌ 演示内容卫生检查未通过：发现 ${offenders.length} 处问题\n`);
  for (const o of offenders) {
    console.error(`  [${o.collection}.${o.field}] ${o.message}`);
    console.error(`      ${o.detail}`);
  }
  console.error(
    '\n修复方式：\n' +
      '  · 内部调试内容 → 从演示导出结果里剔除（导出脚本 sanitize 层）；\n' +
      '  · 正文里的「联调/自动化测试」→ 改写为面向客户的演示文案；\n' +
      `  · 每篇对外内容 → 标题统一加「${FICTION_PREFIX}」前缀；\n` +
      '  · 条目数不足 → 补充虚构演示内容；\n' +
      '  · 通讯录昵称 → 换成一眼可辨但不占位的虚构名。'
  );
  process.exit(1);
}

const counts = Object.entries(MIN_COUNTS)
  .map(([k, min]) => `${k}=${dataset[k]?.length ?? 0}(≥${min})`)
  .join(' ');
console.log(`✅ 演示内容卫生通过：${counts}；通讯录 ${nameMatches.length} 条昵称无占位代号`);
process.exit(0);
