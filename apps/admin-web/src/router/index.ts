import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import type { AdminPermission } from '@nmg/contracts';
import { useAuthStore } from '@/stores/auth';
import { menuGroups } from '@/utils/menu';

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { public: true, title: '管理员登录' },
  },
  {
    path: '/',
    component: () => import('@/layouts/AdminLayout.vue'),
    children: [
      {
        path: 'dashboard',
        name: 'dashboard',
        component: () => import('@/views/dashboard/DashboardView.vue'),
        meta: { requiredPermission: 'dashboard:view', title: '数据总览' },
      },
      {
        path: 'alumni',
        name: 'alumni',
        component: () => import('@/views/alumni/AlumniView.vue'),
        meta: { requiredPermission: 'alumni:view', title: '校友管理' },
      },
      {
        path: 'verification',
        name: 'verification',
        component: () => import('@/views/verification/VerificationView.vue'),
        meta: { requiredPermission: 'verification:review', title: '身份审核' },
      },
      {
        path: 'resource',
        name: 'resource',
        component: () => import('@/views/resource/ResourceView.vue'),
        meta: { requiredPermission: 'resource:review', title: '资源审核' },
      },
      {
        path: 'events',
        name: 'events',
        component: () => import('@/views/event/EventListView.vue'),
        meta: { requiredPermission: 'event:manage', title: '活动管理' },
      },
      {
        path: 'events/new',
        name: 'event-create',
        component: () => import('@/views/event/EventFormView.vue'),
        meta: { requiredPermission: 'event:manage', title: '新建活动' },
      },
      {
        path: 'events/:id/edit',
        name: 'event-edit',
        component: () => import('@/views/event/EventFormView.vue'),
        meta: { requiredPermission: 'event:manage', title: '编辑活动' },
      },
      {
        path: 'articles',
        name: 'articles',
        component: () => import('@/views/content/ArticleView.vue'),
        meta: { requiredPermission: 'content:manage', title: '资讯管理' },
      },
      {
        path: 'notices',
        name: 'notices',
        component: () => import('@/views/content/NoticeView.vue'),
        meta: { requiredPermission: 'content:manage', title: '公告管理' },
      },
      {
        path: 'system/admins',
        name: 'admin-users',
        component: () => import('@/views/system/AdminUsersView.vue'),
        meta: { requiredPermission: 'admin:manage', title: '管理员管理' },
      },
      {
        path: 'system/roles',
        name: 'admin-roles',
        component: () => import('@/views/system/RolesView.vue'),
        meta: { requiredPermission: 'admin:manage', title: '角色权限' },
      },
      {
        path: 'system/dictionary',
        name: 'admin-dictionary',
        component: () => import('@/views/system/DictionaryView.vue'),
        meta: { requiredPermission: 'settings:manage', title: '字典管理' },
      },
      {
        path: 'system/logs',
        name: 'admin-logs',
        component: () => import('@/views/system/ActionLogsView.vue'),
        meta: { requiredPermission: 'audit:view', title: '操作日志' },
      },
      {
        path: 'system/settings',
        name: 'admin-settings',
        component: () => import('@/views/system/SettingsView.vue'),
        meta: { requiredPermission: 'settings:manage', title: '系统设置' },
      },
      {
        path: '403',
        name: 'forbidden',
        component: () => import('@/views/error/ForbiddenView.vue'),
        meta: { public: true, title: '无访问权限' },
      },
    ],
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/error/NotFoundView.vue'),
    meta: { public: true, title: '页面不存在' },
  },
];

const router = createRouter({
  // 使用 hash 模式，避免管理后台依赖 Nginx 的 SPA 回退配置
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

function firstAllowedPath(permissions: Set<AdminPermission>): string {
  for (const group of menuGroups) {
    for (const item of group.items) {
      if (!item.permission || permissions.has(item.permission)) return item.path;
    }
  }
  return '/403';
}

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  await auth.ensureReady();

  if (to.meta.public) {
    if (to.path === '/login' && auth.isAuthenticated) {
      return { path: firstAllowedPath(new Set(auth.permissions)) };
    }
    return true;
  }

  if (!auth.isAuthenticated) {
    return { path: '/login', query: { redirect: to.fullPath } };
  }

  if (to.path === '/') {
    return { path: firstAllowedPath(new Set(auth.permissions)) };
  }

  const required = to.meta.requiredPermission;
  if (required && !auth.hasPermission(required)) {
    return { path: '/403' };
  }
  return true;
});

router.afterEach((to) => {
  const title = to.meta.title;
  document.title = title ? `${title} · 校友会管理后台` : '校友会管理后台';
});

export default router;
