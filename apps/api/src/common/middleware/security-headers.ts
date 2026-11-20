/**
 * 安全响应头中间件（应用层）。
 *
 * ⚠️ 缺口（本轮修复）：`docs/SECURITY.md` 第 8 节把「补充安全响应头」列为上线前必做项，
 *    但此前**只有 nginx 层**加了一小部分头（`infra/nginx/nginx.conf`），
 *    而应用本身**一个响应头都没加** ——
 *    而 API 端口（18081）在私网里是**可直接访问**的（compose 里绑了 127.0.0.1:18081），
 *    绕过 nginx 直连时全部响应头都不存在。
 *
 *    现在应用层与 nginx 层**都**覆盖，两层用同一份清单（见 `SECURITY_RESPONSE_HEADERS`）。
 *
 * 关于 `X-XSS-Protection`：
 *   该头已被主流浏览器**废弃**，且 `1; mode=block` 本身在旧浏览器里会引入风险，
 *   真正的 XSS 防线是 CSP。这里显式置 `0`（= 关闭这个过时特性），
 *   nginx 层同步改成 `0`，两层保持一致。
 *
 * 关于 `Strict-Transport-Security`：
 *   只有在**已经是 HTTPS**（或生产态）时才下发 —— 明文 HTTP 下发 HSTS 会把浏览器
 *   钉死在 https 上却拿不到证书，属于自伤。
 */

import type { NextFunction, Request, Response } from 'express';

/** 应用层统一下发的安全响应头。 */
export const SECURITY_RESPONSE_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
  'X-Permitted-Cross-Domain-Policies': 'none',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // CSP 只声明「不嵌入 / 不改 base / 不挂插件」三类约束，
  // **刻意不写 default-src** —— 本服务同时托管 Swagger UI（/docs），
  // 写死 default-src 'none' 会把文档页打死。
  'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  // 过时的 XSS 过滤器：显式关闭，真正的防线是上面的 CSP。
  'X-XSS-Protection': '0',
};

/** 仅在 HTTPS / 生产态下才下发的头。 */
export const HTTPS_ONLY_RESPONSE_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

export interface SecurityHeadersOptions {
  /** 是否下发 HSTS（生产态或请求走 HTTPS 时为 true） */
  hsts: boolean;
}

/**
 * 生成安全响应头中间件。
 *
 * @param options 是否下发 HSTS
 */
export function createSecurityHeadersMiddleware(options: SecurityHeadersOptions) {
  return function securityHeadersMiddleware(
    request: Request,
    response: Response,
    next: NextFunction,
  ): void {
    // 不暴露技术栈指纹（Express 默认会带 X-Powered-By: Express）。
    response.removeHeader('X-Powered-By');
    for (const [name, value] of Object.entries(SECURITY_RESPONSE_HEADERS)) {
      response.setHeader(name, value);
    }
    if (options.hsts) {
      for (const [name, value] of Object.entries(HTTPS_ONLY_RESPONSE_HEADERS)) {
        response.setHeader(name, value);
      }
    }
    next();
  };
}
