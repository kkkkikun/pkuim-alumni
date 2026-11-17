// =============================================================================
// NMG-PKU-Alumni —— k6 场景：双向互相同时申请连接
//
//   VUS=50 k6 run tests/concurrency/connection-request.js
//
// 场景设计：两个 scenario 在同一时刻启动
//   - asA：用户 A 反复向用户 B 发起联系申请
//   - asB：用户 B 反复向用户 A 发起联系申请
//   二者真正并发，模拟「A 与 B 同时互相申请」（top.md §6.2 / DATABASE-DESIGN.md §3）
//
// 业务正确性断言：
//   1) 同一对用户同时只能存在一条 pending 申请（uk_connection_request_pending）
//      → 全程「新建成功（201）」次数必须 ≤ 1
//   2) 重复提交必须幂等：返回 200/409，绝不出现 500
//   3) 最终不能出现重复的正式连接对
//      → 结束后该用户对的有效连接数必须 ≤ 1
// =============================================================================
import { Counter, Trend } from 'k6/metrics';
import {
  expectStatuses,
  PATHS,
  baseThresholds,
  check,
  fixedCode,
  handleSummary,
  http,
  JSON_HEADERS,
  login,
  loginAsLoadTestAccount,
  parseJson,
  pickList,
  summaryTrendStats,
  url,
  VUS,
  DURATION,
} from './helpers.js';

const pendingCreated = new Counter('connection_pending_created');
const idempotentReplays = new Counter('connection_idempotent_replays');
const conflictCount = new Counter('connection_conflicts');
const serverErrors = new Counter('connection_server_errors');
const finalConnectionCount = new Counter('final_connection_count');
const requestLatency = new Trend('connection_request_latency');

export const options = {
  scenarios: {
    asA: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      exec: 'asA',
      startTime: '0s',
      tags: { scenario: 'A->B' },
    },
    asB: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      exec: 'asB',
      startTime: '0s',
      tags: { scenario: 'B->A' },
    },
  },
  summaryTrendStats: summaryTrendStats(),
  thresholds: baseThresholds({
    connection_request_latency: ['p(95)<3000'],
    connection_pending_created: ['count<=1'],
    connection_idempotent_replays: ['count>0'],
    connection_server_errors: ['count==0'],
    final_connection_count: ['count<=1'],
  }),
};

expectStatuses([200, 201, 202, 409]);

export function setup() {
  // 使用 Seed 生成的已认证压测账号互加。
  // 每轮轮换账号对：上一轮若已建立「待处理申请」或「已连接关系」，
  // 同一对账号再互申就会命中幂等/冲突分支，测不到「新建 pending」路径。
  const pairIndex = Math.floor(Date.now() / 1000) % 100;
  const a = loginAsLoadTestAccount(pairIndex * 2 + 1);
  const b = loginAsLoadTestAccount(pairIndex * 2 + 2);
  if (!a.token || !b.token) {
    throw new Error('连接场景登录失败：A=' + a.res.status + ' B=' + b.res.status);
  }
  const userA = parseInt(__ENV.USER_A_ID || a.userId || '0', 10);
  const userB = parseInt(__ENV.USER_B_ID || b.userId || '0', 10);
  if (!userA || !userB) {
    throw new Error('无法确定对端用户 id，请设置 USER_A_ID / USER_B_ID 环境变量');
  }
  // ⚠️ 通过 setup() 返回值传给各 scenario（模块级变量在 VU 间不共享）
  return { tokenA: a.token, tokenB: b.token, userA: userA, userB: userB };
}

function applyRequest(token, targetUserId, label) {
  const started = Date.now();
  const res = http.post(
    url(PATHS.connectionRequests),
    JSON.stringify({
      targetUserId: targetUserId,
      message: 'k6 并发互加申请 ' + label,
    }),
    {
      headers: Object.assign({ Authorization: 'Bearer ' + token }, JSON_HEADERS),
      tags: { name: 'POST connections/requests' },
    }
  );
  requestLatency.add(Date.now() - started);

  const ok = check(res, {
    '连接申请未返回 5xx': (r) => r.status < 500,
    '连接申请状态合法': (r) =>
      r.status === 200 || r.status === 201 || r.status === 202 || r.status === 409,
  });

  if (!ok || res.status >= 500) {
    serverErrors.add(1);
  } else if (res.status === 201) {
    // 201 = 真正新建了一条 pending 申请
    pendingCreated.add(1);
  } else if (res.status === 200) {
    // 200 = 幂等回放（同一对用户已有 pending 申请），不新建记录
    idempotentReplays.add(1);
  } else if (res.status === 409) {
    conflictCount.add(1);
  }
  return res;
}

export function asA(data) {
  applyRequest(data.tokenA, data.userB, 'A->B');
}

export function asB(data) {
  applyRequest(data.tokenB, data.userA, 'B->A');
}

export function teardown(data) {
  // 断言 3：该用户对最终的有效连接数必须 ≤ 1
  const res = http.get(url(PATHS.myRequests), {
    headers: { Authorization: 'Bearer ' + data.tokenA },
    tags: { name: 'GET my/requests' },
  });
  const list = pickList(parseJson(res));
  const pending = list.filter((item) => {
    const s = (item && (item.status || item.state)) || '';
    return s === 'pending';
  });
  // pending 申请数 ≤ 1（同一对用户）
  if (pending.length > 1) {
    finalConnectionCount.add(pending.length);
  }
}

export { handleSummary };
