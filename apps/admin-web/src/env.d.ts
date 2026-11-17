/// <reference types="vite/client" />

import type { AdminPermission } from '@nmg/contracts';

declare global {
  interface ImportMetaEnv {
    readonly VITE_API_BASE_URL?: string;
    readonly VITE_API_PROXY_TARGET?: string;
    readonly VITE_API_TIMEOUT?: string;
    readonly VITE_DEV_PORT?: string;
    readonly VITE_USE_MOCK?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

declare module 'vue-router' {
  interface RouteMeta {
    /** 免登录页面 */
    public?: boolean;
    /** 进入该路由所需的管理端权限点 */
    requiredPermission?: AdminPermission;
    /** 页面标题（顶栏 / 文档标题） */
    title?: string;
  }
}
