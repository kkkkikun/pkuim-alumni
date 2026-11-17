// =============================================================================
// NMG-PKU-Alumni —— k6 场景：活动最后一个名额竞争
//
//   EVENT_ID=12 EVENT_CAPACITY=5 VUS=50 k6 run tests/concurrency/event-registration.js
//
// 场景设计：capacity 名额远小于 VU，所有 VU 同时抢同一个活动，
//           每个 VU 反复报名（同一用户重复报名必须幂等，不占第二个名额）。
//
// 业务正确性断言（DATABASE-DESIGN.md §5 / §10）：
//   1) 成功报名（201）次数必须 ≤ capacity —— 绝不允许超卖
//   2) 同一用户重复报名不得重复占位（只有首次返回 201）
//   3) 售罄后返回 409（业务冲突），不得出现 5xx
//   4) 结束后活动详情 registered_count 必须 ≤ capacity
// =============================================================================
import { Counter, Trend } from 'k6/metrics';
import {
  PATHS,
  baseThresholds,
  check,
  expectStatuses,
  fixedCode,
  handleSummary,
  http,
  JSON_HEADERS,
  login,
  loginAsLoadTestAccount,
  parseJson,
  summaryTrendStats,
  url,
  VUS,
  DURATION,
} from './helpers.js';

const EVENT_ID = __ENV.EVENT_ID || '';
const CAPACITY = parseInt(__ENV.EVENT_CAPACITY || '10', 10);
const ADMIN_USER = __ENV.ADMIN_USER || '';
const ADMIN_PASS = __ENV.ADMIN_PASS || '';

const seatsTaken = new Counter('event_seats_taken');
const seatConflicts = new Counter('event_seat_conflicts');
const serverErrors = new Counter('event_server_errors');
const finalRegisteredCount = new Counter('event_final_registered_count');
const registerLatency = new Trend('event_register_latency');

let eventId = EVENT_ID;

export const options = {
  vus: VUS,
  duration: DURATION,
  summaryTrendStats: summaryTrendStats(),
  thresholds: baseThresholds({
    event_register_latency: ['p(95)<1600'],
    event_seats_taken: ['count<=' + CAPACITY],
    event_server_errors: ['count==0'],
    event_final_registered_count: ['count<=' + CAPACITY],
  }),
};

// 售罄属于预期业务结果，不计入 http_req_failed。
// setResponseCallback 是每个 VU 独立的设置，必须在模块级调用（setup() 上下文对 VU 不生效）。
expectStatuses([200, 201, 409]);

export function setup() {
  const res = loginAsLoadTestAccount(1);
  if (!res.token) {
    throw new Error('活动场景登录失败：HTTP ' + res.res.status);
  }
  const token = res.token;

  if (!eventId) {
    if (!ADMIN_USER || !ADMIN_PASS) {
      throw new Error(
        '请设置 EVENT_ID（以及可选的 EVENT_CAPACITY）；若需脚本自动创建活动，' +
          '还需提供 ADMIN_USER / ADMIN_PASS'
      );
    }
    eventId = createEvent();
  }
  return { token: token, eventId: eventId, capacity: CAPACITY };
}

// 用管理端接口建一个容量明确的活动
function createEvent() {
  const adminRes = http.post(url(PATHS.adminLogin), JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }), {
    headers: JSON_HEADERS,
    tags: { name: 'POST admin/login' },
  });
  const adminBody = parseJson(adminRes);
  const adminData = (adminBody && (adminBody.data || adminBody)) || {};
  const adminToken =
    adminData.accessToken || adminData.access_token || adminData.token || adminBody.accessToken;
  if (!adminToken) {
    throw new Error('管理端登录失败：HTTP ' + adminRes.status);
  }
  const createRes = http.post(
    url(PATHS.adminEvents),
    JSON.stringify({
      title: __ENV.EVENT_TITLE || 'k6 名额竞争活动',
      kind: 'salon',
      capacity: CAPACITY,
      status: 'published',
      startsAt: __ENV.EVENT_STARTS_AT || '2026-12-01T10:00:00.000Z',
      endsAt: __ENV.EVENT_ENDS_AT || '2026-12-01T12:00:00.000Z',
      place: '呼和浩特',
    }),
    {
      headers: Object.assign({ Authorization: 'Bearer ' + adminToken }, JSON_HEADERS),
      tags: { name: 'POST admin/events' },
    }
  );
  const body = parseJson(createRes);
  const data = (body && (body.data || body)) || {};
  const id = data.id || (data.event && data.event.id);
  if (!id) {
    throw new Error('创建活动失败：HTTP ' + createRes.status + ' ' + String(createRes.body).slice(0, 200));
  }
  return String(id);
}

// 每个 VU 绑定一个独立的已认证压测账号（名额争抢需要不同用户）
const tokenByVu = {};
function tokenForVu() {
  if (!tokenByVu[__VU]) {
    const r = loginAsLoadTestAccount(__VU);
    if (!r.token) throw new Error('VU ' + __VU + ' 登录失败：HTTP ' + r.res.status);
    tokenByVu[__VU] = r.token;
  }
  return tokenByVu[__VU];
}

export default function (data) {
  const token = data.token;
  const eventIdLocal = data.eventId;
  const vuToken = tokenForVu();
  const started = Date.now();
  const res = http.post(
    url(PATHS.eventRegistration.replace('{id}', eventIdLocal)),
    JSON.stringify({ note: 'k6 并发报名' }),
    {
      headers: Object.assign({ Authorization: 'Bearer ' + vuToken }, JSON_HEADERS),
      tags: { name: 'POST event registration' },
    }
  );
  registerLatency.add(Date.now() - started);

  const ok = check(res, {
    '报名未返回 5xx': (r) => r.status < 500,
    '报名状态合法': (r) => r.status === 200 || r.status === 201 || r.status === 409,
  });

  if (!ok || res.status >= 500) {
    serverErrors.add(1);
  } else if (res.status === 201) {
    seatsTaken.add(1);
  } else if (res.status === 409) {
    seatConflicts.add(1);
  }
}

export function teardown(data) {
  const token = data.token;
  const eventIdLocal = data.eventId;
  const res = http.get(url(PATHS.events + '/' + eventIdLocal), {
    headers: { Authorization: 'Bearer ' + token },
    tags: { name: 'GET event' },
  });
  const body = parseJson(res);
  const payload = (body && (body.data || body)) || {};
  const event = payload.event || payload;
  const registered = parseInt(event.registered_count || event.registeredCount || 0, 10);
  const capacity = parseInt(event.capacity || CAPACITY, 10);

  check(res, {
    '活动详情可读': (r) => r.status === 200,
    'registered_count 不超过 capacity': () => registered <= capacity,
  });

  if (registered > capacity) {
    // 超卖：按超出的数量计入失败计数，使阈值立即失败
    finalRegisteredCount.add(registered);
  } else {
    finalRegisteredCount.add(0);
  }
}

export { handleSummary };
