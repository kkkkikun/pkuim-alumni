/* eslint-disable no-console */
import 'reflect-metadata';

import * as bcrypt from 'bcryptjs';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';

import { DataSource, In, Like } from 'typeorm';
import type { ObjectLiteral, QueryDeepPartialEntity, Repository } from 'typeorm';

import { AppDataSource } from '../data-source';
import {
  AdminUser,
  AdminUserRole,
  AlumniProfile,
  Article,
  ArticleCategory,
  ConnectionPair,
  ConnectionRequestHistory,
  ContactShareGrant,
  Event,
  EventRegistration,
  IdempotencyRecord,
  Industry,
  MediaAsset,
  Notice,
  OutboxEvent,
  Permission,
  PrivateContact,
  Region,
  ResourcePost,
  ResourcePostReview,
  Role,
  RolePermission,
  SystemSetting,
  User,
  VerificationApplication,
  VerificationAttachment,
  VerificationReview,
} from '../entities';
import {
  COLLEGES,
  INDUSTRY_FIXTURES,
  REGION_FIXTURES,
  buildConnectionRequestFixtures,
  buildEventFixtures,
  buildFictionalAlumni,
  buildResourcePostFixtures,
  buildVerificationApplicationFixtures,
} from './fixtures';

/* ------------------------------------------------------------------ */
/* 常量                                                                  */
/* ------------------------------------------------------------------ */

/** 初始超级管理员账号（仅用于开发/测试环境） */
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'Admin@2026';
const ADMIN_DISPLAY_NAME = '超级管理员';
const BCRYPT_COST = 10;

/** 虚构校友数据前缀，用于幂等判断 */
const ALUMNI_OPENID_PREFIX = 'mock_alumni_';
const ALUMNI_COUNT = 1000;
const ALUMNI_DIRECTORY_VISIBLE = 200;

/**
 * 压测账号（k6 专用）。
 *
 * openid 形如 `mock_k6_alumni_001`，对应 Mock 登录 code `k6_alumni_001`
 * （Mock 提供方会给 code 补 `mock_` 前缀）。
 * 这些账号固定为：已认证 / 启用 / 通讯录可见 / 接受联系申请 / 允许共享联系方式，
 * 便于压测脚本稳定命中「校友受限接口」而不会因为未认证被 403。
 */
const LOADTEST_OPENID_PREFIX = 'mock_k6_alumni_';
const LOADTEST_COUNT = Number(process.env.SEED_LOADTEST_COUNT ?? 50);

const PERMISSION_FIXTURES = [
  { code: 'dashboard:view', name: '数据总览', description: '查看管理后台数据总览' },
  { code: 'alumni:view', name: '校友查看', description: '查看校友列表与详情' },
  { code: 'alumni:manage', name: '校友管理', description: '编辑校友资料与隐私设置' },
  { code: 'verification:review', name: '身份审核', description: '审核校友身份认证申请' },
  { code: 'resource:review', name: '资源审核', description: '审核资源与需求发布' },
  { code: 'resource:manage', name: '资源管理', description: '管理资源与需求内容' },
  { code: 'event:manage', name: '活动管理', description: '创建与维护活动及报名' },
  { code: 'content:manage', name: '内容管理', description: '管理资讯、公告与分类' },
  { code: 'notification:broadcast', name: '通知广播', description: '发布站内通知与广播' },
  { code: 'admin:manage', name: '管理员管理', description: '管理管理员、角色与权限' },
  { code: 'audit:view', name: '审计查看', description: '查看操作审计日志' },
  { code: 'settings:manage', name: '系统设置', description: '维护系统参数与字典' },
] as const;

const ROLE_FIXTURES = [
  {
    code: 'super_admin',
    name: '超级管理员',
    description: '拥有全部权限',
    permissions: PERMISSION_FIXTURES.map((permission) => permission.code),
  },
  {
    code: 'alumni_reviewer',
    name: '校友审核员',
    description: '负责校友身份认证与校友资料管理',
    permissions: ['alumni:view', 'alumni:manage', 'verification:review', 'audit:view'],
  },
  {
    code: 'resource_reviewer',
    name: '资源审核员',
    description: '负责资源与需求的审核发布',
    permissions: ['resource:review', 'resource:manage', 'audit:view'],
  },
  {
    code: 'content_admin',
    name: '内容管理员',
    description: '负责资讯、公告与通知广播',
    permissions: ['content:manage', 'notification:broadcast', 'audit:view'],
  },
  {
    code: 'event_admin',
    name: '活动管理员',
    description: '负责活动创建与报名管理',
    permissions: ['event:manage', 'audit:view'],
  },
] as const;

const ARTICLE_CATEGORY_FIXTURES = [
  { name: '校友动态', slug: 'alumni-news', sortOrder: 1 },
  { name: '政策解读', slug: 'policy', sortOrder: 2 },
  { name: '行业观察', slug: 'industry', sortOrder: 3 },
  { name: '活动纪实', slug: 'events', sortOrder: 4 },
] as const;

