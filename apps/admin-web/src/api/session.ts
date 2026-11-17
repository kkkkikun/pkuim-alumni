import { reactive } from 'vue';
import type { AdminPermission, AdminUserDto, TokenPair } from '@nmg/contracts';

const STORAGE_KEY = 'nmg_admin_session';

export interface AdminSessionState {
  accessToken: string | null;
  refreshToken: string | null;
  expiresIn: number | null;
  admin: AdminUserDto | null;
  permissions: AdminPermission[];
  /** 用户身份阶段（管理端固定为 admin，登录后可由 /auth/session 回填） */
  stage: string;
}

function readStored(): Partial<AdminSessionState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<AdminSessionState>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export const sessionState = reactive<AdminSessionState>({
  accessToken: null,
  refreshToken: null,
  expiresIn: null,
  admin: null,
  permissions: [],
  stage: 'admin',
  ...readStored(),
});

export function persistSession(): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        accessToken: sessionState.accessToken,
        refreshToken: sessionState.refreshToken,
        expiresIn: sessionState.expiresIn,
        admin: sessionState.admin,
        permissions: sessionState.permissions,
        stage: sessionState.stage,
      }),
    );
  } catch {
    /* 浏览器禁用 localStorage 时静默降级为内存态 */
  }
}

export function applyTokens(tokens: TokenPair): void {
  sessionState.accessToken = tokens.accessToken;
  sessionState.refreshToken = tokens.refreshToken;
  sessionState.expiresIn = tokens.expiresIn;
  persistSession();
}

export function clearSession(): void {
  sessionState.accessToken = null;
  sessionState.refreshToken = null;
  sessionState.expiresIn = null;
  sessionState.admin = null;
  sessionState.permissions = [];
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

/** 注册 401（且刷新失败）后的统一处理：清空会话并跳转登录页 */
export function onUnauthorized(handler: UnauthorizedHandler): void {
  unauthorizedHandler = handler;
}

export function emitUnauthorized(): void {
  unauthorizedHandler?.();
}
