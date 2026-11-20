/**
 * 虚构测试数据工厂。
 *
 * 全部数据均为**虚构**（姓名形如「校友0001」），不含任何真实校友信息。
 * 使用固定种子的伪随机数，保证测试与 Seed 脚本结果一致、可重复。
 */

import type { UserStage } from '../entities/user.entity';
import type {
  ConnectionRequestStatus,
} from '../entities/connection.entity';
import type { ResourceStatus, ResourceType } from '../entities/resource.entity';
import type { EventStatus } from '../entities/event.entity';
import type { VerificationStatus } from '../entities/verification.entity';

/* ------------------------------------------------------------------ */
/* 伪随机数                                                              */
/* ------------------------------------------------------------------ */

/** mulberry32：轻量确定性伪随机数生成器 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

export function pickOne<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}

export function chance(random: () => number, probability: number): boolean {
  return random() < probability;
}

/* ------------------------------------------------------------------ */
/* 字典数据                                                              */
/* ------------------------------------------------------------------ */

export interface RegionFixture {
  code: string;
  name: string;
  level: 'city' | 'outside';
  sortOrder: number;
}

/** 12 个盟市 + 区外 */
export const REGION_FIXTURES: readonly RegionFixture[] = [
  { code: 'HHS', name: '呼和浩特市', level: 'city', sortOrder: 1 },
  { code: 'BTS', name: '包头市', level: 'city', sortOrder: 2 },
  { code: 'ORDS', name: '鄂尔多斯市', level: 'city', sortOrder: 3 },
  { code: 'CFS', name: '赤峰市', level: 'city', sortOrder: 4 },
  { code: 'TLS', name: '通辽市', level: 'city', sortOrder: 5 },
  { code: 'HLLS', name: '呼伦贝尔市', level: 'city', sortOrder: 6 },
  { code: 'BYNLS', name: '巴彦淖尔市', level: 'city', sortOrder: 7 },
  { code: 'WLCS', name: '乌兰察布市', level: 'city', sortOrder: 8 },
  { code: 'XAM', name: '兴安盟', level: 'city', sortOrder: 9 },
  { code: 'XLGLM', name: '锡林郭勒盟', level: 'city', sortOrder: 10 },
  { code: 'ALM', name: '阿拉善盟', level: 'city', sortOrder: 11 },
  { code: 'WHS', name: '乌海市', level: 'city', sortOrder: 12 },
  { code: 'OUTSIDE', name: '区外', level: 'outside', sortOrder: 99 },
] as const;

export interface IndustryFixture {
  code: string;
  name: string;
  sortOrder: number;
}

export const INDUSTRY_FIXTURES: readonly IndustryFixture[] = [
  { code: 'DIGI', name: '数字科技', sortOrder: 1 },
  { code: 'ENER', name: '能源产业', sortOrder: 2 },
  { code: 'AGFO', name: '农牧食品', sortOrder: 3 },
  { code: 'LFIN', name: '法律金融', sortOrder: 4 },
  { code: 'EDUR', name: '教育科研', sortOrder: 5 },
  { code: 'BIZM', name: '企业管理', sortOrder: 6 },
  { code: 'CULT', name: '文化教育', sortOrder: 7 },
] as const;

/* ------------------------------------------------------------------ */
/* 校友数据                                                              */
/* ------------------------------------------------------------------ */

export const COLLEGES: readonly string[] = [
  '数学科学学院',
  '物理学学院',
  '化学与分子工程学院',
  '生命科学学院',
  '经济学院',
  '光华管理学院',
  '法学院',
  '计算机学院',
  '软件与微电子学院',
  '新闻与传播学院',
  '政府管理学院',
  '医学院',
  '城市与环境学院',
  '外国语学院',
  '信息科学技术学院',
  '工学院',
  '国际关系学院',
  '考古文博学院',
  '艺术学院',
  '资源与地球物理学系',
] as const;

export const DEGREES: readonly string[] = ['学士', '硕士', '博士'] as const;

export const DIRECTIONS: readonly string[] = [
  '计算与人工智能',
  '新能源材料',
  '现代金融',
  '公共政策',
  '基础教育',
  '医疗健康',
  '生态环保',
  '数据科学',
  '文旅与传播',
  '智能制造',
  '生物医药',
  '区域经济',
] as const;

export const GRADUATION_YEARS: readonly number[] = [
  1985, 1990, 1995, 2000, 2005, 2010, 2015, 2018, 2020, 2022, 2024,
] as const;

export interface FictionalUserFixture {
  openid: string;
  nickname: string;
  avatarUrl: string | null;
  status: 'active' | 'disabled' | 'locked';
  stage: UserStage;
  source: 'mock';
  lastLoginAt: Date | null;
}