const SYSTEM_SETTING_FIXTURES = [
  { key: 'platform.name', value: '内蒙古北京大学校友会', description: '平台名称' },
  { key: 'directory.default_page_size', value: '20', description: '通讯录默认分页大小' },
  { key: 'connection.request_ttl_hours', value: '168', description: '联系申请有效期（小时）' },
] as const;

const CHUNK_SIZE = 200;

/* ------------------------------------------------------------------ */
/* 工具                                                                  */
/* ------------------------------------------------------------------ */

/**
 * 联系方式加密（与 apps/api/src/common/utils/crypto.ts 保持同样的密文格式：
 * iv(12) + tag(16) + ciphertext，base64 存储，密钥由 JWT_SECRET 派生）。
 * 此处独立实现以避免 Seed 与业务代码强耦合。
 */
function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest().subarray(0, 32);
}

function encryptContact(plain: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

async function insertIgnore<T extends ObjectLiteral>(
  repository: Repository<T>,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await repository
    .createQueryBuilder()
    .insert()
    .values(rows as unknown as QueryDeepPartialEntity<T>[])
    .orIgnore()
    .execute();
}

async function chunkedInsertIgnore<T extends ObjectLiteral>(
  repository: Repository<T>,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  for (let index = 0; index < rows.length; index += CHUNK_SIZE) {
    await insertIgnore(repository, rows.slice(index, index + CHUNK_SIZE));
  }
}

/* ------------------------------------------------------------------ */
/* Seed 步骤                                                             */
/* ------------------------------------------------------------------ */

async function seedDictionaries(dataSource: DataSource): Promise<void> {
  const regions = dataSource.getRepository(Region);
  const industries = dataSource.getRepository(Industry);

  await insertIgnore(
    regions,
    REGION_FIXTURES.map((region) => ({ ...region })),
  );
  await insertIgnore(
    industries,
    INDUSTRY_FIXTURES.map((industry) => ({ ...industry })),
  );

  await insertIgnore(
    dataSource.getRepository(SystemSetting),
    SYSTEM_SETTING_FIXTURES.map((setting) => ({ ...setting })),
  );
}

async function seedRbac(dataSource: DataSource): Promise<Map<string, number>> {
  const permissionRepo = dataSource.getRepository(Permission);
  const roleRepo = dataSource.getRepository(Role);

  await insertIgnore(
    permissionRepo,
    PERMISSION_FIXTURES.map((permission) => ({ ...permission })),
  );
  await insertIgnore(
    roleRepo,
    ROLE_FIXTURES.map((role) => ({
      code: role.code,
      name: role.name,
      description: role.description,
    })),
  );

  const permissions = await permissionRepo.find();
  const permissionIdByCode = new Map(permissions.map((item) => [item.code, item.id]));

  const roles = await roleRepo.find();
  const roleIdByCode = new Map(roles.map((role) => [role.code, role.id]));

  const rolePermissionRepo = dataSource.getRepository(RolePermission);
  const existing = await rolePermissionRepo.find();
  const existingPairs = new Set(existing.map((item) => `${item.roleId}:${item.permissionId}`));

  const rows: Array<Record<string, unknown>> = [];
  for (const role of ROLE_FIXTURES) {
    const roleId = roleIdByCode.get(role.code);
    if (roleId === undefined) {
      continue;
    }
    for (const permissionCode of role.permissions) {
      const permissionId = permissionIdByCode.get(permissionCode);
      if (permissionId === undefined) {
        continue;
      }
      const pairKeyValue = `${roleId}:${permissionId}`;
      if (existingPairs.has(pairKeyValue)) {
        continue;
      }
      existingPairs.add(pairKeyValue);
      rows.push({ roleId, permissionId });
    }
  }
  await insertIgnore(rolePermissionRepo, rows);

  return roleIdByCode;
}

async function seedAdminUser(
  dataSource: DataSource,
  roleIdByCode: Map<string, number>,
): Promise<number> {
  const adminRepo = dataSource.getRepository(AdminUser);
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, BCRYPT_COST);

  let admin = await adminRepo.findOne({ where: { username: ADMIN_USERNAME } });

  if (!admin) {
    admin = await adminRepo.save(
      adminRepo.create({
        username: ADMIN_USERNAME,
        passwordHash,
        displayName: ADMIN_DISPLAY_NAME,
        status: 'active',
      }),
    );
  } else {
    // 已存在则重置为约定口令，避免出现无法登录的残留账号
    admin.passwordHash = passwordHash;
    admin.displayName = ADMIN_DISPLAY_NAME;
    admin.status = 'active';
    admin = await adminRepo.save(admin);
  }

  const superAdminRoleId = roleIdByCode.get('super_admin');
  if (superAdminRoleId !== undefined) {
    await insertIgnore(dataSource.getRepository(AdminUserRole), [
      { adminUserId: admin.id, roleId: superAdminRoleId },
    ]);
  }

  return admin.id;
}

