import axios, {
  type AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { MessagePlugin } from '@/plugins/tdesign';
import { ApiPaths, ErrorCode, type ApiErrorPayload, type ApiResponse, type TokenPair } from '@nmg/contracts';
import { applyTokens, clearSession, emitUnauthorized, sessionState } from './session';
import { mockEnabled, mockRequest } from './mock';

declare module 'axios' {
  export interface AxiosRequestConfig {
    /** 跳过 Authorization 注入与 401 自动刷新（登录 / 刷新接口使用） */
    skipAuth?: boolean;
    /** 显式指定幂等键；POST 写入默认自动生成 */
    idempotencyKey?: string;
  }
}

/** 统一业务异常：页面层只需读取 message 即可展示 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, code: string, status: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const baseURL = import.meta.env.VITE_API_BASE_URL || '/api/v1';
const timeout = Number(import.meta.env.VITE_API_TIMEOUT || 20000);

export const http: AxiosInstance = axios.create({ baseURL, timeout });

/* ------------------------------ 工具 ------------------------------ */

function randomId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const ERROR_CODES = new Set<string>(Object.values(ErrorCode));

function isErrorEnvelope(body: unknown): body is ApiResponse<unknown> {
  if (!body || typeof body !== 'object') return false;
  const candidate = body as { code?: unknown; message?: unknown };
  return typeof candidate.code === 'string' && ERROR_CODES.has(candidate.code);
}

function unwrapEnvelope<T>(body: unknown): T {
  if (isErrorEnvelope(body)) {
    throw new ApiError(body.message || '请求失败', body.code, 200);
  }
  if (body && typeof body === 'object' && 'data' in body && 'code' in body) {
    return (body as ApiResponse<T>).data;
  }
  return body as T;
}

function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError<ApiErrorPayload>;
    const status = axiosError.response?.status ?? 0;
    const payload = axiosError.response?.data;
    const code = payload?.code || (status === 0 ? 'NETWORK_ERROR' : `HTTP_${status}`);
    const message =
      payload?.message ||
      (status === 0 ? '网络异常，请检查网络连接后重试' : axiosError.message || '请求失败');
    return new ApiError(message, String(code), status, payload?.details);
  }
  if (error instanceof Error) return new ApiError(error.message, 'INTERNAL_ERROR', 0);
  return new ApiError('未知错误', 'INTERNAL_ERROR', 0);
}

/* ------------------------------ 拦截器 ------------------------------ */

http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = sessionState.accessToken;
  if (!config.skipAuth && token) {
    config.headers.set('Authorization', `Bearer ${token}`);
  }
  config.headers.set('X-Request-Id', randomId());
  if ((config.method || 'get').toLowerCase() === 'post' && !config.skipAuth) {
    // ⚠️ **已经有钥匙就不要换**（缺陷 #141）：
    //   axios 的重试（401 刷新令牌后重发、其它自动重试）会**复用同一个 config**，
    //   而这里原本每次都重新生成一把 → 重试请求被服务端当成**新请求** →
    //   「服务端已写成功、响应丢了」时会**重复执行**（重复创建）。
    //   调用方显式传入 `idempotencyKey` 时也应当**优先沿用**。
    const existing = config.headers.get('Idempotency-Key');
    if (!existing) {
      config.headers.set('Idempotency-Key', config.idempotencyKey || randomId());
    }
  }
  return config;
});

type RetryableConfig = InternalAxiosRequestConfig & { __retried?: boolean };

/** 单飞刷新：并发 401 只触发一次 refresh，其余请求排队复用结果 */
let refreshPromise: Promise<string | null> | null = null;

async function performRefresh(): Promise<string | null> {
  const refreshToken = sessionState.refreshToken;
  if (!refreshToken) {
    clearSession();
    emitUnauthorized();
    return null;
  }
  try {
    const response = await axios.post<ApiResponse<TokenPair> | TokenPair>(
      `${baseURL}${ApiPaths.refresh}`,
      { refreshToken },
      { timeout, headers: { 'Content-Type': 'application/json' } },
    );
    const body = response.data;
    const tokens =
      body && typeof body === 'object' && 'data' in body && 'code' in body
        ? (body as ApiResponse<TokenPair>).data
        : (body as TokenPair);
    if (!tokens?.accessToken) throw new Error('刷新响应缺少 accessToken');
    applyTokens(tokens);
    return tokens.accessToken;
  } catch {
    clearSession();
    emitUnauthorized();
    return null;
  }
}

function refreshAccessToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = performRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

http.interceptors.response.use(
  (response: AxiosResponse) => response,
  async (error: AxiosError<ApiErrorPayload>) => {
    const original = error.config as RetryableConfig | undefined;
    const status = error.response?.status ?? 0;
    if (
      status === 401 &&
      original &&
      !original.skipAuth &&
      !original.__retried &&
      !(original.url || '').includes(ApiPaths.refresh)
    ) {
      original.__retried = true;
      const token = await refreshAccessToken();
      if (token) {
        original.headers.set('Authorization', `Bearer ${token}`);
        return http.request(original);
      }
    }
    return Promise.reject(error);
  },
);

/** 统一错误提示：所有失败的请求都会弹出一次全局提示（页面仍可展示内联错误） */
export function toApiError(error: unknown): ApiError {
  const apiError = normalizeError(error);
  MessagePlugin.error(apiError.message);
  return apiError;
}

/* ------------------------------ 请求封装 ------------------------------ */

async function request<T>(config: AxiosRequestConfig): Promise<T> {
  try {
    const response = await http.request<T>(config);
    return unwrapEnvelope<T>(response.data);
  } catch (error) {
    throw toApiError(error);
  }
}

async function mockSafe<T>(method: string, url: string, payload?: unknown): Promise<T> {
  try {
    return await mockRequest<T>(method, url, payload);
  } catch (error) {
    throw toApiError(error);
  }
}

export function apiGet<T>(url: string, params?: object): Promise<T> {
  if (mockEnabled) return mockSafe<T>('GET', url, params);
  return request<T>({ method: 'GET', url, params });
}

export function apiPost<T>(
  url: string,
  body?: unknown,
  options?: { skipAuth?: boolean; idempotencyKey?: string },
): Promise<T> {
  if (mockEnabled) return mockSafe<T>('POST', url, body);
  return request<T>({
    method: 'POST',
    url,
    data: body,
    skipAuth: options?.skipAuth,
    idempotencyKey: options?.idempotencyKey,
  });
}

export function apiPatch<T>(url: string, body?: unknown): Promise<T> {
  if (mockEnabled) return mockSafe<T>('PATCH', url, body);
  return request<T>({ method: 'PATCH', url, data: body });
}

export function apiPut<T>(url: string, body?: unknown): Promise<T> {
  if (mockEnabled) return mockSafe<T>('PUT', url, body);
  return request<T>({ method: 'PUT', url, data: body });
}

export function apiDelete<T>(url: string): Promise<T> {
  if (mockEnabled) return mockSafe<T>('DELETE', url);
  return request<T>({ method: 'DELETE', url });
}

/** 文件上传（multipart/form-data，Content-Type 交由浏览器自动生成 boundary） */
export function apiUpload<T>(url: string, form: FormData): Promise<T> {
  if (mockEnabled) return mockSafe<T>('POST', url, form);
  return request<T>({ method: 'POST', url, data: form });
}

/** 统一错误提示：页面层可直接调用 */
export function errorMessage(error: unknown): string {
  return normalizeError(error).message;
}
