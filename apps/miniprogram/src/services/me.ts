/** “我的”相关服务：资料、隐私、校友认证。 */

import { setState } from '../store';
import { ApiPaths } from './paths';
import { get, patch, post, put } from './request';
import type {
  MeResponse,
  MyAlumniProfile,
  PageResult,
  PrivacySettings,
  SubmitVerificationBody,
  UpdatePrivacyBody,
  UpdateProfileBody,
  VerificationApplicationDto,
  VerificationStatus,
} from '../types';

/** 拉取当前登录用户与身份阶段 */
export async function fetchMe(): Promise<MeResponse> {
  const result = await get<MeResponse>(ApiPaths.me);
  setState({
    user: result.user,
    stage: result.stage,
    alumniProfile: result.alumniProfile,
    privacy: result.alumniProfile ? result.alumniProfile.privacy : null,
  });
  return result;
}

/** 我的校友资料 */
export function fetchMyProfile(): Promise<MyAlumniProfile> {
  return get<MyAlumniProfile>(ApiPaths.meProfile);
}

/** 更新个人资料（服务端为 PATCH /me/profile） */
export async function updateProfile(body: UpdateProfileBody): Promise<MyAlumniProfile> {
  const profile = await patch<MyAlumniProfile>(ApiPaths.meProfile, body);
  setState({ alumniProfile: profile });
  return profile;
}

/** 我的隐私设置 */
export async function fetchPrivacy(): Promise<PrivacySettings> {
  const privacy = await get<PrivacySettings>(ApiPaths.mePrivacy);
  setState({ privacy });
  return privacy;
}

/** 更新隐私设置 */
export async function updatePrivacy(body: UpdatePrivacyBody): Promise<PrivacySettings> {
  const privacy = await put<PrivacySettings>(ApiPaths.mePrivacy, body);
  setState({ privacy });
  return privacy;
}

/** 认证历史（我的全部认证申请） */
export function listVerifications(params: { page?: number; pageSize?: number } = {}): Promise<PageResult<VerificationApplicationDto>> {
  return get<PageResult<VerificationApplicationDto>>(ApiPaths.meVerifications, {
    page: params.page,
    pageSize: params.pageSize,
  });
}

/** 单条认证申请 */
export function getVerification(id: number): Promise<VerificationApplicationDto> {
  return get<VerificationApplicationDto>(ApiPaths.alumniVerificationItem(id));
}

/** 当前认证状态（取最近一条认证申请） */
export async function getVerificationStatus(): Promise<{ status: VerificationStatus }> {
  const applications = await get<VerificationApplicationDto[]>(ApiPaths.alumniVerificationMine);
  const latest = applications && applications.length ? applications[0] : null;
  return { status: latest ? latest.status : 'pending' };
}

/** 认证审核历史（某次申请的审核记录） */
export function getVerificationHistory(id: number): Promise<VerificationApplicationDto['reviews']> {
  return get<VerificationApplicationDto['reviews']>(ApiPaths.alumniVerificationHistory(id));
}

/** 提交校友认证 */
export async function submitVerification(body: SubmitVerificationBody): Promise<VerificationApplicationDto> {
  const result = await post<VerificationApplicationDto>(ApiPaths.alumniVerification, body);
  setState({ stage: 'pending_review' });
  return result;
}
