/**
 * 角色 / 权限点的**中文名**（纯常量，无任何依赖）。
 *
 * ## 为什么单独放一个文件
 *
 * 此前 `ROLE_LABELS` / `PERMISSION_LABELS` 定义在 `stores/auth.ts` 里，
 * 而 `api/mock.ts`（演示数据层）要用它们 → 于是出现**循环依赖**：
 *
 * ```
 * stores/auth.ts ──> api/auth.ts ──> api/http.ts ──> api/mock.ts ──> stores/auth.ts
 * ```
 *
 * 浏览器按 ESM 语义求值这个环：`api/mock.ts` 在模块顶层（构造演示数据）就要读
 * `PERMISSION_LABELS`，而此时 `stores/auth.ts` **还没求值完** ——
 * 于是撞上 TDZ：`ReferenceError: Cannot access 'xx' before initialization`，
 * **页面白屏**（首屏连登录框都渲染不出来）。
 *
 * 把这些**纯常量**挪到一个不依赖任何东西的模块里，环就断了：
 * `mock.ts` 与 `stores/auth.ts` 都只依赖它，彼此不再互相引用。
 */
import type { AdminPermission, AdminRole } from '@nmg/contracts';

/** 角色 → 中文名 */
export const ROLE_LABELS: Record<AdminRole, string> = {
  super_admin: '超级管理员',
  alumni_reviewer: '校友审核员',
  content_admin: '内容管理员',
  event_admin: '活动管理员',
  resource_reviewer: '资源审核员',
};

/** 权限点 → 中文名 */
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
