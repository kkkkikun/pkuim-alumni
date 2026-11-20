/**
 * HTTP 硬化（安全响应头 + CORS 白名单）的统一挂载点。
 *
 * 应用与集成测试**共用这一个入口** —— 测试里验证的就是生产同款逻辑，
 * 不会出现「测试里另写一套 CORS 配置」导致两边行为漂移。
 */

import type { INestApplication } from '@nestjs/common';
import { buildCorsOptions, createCorsMiddleware } from '../../config/cors';
import { createSecurityHeadersMiddleware } from './security-headers';

export interface HttpHardeningOptions {
  /** `CORS_ORIGINS` 原始值；缺省读环境变量。 */
  corsOrigins?: string;
  /** 是否生产态；缺省按 `NODE_ENV` 判断。 */
  isProduction?: boolean;
  /** 强制下发 HSTS（即使当前不是生产态，例如已挂在 HTTPS 之后）。 */
  forceHsts?: boolean;
}

/**
 * 把安全响应头与 CORS 白名单挂到应用上。
 *
 * 必须在 `app.init()` **之前**调用（Express 中间件要先于路由注册）。
 */
export function applyHttpHardening(
  app: INestApplication,
  options: HttpHardeningOptions = {},
): void {
  const isProduction =
    options.isProduction ?? (process.env.NODE_ENV ?? 'development') === 'production';
  const rawOrigins =
    options.corsOrigins ?? process.env.CORS_ORIGINS ?? '';
  const cors = buildCorsOptions(rawOrigins, isProduction);

  app.use(
    createSecurityHeadersMiddleware({
      hsts: options.forceHsts === true || isProduction,
    }),
  );
  app.use(createCorsMiddleware(cors));
}
