/**
 * CORS 白名单与中间件。
 *
 * ⚠️ 缺陷（本轮修复）：此前 `main.ts` 里的 CORS 写法是
 *
 *     const cors = process.env.CORS_ORIGINS ?? '*';
 *     app.enableCors({
 *       origin: cors === '*' ? true : cors.split(',').map((item) => item.trim()),
 *       credentials: true,
 *     });
 *
 *    `origin: true` 的语义是「**反射请求里的任意 Origin**」，再叠加
 *    `credentials: true` —— 任何第三方站点都能带着用户 cookie 调本接口，
 *    读走响应内容。这是典型的「CORS 反射 + 允许凭据」漏洞。
 *    而 `CORS_ORIGINS` 的默认值就是 `'*'`，不配也能启动。
 *
 *    现在改成：**白名单精确匹配**，白名单外的 Origin 一个都不放行；
 *    `*` 只在非生产态允许，且此时**不携带凭据**。
 *
 * 匹配规则：
 *   - 精确匹配：`https://a.example.com` 只匹配它自己；
 *   - 子域通配：`https://*.example.com` 匹配 `https://x.example.com`，
 *     **不匹配** `https://example.com`（裸域必须显式列出）。
 */

import type { NextFunction, Request, Response } from 'express';

/** 白名单里的「放行一切」标记（仅非生产态可用）。 */
export const CORS_ALLOW_ALL = '*';

/** 允许的请求方法。 */
export const CORS_ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

/** 允许的请求头。 */
export const CORS_ALLOWED_HEADERS = [
  'Accept',
  'Authorization',
  'Content-Type',
  'Idempotency-Key',
  'Origin',
  'X-Requested-With',
] as const;

/** 暴露给浏览器的响应头。 */
export const CORS_EXPOSED_HEADERS = ['X-Request-Id', 'Idempotency-Key'] as const;

/** 预检结果缓存秒数。 */
export const CORS_MAX_AGE_SECONDS = 600;

export interface CorsOptions {
  /** 生效白名单（已去空白、已去重）。`['*']` 表示「非生产态放行一切」。 */
  allowlist: string[];
  /** 是否放行一切（仅非生产态）。 */
  allowAll: boolean;
  /** 是否允许携带凭据（cookie / Authorization）。 */
  credentials: boolean;
}

/**
 * 把 `CORS_ORIGINS` 解析成白名单。
 *
 * @param raw 原始配置值（逗号分隔）
 * @param isProduction 生产态下 `*` 会被降级成**空白名单**（拒绝一切跨域），
 *   而不是放行 —— 「配置写错」绝不能等价于「全放开」。
 */
export function parseCorsOrigins(raw: string | undefined, isProduction: boolean): string[] {
  const value = (raw ?? '').trim();
  if (!value || value === CORS_ALLOW_ALL) {
    return isProduction ? [] : [CORS_ALLOW_ALL];
  }
  const entries = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (entries.includes(CORS_ALLOW_ALL)) {
    return isProduction ? [] : [CORS_ALLOW_ALL];
  }
  return Array.from(new Set(entries));
}

/** 解析 origin；非法返回 null。 */
function parseOrigin(value: string): URL | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 单条 origin 是否命中白名单。 */
export function isOriginAllowed(origin: string, allowlist: string[]): boolean {
  if (!origin) return false;
  if (allowlist.includes(CORS_ALLOW_ALL)) return true;
  const originUrl = parseOrigin(origin);
  if (!originUrl) return false;
  for (const entry of allowlist) {
    const candidateUrl = parseOrigin(entry);
    if (!candidateUrl) continue;
    // ⚠️ 只做**精确匹配**（URL.origin 已做小写化与默认端口归一）。
    //    复核补漏（第二轮）：此前这里还支持 `https://*.example.com` 这种
    //    「子域通配」——而 docs/SECURITY.md 第 8 节写的是
    //    「只接受配置里列出的**具体域名**，不接受通配符」。
    //    文档与实现不一致时以更严格的一侧为准：通配一律不认。
    //    （白名单里写了通配的，配置校验会在启动期直接拒绝 —— 见 config-validation.ts。）
    if (candidateUrl.origin === originUrl.origin) return true;
  }
  return false;
}

/**
 * 组装 CORS 配置。
 *
 * @param raw `CORS_ORIGINS` 原始值
 * @param isProduction 是否生产态
 */
export function buildCorsOptions(raw: string | undefined, isProduction: boolean): CorsOptions {
  const allowlist = parseCorsOrigins(raw, isProduction);
  const allowAll = allowlist.includes(CORS_ALLOW_ALL);
  return {
    allowlist,
    allowAll,
    // 放行一切时**不带凭据**：`origin: 反射任意来源 + credentials` 是危险组合。
    credentials: !allowAll,
  };
}

function appendVary(response: Response, value: string): void {
  const existing = response.getHeader('Vary');
  if (!existing) {
    response.setHeader('Vary', value);
    return;
  }
  const parts = String(existing)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!parts.some((item) => item.toLowerCase() === value.toLowerCase())) {
    parts.push(value);
  }
  response.setHeader('Vary', parts.join(', '));
}

/**
 * CORS 中间件。
 *
 * 用 `app.use()` 挂载（而不是 `app.enableCors()`），原因有二：
 *   1. 与安全响应头中间件放在同一层，顺序可控；
 *   2. 集成测试用同一份 `AppModule` 起应用即可覆盖到**生产同款**逻辑，
 *      不需要测试代码另写一套。
 */
export function createCorsMiddleware(options: CorsOptions) {
  return function corsMiddleware(request: Request, response: Response, next: NextFunction): void {
    const origin = request.headers.origin;
    if (!origin) {
      // 非跨域请求（小程序 / 服务端调用 / curl）：直接放行，不写任何 CORS 头。
      next();
      return;
    }

    const allowed = isOriginAllowed(String(origin), options.allowlist);
    if (!allowed) {
      // 白名单外的 Origin：**一个 CORS 响应头都不给**，
      // 浏览器据此直接拦掉响应（服务端不再额外返回错误，避免泄露存在性）。
      if (request.method === 'OPTIONS') {
        response.status(403).end();
        return;
      }
      next();
      return;
    }

    appendVary(response, 'Origin');
    // 必须**回显请求里的 Origin**（而不是写死 '*'）：
    // 允许携带凭据时，通配符是非法的，回显才是正确写法。
    response.setHeader('Access-Control-Allow-Origin', String(origin));
    if (options.credentials) {
      response.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    response.setHeader('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS.join(', '));
    response.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS.join(', '));
    response.setHeader('Access-Control-Expose-Headers', CORS_EXPOSED_HEADERS.join(', '));
    response.setHeader('Access-Control-Max-Age', String(CORS_MAX_AGE_SECONDS));

    if (request.method === 'OPTIONS') {
      // 预检请求到此为止。
      response.status(204).end();
      return;
    }
    next();
  };
}
