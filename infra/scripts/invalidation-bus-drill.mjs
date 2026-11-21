#!/usr/bin/env node
/**
 * 多实例部署的**撤权跨实例即时生效**演练脚本。
 *
 * ## 它证明什么
 *
 * `docs/SECURITY.md` 第 2.1.4 节承诺的口径是：
 *
 * | 部署形态 | 总线状态 | 撤权延迟上界 |
 * |---|---|---:|
 * | 单实例 | 不适用 | 0 |
 * | 多实例 | 总线可用 | **0** |
 * | 多实例 | 总线不可用 | ≤ TTL（≤60 秒） |
 *
 * 此前这一层**只能靠部署环境人工核对**（第七轮记在「只能靠人工核对」那一栏）。
 * 本脚本把它变成**仓库侧可重复的自证**：
 * 起**两个 API 进程**（真跨进程，不是同进程两个 Nest 上下文）
 * + **一个 Redis**，然后：
 *
 *   1. 在实例 B 上登录管理员 → 访问受保护端点 → B 的 RBAC 缓存**已热**；
 *   2. 在实例 A 上把该管理员**降权**（写操作在 A 上发生，
 *      A 提交事务后向总线发布失效事件）；
 *   3. 立刻在实例 B 上再访问同一个端点 → 必须**已经是 403**，
 *      而且**不是**等 TTL 过期才生效。
 *
 * ## 退化形态对照（脚本自带，别只跑「正常形态」）
 *
 * 脚本还会起**第三个实例**，把总线**整条关掉**
 * （`RBAC_INVALIDATION_ENABLED=false`）：
 * 同样的降权动作之后，这个实例**仍然是 200**（缓存陈旧），
 * 直到 TTL 到期才失效 —— 这正是「总线可用 → 0 / 总线不可用 → ≤TTL」的分档。
 *
 * ⚠️ 没有这一档对照，「B 变成 403 了」也可能只是「缓存本来就没热」——
 *   那种情况演练脚本会**假绿**。所以对照实例是**必须的**。
 *
 * ## 用法
 *
 *   # 自起两个（+1 个对照）实例演练（需要先 build 出 dist/）
 *   node infra/scripts/invalidation-bus-drill.mjs
 *
 *   # 对着**已经在跑**的两个实例演练（部署环境用）
 *   node infra/scripts/invalidation-bus-drill.mjs --base-a http://127.0.0.1:3001 \
 *                                                 --base-b http://127.0.0.1:3002
 *
 *   # 只跑正向（不起了对照实例）
 *   node infra/scripts/invalidation-bus-drill.mjs --no-control
 *
 * 环境变量：
 *   DATABASE_URL / DB_*   数据库连接（起实例时透传给 API）
 *   REDIS_URL / REDIS_*   Redis 连接（**两个实例必须连同一个 Redis**）
 *   JWT_SECRET            API 的 JWT 密钥（两个实例必须一致）
 *   ADMIN_USERNAME        演练用的超管账号（默认 admin）
 *   ADMIN_PASSWORD        演练用的超管口令（默认 Admin@2026，仅限开发/测试库）
 *   RBAC_CACHE_TTL_SECONDS 缓存 TTL（默认 30 秒；对照实例靠它兜底）
 *
 * 退出码：0 = 演练通过；1 = 演练失败（口径不成立）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/* ------------------------------ 参数 ------------------------------ */

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const HAS_FLAG = (flag) => args.includes(flag);

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const BASE_A = argValue('--base-a', null);
const BASE_B = argValue('--base-b', null);
const USE_EXISTING = Boolean(BASE_A && BASE_B);
const PORT_A = Number(argValue('--port-a', '18181'));
const PORT_B = Number(argValue('--port-b', '18182'));
const PORT_CONTROL = Number(argValue('--port-control', '18183'));
const WITH_CONTROL = !HAS_FLAG('--no-control');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'Admin@2026';
/** 演练用的降权目标角色：必须**不含**被测端点需要的权限点。 */
const DOWNGRADED_ROLE = 'alumni_reviewer';
const RESTORED_ROLE = 'super_admin';

/** 受保护端点：`admin:manage` 权限点，只有超管有。 */
const PROTECTED_PATH = '/api/v1/admin/users';

const problems = [];
function fail(message) {
  problems.push(message);
  process.stderr.write(`  ✗ ${message}\n`);
}
function info(message) {
  process.stdout.write(`  · ${message}\n`);
}
function ok(message) {
  process.stdout.write(`  ✓ ${message}\n`);
}

/* ------------------------------ HTTP ------------------------------ */

