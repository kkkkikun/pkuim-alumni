/**
 * 导出小程序离线演示数据集。
 *
 * 数据策略（用户确认）：**真实公开内容 + 虚构通讯录**
 *  - 活动 / 资讯 / 公告 / 合作资源 / 地区 / 行业字典：直接取线上 API 的序列化结果，
 *    保证字段形状与契约 DTO 完全一致（不手写字段、不臆造结构）。
 *  - 校友名录（directory）：线上接口对未认证用户返回 403，且涉及个人信息，
 *    因此**不导出**，由 src/demo 侧按契约生成虚构条目。
 *  - 「我」的资料：取种子账号（mock_smoke-tester）的资料。
 *
 * ⚠️ **内容净化层（缺陷 #159）**：
 *   演示包是**发给客户看的**，而线上种子库里留着开发期的调试产物：
 *     - 活动「调试校友沙龙」「FK修复验证活动」；
 *     - 正文里的「仅用于联调与自动化测试」；
 *     - 事件类型混着英文枚举 `charity/industry/reunion`（客户端图标匹配不上，
 *       4 条活动会退化成同一个兜底日历图标）；
 *     - 资源标题去掉编号后重复（客户看到 4 条一模一样的「绿色算力机房资源」）。
 *   这些不违反任何契约，所以**任何既有校验层都发现不了**，只有人眼点一遍才看得见。
 *   净化规则与补充内容集中放在 `infra/demo-content/demo-content.json`，
 *   规则改动可 review、内容可复现，不散落在代码里。
 *
 * 只读，不写业务数据；登录复用已有种子账号，不新建用户。
 */
import { writeFileSync, mkdirSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.NMG_API_BASE || 'http://127.0.0.1:18090/api/v1';
const OUT = resolve(
  process.argv[2] || 'apps/miniprogram/src/demo/dataset.data.ts'
);
/** 演示内容库（净化规则 + 补充内容） */
const CONTENT_LIB = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../demo-content/demo-content.json'
);

async function call(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)?.slice(0, 200)}`);
  }
  return json?.data;
}

const login = await call('POST', '/auth/mock/login', {
  body: { mockOpenid: 'smoke-tester', nickname: '体验账号' },
});
const token = login.accessToken;
if (!token) throw new Error('mock 登录失败');

const [events, articles, categories, notices, resources, regions, industries, me] =
  await Promise.all([
    call('GET', '/events?page=1&pageSize=50', { token }),
    call('GET', '/articles?page=1&pageSize=50', { token }),
    call('GET', '/articles/categories', { token }),
    call('GET', '/notices?page=1&pageSize=50', { token }),
    call('GET', '/resources?page=1&pageSize=30', { token }),
    call('GET', '/system/regions', { token }),
    call('GET', '/system/industries', { token }),
    call('GET', '/me', { token }),
  ]);

/**
 * 净化 + 扩充（缺陷 #159）。
 *
 * 顺序很重要：
 *   1. drop     —— 先剔除调试产物（按原始 id 判定，净化前最可靠）；
 *   2. overrides—— 再按 id 覆盖标题/正文/类型（改写成体面的演示文案）；
 *   3. extra    —— 最后并入补充条目；
 *   4. 前缀兜底 —— 任何漏网的标题统一补「【虚构】」前缀；
 *   5. 计数重算 —— 分类的 articleCount 必须与实际文章数一致。
 */
function applyContentLibrary(dataset, lib) {
  const report = { dropped: [], overridden: 0, added: 0, prefixed: 0 };

  // 1. drop
  for (const [collection, ids] of Object.entries(lib.drop || {})) {
    const dropSet = new Set(ids.map(Number));
    const before = dataset[collection]?.length ?? 0;
    dataset[collection] = (dataset[collection] || []).filter((item) => {
      if (dropSet.has(Number(item.id))) {
        report.dropped.push(`${collection}#${item.id}「${item.title}」`);
        return false;
      }
      return true;
    });
    if ((dataset[collection]?.length ?? 0) !== before) {
      console.log(`  · ${collection}: 剔除 ${before - dataset[collection].length} 条调试产物`);
    }
  }

  // 2. overrides
  for (const [collection, byId] of Object.entries(lib.overrides || {})) {
    for (const item of dataset[collection] || []) {
      const patch = byId[String(item.id)];
      if (!patch) continue;
      Object.assign(item, patch);
      report.overridden += 1;
    }
  }

  // 3. extra
  for (const [collection, items] of Object.entries(lib.extra || {})) {
    dataset[collection] = [...(dataset[collection] || []), ...items];
    report.added += items.length;
  }

  // 4. 虚构标记兜底
  for (const collection of ['events', 'articles', 'notices', 'resources']) {
    for (const item of dataset[collection] || []) {
      if (typeof item.title === 'string' && !item.title.startsWith('【虚构】')) {
        item.title = `【虚构】${item.title}`;
        report.prefixed += 1;
      }
    }
  }

  // 5. 分类计数重算
  const categories = dataset.articleCategories || [];
  if (categories.length > 0) {
    const counts = new Map();
    for (const article of dataset.articles || []) {
      const key = String(article.categoryId ?? '');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const category of categories) {
      category.articleCount = counts.get(String(category.id)) || 0;
    }
  }

  return report;
}

