/** 全局常量。 */

export const API_PREFIX = '/api/v1';

/** 统一响应码 */
export const ResponseCode = {
  OK: 'OK',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_FAILED: 'AUTH_FAILED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  VERIFICATION_REQUIRED: 'VERIFICATION_REQUIRED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** 请求头 */
export const HEADER_REQUEST_ID = 'x-request-id';
export const HEADER_IDEMPOTENCY_KEY = 'idempotency-key';

/** BullMQ 队列名 */
export const QueueNames = {
  NOTIFICATION: 'nmg-notification',
  OUTBOX: 'nmg-outbox',
  CLEANUP: 'nmg-cleanup',
} as const;

/** 密钥用途（联系方式加密） */
export const CipherScope = {
  PHONE: 'contact_phone',
  WECHAT: 'contact_wechat',
  EMAIL: 'contact_email',
} as const;

/**
 * 进程内 TTL 缓存的键（第三轮）。
 *
 * 口径见 `docs/SECURITY.md` 第 2.1 节：
 *  - `rbac:*` = 管理员的权限事实（TTL ≤ 60 秒，写操作主动失效）；
 *  - `dict:*` = 字典 / 分类 / 系统设置（写多读少，TTL ≤ 300 秒）。
 */
export const CacheKeys = {
  /** 管理员 RBAC 解析结果：`rbac:admin:<adminId>` */
  adminRbac: (adminId: number) => `rbac:admin:${adminId}`,
  /** 地区字典 */
  regions: 'dict:regions',
  /** 行业字典 */
  industries: 'dict:industries',
  /** 资讯分类 */
  categories: 'dict:categories',
  /** 公开系统设置 */
  publicSettings: 'dict:settings',
} as const;
