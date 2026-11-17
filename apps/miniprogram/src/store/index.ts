/**
 * 轻量全局 Store（无第三方状态库）。
 *
 * 保存：登录态与令牌、用户与校友资料、隐私设置、字典数据、
 * 列表筛选条件、页面滚动位置。
 * 令牌与用户信息持久化到 wx storage，其余仅存在于内存（刷新后回到默认）。
 */

import { STORAGE_KEYS } from '../config';
import type {
  AlumniStage,
  ArticleCategoryDto,
  IndustryDto,
  MyAlumniProfile,
  PrivacySettings,
  RegionDto,
  TokenPair,
  UserProfile,
} from '../types';

/** 通讯录筛选条件 */
export interface DirectoryFilter {
  keyword: string;
  regionCode: string;
  industryCode: string;
  graduationYear: number | null;
}

/** 连接栏目筛选条件 */
export interface ConnectFilter {
  type: 'all' | 'resource' | 'demand';
  regionCode: string;
  industryCode: string;
}

export interface AppState {
  /** 是否已完成启动初始化 */
  ready: boolean;
  /** 访问令牌 */
  token: TokenPair | null;
  /** 当前登录用户 */
  user: UserProfile | null;
  /** 我的校友资料（本人视角，含联系方式与隐私开关） */
  alumniProfile: MyAlumniProfile | null;
  /** 我的隐私设置 */
  privacy: PrivacySettings | null;
  /** 身份阶段 */
  stage: AlumniStage;
  /** 地区字典 */
  regions: RegionDto[];
  /** 行业字典 */
  industries: IndustryDto[];
  /** 资讯分类字典 */
  categories: ArticleCategoryDto[];
  /** 通讯录筛选条件 */
  directoryFilter: DirectoryFilter;
  /** 连接栏目筛选条件 */
  connectFilter: ConnectFilter;
  /** 校友认证草稿（已上传的证明材料 mediaId） */
  verificationDraft: { attachmentMediaIds: number[] };
  /** 页面滚动位置 */
  scrollPositions: Record<string, number>;
}

const defaultDirectoryFilter = (): DirectoryFilter => ({
  keyword: '',
  regionCode: '',
  industryCode: '',
  graduationYear: null,
});

const defaultConnectFilter = (): ConnectFilter => ({
  type: 'all',
  regionCode: '',
  industryCode: '',
});

const state: AppState = {
  ready: false,
  token: null,
  user: null,
  alumniProfile: null,
  privacy: null,
  stage: 'guest',
  regions: [],
  industries: [],
  categories: [],
  directoryFilter: defaultDirectoryFilter(),
  connectFilter: defaultConnectFilter(),
  verificationDraft: { attachmentMediaIds: [] },
  scrollPositions: {},
};

type Listener = (state: AppState) => void;
const listeners: Listener[] = [];

/** 订阅状态变化 */
export function subscribe(listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    const index = listeners.indexOf(listener);
    if (index >= 0) {
      listeners.splice(index, 1);
    }
  };
}

function notify(): void {
  listeners.forEach((listener) => {
    try {
      listener(state);
    } catch (error) {
      // 订阅者异常不影响主流程
      console.error('[store] listener error', error);
    }
  });
}

/** 读取当前状态（只读引用，调用方不应直接修改） */
export function getState(): AppState {
  return state;
}

/** 合并部分状态并通知订阅者 */
export function setState(patch: Partial<AppState>): void {
  Object.assign(state, patch);
  notify();
}

/* ------------------------------ 令牌 ------------------------------ */

export function getAccessToken(): string | null {
  return state.token ? state.token.accessToken : null;
}

export function getRefreshToken(): string | null {
  return state.token ? state.token.refreshToken : null;
}

export function setToken(token: TokenPair | null): void {
  state.token = token;
  if (token) {
    wx.setStorageSync(STORAGE_KEYS.token, token);
  } else {
    wx.removeStorageSync(STORAGE_KEYS.token);
  }
}

/* ------------------------------ 身份 ------------------------------ */

/** 是否已登录 */
export function isLoggedIn(): boolean {
  return state.stage !== 'guest' && !!state.token;
}

/** 是否已通过校友身份认证 */
export function isVerified(): boolean {
  return state.stage === 'verified';
}

/** 当前阶段的中文说明 */
export function stageLabel(stage: AlumniStage = state.stage): string {
  switch (stage) {
    case 'verified':
      return '已认证校友';
    case 'pending_review':
      return '待审核';
    case 'logged_in':
      return '已登录未认证';
    default:
      return '游客';
  }
}

/** 清空登录态 */
export function clearSession(): void {
  state.token = null;
  state.user = null;
  state.alumniProfile = null;
  state.privacy = null;
  state.stage = 'guest';
  setToken(null);
  notify();
}

/* ------------------------------ 筛选条件 ------------------------------ */

export function getDirectoryFilter(): DirectoryFilter {
  return state.directoryFilter;
}

export function setDirectoryFilter(patch: Partial<DirectoryFilter>): DirectoryFilter {
  state.directoryFilter = { ...state.directoryFilter, ...patch };
  notify();
  return state.directoryFilter;
}

export function resetDirectoryFilter(): DirectoryFilter {
  state.directoryFilter = defaultDirectoryFilter();
  notify();
  return state.directoryFilter;
}

export function getConnectFilter(): ConnectFilter {
  return state.connectFilter;
}

export function setConnectFilter(patch: Partial<ConnectFilter>): ConnectFilter {
  state.connectFilter = { ...state.connectFilter, ...patch };
  notify();
  return state.connectFilter;
}

/* ------------------------------ 认证草稿 ------------------------------ */

export function getVerificationDraft(): { attachmentMediaIds: number[] } {
  return state.verificationDraft;
}

export function setVerificationMediaIds(ids: number[]): void {
  state.verificationDraft = { attachmentMediaIds: ids };
  notify();
}

/* ------------------------------ 滚动位置 ------------------------------ */

export function saveScrollTop(key: string, scrollTop: number): void {
  state.scrollPositions[key] = scrollTop;
}

export function getScrollTop(key: string): number {
  return state.scrollPositions[key] || 0;
}

/* ------------------------------ 持久化 ------------------------------ */

/** 启动时恢复令牌与用户缓存 */
export function restoreSession(): void {
  try {
    const cachedToken = wx.getStorageSync(STORAGE_KEYS.token) as TokenPair | undefined;
    if (cachedToken && cachedToken.accessToken) {
      state.token = cachedToken;
    }
    const cachedUser = wx.getStorageSync(STORAGE_KEYS.user) as UserProfile | undefined;
    if (cachedUser && cachedUser.id) {
      state.user = cachedUser;
      state.stage = cachedUser.stage;
    }
  } catch (error) {
    console.error('[store] restore session failed', error);
  }
}

/** 缓存用户信息，便于冷启动时先展示昵称 */
export function cacheUser(user: UserProfile | null): void {
  state.user = user;
  if (user) {
    wx.setStorageSync(STORAGE_KEYS.user, user);
  } else {
    wx.removeStorageSync(STORAGE_KEYS.user);
  }
}