export interface FictionalProfileFixture {
  openid: string;
  displayName: string;
  realName: string | null;
  college: string | null;
  degree: string | null;
  graduationYear: number | null;
  regionCode: string | null;
  industryCode: string | null;
  direction: string | null;
  intro: string | null;
  verified: boolean;
  verifiedAt: Date | null;
  showInDirectory: boolean;
  showCollege: boolean;
  showIndustry: boolean;
  showRegion: boolean;
  acceptContactRequests: boolean;
  allowContactShare: boolean;
}

export interface FictionalContactFixture {
  openid: string;
  phone: string;
  wechat: string;
  email: string;
}

export interface AlumniFixtureSet {
  users: FictionalUserFixture[];
  profiles: FictionalProfileFixture[];
  contacts: FictionalContactFixture[];
}

export interface AlumniFixtureOptions {
  /** 生成数量 */
  count?: number;
  /** 随机种子 */
  seed?: number;
  /** 出现在通讯录中的校友数量（仅 verified 校友） */
  directoryVisible?: number;
  /** 基准时间 */
  baseTime?: Date;
}

const DEFAULT_BASE_TIME = new Date('2026-01-05T02:00:00.000Z');

/**
 * 生成一批虚构校友：用户 + 校友资料 + 私人联系方式。
 *
 * - stage 分布：verified 60% / pending_review 25% / logged_in 15%
 * - 隐私开关随机混合，但 verified 校友默认允许接受联系申请
 * - 联系方式仅部分校友拥有，且仅存于 private_contacts（密文）
 */
export function buildFictionalAlumni(options: AlumniFixtureOptions = {}): AlumniFixtureSet {
  const count = options.count ?? 1000;
  const directoryVisible = options.directoryVisible ?? 200;
  const baseTime = options.baseTime ?? DEFAULT_BASE_TIME;
  const random = createSeededRandom(options.seed ?? 20260105);

  const users: FictionalUserFixture[] = [];
  const profiles: FictionalProfileFixture[] = [];
  const contacts: FictionalContactFixture[] = [];

  for (let index = 1; index <= count; index += 1) {
    const serial = String(index).padStart(4, '0');
    const openid = `mock_alumni_${serial}`;
    const displayName = `校友${serial}`;

    const stageRoll = random();
    const stage: UserStage =
      stageRoll < 0.6 ? 'verified' : stageRoll < 0.85 ? 'pending_review' : 'logged_in';

    const region = pickOne(random, REGION_FIXTURES);
    const industry = pickOne(random, INDUSTRY_FIXTURES);
    const college = pickOne(random, COLLEGES);
    const degree = pickOne(random, DEGREES);
    const direction = pickOne(random, DIRECTIONS);
    const graduationYear = pickOne(random, GRADUATION_YEARS);

    const statusRoll = random();
    const status: 'active' | 'disabled' | 'locked' =
      statusRoll < 0.97 ? 'active' : statusRoll < 0.99 ? 'disabled' : 'locked';

    const lastLoginAt =
      stage === 'logged_in'
        ? new Date(baseTime.getTime() - randomInt(random, 1, 720) * 3_600_000)
        : null;

    users.push({
      openid,
      nickname: displayName,
      avatarUrl: null,
      status,
      stage,
      source: 'mock',
      lastLoginAt,
    });

    const verified = stage === 'verified';

    profiles.push({
      openid,
      displayName,
      realName: verified ? displayName : null,
      college,
      degree,
      graduationYear,
      regionCode: region.code,
      industryCode: industry.code,
      direction,
      intro:
        `【虚构测试数据】${industry.name}方向，希望与在内蒙古的校友对接${direction}相关合作。`,
      verified,
      verifiedAt: verified ? new Date(baseTime.getTime() - randomInt(random, 1, 365) * 86_400_000) : null,
      showInDirectory: false, // 由下方统一分配
      showCollege: chance(random, 0.9),
      showIndustry: chance(random, 0.9),
      showRegion: chance(random, 0.95),
      acceptContactRequests: chance(random, 0.85),
      allowContactShare: chance(random, 0.7),
    });

    if (chance(random, 0.6)) {
      contacts.push({
        openid,
        phone: `139${String(10000000 + index).slice(0, 8)}`,
        wechat: `mock_alumni_${serial}`,
        email: `alumni${serial}@example.invalid`,
      });
    }
  }

  // 通讯录展示：仅 verified 校友，且不超过 directoryVisible
  const verifiedProfiles = profiles.filter((profile) => profile.verified);
  const visible = verifiedProfiles.slice(0, directoryVisible);
  for (const profile of visible) {
    profile.showInDirectory = true;
  }

  return { users, profiles, contacts };
}

/* ------------------------------------------------------------------ */
/* 资源与需求                                                            */
/* ------------------------------------------------------------------ */

