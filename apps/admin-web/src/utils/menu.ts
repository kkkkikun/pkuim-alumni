import type { AdminPermission } from '@nmg/contracts';

export interface MenuEntry {
  key: string;
  title: string;
  path: string;
  icon: string;
  permission?: AdminPermission;
}

export interface MenuGroup {
  key: string;
  title: string;
  items: MenuEntry[];
}

export const menuGroups: MenuGroup[] = [
  {
    key: 'overview',
    title: '概览',
    items: [
      {
        key: 'dashboard',
        title: '数据总览',
        path: '/dashboard',
        icon: 'dashboard',
        permission: 'dashboard:view',
      },
    ],
  },
  {
    key: 'member',
    title: '校友事务',
    items: [
      { key: 'alumni', title: '校友管理', path: '/alumni', icon: 'users', permission: 'alumni:view' },
      {
        key: 'verification',
        title: '身份审核',
        path: '/verification',
        icon: 'shield',
        permission: 'verification:review',
      },
      {
        key: 'resource',
        title: '资源审核',
        path: '/resource',
        icon: 'inbox',
        permission: 'resource:review',
      },
    ],
  },
  {
    key: 'operation',
    title: '内容运营',
    items: [
      { key: 'events', title: '活动管理', path: '/events', icon: 'calendar', permission: 'event:manage' },
      { key: 'articles', title: '资讯管理', path: '/articles', icon: 'article', permission: 'content:manage' },
      { key: 'notices', title: '公告管理', path: '/notices', icon: 'bell', permission: 'content:manage' },
    ],
  },
  {
    key: 'system',
    title: '系统管理',
    items: [
      { key: 'admins', title: '管理员', path: '/system/admins', icon: 'admin', permission: 'admin:manage' },
      { key: 'roles', title: '角色权限', path: '/system/roles', icon: 'key', permission: 'admin:manage' },
      {
        key: 'dictionary',
        title: '字典管理',
        path: '/system/dictionary',
        icon: 'globe',
        permission: 'settings:manage',
      },
      { key: 'logs', title: '操作日志', path: '/system/logs', icon: 'log', permission: 'audit:view' },
      {
        key: 'settings',
        title: '系统设置',
        path: '/system/settings',
        icon: 'setting',
        permission: 'settings:manage',
      },
    ],
  },
];
