/**
 * 接口路径常量（运行时副本）。
 *
 * 来源：`packages/contracts/src/api.ts` 的 `ApiPaths`（工作区包 `@nmg/contracts`）。
 * 小程序无法在运行时引用工作区包，因此在此镜像一份；契约变更需同步本文件。
 *
 * ⚠️ 路径均**不含** `/api/v1` 前缀 —— 前缀由 `config.API_BASE_URL` **自带**
 *    （`API_BASE_URL` 本身就以 `/api/v1` 结尾，请求层直接做
 *    `${API_BASE_URL}${path}` 拼接）。
 *    `config.API_PREFIX` 常量因此**未被请求层引用**，
 *    改前缀要改的是 `API_BASE_URL`，不是这个文件。
 */

export const ApiPaths = {
  // Auth
  wechatLogin: '/auth/wechat/login',
  mockLogin: '/auth/mock/login',
  refresh: '/auth/refresh',
  logout: '/auth/logout',
  session: '/auth/session',

  // Me
  me: '/me',
  meProfile: '/me/profile',
  mePrivacy: '/me/privacy',
  meContacts: '/me/contacts',
  meConnections: '/me/connections',
  meConnectionRequests: '/me/connection-requests',
  meResources: '/me/resources',
  meEvents: '/me/events',
  meVerifications: '/me/verifications',

  // Alumni / Directory
  // 镜像说明：`/alumni` **列表**（管理端）已删除，管理端校友列表统一走 `/admin/alumni`
  // （详见 docs/KNOWN-ISSUES.md #72）；这里只保留公开名片与认证流程。
  alumniItem: (id: number): string => `/alumni/${id}`,
  alumniVerification: '/alumni/verification',
  alumniVerificationItem: (id: number): string => `/alumni/verification/${id}`,
  alumniVerificationHistory: (id: number): string => `/alumni/verification/${id}/history`,
  alumniVerificationMine: '/alumni/verification/mine',
  directory: '/directory',
  directoryItem: (id: number): string => `/directory/${id}`,

  // Connections
  connectionRequests: '/connections/requests',
  connectionRequestItem: (id: number): string => `/connections/requests/${id}`,
  connectionRequestAccept: (id: number): string => `/connections/requests/${id}/accept`,
  connectionRequestReject: (id: number): string => `/connections/requests/${id}/reject`,
  connectionRequestCancel: (id: number): string => `/connections/requests/${id}/cancel`,
  connections: '/connections',
  connectionItem: (id: number): string => `/connections/${id}`,
  connectionContactGrant: (id: number): string => `/connections/${id}/contact-grant`,

  // Resources
  resources: '/resources',
  resourceItem: (id: number): string => `/resources/${id}`,
  resourceSubmit: (id: number): string => `/resources/${id}/submit`,
  resourceWithdraw: (id: number): string => `/resources/${id}/withdraw`,

  // Events
  events: '/events',
  eventItem: (id: number): string => `/events/${id}`,
  eventRegister: (id: number): string => `/events/${id}/registrations`,

  // Content
  articles: '/articles',
  articleItem: (id: number): string => `/articles/${id}`,
  articleCategories: '/articles/categories',
  notices: '/notices',
  noticeItem: (id: number): string => `/notices/${id}`,

  // Uploads
  uploads: '/uploads',
  uploadRecords: '/uploads/records',
  uploadUrl: (id: number): string => `/uploads/${id}/url`,

  // Notifications
  meNotifications: '/me/notifications',
  notificationItem: (id: number): string => `/notifications/${id}`,
  notificationRead: (id: number): string => `/notifications/${id}/read`,
  notificationReadAll: '/notifications/read-all',
  notificationUnreadCount: '/notifications/unread-count',

  // System
  systemRegions: '/system/regions',
  systemIndustries: '/system/industries',
} as const;
