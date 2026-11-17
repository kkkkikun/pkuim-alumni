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
 * 只读，不写业务数据；登录复用已有种子账号，不新建用户。
 */
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const BASE = process.env.NMG_API_BASE || 'http://127.0.0.1:18090/api/v1';
const OUT = resolve(
  process.argv[2] || 'apps/miniprogram/src/demo/dataset.data.ts'
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

const dataset = {
  __note:
    '离线演示数据集：由线上 API 导出（真实公开内容），通讯录为虚构条目，由 src/demo 生成。',
  __exportedAt: new Date().toISOString(),
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
