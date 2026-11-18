/**
 * 认证适配层（spec §3.4）。
 *
 * - `loginWithWechat()`：真实微信登录，wx.login 拿到 code 后交给后端，
 *   session_key / openid 等敏感数据只在服务端处理，小程序不接触。
 * - `loginWithMock()`：开发期 Mock 登录，走后端 `/auth/mock/login`。
 * - 两者实现同一套调用方式，通过 `config.USE_MOCK_LOGIN` 运行时切换，
 *   小程序注册完成后只需把开关改为 false 并配置 AppID 即可。
 *
 * ⚠️ 离线演示模式（`config.DATA_MODE === 'demo'`）下：
 *   登录 / 加载会话 / 退出登录**一律不发网络请求**，全部用本地演示数据。
 */

import { DATA_MODE, MOCK_NICKNAME, MOCK_OPENID, USE_MOCK_LOGIN } from '../config/index';
import { buildDemoLoginResult } from '../demo/session';
import { cacheUser, clearSession, getState, isLoggedIn, setToken, setState } from '../store/index';
import { ApiPaths } from './paths';
import { get, post } from './request';
import type { AlumniStage, AuthSessionResponse, LoginResult, UserProfile } from '../types/index';

/** wx.login 包装 */
export function wxLogin(): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        if (res.code) {
          resolve(res.code);
        } else {
          reject(new Error('wx.login 未返回 code'));
        }
      },
      fail: (error) => {
        reject(new Error(error.errMsg || 'wx.login 调用失败'));
      },
    });
  });
}

/** 登录成功后写入全局状态 */
function applyLogin(result: LoginResult): LoginResult {
  setToken({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresIn: result.expiresIn,
    tokenType: result.tokenType,
  });
  cacheUser(result.user);
  setState({
    user: result.user,
    stage: result.stage,
    alumniProfile: null,
  });
  return result;
}

/** 真实微信登录 */
export async function loginWithWechat(): Promise<LoginResult> {
  // 演示模式：不调用 wx.login、不发网络请求，直接用本地演示会话。
  if (DATA_MODE === 'demo') {
    return applyLogin(buildDemoLoginResult());
  }
  const code = await wxLogin();
  const result = await post<LoginResult>(ApiPaths.wechatLogin, { code }, { auth: false });
  return applyLogin(result);
}

/** 开发期 Mock 登录 */
export async function loginWithMock(mockOpenid?: string): Promise<LoginResult> {
  // 演示模式：不发网络请求，直接用本地演示会话。
  if (DATA_MODE === 'demo') {
    return applyLogin(buildDemoLoginResult());
  }
  const result = await post<LoginResult>(
    ApiPaths.mockLogin,
    { mockOpenid: mockOpenid || MOCK_OPENID, nickname: MOCK_NICKNAME },
    { auth: false }
  );
  return applyLogin(result);
}

/** 按运行时配置选择登录方式 */
export function login(): Promise<LoginResult> {
  // 演示模式：完全本地化。
  if (DATA_MODE === 'demo') {
    return Promise.resolve(applyLogin(buildDemoLoginResult()));
  }
  return USE_MOCK_LOGIN ? loginWithMock() : loginWithWechat();
}

/**
 * 确保本地存在一个演示会话。
 *
 * 演示场合客户往往还没点「登录」；这个函数让页面（首页）在演示模式下
 * 直接有一个可用的本地会话，**不发任何网络请求**。
 *
 * 非演示模式（或已有登录态）时返回 null，什么都不做。
 */
export function ensureDemoSession(): LoginResult | null {
  if (DATA_MODE !== 'demo') {
    return null;
  }
  if (isLoggedIn()) {
    return null;
  }
  return applyLogin(buildDemoLoginResult());
}

/** 是否处于 Mock 登录模式 */
export function isMockLoginMode(): boolean {
  return USE_MOCK_LOGIN;
}

/** 退出登录 */
export async function logout(): Promise<void> {
  // 演示模式：只清本地状态，不发网络请求。
  if (DATA_MODE === 'demo') {
    clearSession();
    return;
  }
  try {
    await post(ApiPaths.logout, undefined, { auth: true, showError: false });
  } catch (error) {
    // 忽略退出接口失败，本地状态照常清理
  }
  clearSession();
}

/**
 * 拉取当前会话信息（含身份阶段）。
 *
 * `GET /auth/session` 返回的是**精简投影**（id / openid / nickname / role / stage /
 * isAdmin / permissions），不包含头像、账号状态等完整资料，因此这里只同步身份阶段，
 * 用户资料仍以登录时缓存的完整对象为准（冷启动由 store.restoreSession 恢复）。
 */
export async function loadSession(): Promise<{ user: UserProfile | null; stage: AlumniStage }> {
  // 演示模式：从本地状态返回，不发网络请求。
  if (DATA_MODE === 'demo') {
    const state = getState();
    const stage = (state.stage || 'guest') as AlumniStage;
    setState({ stage });
    return { user: state.user, stage };
  }
  const result = await get<AuthSessionResponse>(ApiPaths.session, undefined, { auth: true });
  const stage = (result.stage || getState().stage) as AlumniStage;
  setState({ stage });
  return { user: getState().user, stage };
}
