/**
 * HTTP 硬化（安全响应头 + CORS 白名单）的用例。
 *
 * 对应 docs/SECURITY.md：
 *   - 第 5 节「传输与暴露面」：CORS 收敛到白名单；
 *   - 第 8 节第 3、5 条：CORS 收敛到正式域名、补充安全响应头。
 *
 * ⚠️ 负向验证是重点：
 *    白名单外的 Origin **必须拿不到任何 CORS 响应头**（否则浏览器会放行）。
 */

import request from 'supertest';
import { createTestApp } from '../helpers';
import type { TestContext } from '../helpers';
import { buildCorsOptions, isOriginAllowed, parseCorsOrigins } from '../../src/config/cors';

const ALLOWED_ORIGIN = 'https://alumni.example.com';
const EVIL_ORIGIN = 'https://evil.example.net';

describe('HTTP 硬化：安全响应头与 CORS 白名单', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp({ corsOrigins: ALLOWED_ORIGIN });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  describe('安全响应头', () => {
    it('每个响应都带齐安全响应头', async () => {
      const response = await request(ctx.app.getHttpServer()).get('/healthz').expect(200);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['x-permitted-cross-domain-policies']).toBe('none');
      expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(response.headers['permissions-policy']).toContain('geolocation=()');
    });

    it('不暴露技术栈指纹（X-Powered-By）', async () => {
      const response = await request(ctx.app.getHttpServer()).get('/healthz').expect(200);
      expect(response.headers['x-powered-by']).toBeUndefined();
    });

    it('非生产态不下发 HSTS（明文 HTTP 下发会把浏览器钉死在 https 上）', async () => {
      const response = await request(ctx.app.getHttpServer()).get('/healthz').expect(200);
      expect(response.headers['strict-transport-security']).toBeUndefined();
    });

    it('生产态下发 HSTS', async () => {
      const prodCtx = await createTestApp({ corsOrigins: ALLOWED_ORIGIN, isProduction: true });
      try {
        const response = await request(prodCtx.app.getHttpServer()).get('/healthz').expect(200);
        expect(response.headers['strict-transport-security']).toContain('max-age=');
      } finally {
        await prodCtx.app.close();
      }
    });
  });

  describe('CORS 白名单', () => {
    it('白名单内的 Origin：回显 Access-Control-Allow-Origin 并允许凭据', async () => {
      const response = await request(ctx.app.getHttpServer())
        .get('/healthz')
        .set('Origin', ALLOWED_ORIGIN)
        .expect(200);
      expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
      expect(response.headers['vary']).toContain('Origin');
    });

    it('白名单外的 Origin：一个 CORS 响应头都不给（负向验证）', async () => {
      const response = await request(ctx.app.getHttpServer())
        .get('/healthz')
        .set('Origin', EVIL_ORIGIN)
        .expect(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('预检请求：白名单内放行并回显允许的方法', async () => {
      const response = await request(ctx.app.getHttpServer())
        .options('/api/v1/auth/wechat/login')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Access-Control-Request-Method', 'POST');
      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(response.headers['access-control-allow-methods']).toContain('POST');
      expect(response.headers['access-control-allow-headers']).toContain('Authorization');
      expect(response.headers['access-control-allow-headers']).toContain('Idempotency-Key');
    });

    it('预检请求：白名单外直接 403（负向验证）', async () => {
      const response = await request(ctx.app.getHttpServer())
        .options('/api/v1/auth/wechat/login')
        .set('Origin', EVIL_ORIGIN)
        .set('Access-Control-Request-Method', 'POST');
      expect(response.status).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('没有 Origin 头的普通请求不受影响（小程序 / 服务端调用）', async () => {
      const response = await request(ctx.app.getHttpServer()).get('/healthz').expect(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('生产态下 CORS_ORIGINS=* 不等于放行一切（负向验证）', async () => {
      const prodCtx = await createTestApp({ corsOrigins: '*', isProduction: true });
      try {
        const response = await request(prodCtx.app.getHttpServer())
          .get('/healthz')
          .set('Origin', EVIL_ORIGIN)
          .expect(200);
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
      } finally {
        await prodCtx.app.close();
      }
    });
  });

  describe('白名单匹配规则', () => {
    it('精确匹配', () => {
      const options = buildCorsOptions(ALLOWED_ORIGIN, true);
      expect(isOriginAllowed(ALLOWED_ORIGIN, options.allowlist)).toBe(true);
      expect(isOriginAllowed('https://alumni.example.com.evil.net', options.allowlist)).toBe(false);
      expect(isOriginAllowed('http://alumni.example.com', options.allowlist)).toBe(false);
    });

    it('子域通配只匹配子域，裸域必须显式列出', () => {
      const options = buildCorsOptions('https://*.example.com', true);
      expect(isOriginAllowed('https://a.example.com', options.allowlist)).toBe(true);
      expect(isOriginAllowed('https://a.b.example.com', options.allowlist)).toBe(true);
      expect(isOriginAllowed('https://example.com', options.allowlist)).toBe(false);
      expect(isOriginAllowed('https://example.com.evil.net', options.allowlist)).toBe(false);
    });

    it('生产态把 * 降级成空白名单（配置写错 ≠ 全放开）', () => {
      expect(parseCorsOrigins('*', true)).toEqual([]);
      expect(parseCorsOrigins('', true)).toEqual([]);
      expect(parseCorsOrigins('*', false)).toEqual(['*']);
    });

    it('放行一切时不携带凭据（避免「反射任意来源 + 凭据」漏洞）', () => {
      const options = buildCorsOptions('*', false);
      expect(options.allowAll).toBe(true);
      expect(options.credentials).toBe(false);
    });

    it('白名单模式下携带凭据', () => {
      const options = buildCorsOptions(ALLOWED_ORIGIN, true);
      expect(options.allowAll).toBe(false);
      expect(options.credentials).toBe(true);
    });
  });
});
