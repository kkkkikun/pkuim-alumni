/**
 * 虚构校友名录（离线演示用）。
 *
 * ⚠️ **这里的人全是编的**。
 *
 * 线上 `/directory` 对未认证用户返回 403，且条目含个人信息（联系方式、实名等），
 * 因此**绝不导出**到小程序包里 —— 小程序包是要分发出去的。
 * 这里按 `DirectoryEntry`（契约里的公开名片投影）生成 12 条**虚构**条目：
 *  - 姓名：明显可辨的虚构名（「校友 A」「张同学」…）；
 *  - 单位 / 学院：泛化名称（「某科技公司」「示例学院」…）；
 *  - 地区 / 行业：取 `dataset.json` 里**真实字典**的 code（保证下拉筛选能对上）；
 *  - 统计类字段（alumniCount 等）一律为 0；
 *  - **绝不包含任何联系方式字段**（DirectoryEntry 契约里本来也没有）。
 */

import { dataset } from './dataset';
import type { DirectoryEntry } from '../types';

/** 按 code 查地区名（找不到就回退成 code 本身） */
function regionName(code: string): string {
  const hit = dataset.regions.find((item) => item.code === code);
  return hit ? hit.name : code;
}

/** 按 code 查行业名（找不到就回退成 code 本身） */
function industryName(code: string): string {
  const hit = dataset.industries.find((item) => item.code === code);
  return hit ? hit.name : code;
}

interface DemoEntrySeed {
  id: number;
  name: string;
  org: string;
  college: string;
  year: number;
  regionCode: string;
  industryCode: string;
  direction: string;
  verified: boolean;
  connectionState: DirectoryEntry['connectionState'];
}

/** 12 条虚构校友的种子数据（全部为编造信息） */
const SEEDS: DemoEntrySeed[] = [
  { id: 900001, name: '校友 A', org: '某科技公司', college: '示例学院', year: 2015, regionCode: 'HHS', industryCode: 'DIGI', direction: '产品研发', verified: true, connectionState: 'none' },
  { id: 900002, name: '校友 B', org: '某能源集团', college: '示例学院', year: 2012, regionCode: 'BTS', industryCode: 'ENER', direction: '项目工程', verified: true, connectionState: 'none' },
  { id: 900003, name: '张同学', org: '某农牧食品公司', college: '示例学院', year: 2018, regionCode: 'HLLS', industryCode: 'AGFO', direction: '品牌运营', verified: false, connectionState: 'none' },
  { id: 900004, name: '校友 C', org: '某律师事务所', college: '示例学院', year: 2010, regionCode: 'HHS', industryCode: 'LFIN', direction: '合规咨询', verified: true, connectionState: 'pending_outgoing' },
  { id: 900005, name: '校友 D', org: '某教育研究机构', college: '示例学院', year: 2016, regionCode: 'ORDS', industryCode: 'EDUR', direction: '教育研究', verified: true, connectionState: 'none' },
  { id: 900006, name: '校友 E', org: '某实业集团', college: '示例学院', year: 2009, regionCode: 'HHS', industryCode: 'BIZM', direction: '经营管理', verified: true, connectionState: 'connected' },
  { id: 900007, name: '李同学', org: '某文化传媒公司', college: '示例学院', year: 2019, regionCode: 'WLCS', industryCode: 'CULT', direction: '内容策划', verified: false, connectionState: 'none' },
  { id: 900008, name: '校友 F', org: '某新能源公司', college: '示例学院', year: 2014, regionCode: 'CFS', industryCode: 'ENER', direction: '市场拓展', verified: true, connectionState: 'none' },
  { id: 900009, name: '校友 G', org: '某建筑设计院', college: '示例学院', year: 2013, regionCode: 'TLS', industryCode: 'DIGI', direction: '城市规划', verified: true, connectionState: 'none' },
  { id: 900010, name: '校友 H', org: '某食品加工厂', college: '示例学院', year: 2011, regionCode: 'BYNLS', industryCode: 'AGFO', direction: '生产管理', verified: false, connectionState: 'none' },
  { id: 900011, name: '王同学', org: '某金融信息服务公司', college: '示例学院', year: 2017, regionCode: 'HHS', industryCode: 'LFIN', direction: '风控合规', verified: true, connectionState: 'none' },
  { id: 900012, name: '校友 I', org: '某农业科技公司', college: '示例学院', year: 2020, regionCode: 'XAM', industryCode: 'AGFO', direction: '技术推广', verified: false, connectionState: 'none' },
];

/** 虚构通讯录条目（12 条） */
export const demoDirectory: DirectoryEntry[] = SEEDS.map((seed) => ({
  userId: seed.id,
  displayName: seed.name,
  college: `${seed.college}·${seed.org}`,
  graduationYear: seed.year,
  regionCode: seed.regionCode,
  regionName: regionName(seed.regionCode),
  industryCode: seed.industryCode,
  industryName: industryName(seed.industryCode),
  direction: seed.direction,
  verified: seed.verified,
  connectionState: seed.connectionState,
}));