export interface ResourcePostFixture {
  title: string;
  body: string;
  type: ResourceType;
  status: ResourceStatus;
  industryCode: string | null;
  regionCode: string | null;
  publishedAt: Date | null;
  version: number;
}

export interface ResourcePostFixtureOptions {
  count?: number;
  seed?: number;
  baseTime?: Date;
  /** pending 占比，用于给管理端留出待审核数据 */
  pendingRatio?: number;
}

const RESOURCE_TITLES = [
  '【虚构】数字科技方向的技术顾问资源',
  '【虚构】能源产业产能对接需求',
  '【虚构】农牧食品渠道合作资源',
  '【虚构】法律金融合规咨询服务',
  '【虚构】教育科研联合实验室需求',
  '【虚构】企业管理内训资源',
  '【虚构】文化教育研学合作资源',
  '【虚构】新能源装备采购需求',
  '【虚构】农牧冷链仓储资源',
  '【虚构】数据治理与算法咨询需求',
  '【虚构】绿色算力机房资源',
  '【虚构】碳汇与生态修复合作需求',
] as const;

export function buildResourcePostFixtures(
  options: ResourcePostFixtureOptions = {},
): ResourcePostFixture[] {
  const count = options.count ?? 60;
  const pendingRatio = options.pendingRatio ?? 0.3;
  const baseTime = options.baseTime ?? DEFAULT_BASE_TIME;
  const random = createSeededRandom(options.seed ?? 20260202);

  const posts: ResourcePostFixture[] = [];

  for (let index = 1; index <= count; index += 1) {
    const title = `${RESOURCE_TITLES[(index - 1) % RESOURCE_TITLES.length]} #${index}`;
    const roll = random();
    const status: ResourceStatus =
      roll < pendingRatio
        ? 'pending'
        : roll < pendingRatio + 0.35
          ? 'published'
          : roll < pendingRatio + 0.5
            ? 'draft'
            : roll < pendingRatio + 0.62
              ? 'rejected'
              : roll < pendingRatio + 0.72
                ? 'offline'
                : 'withdrawn';

    const published = status === 'published';
    const industry = pickOne(random, INDUSTRY_FIXTURES);
    const region = pickOne(random, REGION_FIXTURES);

    posts.push({
      title,
      body:
        `【虚构测试内容】这是第 ${index} 条${index % 2 === 0 ? '合作需求' : '可共享资源'}，` +
        `属于${industry.name}行业，服务区域为${region.name}。内容仅用于联调与自动化测试。`,
      type: index % 2 === 0 ? 'demand' : 'resource',
      status,
      industryCode: industry.code,
      regionCode: region.code,
      publishedAt: published ? new Date(baseTime.getTime() - randomInt(random, 1, 180) * 86_400_000) : null,
      version: status === 'pending' ? randomInt(random, 0, 2) : 1,
    });
  }

  return posts;
}

/* ------------------------------------------------------------------ */
/* 活动                                                                  */
/* ------------------------------------------------------------------ */

export interface EventFixture {
  title: string;
  kind: string;
  regionCode: string | null;
  place: string;
  description: string;
  startsAt: Date | null;
  endsAt: Date | null;
  capacity: number;
  status: EventStatus;
}

export interface EventFixtureOptions {
  baseTime?: Date;
  seed?: number;
}

export function buildEventFixtures(options: EventFixtureOptions = {}): EventFixture[] {
  const baseTime = options.baseTime ?? DEFAULT_BASE_TIME;
  const random = createSeededRandom(options.seed ?? 20260303);

  const events: EventFixture[] = [
    {
      title: '【虚构】呼和浩特校友返校日',
      kind: 'reunion',
      regionCode: 'HHS',
      place: '呼和浩特市赛罕区某会议中心',
      description: '【虚构测试活动】校友返校与交流活动，限 5 人，用于验证报名并发控制。',
      startsAt: new Date(baseTime.getTime() + 30 * 86_400_000),
      endsAt: new Date(baseTime.getTime() + 30 * 86_400_000 + 4 * 3_600_000),
      capacity: 5,
      status: 'published',
    },
    {
      title: '【虚构】包头新能源产业专场对接会',
      kind: 'industry',
      regionCode: 'BTS',
      place: '包头市某国际会议中心',
      description: '【虚构测试活动】面向能源产业校友的对接会。',
      startsAt: new Date(baseTime.getTime() + 45 * 86_400_000),
      endsAt: new Date(baseTime.getTime() + 45 * 86_400_000 + 3 * 3_600_000),
      capacity: 50,
      status: 'published',
    },
    {
      title: '【虚构】鄂尔多斯校友企业家沙龙',
      kind: 'industry',
      regionCode: 'ORDS',
      place: '鄂尔多斯市某酒店会议室',
      description: '【虚构测试活动】企业家沙龙，不限名额。',
      startsAt: new Date(baseTime.getTime() + 60 * 86_400_000),
      endsAt: null,
      capacity: 0,
      status: 'published',
    },
    {
      title: '【虚构】赤峰公益助学活动',
      kind: 'charity',
      regionCode: 'CFS',
      place: '赤峰市某中学',
      description: '【虚构测试活动】公益助学，规模 30 人。',
      startsAt: new Date(baseTime.getTime() + 75 * 86_400_000),
      endsAt: null,
      capacity: 30,
      status: 'published',
    },
    {
      title: '【虚构】通辽校友讲堂（草稿）',
      kind: 'lecture',
      regionCode: 'TLS',
      place: '通辽市某高校报告厅',
      description: '【虚构测试活动】尚未发布的草稿活动。',
      startsAt: new Date(baseTime.getTime() + 90 * 86_400_000),
      endsAt: null,
      capacity: 20,
      status: 'draft',
    },
  ];

  // 轻微扰动，避免每次生成完全一致的地点描述（仍为确定性）
  for (const event of events) {
    event.description += ` 批次 ${randomInt(random, 1000, 9999)}。`;
  }

  return events;
}

