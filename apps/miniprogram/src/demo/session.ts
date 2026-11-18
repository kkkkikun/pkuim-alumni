/**
 * 演示会话（离线模式下替代真实登录 / 会话接口）。
 *
 * 这里构造的所有对象都**不含任何联系方式**：
 * 联系方式字段一律为 `null`（`MyAlumniProfile` 契约要求这几个字段存在，
 * 但演示数据永远不给真实值）。
 */

import { DEMO_ACCESS_TOKEN, DEMO_REFRESH_TOKEN, dataset } from './dataset';
import type {
  AlumniStage,
  LoginResult,
  MyAlumniProfile,
  PrivacySettings,
  SessionUser,
  UserProfile,
} from '../types/index';

/** 演示用的「我」的用户信息 */
export function buildDemoUser(): UserProfile {
  return { ...dataset.me.user };
}

/** 演示用的「我」的校友档案（联系方式恒为 null） */
export function buildDemoMyProfile(): MyAlumniProfile {
  const base = dataset.me.alumniProfile;
  const profile: MyAlumniProfile = {
    userId: base ? base.userId : dataset.me.user.id,
    displayName: base ? base.displayName : dataset.me.user.nickname,
    realName: null,
    college: base ? base.college : null,
    degree: base ? base.degree : null,
    graduationYear: base ? base.graduationYear : null,
    regionCode: base ? base.regionCode : null,
    regionName: base ? base.regionName : null,
    industryCode: base ? base.industryCode : null,
    industryName: base ? base.industryName : null,
    direction: base ? base.direction : null,
    intro: base ? base.intro : null,
    verified: base ? base.verified : false,
    verifiedAt: base ? base.verifiedAt : null,
    contactVisible: base ? base.contactVisible : false,
    privacy: buildDemoPrivacy(),
    // 演示模式永远不提供真实联系方式
    contactPhone: null,
    contactWechat: null,
    contactEmail: null,
    createdAt: base ? base.createdAt : dataset.me.user.createdAt,
    updatedAt: base ? base.updatedAt : dataset.me.user.createdAt,
  };
  return profile;
}

/** 演示用的隐私开关 */
export function buildDemoPrivacy(): PrivacySettings {
  const base = dataset.me.alumniProfile;
  const privacy = base ? base.privacy : null;
  return {
    showInDirectory: privacy ? privacy.showInDirectory : false,
    showCollege: privacy ? privacy.showCollege : true,
    showIndustry: privacy ? privacy.showIndustry : true,
    showRegion: privacy ? privacy.showRegion : true,
    showDirection: privacy ? privacy.showDirection : true,
    acceptContactRequests: privacy ? privacy.acceptContactRequests : true,
    allowContactShare: privacy ? privacy.allowContactShare : false,
  };
}

/** 演示用的「我的联系方式」：字段存在但恒为 null（没有任何真实联系方式） */
export function buildDemoContacts(): {
  contactPhone: string | null;
  contactWechat: string | null;
  contactEmail: string | null;
} {
  return { contactPhone: null, contactWechat: null, contactEmail: null };
}

/** 演示用的会话用户（`GET /auth/session` 的精简投影） */
export function buildDemoSessionUser(): SessionUser {
  const user = dataset.me.user;
  return {
    id: user.id,
    openid: user.openid,
    nickname: user.nickname,
    role: user.role,
    stage: user.stage,
    isAdmin: false,
    permissions: [],
  };
}

/**
 * 演示用的登录结果。
 *
 * 令牌是**一眼可辨的假字符串**（`demo-access-token`），
 * 既不会误当成真实凭证，也方便在日志里一眼定位演示流量。
 */
export function buildDemoLoginResult(): LoginResult {
  return {
    accessToken: DEMO_ACCESS_TOKEN,
    refreshToken: DEMO_REFRESH_TOKEN,
    expiresIn: 3600,
    tokenType: 'Bearer',
    user: buildDemoUser(),
    alumniProfile: buildDemoMyProfile(),
    stage: dataset.me.stage,
  };
}

/** 演示用的 `GET /me` 结果 */
export function buildDemoMe(): {
  user: UserProfile;
  alumniProfile: MyAlumniProfile | null;
  stage: AlumniStage;
} {
  return {
    user: buildDemoUser(),
    alumniProfile: buildDemoMyProfile(),
    stage: dataset.me.stage,
  };
}
