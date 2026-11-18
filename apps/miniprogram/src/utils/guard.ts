/**
 * 身份守卫（spec §3.3）。
 *
 * 后端始终强制校验身份，前端只负责把不可用的操作收敛为引导，
 * 绝不能依赖前端隐藏按钮来保证安全。
 */

import { getState, isLoggedIn, isVerified } from '../store/index';
import { showToast } from './feedback';
import { navigateTo } from './navigate';
import { login } from '../services/auth';

/** 登录并返回是否成功 */
export async function ensureLogin(): Promise<boolean> {
  if (isLoggedIn()) {
    return true;
  }
  try {
    await login();
    return true;
  } catch (error) {
    showToast('登录失败，请稍后重试');
    return false;
  }
}

/**
 * 需要“已认证校友”才能进行的操作。
 * 未认证时给出认证引导并跳转到认证介绍页。
 */
export function requireVerified(actionLabel = '该操作'): boolean {
  if (isVerified()) {
    return true;
  }
  const stage = getState().stage;
  if (stage === 'guest') {
    showToast(`请先登录后再${actionLabel}`);
    return false;
  }
  if (stage === 'pending_review') {
    showToast('认证审核中，通过后即可使用该功能');
    navigateTo('/pages/me/verify-progress/index');
    return false;
  }
  showToast(`完成校友认证后即可${actionLabel}`);
  navigateTo('/pages/me/verify-intro/index');
  return false;
}

/** 游客可见但需要登录的操作提示 */
export function requireLogin(actionLabel = '该操作'): boolean {
  if (isLoggedIn()) {
    return true;
  }
  showToast(`请先登录后再${actionLabel}`);
  return false;
}
