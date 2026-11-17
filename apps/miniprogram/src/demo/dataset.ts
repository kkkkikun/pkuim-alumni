/**
 * 离线演示数据集（类型化入口）。
 *
 * 数据来源：`dataset.data.ts`（由 `infra/scripts/export-miniprogram-demo-data.mjs`
 * 从线上 API 导出，内容为**真实公开内容**：活动 / 资讯 / 公告 / 合作资源 /
 * 地区与行业字典 / 「我」的资料）。
 *
 * ⚠️ 数据以 **TS 模块**（编译期内联）而不是 .json 的形式进入小程序包 ——
 *    微信小程序运行时对 `require('*.json')` 的支持不确定，不能赌。
 *
 * 隐私红线：
 *  - 导出脚本已经把 `contactPhone` / `contactWechat` / `contactEmail` /
 *    `realName` 从「我」的档案里剥掉了 —— 小程序包是要分发出去的，
 *    连**字段本身**都不应该出现（哪怕值是 null）。
 *  - 校友名录（通讯录）**不在**数据集里：线上接口对未认证用户返回 403，
 *    且涉及个人信息 → 由 `src/demo/directory.ts` 生成**虚构条目**。
 *
 * 说明：`dataset.json` 里的活动 / 资讯 / 公告 / 资源正文本身已标注为
 * 「【虚构】/【虚构测试数据】」，是线上种子库里的测试数据，不含任何真实个人信息。
 */

import { RAW_DATASET } from './dataset.data';
import type {
  AlumniProfileDto,
  AlumniStage,
  ArticleCategoryDto,
  ArticleDto,
  EventDto,
  IndustryDto,
  NoticeDto,
  PrivacySettings,
  RegionDto,
  ResourcePostDto,
  UserProfile,
} from '../types';

/**
 * 数据集里的「我」的校友档案。
 *
 * 注意：导出脚本剥掉了联系方式与实名字段，但**保留**了 `privacy`
 * （隐私开关不是个人信息），所以这里在契约的 `AlumniProfileDto` 基础上补上它。
 */
export interface DemoAlumniProfile extends AlumniProfileDto {
  privacy: PrivacySettings;
}

/** 数据集里的「我」：联系方式与实名已被导出脚本剥掉 */
export interface DemoMe {
  user: UserProfile;
  alumniProfile: DemoAlumniProfile | null;
  stage: AlumniStage;
}

/** 离线演示数据集（与 `dataset.json` 一一对应） */
export interface DemoDataset {
  /** 数据集说明（导出脚本写入） */
  __note: string;
  /** 导出时间（导出脚本写入） */
  __exportedAt: string;
  events: EventDto[];
  articles: ArticleDto[];
  articleCategories: ArticleCategoryDto[];
  notices: NoticeDto[];
  resources: ResourcePostDto[];
  regions: RegionDto[];
  industries: IndustryDto[];
  me: DemoMe;
}

/**
 * 类型化后的数据集。
 *
 * 用 `as unknown as` 是因为数据集是**运行时**才确定形状的字面量，
 * 而导出脚本的 JSON 形状是运行时才确定的；这里以 `src/types` 的契约镜像为准。
 */
export const dataset: DemoDataset = RAW_DATASET as unknown as DemoDataset;

/** 演示会话用的假令牌（一眼可辨，绝不是真实凭证） */
export const DEMO_ACCESS_TOKEN = 'demo-access-token';
export const DEMO_REFRESH_TOKEN = 'demo-refresh-token';
