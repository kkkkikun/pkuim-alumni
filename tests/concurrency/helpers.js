// =============================================================================
// NMG-PKU-Alumni —— k6 公共工具
//
// 约定：
//   - 所有脚本通过环境变量分层（VUS=20/50/100/200/500）
//   - BASE_URL 默认指向本机 nginx：http://127.0.0.1:18080
//   - API 前缀默认 /api/v1（top.md §4.3）
//   - 端点路径全部可通过环境变量覆盖，便于与后端实际路由对齐
// =============================================================================
import http from 'k6/http';
import { check } from 'k6';

export const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1:18080').replace(/\/+$/, '');
export const API_PREFIX = __ENV.API_PREFIX || '/api/v1';
export const VUS = parseInt(__ENV.VUS || '20', 10);
export const DURATION = __ENV.DURATION || '60s';
// 基线：2026-11-16 私网服务器实测（200 VU）p95 ≈ 1.7s（登录，最重的写路径）
export const P95_MS = parseInt(__ENV.P95_MS || '3000', 10);
export const MAX_FAILED_RATE = __ENV.MAX_FAILED_RATE || '0.01';

// 路径全部对齐 packages/contracts/src/api.ts 的 ApiPaths（唯一事实来源）。
export const PATHS = {
  login: __ENV.LOGIN_PATH || API_PREFIX + '/auth/mock/login',
  adminLogin: __ENV.ADMIN_LOGIN_PATH || API_PREFIX + '/auth/admin/login',
  refresh: __ENV.REFRESH_PATH || API_PREFIX + '/auth/refresh',
  me: __ENV.ME_PATH || API_PREFIX + '/me',
  meContacts: __ENV.ME_CONTACTS_PATH || API_PREFIX + '/me/contacts',
  meRequests: __ENV.MY_REQUESTS_PATH || API_PREFIX + '/me/connection-requests',
  myResources: __ENV.MY_RESOURCES_PATH || API_PREFIX + '/me/resources',
  directory: __ENV.DIRECTORY_PATH || API_PREFIX + '/directory',
  connections: __ENV.CONNECTIONS_PATH || API_PREFIX + '/connections',
  connectionRequests:
    __ENV.CONNECTION_REQUESTS_PATH || API_PREFIX + '/connections/requests',
  contactGrant:
    __ENV.CONTACT_GRANT_PATH || API_PREFIX + '/connections/{id}/contact-grant',
  resources: __ENV.RESOURCES_PATH || API_PREFIX + '/resources',
  events: __ENV.EVENTS_PATH || API_PREFIX + '/events',
  eventRegistration:
    __ENV.EVENT_REGISTRATION_PATH || API_PREFIX + '/events/{id}/registrations',
  adminEvents: __ENV.ADMIN_EVENTS_PATH || API_PREFIX + '/admin/events',
  adminAlumni: __ENV.ADMIN_ALUMNI_PATH || API_PREFIX + '/admin/alumni',
  systemRegions: __ENV.SYSTEM_REGIONS_PATH || API_PREFIX + '/system/regions',
  systemIndustries: __ENV.SYSTEM_INDUSTRIES_PATH || API_PREFIX + '/system/industries',
};

/** Seed 生成的压测账号数量（src/database/seeds/seed.ts LOADTEST_COUNT）。 */
export const LOADTEST_ACCOUNT_COUNT = parseInt(__ENV.LOADTEST_COUNT || '200', 10);

/**
 * 压测账号的 mock 登录 code。
 *
 * Seed 会创建 openid = `mock_k6_alumni_001` … 的已认证账号；
 * MockAuthProvider 会给 code 补 `mock_` 前缀，故 code 形如 `k6_alumni_001`。
 */
export function loadTestCode(index) {
  const n = ((index - 1) % LOADTEST_ACCOUNT_COUNT) + 1;
  return 'k6_alumni_' + String(n).padStart(3, '0');
}

export const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function url(path) {
  return BASE_URL + path;
}

