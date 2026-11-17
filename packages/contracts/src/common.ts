/**
 * 通用契约类型：统一响应、分页、错误码。
 * 所有应用（小程序 / 管理后台 / API / Worker）必须复用这里的定义。
 */

export const API_PREFIX = '/api/v1';

/** 统一响应包装 */
export interface ApiResponse<T> {
  code: string;
  message: string;
  data: T;
  requestId?: string;
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PageResult<T> {
  items: T[];
  meta: PageMeta;
}

export interface PageQuery {
  page?: number;
  pageSize?: number;
}

/** 业务错误码（与后端 app/core/errors 保持一致） */
export const ErrorCode = {
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

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiErrorPayload {
  code: ErrorCodeValue | string;
  message: string;
  requestId?: string;
  details?: Record<string, unknown>;
}

/** 排序 */
export type SortOrder = 'asc' | 'desc';
