import 'reflect-metadata';

// ---------------------------------------------------------------------------
// 集成测试环境变量
//
// 重要：集成测试会 TRUNCATE 业务表。必须保证连接的是**测试库**，
// 否则会清空生产/联调数据。下方的护栏会在库名不含 "test" 时直接抛错。
// ---------------------------------------------------------------------------
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.AUTH_MODE = process.env.AUTH_MODE ?? 'both';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'nmg-test-secret-please-change-32chars';
process.env.JWT_ACCESS_TTL = process.env.JWT_ACCESS_TTL ?? '15m';
process.env.JWT_REFRESH_TTL = process.env.JWT_REFRESH_TTL ?? '1d';
process.env.DB_LOGGING = 'false';

// 限流在集成测试中关闭：单窗口内大量登录/写入会触发 429 干扰断言。
process.env.RATE_LIMIT_ENABLED = 'false';

function assertTestDatabase(): void {
  // 与 src/config/configuration.ts 的解析规则保持一致：DATABASE_URL 优先。
  const url = process.env.DATABASE_URL?.trim() ?? '';
  let effective = process.env.DB_NAME ?? '';
  if (url) {
    try {
      effective = new URL(url).pathname.replace(/^\//, '') || effective;
    } catch {
      effective = effective || '(无法解析 DATABASE_URL)';
    }
  }
  if (!/test/i.test(effective)) {
    throw new Error(
      '[测试护栏] 拒绝在非测试库上运行集成测试（会 TRUNCATE 业务表）。' +
        `当前生效库名=${effective || '(未知)'}；` +
        '请显式设置 DATABASE_URL=mysql://user:pass@host:3306/nmg_alumni_test。',
    );
  }
}
assertTestDatabase();

jest.setTimeout(60000);