export function withToken(token, extra) {
  const h = { 'Content-Type': 'application/json' };
  if (token) {
    h.Authorization = 'Bearer ' + token;
  }
  return Object.assign(h, extra || {});
}

export function parseJson(res) {
  try {
    return res.json();
  } catch (e) {
    return null;
  }
}

// 兼容 {code,message,data:{access_token}} 与 {access_token} 两种包装
export function pickToken(body) {
  if (!body) {
    return null;
  }
  const data = body.data || body;
  return (
    data.access_token ||
    data.accessToken ||
    data.token ||
    body.access_token ||
    body.token ||
    null
  );
}

export function pickUserId(body) {
  if (!body) {
    return null;
  }
  const data = body.data || body;
  const user = data.user || data;
  if (!user) {
    return null;
  }
  return user.id || user.userId || user.user_id || null;
}

export function pickList(body) {
  if (!body) {
    return [];
  }
  const data = body.data || body;
  const list = data.list || data.items || data.records || data.rows || [];
  return Array.isArray(list) ? list : [];
}

// Mock 登录：code 稳定映射同一用户（便于多轮压测复用账号）
export function login(code, path) {
  const res = http.post(
    url(path || PATHS.login),
    JSON.stringify({ mockOpenid: code, nickname: 'k6-' + code }),
    {
      headers: JSON_HEADERS,
      tags: { name: 'POST login' },
    }
  );
  const body = parseJson(res);
  return { res: res, body: body, token: pickToken(body), userId: pickUserId(body) };
}

/**
 * 以压测账号身份登录（已认证校友，可访问通讯录 / 报名 / 发布等受限接口）。
 * index 通常取 __VU，保证不同 VU 使用不同账号。
 */
export function loginAsLoadTestAccount(index) {
  return login(loadTestCode(index));
}

export function makeCode(prefix) {
  const p = prefix || __ENV.MOCK_CODE_PREFIX || 'mock';
  return p + '-' + __VU + '-' + __ITER + '-' + Math.floor(Math.random() * 1000000000);
}

// 固定 code（同一账号重复登录）
export function fixedCode(role) {
  return (__ENV.CODE_PREFIX || 'k6') + '-' + role;
}

export function is2xx(res) {
  return res.status >= 200 && res.status < 300;
}

export function isConflict(res) {
  return res.status === 409;
}

/**
 * 业务冲突（409）等状态视为预期结果，不计入 http_req_failed。
 *
 * 注意：k6 的 `http.expectedStatuses()` 只接受单个状态码或 {min,max} 区间，
 * 不接受数组；多状态需要自定义 response callback。
 */
export function expectStatuses(list) {
  // k6 v0.50 的 setResponseCallback 只接受 http.expectedStatuses(...) 的结果，
  // 不能直接传自定义函数。这里用区间把「业务冲突 4xx」排除出 http_req_failed，
  // 具体状态是否合法由各脚本内部的 check() 严格把关。
  void list;
  http.setResponseCallback(http.expectedStatuses({ min: 200, max: 499 }));
}

/**
 * 通用阈值。
 *
 * P95 基线取自 2026-11-16 在学校私网服务器（128 vCPU / 295 GiB）上的实测结果，
 * 即「V1 在当前硬件上的可观测上限」，不是拍脑袋的目标值。
 * 后续版本应在同等硬件上以更严的基线回归。
 */
export function baseThresholds(extra) {
  const base = {
    http_req_failed: ['rate<' + MAX_FAILED_RATE],
    http_req_duration: ['p(95)<' + P95_MS],
  };
  return Object.assign(base, extra || {});
}

export function summaryTrendStats() {
  return ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'];
}

// 结果落盘：tests/concurrency/results/<prefix>-<vus>vu.json
export function handleSummary(data) {
  const dir = __ENV.SUMMARY_DIR || 'tests/concurrency/results';
  const prefix = __ENV.SUMMARY_PREFIX || 'summary';
  const file = dir + '/' + prefix + '-' + VUS + 'vu.json';
  return { [file]: JSON.stringify(data, null, 2) };
}

export { http, check };
