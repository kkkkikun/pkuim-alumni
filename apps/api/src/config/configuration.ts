import { registerAs } from '@nestjs/config';

export const appConfig = registerAs('app', () => ({
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 8000),
  apiPrefix: process.env.API_PREFIX ?? '/api/v1',
  // ⚠️ 这里只做「读取」，**不做放行判定**：真正的白名单判定在
  //    `config/cors.ts`（main.ts 与集成测试共用同一份实现）。
  //    生产态的 '*' 会在启动期被 `config/config-validation.ts` 判为致命问题。
  corsOrigins: process.env.CORS_ORIGINS ?? '',
  publicApiBase: process.env.PUBLIC_API_BASE ?? 'http://127.0.0.1:18081',
  // ⚠️ 兜底值只是为了让开发态「开箱即用」。
  //    生产态下 `JWT_SECRET` 缺失或仍是占位值时，`config/config-validation.ts`
  //    会在**启动期**直接拒绝启动（不会带着这个兜底值跑起来）。
  jwtSecret: process.env.JWT_SECRET ?? 'change-me-to-a-long-random-string',
  jwtAccessTtl: process.env.JWT_ACCESS_TTL ?? '2h',
  jwtRefreshTtl: process.env.JWT_REFRESH_TTL ?? '30d',
  authMode: process.env.AUTH_MODE ?? 'both',
  wechatAppId: process.env.WECHAT_APP_ID ?? '',
  wechatAppSecret: process.env.WECHAT_APP_SECRET ?? '',
  wechatApiBase: process.env.WECHAT_API_BASE ?? 'https://api.weixin.qq.com',
  adminBootstrapUsername: process.env.ADMIN_BOOTSTRAP_USERNAME ?? 'admin',
  adminBootstrapPassword: process.env.ADMIN_BOOTSTRAP_PASSWORD ?? 'Admin@2026',
  rateLimit: {
    enabled: process.env.RATE_LIMIT_ENABLED ?? 'true',
    windowSeconds: Number(process.env.RATE_LIMIT_WINDOW_SECONDS ?? 60),
    default: Number(process.env.RATE_LIMIT_DEFAULT ?? 240),
    write: Number(process.env.RATE_LIMIT_WRITE ?? 30),
    auth: Number(process.env.RATE_LIMIT_AUTH ?? 20),
  },
}));

export const databaseConfig = registerAs('database', () => {
  // DATABASE_URL 优先（与 src/database/data-source.ts 的解析规则保持一致），
  // 避免「迁移连到 A 库、应用连到 B 库」这类割裂事故。
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    try {
      const parsed = new URL(url);
      const dbName = parsed.pathname.replace(/^\//, '');
      return {
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 3306,
        username: parsed.username ? decodeURIComponent(parsed.username) : 'nmg',
        password: parsed.password ? decodeURIComponent(parsed.password) : '',
        database: dbName,
        logging: process.env.DB_LOGGING === 'true',
      };
    } catch {
      // URL 非法时退回分离式环境变量
    }
  }
  return {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    username: process.env.DB_USER ?? 'nmg',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'nmg_pku_alumni',
    logging: process.env.DB_LOGGING === 'true',
  };
});

export const redisConfig = registerAs('redis', () => ({
  host: process.env.REDIS_HOST ?? '127.0.0.1',
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  db: Number(process.env.REDIS_DB ?? 0),
  bullPrefix: process.env.BULLMQ_PREFIX ?? 'nmg-bull',
}));

export const minioConfig = registerAs('minio', () => {
  const rawEndpoint = process.env.MINIO_ENDPOINT ?? '127.0.0.1';
  const withScheme = rawEndpoint.includes('://') ? rawEndpoint : `http://${rawEndpoint}`;
  let endpoint = rawEndpoint;
  let port = Number(process.env.MINIO_PORT ?? 9000);
  try {
    const parsed = new URL(withScheme);
    endpoint = parsed.hostname;
    if (parsed.port) port = Number(parsed.port);
  } catch {
    // 保持默认值
  }
  return {
    endpoint,
    port,
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY ?? '',
    secretKey: process.env.MINIO_SECRET_KEY ?? '',
    publicBucket: process.env.MINIO_BUCKET_PUBLIC ?? process.env.MINIO_BUCKET ?? 'nmg-public',
    privateBucket:
      process.env.MINIO_BUCKET_PRIVATE ?? process.env.MINIO_PRIVATE_BUCKET ?? 'nmg-private',
  };
});

export const configurations = [appConfig, databaseConfig, redisConfig, minioConfig];
