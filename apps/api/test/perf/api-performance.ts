/* eslint-disable no-console */
/**
 * API 性能基线测量（第二轮新增）。
 *
 * 目的：让「性能有没有变好」变成**可复现的数字**，而不是感觉。
 *
 * 怎么用（必须先备好带 Seed 数据的测试库）：
 *   source .env.test && pnpm --filter @nmg/api db:migrate && pnpm --filter @nmg/api db:seed
 *   pnpm --filter @nmg/api perf:baseline            # 打印 Markdown 表格
 *   pnpm --filter @nmg/api perf:baseline -- --json   # 额外写 perf-baseline.json
 *
 * 为什么测这三个量：
 *   1. **SQL 条数** —— 决定「查询数是否随页大小增长」（N+1 的直接证据）；
 *      它是**确定性**的，同一份数据跑两次必然一样，适合当回归守卫。
 *   2. **p50 / p95 延迟** —— 用户真正感知的量；抖动比 SQL 条数大得多，
 *      所以每次跑都取多次迭代的中位数，并打印样本数。
 *   3. **返回条数** —— 防止「靠少返回数据假装变快」。
 *
 * ⚠️ 数据集必须**固定**：本脚本依赖 Seed 造出的数据（1000 个校友 / 200 个通讯录可见 /
 *    连接 / 资源 / 活动 / 文章 / 公告）。换数据集后数字不可与历史数字直接比较 ——
 *    比较时务必「同一数据集、同一命令」（见 docs/TEST-REPORT.md 的性能小节）。
 */

import 'reflect-metadata';

import * as fs from 'node:fs';
import * as path from 'node:path';

import request from 'supertest';
import type { Logger } from 'typeorm';

import { createTestApp } from '../helpers';

/** 每个接口的预热次数与测量次数。 */
const WARMUP = 2;
const ITERATIONS = 7;

interface EndpointSpec {
  name: string;
  path: string;
  /** 'admin' | 'user' | 'anon' */
  as: 'admin' | 'user' | 'anon';
}

interface Measurement {
  name: string;
  path: string;
  status: number;
  sql: number;
  p50: number;
  p95: number;
  items: number;
}

/** 被测接口清单（都是「列表 / 汇总」类接口 —— N+1 与分页问题都出在这里）。 */
const ENDPOINTS: EndpointSpec[] = [
  { name: '通讯录检索', path: '/api/v1/directory?page=1&pageSize=20', as: 'user' },
  { name: '资源列表（公开）', path: '/api/v1/resources?page=1&pageSize=20', as: 'anon' },
  { name: '活动列表（公开）', path: '/api/v1/events?page=1&pageSize=20', as: 'anon' },
  { name: '资讯列表（公开）', path: '/api/v1/articles?page=1&pageSize=20', as: 'anon' },
  { name: '公告列表（公开）', path: '/api/v1/notices?page=1&pageSize=20', as: 'anon' },
  { name: '首页聚合', path: '/api/v1/home/feed', as: 'anon' },
  { name: '我的通知', path: '/api/v1/me/notifications?page=1&pageSize=20', as: 'user' },
  { name: '我的连接', path: '/api/v1/me/connections?page=1&pageSize=20', as: 'user' },
  { name: '我的认证记录', path: '/api/v1/me/verifications?page=1&pageSize=20', as: 'user' },
  { name: '通知中心', path: '/api/v1/notifications?page=1&pageSize=20', as: 'user' },
  { name: '我的联系方式', path: '/api/v1/me/contacts', as: 'user' },
  { name: '管理端·校友列表', path: '/api/v1/admin/alumni?page=1&pageSize=20', as: 'admin' },
  { name: '管理端·资源列表', path: '/api/v1/admin/resources?page=1&pageSize=20', as: 'admin' },
  { name: '管理端·认证审核列表', path: '/api/v1/admin/verifications?page=1&pageSize=20', as: 'admin' },
  { name: '管理端·活动列表', path: '/api/v1/admin/events?page=1&pageSize=20', as: 'admin' },
  { name: '管理端·资讯列表', path: '/api/v1/admin/articles?page=1&pageSize=20', as: 'admin' },
  { name: '管理端·公告列表', path: '/api/v1/admin/notices?page=1&pageSize=20', as: 'admin' },
  { name: '管理端·账号列表', path: '/api/v1/admin/users?page=1&pageSize=20', as: 'admin' },
  { name: '管理端·操作日志', path: '/api/v1/admin/action-logs?page=1&pageSize=20', as: 'admin' },
  { name: '管理端·数据总览', path: '/api/v1/admin/stats', as: 'admin' },
];

/** 统计一次请求打了几条 SQL。 */
class SqlCounter {
  private count = 0;

