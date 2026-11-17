/**
 * 统一请求层。
 *
 * 能力：
 *  - 统一拼接 `/api/v1` 前缀与基础地址；
 *  - 自动附加 `Authorization: Bearer <accessToken>`；
 *  - 自动生成 `X-Request-Id` 请求 ID；
 *  - 写操作 POST 自动附加 `Idempotency-Key`；
 *  - 访问令牌过期时自动刷新：刷新为 single-flight，并发请求排队等待同一次刷新，
 *    刷新成功后原请求重试一次（最多重试一次）；
 *  - 统一解包 `{ code, message, data }` 信封，返回 `data`；
 *  - 统一错误 Toast（可关闭）；
 *  - **离线演示兜底**：按 `config.DATA_MODE` 分流，网络层失败时可回退到本地演示数据。
 *
 * ⚠️ 回退边界：只有**网络层失败**（`wx.request` 的 fail 回调 → `NETWORK_ERROR`）
 *    才允许回退到演示数据；HTTP 4xx/5xx 是服务端的**真实业务响应**，
 *    回退会用假数据把真实缺陷盖住，因此**一律不回退**。
 */

import { API_BASE_URL, DATA_MODE, REQUEST_TIMEOUT } from '../config';
import { clearSession, getAccessToken, getRefreshToken, setToken } from '../store';
import { showError } from '../utils/feedback';
import { DemoRouteError, handleDemoRequest } from '../demo/router';
import type { ApiResponse, TokenPair } from '../types';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  method?: HttpMethod;
  data?: unknown;
  /** 是否附带访问令牌，默认 true */
  auth?: boolean;
  /** 附加自定义请求头 */
  header?: Record<string, string>;
  /** 是否在失败时弹出统一错误提示，默认 true */
  showError?: boolean;
  /** 401 时是否允许自动刷新并重试，默认 true */
  retryOnUnauthorized?: boolean;
  /** POST 是否附加幂等键，默认 true */
  idempotent?: boolean;
  /**
   * 幂等键（`Idempotency-Key`）。
   *
   * ⚠️ 默认每次请求**现生成一把新的**（见下方 rawRequest），
   *    那样的话「服务端已写成功、但响应丢了」后的重试会被当成**新请求** →
   *    服务端再执行一次 → **重复创建**。
   *    所以重试**同一个动作**时，调用方必须把**同一把钥匙**再传进来，
   *    服务端才会把它识别成「同一次操作」并回放首次响应。
   */
  idempotencyKey?: string;
  timeout?: number;
}

/** 业务错误 */
export class ApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly requestId?: string;

  constructor(code: string, message: string, statusCode = 0, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode;
    this.requestId = requestId;
  }

  /** 是否为需要登录/认证的错误 */
  get isAuthError(): boolean {
    return this.code === 'AUTH_REQUIRED' || this.code === 'AUTH_FAILED' || this.statusCode === 401;
  }

  /**
   * 是否为「需要先完成校友身份认证」的错误。
   *
   * ⚠️ 缺陷 #109：服务端此前抛的是普通 `ForbiddenException`，
   *    统一异常过滤器按状态码映射成通用的 `FORBIDDEN`
   *    → 契约里的 `VERIFICATION_REQUIRED` **从未被返回过**（死码），
   *    客户端无法区分「你没认证 → 去认证页」与「你没权限」。
   *    修复后服务端会返回专用错误码，这里据此把用户引导到认证流程。
   */
  get isVerificationRequired(): boolean {
    return this.code === 'VERIFICATION_REQUIRED';
  }
}

/** 认证引导页（校友认证介绍） */
const VERIFY_INTRO_PAGE = '/pages/me/verify-intro/index';

/** 防止连续失败时反复跳转（一次失败风暴只引导一次） */
let lastVerificationGuideAt = 0;
const VERIFICATION_GUIDE_COOLDOWN_MS = 5000;

function guideToVerification(): void {
  const now = Date.now();
  if (now - lastVerificationGuideAt < VERIFICATION_GUIDE_COOLDOWN_MS) return;
  lastVerificationGuideAt = now;
  wx.navigateTo({ url: VERIFY_INTRO_PAGE });
}

const SUCCESS_CODES = ['OK', 'SUCCESS', '0', '200', 'ok', 'success'];