async function api(base, method, path_, { token, body } = {}) {
  const response = await fetch(`${base}${path_}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, body: payload };
}

async function waitReady(base, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(`${label} 在 ${timeoutMs} ms 内没有就绪（${base}/healthz）`);
  return false;
}

/* ------------------------------ 起实例 ------------------------------ */

const children = [];

function startInstance(label, port, extraEnv = {}) {
  const dist = path.join(ROOT, 'apps/api/dist/main.js');
  if (!fs.existsSync(dist)) {
    fail(`找不到 ${dist} —— 先跑 pnpm --filter @nmg/api build`);
    return null;
  }
  const child = spawn(process.execPath, [dist], {
    cwd: path.join(ROOT, 'apps/api'),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: process.env.NODE_ENV ?? 'development',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logFile = `/tmp/invalidation-bus-drill-${label}.log`;
  const stream = fs.createWriteStream(logFile, { flags: 'w' });
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);
  child.on('exit', () => stream.end());
  children.push(child);
  info(`实例 ${label} 已启动：端口 ${port}（日志：${logFile}）`);
  return child;
}

function stopInstances() {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 已经退了 */
    }
  }
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  process.stdout.write('=== 多实例撤权即时生效演练 ===\n');

  const baseA = USE_EXISTING ? BASE_A.replace(/\/$/, '') : `http://127.0.0.1:${PORT_A}`;
  const baseB = USE_EXISTING ? BASE_B.replace(/\/$/, '') : `http://127.0.0.1:${PORT_B}`;
  const baseControl = `http://127.0.0.1:${PORT_CONTROL}`;

  if (!USE_EXISTING) {
    startInstance('A', PORT_A);
    startInstance('B', PORT_B);
    if (WITH_CONTROL) {
      // 对照实例：把总线**整条关掉** —— 它代表「多实例 + 总线不可用」那一档
      startInstance('control', PORT_CONTROL, { RBAC_INVALIDATION_ENABLED: 'false' });
    }
  } else {
    info(`使用已在运行的实例：A=${baseA} B=${baseB}`);
  }

  const readyA = await waitReady(baseA, '实例 A');
  const readyB = await waitReady(baseB, '实例 B');
  const readyControl = WITH_CONTROL ? await waitReady(baseControl, '对照实例') : true;
  if (!readyA || !readyB || !readyControl) {
    stopInstances();
    process.exit(1);
  }

  // --- 登录（两个实例各自登录，拿到各自进程里的令牌与缓存） ------------------
  const loginA = await api(baseA, 'POST', '/api/v1/auth/admin/login', {
    body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  const loginB = await api(baseB, 'POST', '/api/v1/auth/admin/login', {
    body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  if (loginA.status !== 200 || loginB.status !== 200) {
    fail(
      `管理员登录失败（A=${loginA.status} B=${loginB.status}）—— ` +
        '请用 ADMIN_USERNAME / ADMIN_PASSWORD 指定一个**超管**账号',
    );
    stopInstances();
    process.exit(1);
  }
  const tokenA = loginA.body.data.accessToken;
  const tokenB = loginB.body.data.accessToken;
  const actorId = Number(loginA.body.data.admin.id);
  ok(`管理员 ${ADMIN_USERNAME}（id=${actorId}）已在实例 A / B 上登录`);

  // --- 建一个**专用**的演练账号：演练的是「降权别人」，不是「降权自己」 ------
  //   用自己当靶子的话，降权之后**没人能把它改回来**（自己也失去了 admin:manage）。
  //   所以靶子是一个临时账号，操刀的是登录进来的超管。
  const stamp = Date.now().toString(36);
  const drillUsername = `drill-${stamp}`;
  const drillPassword = `Drill@${stamp}Aa1`;
  const created = await api(baseA, 'POST', '/api/v1/admin/users', {
    token: tokenA,
    body: {
      username: drillUsername,
      displayName: '撤权演练靶子',
      password: drillPassword,
      roles: [RESTORED_ROLE],
    },
  });
  if (created.status !== 201) {
    fail(`创建演练账号失败（${created.status}）—— 登录进来的账号可能不是超管`);
    stopInstances();
    process.exit(1);
  }
  const drillAdminId = Number(created.body.data.id);
  ok(`已创建演练靶子账号 ${drillUsername}（id=${drillAdminId}）`);

  // --- 降权前：靶子账号在两个实例上的缓存都要是「热」的 ----------------------
  const loginDrillB = await api(baseB, 'POST', '/api/v1/auth/admin/login', {
    body: { username: drillUsername, password: drillPassword },
  });
  const tokenDrillB = loginDrillB.body?.data?.accessToken;
  const warmB = await api(baseB, 'GET', PROTECTED_PATH, { token: tokenDrillB });
  if (warmB.status !== 200) {
    fail(`实例 B 上预热失败（${warmB.status}）—— 演练前提不成立`);
    stopInstances();
    process.exit(1);
  }
  ok('实例 B 上靶子账号的 RBAC 缓存已热（受保护端点返回 200）');

  let warmControl = null;
  let tokenControl = null;
  if (WITH_CONTROL) {
    const loginControl = await api(baseControl, 'POST', '/api/v1/auth/admin/login', {
      body: { username: drillUsername, password: drillPassword },
    });
    tokenControl = loginControl.body?.data?.accessToken;
    warmControl = await api(baseControl, 'GET', PROTECTED_PATH, { token: tokenControl });
    if (warmControl.status !== 200) {
      fail(`对照实例预热失败（${warmControl.status}）`);
    } else {
      ok('对照实例（总线已关闭）上靶子账号的 RBAC 缓存也已热');
    }
  }

  // --- 在实例 A 上降权（操刀的是超管，靶子是演练账号） ----------------------
  const downgrade = await api(baseA, 'PATCH', `/api/v1/admin/users/${drillAdminId}`, {
    token: tokenA,
    body: { roles: [DOWNGRADED_ROLE] },
  });
  if (downgrade.status !== 200) {
    fail(
      `降权失败（${downgrade.status}）—— ` +
        '最常见的原因是「系统里只剩一个能管管理员的人」，该降权会被不变量拒绝；' +
        '请先建第二个超管账号再演练',
    );
    stopInstances();
    process.exit(1);
  }
  ok(`实例 A 上已把靶子账号 ${drillUsername} 降权为 ${DOWNGRADED_ROLE}`);

  // --- 立刻在实例 B 上再访问同一个端点 -------------------------------------
  const startedAt = Date.now();
  const afterB = await api(baseB, 'GET', PROTECTED_PATH, { token: tokenDrillB });
  const elapsed = Date.now() - startedAt;
  if (afterB.status === 403) {
    ok(`实例 B 在 ${elapsed} ms 内已拒绝（403）—— 跨进程撤权即时生效成立`);
  } else {
    fail(
      `实例 B 在降权后仍然返回 ${afterB.status}（期望 403）—— ` +
        '跨进程撤权**没有**即时生效（可能没订阅上总线，或两个实例没连同一个 Redis）',
    );
  }

  // --- 对照：总线关掉的实例应当**仍然放行**（直到 TTL 到期） ------------------
  if (WITH_CONTROL && warmControl?.status === 200) {
    const afterControl = await api(baseControl, 'GET', PROTECTED_PATH, {
      token: tokenControl,
    });
    if (afterControl.status === 200) {
      ok(
        '对照实例（总线已关闭）在同样的一段时间里仍然放行（200）—— ' +
          '说明上面那次 403 确实是**总线**带来的，不是巧合',
      );
    } else {
      fail(
        `对照实例在总线关闭的情况下却返回了 ${afterControl.status} —— ` +
          '对照失效，本次演练的结论不可信',
      );
    }
  }

  // --- 复原：把靶子账号的角色改回去，再把它停用 ------------------------------
  const restore = await api(baseA, 'PATCH', `/api/v1/admin/users/${drillAdminId}`, {
    token: tokenA,
    body: { roles: [RESTORED_ROLE] },
  });
  if (restore.status === 200) {
    ok(`已把靶子账号 ${drillUsername} 的角色复原为 ${RESTORED_ROLE}`);
  } else {
    fail(
      `复原失败（${restore.status}）—— 请人工把账号 ${drillUsername}（id=${drillAdminId}）` +
        `的角色改回 ${RESTORED_ROLE}`,
    );
  }
  // ⚠️ 管理员账号的停用走 `PATCH /admin/users/:id`（`users/:id/status` 那个端点
  //    改的是**普通校友账号**，对管理员 id 会返回 404「用户不存在」）。
  const disable = await api(baseA, 'PATCH', `/api/v1/admin/users/${drillAdminId}`, {
    token: tokenA,
    body: { status: 'disabled' },
  });
  if (disable.status === 200) {
    ok(`演练靶子账号 ${drillUsername} 已停用（仓库不提供删除管理员的端点，故停用而非删除）`);
  } else {
    fail(`停用演练账号失败（${disable.status}）—— 请人工停用 ${drillUsername}`);
  }

  stopInstances();

  if (problems.length) {
    process.stdout.write(`\n❌ 演练失败：${problems.length} 项不成立\n`);
    process.exit(1);
  }
  process.stdout.write('\n✅ 演练通过：跨进程「撤权 → 缓存立刻失效」成立\n');
  process.exit(0);
}

process.on('exit', stopInstances);
main().catch((error) => {
  fail(`演练脚本异常：${error instanceof Error ? error.message : String(error)}`);
  stopInstances();
  process.exit(1);
});
