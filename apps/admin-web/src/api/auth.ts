import type {
  AdminLoginBody,
  AdminLoginResult,
  AuthSessionResponse,
  RefreshBody,
  TokenPair,
} from '@nmg/contracts';
import { ApiPaths } from '@nmg/contracts';
import { apiGet, apiPost } from './http';

/** 管理员登录 */
export function adminLogin(body: AdminLoginBody): Promise<AdminLoginResult> {
  return apiPost<AdminLoginResult>(ApiPaths.adminLogin, body, { skipAuth: true });
}

/** 刷新令牌 */
export function refreshTokens(body: RefreshBody): Promise<TokenPair> {
  return apiPost<TokenPair>(ApiPaths.refresh, body, { skipAuth: true });
}

/** 退出登录 */
export function adminLogout(): Promise<void> {
  return apiPost<void>(ApiPaths.logout);
}

/** 校验当前会话（页面刷新后用于确认令牌是否仍然有效） */
export function fetchSession(): Promise<AuthSessionResponse> {
  return apiGet<AuthSessionResponse>(ApiPaths.session);
}