/* ------------------------------------------------------------------ */
/* 校友认证申请                                                          */
/* ------------------------------------------------------------------ */

export interface VerificationApplicationFixture {
  realName: string;
  college: string;
  graduationYear: number;
  degree: string | null;
  studentIdMasked: string | null;
  remark: string | null;
  status: VerificationStatus;
  submittedAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
}

export interface VerificationFixtureOptions {
  count?: number;
  seed?: number;
  baseTime?: Date;
}

export function buildVerificationApplicationFixtures(
  options: VerificationFixtureOptions = {},
): VerificationApplicationFixture[] {
  const count = options.count ?? 40;
  const baseTime = options.baseTime ?? DEFAULT_BASE_TIME;
  const random = createSeededRandom(options.seed ?? 20260404);

  const statuses: VerificationStatus[] = [
    'pending',
    'needs_more_material',
    'approved',
    'rejected',
    'resubmitted',
  ];

  const applications: VerificationApplicationFixture[] = [];

  for (let index = 1; index <= count; index += 1) {
    const serial = String(index).padStart(4, '0');
    const status = statuses[index % statuses.length];
    const submittedAt = new Date(baseTime.getTime() - randomInt(random, 1, 120) * 86_400_000);
    const decided = status === 'approved' || status === 'rejected';

    applications.push({
      realName: `校友${serial}`,
      college: pickOne(random, COLLEGES),
      graduationYear: pickOne(random, GRADUATION_YEARS),
      degree: pickOne(random, DEGREES),
      studentIdMasked: `****${String(1000 + index).slice(-4)}`,
      remark: '【虚构测试数据】用于身份审核队列演示。',
      status,
      submittedAt,
      decidedAt: decided ? new Date(submittedAt.getTime() + 2 * 86_400_000) : null,
      decisionNote: decided
        ? status === 'approved'
          ? '【虚构】材料齐全，审核通过。'
          : '【虚构】材料不足，请补充后重新提交。'
        : null,
    });
  }

  return applications;
}

/* ------------------------------------------------------------------ */
/* 联系申请                                                              */
/* ------------------------------------------------------------------ */

export interface ConnectionRequestFixture {
  message: string;
  status: ConnectionRequestStatus;
  decidedAt: Date | null;
}

/**
 * 生成联系申请历史。
 * 注意：pending_guard 由 seed 脚本按 pair_key 填充，
 * 且同一对用户只允许存在一条 pending（唯一索引 uk_connection_request_pending）。
 */
export function buildConnectionRequestFixtures(
  options: { count?: number; seed?: number; baseTime?: Date } = {},
): ConnectionRequestFixture[] {
  const count = options.count ?? 30;
  const baseTime = options.baseTime ?? DEFAULT_BASE_TIME;
  const random = createSeededRandom(options.seed ?? 20260505);

  const statuses: ConnectionRequestStatus[] = [
    'pending',
    'accepted',
    'rejected',
    'cancelled',
    'expired',
  ];

  const requests: ConnectionRequestFixture[] = [];

  for (let index = 1; index <= count; index += 1) {
    const status = statuses[index % statuses.length];
    const createdOffset = randomInt(random, 1, 90) * 86_400_000;

    requests.push({
      message: `【虚构测试数据】您好，我是${pickOne(random, DIRECTIONS)}方向的校友，希望建立联系。`,
      status,
      decidedAt:
        status === 'pending' ? null : new Date(baseTime.getTime() - createdOffset + 3_600_000),
    });
  }

  return requests;
}
