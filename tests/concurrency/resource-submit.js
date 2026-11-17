// =============================================================================
// NMG-PKU-Alumni —— k6 场景：资源重复提交（幂等）
//
//   VUS=50 k6 run tests/concurrency/resource-submit.js
//
// 场景设计：所有 VU 使用同一个 Idempotency-Key 反复提交同一条资源，
//           模拟用户网络抖动 / 客户端重复点击。
//
// 业务正确性断言（DATABASE-DESIGN.md §9 uk_idempotency）：
//   1) 同一幂等键只能创建一条资源 → 全程「创建成功（201）」次数必须 == 1
//   2) 重复提交必须返回既有结果（200），不得再次创建
//   3) 不得出现 5xx
//   4) 未审核资源不得出现在公开列表中
//      （提交后立刻查公开资源列表，本次提交的标题不应出现）
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
  loginAsLoadTestAccount,
  parseJson,
  pickList,
  summaryTrendStats,
  url,
  VUS,
  DURATION,
} from './helpers.js';

const resourcesCreated = new Counter('resources_created');
const idempotentReplays = new Counter('idempotent_replays');
const serverErrors = new Counter('resource_server_errors');
const leakedUnpublished = new Counter('unpublished_resource_leaked');
const submitLatency = new Trend('resource_submit_latency');

// 幂等键由 setup() 统一生成并通过参数下发：
//   - 同一轮内所有 VU 必须共用同一个键（验证「同一键只创建一次」）；
//   - 不同轮次互不影响（否则会命中上一轮的幂等记录，测不到创建路径）。
//   注意：模块级代码在**每个 VU** 中各执行一次，不能在这里用 Date.now() 生成键。
const TITLE = __ENV.RESOURCE_TITLE || 'k6 幂等测试资源';

let createdId = null;

export const options = {
  vus: VUS,
  duration: DURATION,
  summaryTrendStats: summaryTrendStats(),
  thresholds: baseThresholds({
    resource_submit_latency: ['p(95)<2600'],
    resources_created: ['count==1'],
    idempotent_replays: ['count>0'],
    resource_server_errors: ['count==0'],
    unpublished_resource_leaked: ['count==0'],
  }),
};

expectStatuses([200, 201, 409]);

export function setup() {
  const res = loginAsLoadTestAccount(1);
  if (!res.token) {
    throw new Error('资源场景登录失败：HTTP ' + res.res.status);
  }
  const idemKey = __ENV.IDEMPOTENCY_KEY || 'k6-resource-' + Date.now();
  // ⚠️ 通过 setup() 返回值传给各 VU（模块级变量在 VU 间不共享）
  return { token: res.token, idemKey: idemKey };
}

export default function (data) {
  const token = data.token;
  const idemKey = data.idemKey;
  const started = Date.now();
  const res = http.post(
    url(PATHS.resources),
    JSON.stringify({
      type: __ENV.RESOURCE_TYPE || 'resource',
      title: TITLE,
      body: __ENV.RESOURCE_BODY || 'k6 重复提交幂等验证',
      industryCode: __ENV.RESOURCE_INDUSTRY || 'ENER',
      regionCode: __ENV.RESOURCE_REGION || 'HHS',
    }),
    {
      headers: Object.assign(
        { Authorization: 'Bearer ' + token, 'Idempotency-Key': idemKey },
        JSON_HEADERS
      ),
      tags: { name: 'POST resources' },
    }
  );
  submitLatency.add(Date.now() - started);

  const ok = check(res, {
    '资源提交未返回 5xx': (r) => r.status < 500,
    '资源提交状态合法': (r) => r.status === 200 || r.status === 201 || r.status === 409,
  });
  if (!ok || res.status >= 500) {
    serverErrors.add(1);
    return;
  }

  const body = parseJson(res);
  const payload = (body && (body.data || body)) || {};
  const id = payload.id || (payload.resource && payload.resource.id);

  if (res.status === 201) {
    resourcesCreated.add(1);
    createdId = id;
  } else {
    idempotentReplays.add(1);
    // 幂等回放必须返回同一个 id
    if (createdId && id && String(id) !== String(createdId)) {
      serverErrors.add(1);
    }
  }

  // 断言 4：未审核内容不得出现在公开列表
  const listRes = http.get(url(PATHS.resources + '?page=1&pageSize=50'), {
    headers: { Authorization: 'Bearer ' + token },
    tags: { name: 'GET resources' },
  });
  if (listRes.status === 200) {
    const list = pickList(parseJson(listRes));
    for (let i = 0; i < list.length; i++) {
      const item = list[i] || {};
      if (item.title === TITLE) {
        leakedUnpublished.add(1);
        break;
      }
    }
  }
}

export { handleSummary };