const contentLib = JSON.parse(readFileSync(CONTENT_LIB, 'utf8'));
const rawDataset = {
  events: events.items,
  articles: articles.items,
  articleCategories: categories,
  notices: notices.items,
  resources: resources.items,
  regions,
  industries,
  me: {
    user: me.user,
    alumniProfile: stripContactFields(me.alumniProfile),
    stage: me.stage,
  },
};

console.log('应用演示内容库（净化 + 扩充）……');
const report = applyContentLibrary(rawDataset, contentLib);
if (report.dropped.length > 0) {
  console.log('  · 已剔除调试产物：', report.dropped.join('、'));
}
console.log(
  `  · 覆盖 ${report.overridden} 条 / 补充 ${report.added} 条 / 补前缀 ${report.prefixed} 条`
);

const dataset = {
  __note:
    '离线演示数据集：由线上 API 导出后经「演示内容库」净化与扩充（infra/demo-content/demo-content.json）；通讯录为虚构条目，由 src/demo 生成。',
  __exportedAt: new Date().toISOString(),
  events: rawDataset.events,
  articles: rawDataset.articles,
  articleCategories: rawDataset.articleCategories,
  notices: rawDataset.notices,
  resources: rawDataset.resources,
  regions: rawDataset.regions,
  industries: rawDataset.industries,
  me: rawDataset.me,
};

/**
 * 剥掉一切联系方式与实名姓名字段。
 *
 * 隐私铁律：联系方式只允许存 `private_contacts`（AES-256-GCM），
 * 列表接口永不 SELECT。小程序包会被分发出去，所以演示数据集里
 * 连「字段本身」都不应该存在（哪怕值是 null）。
 */
function stripContactFields(profile) {
  if (!profile || typeof profile !== 'object') return profile;
  const clone = { ...profile };
  for (const key of ['contactPhone', 'contactWechat', 'contactEmail', 'realName']) {
    delete clone[key];
  }
  return clone;
}

mkdirSync(dirname(OUT), { recursive: true });

/**
 * 生成的是 **TS 模块**而不是 .json 文件。
 *
 * 原因：微信小程序运行时的模块系统对 `require('*.json')` 的支持并不确定，
 * 而我们没法在真机上先试一次再决定 —— 所以把数据在**编译期**内联成
 * TS 对象字面量（JSON 是 TS 对象字面量的合法子集），运行时零风险。
 *
 * 旧的 dataset.json 若存在则清掉，避免有人误 import 它（会绕过 R7 规则）。
 */
const header = `/**
 * 离线演示数据集（自动生成，请勿手改）。
 *
 * 重新生成：
 *   node infra/scripts/export-miniprogram-demo-data.mjs
 *
 * ⚠️ 为什么是 .ts 而不是 .json：
 *   微信小程序运行时对 \`require('*.json')\` 的支持不确定，
 *   编译期内联成对象字面量 → 运行时零风险。
 *
 * 隐私红线：本文件不含任何联系方式字段（导出脚本已剥离）。
 */
export const RAW_DATASET = `;
// JSON.stringify 的结果自带最外层花括号，直接接分号即可（别再多加一个 }）
writeFileSync(OUT, `${header}${JSON.stringify(dataset, null, 2)};\n`, 'utf8');

const legacyJson = resolve(dirname(OUT), 'dataset.json');
if (existsSync(legacyJson)) {
  unlinkSync(legacyJson);
  console.log('已移除旧文件（避免误 import .json）：', legacyJson);
}

const size = Buffer.byteLength(JSON.stringify(dataset));
console.log('written:', OUT);
console.log(
  'counts:',
  JSON.stringify({
    events: dataset.events.length,
    articles: dataset.articles.length,
    articleCategories: dataset.articleCategories.length,
    notices: dataset.notices.length,
    resources: dataset.resources.length,
    regions: dataset.regions.length,
    industries: dataset.industries.length,
  })
);
console.log('bytes:', size);
