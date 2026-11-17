import { computed } from 'vue';
import { defineStore } from 'pinia';
import type { AdminPermission, AdminRole } from '@nmg/contracts';
import { adminLogin, adminLogout, fetchSession } from '@/api/auth';
import { applyTokens, clearSession, persistSession, sessionState } from '@/api/session';

/**
 * 角色 → 权限点兜底映射。
 * 数据来源：docs/DATABASE-DESIGN.md「管理后台 RBAC」初始种子。
 * 仅在会话恢复时服务端未返回 permissions 的情况下用于界面兜底显示，
 * 真正的权限校验始终由服务端执行。
 */
export const ROLE_PERMISSIONS: Record<AdminRole, AdminPermission[]> = {
  super_admin: [
    'dashboard:view',
    'alumni:view',
    'alumni:manage',
    'verification:review',
    'resource:review',
    'resource:manage',
    'event:manage',
    'content:manage',
    'notification:broadcast',
    'admin:manage',
    'audit:view',
    'settings:manage',
  ],
  alumni_reviewer: ['alumni:view', 'alumni:manage', 'verification:review', 'audit:view'],
  resource_reviewer: ['resource:review', 'resource:manage', 'audit:view'],
  content_admin: ['content:manage', 'notification:broadcast', 'audit:view'],
  event_admin: ['event:manage', 'audit:view'],
};

export const ROLE_LABELS: Record<AdminRole, string> = {
  super_admin: '超级管理员',
  alumni_reviewer: '校友审核员',
  content_admin: '内容管理员',
  event_admin: '活动管理员',
  resource_reviewer: '资源审核员',
};

export const PERMISSION_LABELS: Record<AdminPermission, string> = {
  'dashboard:view': '查看数据总览',
  'alumni:view': '查看校友列表',
  'alumni:manage': '管理校友资料与账号状态',
  'verification:review': '身份审核',
  'resource:review': '资源审核',
  'resource:manage': '资源管理',
  'event:manage': '活动管理',
  'content:manage': '内容管理',
  'notification:broadcast': '通知群发',
  'admin:manage': '管理员与角色管理',
  'audit:view': '查看操作日志',
  'settings:manage': '系统设置与字典维护',
};

export const useAuthStore = defineStore('auth', () => {
  const admin = computed(() => sessionState.admin);
  const permissions = computed<AdminPermission[]>(() => sessionState.permissions);
  const roles = computed<AdminRole[]>(() => sessionState.admin?.roles ?? []);
  const stage = computed(() => sessionState.stage);
  const isAuthenticated = computed(() => Boolean(sessionState.accessToken));
  const displayName = computed(
    () => sessionState.admin?.displayName || sessionState.admin?.username || '未登录',
  );
  const permissionSet = computed(() => new Set<AdminPermission>(sessionState.permissions));

  function hasPermission(required?: AdminPermission | AdminPermission[] | null): boolean {
    if (!required) return true;
    if (Array.isArray(required)) {
      return required.some((code) => permissionSet.value.has(code));
    }
    return permissionSet.value.has(required);
  }

  function hasAll(required: AdminPermission[]): boolean {
    return required.every((code) => permissionSet.value.has(code));
  }

  async function login(username: string, password: string): Promise<void> {
    const result = await adminLogin({ username, password });
    applyTokens(result);
    sessionState.admin = result.admin;
    sessionState.permissions = result.permissions ?? [];
    sessionState.stage = 'admin';
    persistSession();
  }

  async function logout(): Promise<void> {
    try {
      await adminLogout();
    } catch {
      /* 登出接口失败不阻塞本地会话清理 */
    }
    clearSession();
  }

  function reset(): void {
    clearSession();
  }

  /** 页面刷新后恢复会话：校验令牌有效性并回填权限点 */
  async function restore(): Promise<void> {
    if (!sessionState.accessToken) return;
    try {
      const session = await fetchSession();
      if (session?.stage) sessionState.stage = session.stage;
      const role = session?.user?.role ?? null;
      if (!role) {
        // 返回的是小程序用户会话，管理后台不接受
        clearSession();
        return;
      }
      if (!sessionState.permissions.length && sessionState.admin?.roles?.length) {
        const codes = new Set<AdminPermission>();
        sessionState.admin.roles.forEach((item) => {
          ROLE_PERMISSIONS[item]?.forEach((code) => codes.add(code));
        });
        sessionState.permissions = Array.from(codes);
        persistSession();
      }
    } catch {
      /* 网络异常时不主动登出，交由具体请求的 401 处理流程 */
    }
  }

  let readyPromise: Promise<void> | null = null;
  function ensureReady(): Promise<void> {
    if (!readyPromise) {
      readyPromise = restore();
    }
    return readyPromise;
  }

  return {
    admin,
    permissions,
    roles,
    stage,
    isAuthenticated,
    displayName,
    hasPermission,
    hasAll,
    login,
    logout,
    reset,
    restore,
    ensureReady,
  };
});
