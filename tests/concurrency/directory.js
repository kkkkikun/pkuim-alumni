// =============================================================================
// NMG-PKU-Alumni —— k6 场景：通讯录查询
//
//   VUS=50 k6 run tests/concurrency/directory.js
//
// 业务正确性断言（docs/top.md §6 / DATABASE-DESIGN.md §11）：
//   1) 只返回已认证且授权公开的校友（服务端保证，这里只断言不出现 5xx/越权字段）
//   2) 通讯录响应中绝不能出现联系方式字段（phone / wechat / email / mobile）
//   3) 同一页内 id 不重复
//   4) 第 1 页与第 2 页结果 id 不重叠（分页不串数据）
// =============================================================================
import { Counter, Trend } from 'k6/metrics';
import {
  API_PREFIX,
  BASE_URL,
  expectStatuses,
  PATHS,
  baseThresholds,
  check,
  handleSummary,
  http,
  loginAsLoadTestAccount,
  parseJson,
  pickList,
  summaryTrendStats,
  url,
  VUS,
  DURATION,
} from './helpers.js';

const directoryErrors = new Counter('directory_errors');
const leakedContacts = new Counter('leaked_contact_fields');
const duplicateIds = new Counter('duplicate_ids_in_page');
const pageOverlap = new Counter('page_overlap_ids');
const directoryLatency = new Trend('directory_latency');

const LEAK_PATTERNS = ['phone', 'mobile', 'wechat', 'weixin', 'email', 'contact_number'];

export const options = {
  vus: VUS,
  duration: DURATION,
  summaryTrendStats: summaryTrendStats(),
  thresholds: baseThresholds({
    directory_latency: ['p(95)<1200'],
    directory_errors: ['count==0'],
    leaked_contact_fields: ['count==0'],
    duplicate_ids_in_page: ['count==0'],
    page_overlap_ids: ['count==0'],
  }),
};

expectStatuses([200]);

export function setup() {
  const res = loginAsLoadTestAccount(1);
  if (!res.token) {
    throw new Error('通讯录场景登录失败：HTTP ' + res.res.status);
  }
  // ⚠️ k6 中 setup() 的返回值必须通过函数参数传给 VU；
  //    模块级变量在各 VU 的独立运行时之间不共享。
  return { token: res.token };
}

function idsOf(body) {
  const list = pickList(body);
  const ids = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i] || {};
    const id = item.id || item.userId || item.user_id;
    if (id !== undefined && id !== null) {
      ids.push(String(id));
    }
  }
  return ids;
}

export default function (data) {
  const token = data.token;
  const auth = { headers: { Authorization: 'Bearer ' + token } };
  const page = (__ITER % 2) + 1;
  const size = parseInt(__ENV.PAGE_SIZE || '20', 10);

  const started = Date.now();
  const res = http.get(url(PATHS.directory + '?page=' + page + '&pageSize=' + size), {
    headers: auth.headers,
    tags: { name: 'GET directory' },
  });
  directoryLatency.add(Date.now() - started);

  const body = parseJson(res);
  const raw = (res.body || '').toLowerCase();

  const ok = check(res, {
    '通讯录返回 2xx': (r) => r.status === 200,
    '通讯录未返回 5xx': (r) => r.status < 500,
  });
  if (!ok) {
    directoryErrors.add(1);
    return;
  }

  // 断言 2：不得泄露联系方式
  for (let i = 0; i < LEAK_PATTERNS.length; i++) {
    if (raw.indexOf('"' + LEAK_PATTERNS[i] + '"') !== -1) {
      leakedContacts.add(1);
      break;
    }
  }

  // 断言 3：页内 id 不重复
  const ids = idsOf(body);
  const seen = {};
  for (let i = 0; i < ids.length; i++) {
    if (seen[ids[i]]) {
      duplicateIds.add(1);
      break;
    }
    seen[ids[i]] = true;
  }

  // 断言 4：与上一页不重叠
  const prev = prevIds;
  if (prev && prev.length) {
    for (let i = 0; i < ids.length; i++) {
      if (prev.indexOf(ids[i]) !== -1) {
        pageOverlap.add(1);
        break;
      }
    }
  }
  prevIds = ids;
}

let prevIds = [];

export { handleSummary };
