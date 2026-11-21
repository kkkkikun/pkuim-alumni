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
 *
 * ⚠️ 键集合是**开放**的（缺陷 #182）：角色是目录表，代码可能不在内置角色集合里
 *    → 查不到时回退到空数组（服务端返回的 permissions 才是权威）。
 *    `satisfies Record<AdminRole, AdminPermission[]>` 保证内置角色都有兜底矩阵。
 */
export const ROLE_PERMISSIONS: Record<string, AdminPermission[] | undefined> = {
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
} satisfies Record<AdminRole, AdminPermission[]>;

// ⚠️ 中文名常量在 `./role-labels.ts`（**无依赖**的纯常量模块）里定义 ——
//    放在这里会与 `api/mock.ts` 形成循环依赖，浏览器求值时撞 TDZ → 页面白屏。
//    这里**转出**一份，保留原有的导入路径不变（`@/stores/auth`）。
export { PERMISSION_LABELS, ROLE_LABELS } from './role-labels';

export const useAuthStore = defineStore('auth', () => {
  const admin = computed(() => sessionState.admin);
  const permissions = computed<AdminPermission[]>(() => sessionState.permissions);
  const roles = computed<string[]>(() => sessionState.admin?.roles ?? []);
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