async function seedAlumni(dataSource: DataSource, adminId: number): Promise<number[]> {
  const userRepo = dataSource.getRepository(User);
  const profileRepo = dataSource.getRepository(AlumniProfile);
  const contactRepo = dataSource.getRepository(PrivateContact);

  const marker = await userRepo.findOne({
    where: { openid: `${ALUMNI_OPENID_PREFIX}0001` },
    select: { id: true },
  });

  if (marker) {
    console.log('· 虚构校友数据已存在，跳过生成（幂等）');
    const existing = await userRepo.find({
      select: { id: true },
      where: { openid: Like(`${ALUMNI_OPENID_PREFIX}%`) },
    });
    return existing.map((user) => user.id);
  }

  const fixtures = buildFictionalAlumni({
    count: ALUMNI_COUNT,
    directoryVisible: ALUMNI_DIRECTORY_VISIBLE,
    seed: 20260105,
  });

  await chunkedInsertIgnore(
    userRepo,
    fixtures.users.map((user) => ({
      openid: user.openid,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      status: user.status,
      stage: user.stage,
      source: user.source,
      lastLoginAt: user.lastLoginAt,
    })),
  );

  const persisted = await userRepo.find({
    select: { id: true, openid: true },
    where: { openid: Like(`${ALUMNI_OPENID_PREFIX}%`) },
  });
  const userIdByOpenid = new Map(persisted.map((user) => [user.openid, user.id]));

  await chunkedInsertIgnore(
    profileRepo,
    fixtures.profiles
      .map((profile) => {
        const userId = userIdByOpenid.get(profile.openid);
        if (userId === undefined) {
          return null;
        }
        return {
          userId,
          displayName: profile.displayName,
          realName: profile.realName,
          college: profile.college,
          degree: profile.degree,
          graduationYear: profile.graduationYear,
          regionCode: profile.regionCode,
          industryCode: profile.industryCode,
          direction: profile.direction,
          intro: profile.intro,
          verified: profile.verified,
          verifiedAt: profile.verifiedAt,
          verifiedBy: profile.verified ? adminId : null,
          showInDirectory: profile.showInDirectory,
          showCollege: profile.showCollege,
          showIndustry: profile.showIndustry,
          showRegion: profile.showRegion,
          acceptContactRequests: profile.acceptContactRequests,
          allowContactShare: profile.allowContactShare,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null),
  );

  const contactSecret = process.env.JWT_SECRET ?? 'nmg-pku-alumni-dev-secret';
  await chunkedInsertIgnore(
    contactRepo,
    fixtures.contacts
      .map((contact) => {
        const userId = userIdByOpenid.get(contact.openid);
        if (userId === undefined) {
          return null;
        }
        return {
          userId,
          phoneCipher: encryptContact(contact.phone, contactSecret),
          wechatCipher: encryptContact(contact.wechat, contactSecret),
          emailCipher: encryptContact(contact.email, contactSecret),
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null),
  );

  console.log(
    `· 生成虚构校友 ${fixtures.users.length} 人（通讯录可见 ${ALUMNI_DIRECTORY_VISIBLE} 人），` +
      `联系方式 ${fixtures.contacts.length} 条`,
  );

  return persisted.map((user) => user.id);
}

/**
 * 生成压测专用账号（幂等）。
 *
 * 这些账号仅用于自动化压测，不属于业务数据；正式环境如需保留请显式配置。
 */
async function seedLoadTestAccounts(dataSource: DataSource, adminId: number): Promise<void> {
  const userRepo = dataSource.getRepository(User);
  const profileRepo = dataSource.getRepository(AlumniProfile);
  const contactRepo = dataSource.getRepository(PrivateContact);
  const baseTime = new Date();

  const users = [];
  const profiles = [];
  const contacts = [];
  for (let index = 1; index <= LOADTEST_COUNT; index += 1) {
    const serial = String(index).padStart(3, '0');
    const openid = `${LOADTEST_OPENID_PREFIX}${serial}`;
    users.push({
      openid,
      nickname: `压测校友${serial}`,
      avatarUrl: null,
      status: 'active' as const,
      stage: 'verified' as const,
      source: 'mock',
      lastLoginAt: null,
    });
    profiles.push({
      openid,
      displayName: `压测校友${serial}`,
      realName: `压测校友${serial}`,
      college: COLLEGES[(index - 1) % COLLEGES.length],
      degree: '学士',
      graduationYear: 2010 + (index % 10),
      regionCode: REGION_FIXTURES[index % REGION_FIXTURES.length].code,
      industryCode: INDUSTRY_FIXTURES[index % INDUSTRY_FIXTURES.length].code,
      direction: '压测方向',
      intro: '【压测专用账号】仅用于自动化压测，不含任何真实个人信息。',
      verified: true,
      verifiedAt: baseTime,
      verifiedBy: adminId,
      showInDirectory: true,
      showCollege: true,
      showIndustry: true,
      showRegion: true,
      showDirection: true,
      acceptContactRequests: true,
      allowContactShare: true,
    });
    contacts.push({
      openid,
      phone: `1380000${String(index).padStart(4, '0')}`,
      wechat: `k6_alumni_${serial}`,
      email: `k6_alumni_${serial}@example.com`,
    });
  }

  await chunkedInsertIgnore(userRepo, users as unknown as Array<Record<string, unknown>>);
  const persisted = await userRepo.find({
    select: { id: true, openid: true },
    where: { openid: Like(`${LOADTEST_OPENID_PREFIX}%`) },
  });
  const userIdByOpenid = new Map(persisted.map((user) => [user.id ? user.openid : '', user.id]));

  await chunkedInsertIgnore(
    profileRepo,
    profiles
      .map((profile) => {
        const userId = userIdByOpenid.get(profile.openid);
        if (userId === undefined) return null;
        return {
          userId,
          displayName: profile.displayName,
          realName: profile.realName,
          college: profile.college,
          degree: profile.degree,
          graduationYear: profile.graduationYear,
          regionCode: profile.regionCode,
          industryCode: profile.industryCode,
          direction: profile.direction,
          intro: profile.intro,
          verified: profile.verified,
          verifiedAt: profile.verifiedAt,
          verifiedBy: profile.verifiedBy,
          showInDirectory: profile.showInDirectory,
          showCollege: profile.showCollege,
          showIndustry: profile.showIndustry,
          showRegion: profile.showRegion,
          showDirection: profile.showDirection,
          acceptContactRequests: profile.acceptContactRequests,
          allowContactShare: profile.allowContactShare,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null),
  );

  const contactSecret = process.env.JWT_SECRET ?? 'nmg-pku-alumni-dev-secret';
  await chunkedInsertIgnore(
    contactRepo,
    contacts
      .map((contact) => {
        const userId = userIdByOpenid.get(contact.openid);
        if (userId === undefined) return null;
        return {
          userId,
          phoneCipher: encryptContact(contact.phone, contactSecret),
          wechatCipher: encryptContact(contact.wechat, contactSecret),
          emailCipher: encryptContact(contact.email, contactSecret),
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null),
  );

  console.log(`· 生成压测专用账号 ${LOADTEST_COUNT} 个（openid 前缀 ${LOADTEST_OPENID_PREFIX}）`);
}

async function seedConnections(dataSource: DataSource): Promise<void> {
  const pairRepo = dataSource.getRepository(ConnectionPair);
  const grantRepo = dataSource.getRepository(ContactShareGrant);
  const requestRepo = dataSource.getRepository(ConnectionRequestHistory);

  if ((await pairRepo.count()) > 0) {
    console.log('· 连接关系数据已存在，跳过生成（幂等）');
    return;
  }

  const verified = await dataSource
    .getRepository(User)
    .find({ select: { id: true }, where: { stage: 'verified' } });
  const verifiedIds = verified.map((user) => user.id);

  if (verifiedIds.length < 20) {
    console.log('· 已认证校友数量不足，跳过连接关系生成');
    return;
  }

  // 1) 建立 40 组正式连接（规范化：user_a_id < user_b_id）
  const pairs: Array<{ userAId: number; userBId: number }> = [];
  for (let index = 0; index < 40; index += 1) {
    const a = verifiedIds[index * 2];
    const b = verifiedIds[index * 2 + 1];
    if (a === undefined || b === undefined) {
      continue;
    }
    const [low, high] = a < b ? [a, b] : [b, a];
    pairs.push({ userAId: low, userBId: high });
  }

  await insertIgnore(
    pairRepo,
    pairs.map((pair) => ({
      userAId: pair.userAId,
      userBId: pair.userBId,
      status: 'active',
      establishedAt: new Date('2026-01-10T08:00:00.000Z'),
    })),
  );

  const persistedPairs = await pairRepo.find();

  // 2) 联系方式授权（双方独立授权，可撤回）
  const grantRows: Array<Record<string, unknown>> = [];
  for (const pair of persistedPairs) {
    grantRows.push({
      pairId: pair.id,
      userId: pair.userAId,
      allow: pair.userAId % 3 !== 0 ? 1 : 0,
    });
    grantRows.push({
      pairId: pair.id,
      userId: pair.userBId,
      allow: pair.userBId % 3 !== 0 ? 1 : 0,
    });
  }
  await insertIgnore(grantRepo, grantRows);

  // 3) 联系申请历史
  const fixtures = buildConnectionRequestFixtures({ count: 30, seed: 20260505 });
  const requestRows: Array<Record<string, unknown>> = [];
  let freshPairCursor = 120;

  for (const fixture of fixtures) {
    let fromUserId: number | undefined;
    let toUserId: number | undefined;
    let pairId: number | null = null;

    if (fixture.status === 'accepted') {
      const pair = persistedPairs[requestRows.length % Math.max(persistedPairs.length, 1)];
      if (pair) {
        fromUserId = pair.userAId;
        toUserId = pair.userBId;
        pairId = pair.id;
      }
    }

    if (fromUserId === undefined || toUserId === undefined) {
      const a = verifiedIds[freshPairCursor];
      const b = verifiedIds[freshPairCursor + 1];
      freshPairCursor += 2;
      if (a === undefined || b === undefined) {
        continue;
      }
      fromUserId = a;
      toUserId = b;
    }

    const key = pairKey(fromUserId, toUserId);

    requestRows.push({
      fromUserId,
      toUserId,
      pairKey: key,
      // pending 时才占用唯一索引，其余状态置 NULL（MySQL 唯一索引允许多个 NULL）
      pendingGuard: fixture.status === 'pending' ? key : null,
      pairId,
      message: fixture.message,
      status: fixture.status,
      decidedAt: fixture.decidedAt,
    });
  }

  await insertIgnore(requestRepo, requestRows);
  console.log(`· 生成连接关系 ${persistedPairs.length} 组，联系申请历史 ${requestRows.length} 条`);
}

async function seedResources(dataSource: DataSource, alumniIds: number[]): Promise<void> {
  const postRepo = dataSource.getRepository(ResourcePost);
  const reviewRepo = dataSource.getRepository(ResourcePostReview);

  if ((await postRepo.count()) > 0) {
    console.log('· 资源与需求数据已存在，跳过生成（幂等）');
    return;
  }

  const fixtures = buildResourcePostFixtures({ count: 60, seed: 20260202 });
  const verified = alumniIds.length > 0 ? alumniIds : [];

  if (verified.length === 0) {
    console.log('· 没有可用的作者账号，跳过资源生成');
    return;
  }

  const rows = fixtures.map((fixture, index) => {
    const authorId = verified[index % verified.length];
    return {
      authorId,
      type: fixture.type,
      title: fixture.title,
      body: fixture.body,
      industryCode: fixture.industryCode,
      regionCode: fixture.regionCode,
      status: fixture.status,
      version: fixture.version,
      publishedAt: fixture.publishedAt,
      createdBy: authorId,
    };
  });

  await chunkedInsertIgnore(postRepo, rows);

  // 审核历史（只追加）：为已审核过的内容补一条历史记录
  const posts = await postRepo.find({
    select: { id: true, status: true, version: true },
    where: { status: In(['published', 'rejected', 'offline']) },
  });

  const admin = await dataSource
    .getRepository(AdminUser)
    .findOne({ where: { username: ADMIN_USERNAME }, select: { id: true } });

  if (admin) {
    await insertIgnore(
      reviewRepo,
      posts.map((post) => ({
        postId: post.id,
        adminId: admin.id,
        action: post.status === 'published' ? 'approve' : post.status === 'rejected' ? 'reject' : 'offline',
        note: '【虚构测试数据】初始审核记录。',
        snapshotVersion: post.version,
      })),
    );
  }

  console.log(`· 生成资源与需求 ${rows.length} 条（含待审核数据）`);
}

async function seedContent(dataSource: DataSource): Promise<void> {
  const categoryRepo = dataSource.getRepository(ArticleCategory);
  const articleRepo = dataSource.getRepository(Article);
  const noticeRepo = dataSource.getRepository(Notice);

  if ((await articleRepo.count()) > 0) {
    console.log('· 资讯与公告数据已存在，跳过生成（幂等）');
    return;
  }

  await insertIgnore(
    categoryRepo,
    ARTICLE_CATEGORY_FIXTURES.map((category) => ({ ...category })),
  );

  const categories = await categoryRepo.find();
  const admin = await dataSource
    .getRepository(AdminUser)
    .findOne({ where: { username: ADMIN_USERNAME }, select: { id: true } });
  const adminId = admin?.id ?? null;

  const articleRows: Array<Record<string, unknown>> = [];
  for (let index = 1; index <= 10; index += 1) {
    const category = categories[index % Math.max(categories.length, 1)];
    const published = index <= 8;
    articleRows.push({
      categoryId: category?.id ?? null,
      title: `【虚构】校友会资讯第 ${index} 期`,
      summary: `【虚构测试数据】第 ${index} 期资讯摘要。`,
      body: `【虚构测试数据】这是第 ${index} 期资讯正文，用于首页与资讯列表联调。`,
      status: published ? 'published' : 'draft',
      publishedAt: published ? new Date(`2026-01-${String(index).padStart(2, '0')}T08:00:00.000Z`) : null,
      viewCount: index * 13,
      createdBy: adminId,
    });
  }
  await insertIgnore(articleRepo, articleRows);

  const noticeRows: Array<Record<string, unknown>> = [];
  for (let index = 1; index <= 5; index += 1) {
    const published = index <= 4;
    noticeRows.push({
      title: `【虚构】校友会公告第 ${index} 号`,
      body: `【虚构测试数据】第 ${index} 号公告正文。`,
      status: published ? 'published' : 'draft',
      publishedAt: published ? new Date(`2026-01-${String(index).padStart(2, '0')}T09:00:00.000Z`) : null,
      viewCount: index * 7,
      createdBy: adminId,
    });
  }
  await insertIgnore(noticeRepo, noticeRows);

  console.log(`· 生成分类 ${categories.length} 个，资讯 ${articleRows.length} 条，公告 ${noticeRows.length} 条`);
}

async function seedEvents(dataSource: DataSource, alumniIds: number[]): Promise<void> {
  const eventRepo = dataSource.getRepository(Event);
  const registrationRepo = dataSource.getRepository(EventRegistration);

  if ((await eventRepo.count()) > 0) {
    console.log('· 活动数据已存在，跳过生成（幂等）');
    return;
  }

  const fixtures = buildEventFixtures({ seed: 20260303 });
  const admin = await dataSource
    .getRepository(AdminUser)
    .findOne({ where: { username: ADMIN_USERNAME }, select: { id: true } });

  await insertIgnore(
    eventRepo,
    fixtures.map((fixture) => ({
      title: fixture.title,
      kind: fixture.kind,
      regionCode: fixture.regionCode,
      place: fixture.place,
      description: fixture.description,
      startsAt: fixture.startsAt,
      endsAt: fixture.endsAt,
      capacity: fixture.capacity,
      registeredCount: 0,
      status: fixture.status,
      createdBy: admin?.id ?? null,
    })),
  );

  const events = await eventRepo.find();
  const registrationRows: Array<Record<string, unknown>> = [];
  const registeredCountByEvent = new Map<number, number>();
  let cursor = 0;

  for (const event of events) {
    // 容量为 5 的活动预置 3 名报名；其他活动 4~6 名
    const count = event.capacity === 5 ? 3 : 4 + (cursor % 3);
    let inserted = 0;
    for (let index = 0; index < count; index += 1) {
      const userId = alumniIds[(cursor + index) % Math.max(alumniIds.length, 1)];
      if (userId === undefined) {
        continue;
      }
      registrationRows.push({
        eventId: event.id,
        userId,
        status: 'registered',
        note: '【虚构测试数据】预置报名记录。',
      });
      inserted += 1;
    }
    registeredCountByEvent.set(event.id, inserted);
    cursor += count;
  }

  await chunkedInsertIgnore(registrationRepo, registrationRows);

  // 同步已报名人数（正式业务由事务内条件更新维护）
  for (const event of events) {
    await eventRepo.update(
      { id: event.id },
      { registeredCount: registeredCountByEvent.get(event.id) ?? 0 },
    );
  }

  console.log(`· 生成活动 ${events.length} 个（含容量 5 的活动），报名记录 ${registrationRows.length} 条`);
}

async function seedVerifications(dataSource: DataSource): Promise<void> {
  const applicationRepo = dataSource.getRepository(VerificationApplication);
  const reviewRepo = dataSource.getRepository(VerificationReview);
  const attachmentRepo = dataSource.getRepository(VerificationAttachment);
  const mediaRepo = dataSource.getRepository(MediaAsset);

  if ((await applicationRepo.count()) > 0) {
    console.log('· 认证申请数据已存在，跳过生成（幂等）');
    return;
  }

  const fixtures = buildVerificationApplicationFixtures({ count: 40, seed: 20260404 });

  // 申请状态必须与申请人的 users.stage 对齐（状态机见 alumni.service.ts）：
  //   approved            → verified
  //   pending/resubmitted → pending_review
  //   needs_more_material/rejected → logged_in
  // 否则会出现「用户已认证却没有通过记录」「有待审申请但用户不在待审阶段」这类
  // 与业务不变量冲突的数据（由 infra/scripts/check-data-integrity.sh 守住）。
  const stageUsers = await dataSource.getRepository(User).find({
    select: { id: true, stage: true },
  });
  const poolByStatus: Record<string, number[]> = {
    approved: [],
    pending: [],
    resubmitted: [],
    needs_more_material: [],
    rejected: [],
  };
  const verifiedIds: number[] = [];
  const pendingReviewIds: number[] = [];
  const loggedInIds: number[] = [];
  for (const user of stageUsers) {
    if (user.stage === 'verified') verifiedIds.push(user.id);
    else if (user.stage === 'pending_review') pendingReviewIds.push(user.id);
    else loggedInIds.push(user.id);
  }
  // 同一条申请池内不重复取人：奇偶下标分给两种状态，避免同一用户出现两条在途申请
  poolByStatus.approved = verifiedIds;
  poolByStatus.pending = pendingReviewIds.filter((_, index) => index % 2 === 0);
  poolByStatus.resubmitted = pendingReviewIds.filter((_, index) => index % 2 === 1);
  poolByStatus.needs_more_material = loggedInIds.filter((_, index) => index % 2 === 0);
  poolByStatus.rejected = loggedInIds.filter((_, index) => index % 2 === 1);

  const cursors: Record<string, number> = {};
  const assigned = fixtures.flatMap((fixture) => {
    const pool = poolByStatus[fixture.status] ?? [];
    const index = cursors[fixture.status] ?? 0;
    const userId = pool[index];
    if (userId === undefined) return [];
    cursors[fixture.status] = index + 1;
    return [{ fixture, userId }];
  });

  const admin = await dataSource
    .getRepository(AdminUser)
    .findOne({ where: { username: ADMIN_USERNAME }, select: { id: true } });
  const adminId = admin?.id ?? null;

  await insertIgnore(
    applicationRepo,
    assigned.map(({ fixture, userId }) => ({
      userId,
      realName: fixture.realName,
      college: fixture.college,
      graduationYear: fixture.graduationYear,
      degree: fixture.degree,
      studentIdMasked: fixture.studentIdMasked,
      remark: fixture.remark,
      status: fixture.status,
      decidedBy: fixture.decidedAt ? adminId : null,
      decisionNote: fixture.decisionNote,
      submittedAt: fixture.submittedAt,
      decidedAt: fixture.decidedAt,
    })),
  );

  const applications = await applicationRepo.find({
    select: { id: true, status: true, version: true },
  });

  if (adminId !== null) {
    const reviewRows = applications
      .filter((application) => application.status !== 'pending' && application.status !== 'resubmitted')
      .map((application) => ({
        applicationId: application.id,
        adminId,
        action:
          application.status === 'approved'
            ? ('approve' as const)
            : application.status === 'rejected'
              ? ('reject' as const)
              : ('request_changes' as const),
        note: '【虚构测试数据】初始审核记录。',
        snapshotVersion: application.version,
      }));
    await insertIgnore(reviewRepo, reviewRows);
  }

  // 证明材料（虚构文件元数据）
  const mediaRows = Array.from({ length: 5 }, (_, index) => ({
    fileName: `mock-verification-${index + 1}.jpg`,
    mimeType: 'image/jpeg',
    size: 128 * 1024 + index * 1024,
    bucket: 'nmg-pku-private',
    objectKey: `verification/mock-${index + 1}.jpg`,
    visibility: 'private',
    uploaderId: assigned[0]?.userId ?? null,
  }));
  await insertIgnore(mediaRepo, mediaRows);

  const media = await mediaRepo.find();
  const attachmentRows = applications.slice(0, 10).map((application, index) => ({
    applicationId: application.id,
    mediaId: media[index % Math.max(media.length, 1)]?.id ?? 0,
  }));
  await insertIgnore(attachmentRepo, attachmentRows);

  console.log(
    `· 生成认证申请 ${applications.length} 条，审核历史 ${applications.length} 条，证明材料 ${media.length} 个`,
  );
}

/**
 * 按用户的认证状态补录认证申请与审核记录。
 *
 * 背景：虚构校友的 users.stage 按 60% / 25% / 15% 随机分配，
 *       但认证流程记录（verification_applications）此前只生成 40 条队列演示数据，
 *       导致「已认证校友」绝大多数没有对应的通过记录 —— 与业务不变量冲突
 *       （见 infra/scripts/check-data-integrity.sh 的 C1 / C2 / E3 / E4）。
 *       本函数让 seed 产出的数据自洽：每个已认证校友有通过记录，
 *       每个待审核校友有在途申请。
 *
 * 幂等：已有对应申请的用户直接跳过；重复执行不会产生重复记录。
 */
async function seedVerificationHistory(dataSource: DataSource): Promise<void> {
  const userRepo = dataSource.getRepository(User);
  const profileRepo = dataSource.getRepository(AlumniProfile);
  const applicationRepo = dataSource.getRepository(VerificationApplication);
  const reviewRepo = dataSource.getRepository(VerificationReview);

  const users = await userRepo.find({
    select: { id: true, stage: true, nickname: true, createdAt: true },
    where: { stage: In(['verified', 'pending_review']) },
  });
  if (users.length === 0) {
    console.log('· 没有需要补录认证记录的校友');
    return;
  }

  const existing = new Set(
    (
      await applicationRepo.find({ select: { userId: true, status: true } })
    )
      .filter(
        (application) =>
          application.status === 'approved' ||
          application.status === 'pending' ||
          application.status === 'resubmitted',
      )
      .map((application) => application.userId),
  );

  const profiles = await profileRepo.find({
    select: {
      userId: true,
      realName: true,
      displayName: true,
      college: true,
      graduationYear: true,
      degree: true,
      verifiedAt: true,
    },
  });
  const profileByUserId = new Map(profiles.map((profile) => [profile.userId, profile]));

  const admin = await dataSource
    .getRepository(AdminUser)
    .findOne({ where: { username: ADMIN_USERNAME }, select: { id: true } });
  const adminId = admin?.id ?? null;

  const approvedRows: Array<Record<string, unknown>> = [];
  const pendingRows: Array<Record<string, unknown>> = [];

  for (const user of users) {
    if (existing.has(user.id)) continue;
    const profile = profileByUserId.get(user.id);
    const realName = profile?.realName || profile?.displayName || user.nickname;
    const college = profile?.college || '未填写';
    const graduationYear = profile?.graduationYear ?? 2015;
    const degree = profile?.degree ?? null;
    const studentIdMasked = `SN${String(user.id).padStart(8, '0')}`;

    if (user.stage === 'verified') {
      const decidedAt = profile?.verifiedAt ?? user.createdAt ?? new Date();
      approvedRows.push({
        userId: user.id,
        realName,
        college,
        graduationYear,
        degree,
        studentIdMasked,
        remark: '【虚构测试数据】按用户认证状态补录的通过记录。',
        status: 'approved',
        decidedBy: adminId,
        decisionNote: '【虚构】材料齐全，审核通过。',
        submittedAt: decidedAt,
        decidedAt,
        version: 0,
      });
    } else {
      pendingRows.push({
        userId: user.id,
        realName,
        college,
        graduationYear,
        degree,
        studentIdMasked,
        remark: '【虚构测试数据】按用户认证状态补录的待审核记录。',
        status: 'pending',
        submittedAt: user.createdAt ?? new Date(),
        version: 0,
      });
    }
  }

  await chunkedInsertIgnore(applicationRepo, approvedRows);
  await chunkedInsertIgnore(applicationRepo, pendingRows);

  // 审核记录：每条 approved 申请都要有对应的 approve 审核
  const reviewedApplicationIds = new Set(
    (await reviewRepo.find({ select: { applicationId: true } })).map(
      (review) => review.applicationId,
    ),
  );
  const approvedApplications = await applicationRepo.find({
    select: { id: true, version: true, decidedBy: true },
    where: { status: 'approved' },
  });
  const reviewRows = approvedApplications
    .filter((application) => !reviewedApplicationIds.has(application.id))
    .map((application) => ({
      applicationId: application.id,
      adminId: application.decidedBy ?? adminId,
      action: 'approve' as const,
      note: '【虚构测试数据】补录的审核通过记录。',
      snapshotVersion: application.version,
    }));
  await chunkedInsertIgnore(reviewRepo, reviewRows);

  console.log(
    `· 补录认证申请 ${approvedRows.length + pendingRows.length} 条（通过 ${approvedRows.length} / 待审 ${pendingRows.length}），审核记录 ${reviewRows.length} 条`,
  );
}

async function seedOutbox(dataSource: DataSource): Promise<void> {
  const outboxRepo = dataSource.getRepository(OutboxEvent);
  if ((await outboxRepo.count()) > 0) {
    return;
  }
  await insertIgnore(outboxRepo, [
    {
      aggregateType: 'system',
      aggregateId: 'seed',
      eventType: 'seed.completed',
      payload: { source: 'seed', note: '【虚构测试数据】种子数据写入完成' },
      status: 'done',
      attempts: 1,
      availableAt: new Date('2026-01-05T02:00:00.000Z'),
      processedAt: new Date('2026-01-05T02:00:01.000Z'),
    },
  ]);
}

async function printSummary(dataSource: DataSource): Promise<void> {
  const counts: Array<[string, number]> = [
    ['regions', await dataSource.getRepository(Region).count()],
    ['industries', await dataSource.getRepository(Industry).count()],
    ['users', await dataSource.getRepository(User).count()],
    ['alumni_profiles', await dataSource.getRepository(AlumniProfile).count()],
    ['private_contacts', await dataSource.getRepository(PrivateContact).count()],
    ['admin_users', await dataSource.getRepository(AdminUser).count()],
    ['roles', await dataSource.getRepository(Role).count()],
    ['permissions', await dataSource.getRepository(Permission).count()],
    ['resource_posts', await dataSource.getRepository(ResourcePost).count()],
    ['resource_post_reviews', await dataSource.getRepository(ResourcePostReview).count()],
    ['articles', await dataSource.getRepository(Article).count()],
    ['notices', await dataSource.getRepository(Notice).count()],
    ['events', await dataSource.getRepository(Event).count()],
    ['event_registrations', await dataSource.getRepository(EventRegistration).count()],
    ['verification_applications', await dataSource.getRepository(VerificationApplication).count()],
    ['verification_reviews', await dataSource.getRepository(VerificationReview).count()],
    ['verification_attachments', await dataSource.getRepository(VerificationAttachment).count()],
    ['connection_pairs', await dataSource.getRepository(ConnectionPair).count()],
    ['connection_request_history', await dataSource.getRepository(ConnectionRequestHistory).count()],
    ['contact_share_grants', await dataSource.getRepository(ContactShareGrant).count()],
    ['media_assets', await dataSource.getRepository(MediaAsset).count()],
    ['idempotency_records', await dataSource.getRepository(IdempotencyRecord).count()],
    ['system_settings', await dataSource.getRepository(SystemSetting).count()],
  ];

  console.log('\n========== Seed 结果汇总 ==========');
  for (const [name, count] of counts) {
    console.log(`  ${name.padEnd(28)} ${count}`);
  }
  console.log('===================================');
  console.log(`管理员账号：${ADMIN_USERNAME} / ${ADMIN_PASSWORD}（角色 super_admin）`);
  console.log('提示：以上全部为虚构测试数据，请勿用于生产环境。');
}

/* ------------------------------------------------------------------ */
/* 入口                                                                  */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log('开始写入 Seed 数据……');
  await AppDataSource.initialize();

  try {
    await seedDictionaries(AppDataSource);
    const roleIdByCode = await seedRbac(AppDataSource);
    const adminId = await seedAdminUser(AppDataSource, roleIdByCode);
    const alumniIds = await seedAlumni(AppDataSource, adminId);
    await seedLoadTestAccounts(AppDataSource, adminId);
    await seedConnections(AppDataSource);
    await seedResources(AppDataSource, alumniIds);
    await seedContent(AppDataSource);
    await seedEvents(AppDataSource, alumniIds);
    await seedVerifications(AppDataSource);
    await seedVerificationHistory(AppDataSource);
    await seedOutbox(AppDataSource);
    await printSummary(AppDataSource);
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error('Seed 执行失败：', error);
  process.exitCode = 1;
});
