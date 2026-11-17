// =============================================================================
// NMG-PKU-Alumni —— k6 场景：登录
//
//   VUS=20  k6 run tests/concurrency/login.js
//
// 业务正确性断言：
//   1) 每个请求都返回 2xx（登录是所有其它场景的前置）
//   2) 响应中必须包含 access_token
//   3) 不出现 5xx（限流以外的服务器错误视为缺陷）
// =============================================================================
import { Counter, Trend } from 'k6/metrics';
import {
  baseThresholds,
  check,
  expectStatuses,
  fixedCode,
  http,
  login,
  makeCode,
  summaryTrendStats,
  handleSummary,
  VUS,
  DURATION,
} from './helpers.js';

const loginErrors = new Counter('login_errors');
const loginLatency = new Trend('login_latency');
const uniqueAccounts = new Counter('unique_accounts');

export const options = {
  vus: VUS,
  duration: DURATION,
  summaryTrendStats: summaryTrendStats(),
  thresholds: baseThresholds({
    login_latency: ['p(95)<2000'],
    login_errors: ['count==0'],
  }),
};

expectStatuses([200, 201]);

export function setup() {
  // 预热一次，确认登录链路可用（失败则整个场景无意义）
  const { res, token } = login(fixedCode('setup'));
  if (!token) {
    throw new Error('登录预热失败：HTTP ' + res.status + ' ' + (res.body || '').slice(0, 200));
  }
  return { token: token };
}

export default function () {
  // 每次迭代使用唯一 code（模拟新用户首次登录）
  const code = makeCode('mock-login');
  const started = Date.now();
  const { res, token } = login(code);

  const ok = check(res, {
    'login 返回 2xx': (r) => r.status === 200 || r.status === 201,
    'login 返回 access_token': () => !!token,
    'login 未返回 5xx': (r) => r.status < 500,
  });

  loginLatency.add(Date.now() - started);
  if (!ok) {
    loginErrors.add(1);
  } else {
    uniqueAccounts.add(1);
  }
}

export { handleSummary };