  /**
   * 接管 TypeORM 的 logger。
   *
   * ⚠️ 必须替换 **DataSource.logger 实例**，而不是 `options.logger`：
   *    TypeORM 在 `initialize()` 时就用 `options.logger` 构造好了 logger 实例，
   *    之后再改 `options.logger` 不会影响已构造好的实例（计数会一直是 0）。
   */
  install(dataSource: { logger: Logger }): void {
    const original = dataSource.logger;
    dataSource.logger = {
      logQuery: () => {
        this.count += 1;
      },
      logQueryError: (error: string | Error, query: string, parameters?: unknown[]) => {
        this.count += 1;
        original.logQueryError?.(error, query, parameters);
      },
      logQuerySlow: original.logQuerySlow?.bind(original),
      logSchemaBuild: original.logSchemaBuild?.bind(original),
      logMigration: original.logMigration?.bind(original),
      log: original.log?.bind(original),
    } as unknown as Logger;
  }

  reset(): void {
    this.count = 0;
  }

  value(): number {
    return this.count;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function countItems(body: unknown): number {
  const data = (body as { data?: unknown } | undefined)?.data as
    | { items?: unknown[]; list?: unknown[]; records?: unknown[] }
    | undefined;
  if (!data) return 0;
  if (Array.isArray(data)) return data.length;
  const candidates: Record<string, unknown> = data as unknown as Record<string, unknown>;
  for (const key of ['items', 'list', 'records']) {
    const value = candidates[key];
    if (Array.isArray(value)) return value.length;
  }
  return 0;
}

async function main(): Promise<void> {
  const { app, dataSource } = await createTestApp();
  const counter = new SqlCounter();
  counter.install(dataSource as unknown as { logger: Logger });
  const server = app.getHttpServer();

  // ---- 登录（拿两种身份）----------------------------------------------
  const adminLogin = await request(server)
    .post('/api/v1/auth/admin/login')
    .send({ username: 'admin', password: 'Admin@2026' })
    .expect(200);
  const adminToken = adminLogin.body.data.accessToken as string;

  const userLogin = await request(server)
    .post('/api/v1/auth/mock/login')
    .send({ mockOpenid: process.env.PERF_USER_OPENID ?? 'mock_alumni_0005', nickname: '压测校友' });
  if (userLogin.status !== 200) {
    throw new Error(
      `用户登录失败（HTTP ${userLogin.status}）：${JSON.stringify(userLogin.body)}。` +
        '请先重跑 `pnpm --filter @nmg/api db:migrate && pnpm --filter @nmg/api db:seed` ' +
        '恢复固定数据集（集成测试会把部分账号停用）。',
    );
  }
  const userToken = userLogin.body.data.accessToken as string;

  const tokenFor = (as: EndpointSpec['as']): string | undefined => {
    if (as === 'admin') return adminToken;
    if (as === 'user') return userToken;
    return undefined;
  };

  const results: Measurement[] = [];

  for (const endpoint of ENDPOINTS) {
    const token = tokenFor(endpoint.as);
    const call = () => {
      const req = request(server).get(endpoint.path);
      if (token) req.set('Authorization', `Bearer ${token}`);
      return req;
    };

    console.log(`… 测量中：${endpoint.name}`);
    // 预热（把连接池、计划缓存、鉴权查询的首次开销排除掉）
    for (let i = 0; i < WARMUP; i += 1) {
      await call();
    }

    const samples: number[] = [];
    let status = 0;
    let items = 0;
    let sql = 0;
    for (let i = 0; i < ITERATIONS; i += 1) {
      counter.reset();
      const started = process.hrtime.bigint();
      const response = await call();
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      status = response.status;
      items = countItems(response.body);
      sql = counter.value();
      samples.push(elapsed);
    }

    samples.sort((a, b) => a - b);
    results.push({
      name: endpoint.name,
      path: endpoint.path,
      status,
      sql,
      p50: Number(percentile(samples, 50).toFixed(1)),
      p95: Number(percentile(samples, 95).toFixed(1)),
      items,
    });
  }

  const header =
    '| 接口 | 路径 | 状态 | SQL 条数 | p50(ms) | p95(ms) | 返回条数 |\n' +
    '| --- | --- | --- | --- | --- | --- | --- |';
  const rows = results
    .map(
      (row) =>
        `| ${row.name} | \`${row.path}\` | ${row.status} | ${row.sql} | ${row.p50} | ${row.p95} | ${row.items} |`,
    )
    .join('\n');

  console.log('\n===== API 性能基线 =====');
  console.log(`数据集：Seed 造出的固定数据（迁移 + seed 后的测试库）`);
  console.log(`每个接口：预热 ${WARMUP} 次，测量 ${ITERATIONS} 次，取分位数`);
  console.log(header);
  console.log(rows);
  console.log('======================\n');

  if (process.argv.includes('--json')) {
    const outFile = path.resolve(process.cwd(), 'perf-baseline.json');
    fs.writeFileSync(
      outFile,
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          warmup: WARMUP,
          iterations: ITERATIONS,
          results,
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`已写出 ${outFile}`);
  }

  await app.close();
}

main().catch((error: unknown) => {
  console.error('性能基线测量失败：', error);
  process.exitCode = 1;
});