function generateId(): string {
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${stamp}-${random}`;
}

function buildQuery(params?: Record<string, unknown>): string {
  if (!params) {
    return '';
  }
  const pairs: string[] = [];
  Object.keys(params).forEach((key) => {
    const value = params[key];
    if (value === undefined || value === null || value === '') {
      return;
    }
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  });
  return pairs.length ? `?${pairs.join('&')}` : '';
}

/** 原始 wx.request 封装 */
function rawRequest<T>(
  url: string,
  options: RequestOptions
): Promise<{ statusCode: number; data: unknown; header: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const method = options.method || 'GET';
    const header: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Request-Id': generateId(),
      ...(options.header || {}),
    };
    if (options.auth !== false) {
      const token = getAccessToken();
      if (token) {
        header.Authorization = `Bearer ${token}`;
      }
    }
    if (method === 'POST' && options.idempotent !== false) {
      // ⚠️ 调用方显式给了钥匙就**沿用**（重试同一个动作必须用同一把钥匙，
      //    否则服务端无法识别成同一次操作 → 会重复执行）；
      //    没给才现生成一把。
      header['Idempotency-Key'] = options.idempotencyKey ?? generateId();
    }
    wx.request({
      url: `${API_BASE_URL}${url}`,
      method: method as WechatMiniprogram.RequestOption['method'],
      data: options.data as WechatMiniprogram.RequestOption['data'],
      header,
      timeout: options.timeout || REQUEST_TIMEOUT,
      success: (res) => {
        resolve({
          statusCode: res.statusCode,
          data: res.data,
          header: (res.header || {}) as Record<string, string>,
        });
      },
      fail: (error) => {
        reject(new ApiError('NETWORK_ERROR', error.errMsg || '网络异常，请检查网络后重试'));
      },
    });
  });
}

/** 解包统一响应信封 */
function unwrap<T>(statusCode: number, payload: unknown): T {
  if (statusCode >= 200 && statusCode < 300) {
    const body = payload as ApiResponse<T> | null;
    if (!body || typeof body !== 'object' || !('code' in body)) {
      return body as unknown as T;
    }
    if (body.code && SUCCESS_CODES.indexOf(body.code) === -1) {
      throw new ApiError(body.code, body.message || '请求失败', statusCode, body.requestId);
    }
    return body.data;
  }
  const body = (payload || {}) as Partial<ApiResponse<unknown>>;
  throw new ApiError(
    body.code || `HTTP_${statusCode}`,
    body.message || `请求失败（${statusCode}）`,
    statusCode,
    body.requestId
  );
}

/* ------------------------------ 离线演示兜底 ------------------------------ */

/**
 * 当前是否处于「演示数据」状态。
 *
 * - `DATA_MODE === 'demo'`：恒为 true（根本没连后端）；
 * - `DATA_MODE === 'auto'`：发生过**网络层失败**并回退到本地数据后为 true，
 *   之后一旦有请求成功拿到真实数据就自动恢复为 false（提示条随之消失）。
 */
let demoActive = DATA_MODE === 'demo';

const demoListeners: Array<() => void> = [];

/** 当前是否处于演示数据模式 */
export function isDemoFallbackActive(): boolean {
  return demoActive;
}

/** 订阅演示模式变化（返回取消订阅函数） */
export function onDemoModeChange(callback: () => void): () => void {
  demoListeners.push(callback);
  return () => {
    const index = demoListeners.indexOf(callback);
    if (index >= 0) {
      demoListeners.splice(index, 1);
    }
  };
}

/** 设置演示状态并通知订阅者 */
function setDemoActive(active: boolean): void {
  if (demoActive === active) {
    return;
  }
  demoActive = active;
  demoListeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error('[request] demo listener error', error);
    }
  });
}

/**
 * 调用本地演示路由，返回接口 `data` 部分。
 *
 * 路径里的查询串由演示路由自己解析；POST 的请求体走 `options.data`。
 */
function callDemo<T>(path: string, options: RequestOptions): T {
  const result = handleDemoRequest(options.method || 'GET', path, undefined, options.data);
  return result as T;
}

/** 统一把任意异常转换成 `ApiError` */
function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof DemoRouteError) {
    return new ApiError(error.code, error.message, error.statusCode);
  }
  return new ApiError('UNKNOWN_ERROR', '网络异常，请稍后重试');
}

/* ------------------------------ 令牌刷新 ------------------------------ */

let refreshTask: Promise<boolean> | null = null;

/**
 * 刷新访问令牌（single-flight）。
 * 并发的 401 请求会排队等待同一次刷新结果，避免刷新风暴。
 */
export function refreshAccessToken(): Promise<boolean> {
  if (!refreshTask) {
    refreshTask = doRefresh().then(
      (ok) => {
        refreshTask = null;
        return ok;
      },
      () => {
        refreshTask = null;
        return false;
      }
    );
  }
  return refreshTask;
}

async function doRefresh(): Promise<boolean> {
  // 演示模式下不发网络请求：直接按「刷新失败」处理（清登录态）。
  if (DATA_MODE === 'demo') {
    clearSession();
    return false;
  }
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    clearSession();
    return false;
  }
  try {
    const response = await rawRequest<TokenPair>('/auth/refresh', {
      method: 'POST',
      data: { refreshToken },
      auth: false,
      idempotent: false,
    });
    const token = unwrap<TokenPair>(response.statusCode, response.data);
    if (token && token.accessToken) {
      setToken(token);
      return true;
    }
  } catch (error) {
    // 刷新失败按未登录处理
  }
  clearSession();
  return false;
}

/* ------------------------------ 对外入口 ------------------------------ */

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const opts: RequestOptions = { method: 'GET', auth: true, ...options };
  // ⚠️ 幂等键在**这一层**生成一次（而不是每发一次请求就换一把）：
  //    401 刷新令牌后的重试走的是 `{ ...opts }` → 必须带着**同一把钥匙**，
  //    否则服务端会把重试当成**新请求** →
  //    「首次其实写成功了、只是响应丢了」时会**重复创建**（缺陷 #141）。
  if (opts.method === 'POST' && opts.idempotent !== false && !opts.idempotencyKey) {
    opts.idempotencyKey = generateId();
  }

  // ── 演示模式：完全不发起 wx.request ──────────────────────────────────
  if (DATA_MODE === 'demo') {
    try {
      const data = callDemo<T>(path, opts);
      setDemoActive(true);
      return data;
    } catch (error) {
      const apiError = toApiError(error);
      if (opts.showError !== false) {
        showError(apiError.message);
      }
      throw apiError;
    }
  }

  try {
    const response = await rawRequest(path, opts);
    if (response.statusCode === 401 && opts.auth !== false && opts.retryOnUnauthorized !== false) {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        return request<T>(path, { ...opts, retryOnUnauthorized: false });
      }
      clearSession();
      throw new ApiError('AUTH_REQUIRED', '登录状态已失效，请重新登录', 401);
    }
    const data = unwrap<T>(response.statusCode, response.data);
    // 真实数据可达 → 收起演示提示条
    setDemoActive(false);
    return data;
  } catch (error) {
    const apiError = toApiError(error);
    // ── auto 模式：仅「网络层失败」才回退到演示数据 ────────────────────
    // ⚠️ HTTP 4xx/5xx（服务端真实业务响应）**不回退** —— 回退会用假数据
    //    把真实缺陷盖住。只有 `wx.request` 的 fail 回调（NETWORK_ERROR）才回退。
    if (DATA_MODE === 'auto' && apiError.code === 'NETWORK_ERROR') {
      try {
        const data = callDemo<T>(path, opts);
        setDemoActive(true);
        return data;
      } catch (demoError) {
        // 演示路由没覆盖这个接口 → 走下面的统一错误处理
      }
    }
    if (opts.showError !== false) {
      showError(apiError.message);
    }
    if (apiError.isVerificationRequired) {
      // 需要先完成校友身份认证 → 引导到认证页（而不是让用户对着「无权限」发呆）
      guideToVerification();
    }
    throw apiError;
  }
}

/** GET 请求 */
export function get<T>(path: string, params?: Record<string, unknown>, options: RequestOptions = {}): Promise<T> {
  return request<T>(`${path}${buildQuery(params)}`, { ...options, method: 'GET' });
}

/** POST 请求 */
export function post<T>(path: string, data?: unknown, options: RequestOptions = {}): Promise<T> {
  return request<T>(path, { ...options, method: 'POST', data });
}

/** PUT 请求 */
export function put<T>(path: string, data?: unknown, options: RequestOptions = {}): Promise<T> {
  return request<T>(path, { ...options, method: 'PUT', data });
}

/** PATCH 请求 */
export function patch<T>(path: string, data?: unknown, options: RequestOptions = {}): Promise<T> {
  return request<T>(path, { ...options, method: 'PATCH', data });
}

/** DELETE 请求 */
export function del<T>(path: string, data?: unknown, options: RequestOptions = {}): Promise<T> {
  return request<T>(path, { ...options, method: 'DELETE', data });
}
