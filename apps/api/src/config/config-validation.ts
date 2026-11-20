/**
 * 启动期配置校验。
 *
 * ⚠️ 缺陷（本轮修复）：此前 `configuration.ts` 给每一项配置都写了**兜底默认值**，
 *    其中 `JWT_SECRET` 的兜底值是 `'change-me-to-a-long-random-string'` ——
 *    这是一个**公开在仓库里**的常量。任何知道仓库内容的人都能用它**伪造任意用户的
 *    access token**（包括管理员令牌），越权读取联系方式、直连管理端接口。
 *
 *    同理：数据库口令默认 `''`、MinIO 密钥默认 `''`，
 *    `CORS_ORIGINS` 默认 `'*'`（且 main.ts 把它翻译成 `origin: true`，
 *    即**反射任意 Origin 并允许携带凭据**）。
 *
 *    这些默认值在开发态是合理的（开箱即用），在生产态是**致命**的。
 *    因此这里做的是：**生产态缺配置 / 用占位值 → 拒绝启动**，
 *    而不是把默认值悄悄换成另一个默认值。
 *
 * 校验口径（docs/SECURITY.md 第 8 节「待办（上线前必须完成）」）：
 *   1. `JWT_SECRET` —— 必须存在、长度 ≥ 32、且不是占位值；
 *   2. 数据库口令 —— 必须存在（DATABASE_URL 或 DB_PASSWORD）、且不是占位值；
 *   3. MinIO 密钥 —— access/secret 必须存在，且不是占位值；
 *   4. `CORS_ORIGINS` —— 生产态不得为 `*`，必须是逐条列出的具体 origin；
 *   5. `AUTH_MODE` —— 生产态不得为 `mock`（Mock 登录是公开后门）；
 *      为 `wechat` 时必须同时提供正式 AppID / AppSecret。
 *
 * ⚠️ 本模块**只做校验，不生成也不写入任何密钥**：
 *    「接入密钥管理服务」是人工安排的事，仓库侧只负责把「没配就别启动」这条线守住。
 */

/** 生产态下 JWT_SECRET 的最小长度（字节）。 */
export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * 占位值黑名单（大小写不敏感）。
 * 这些字符串**出现在仓库里**，等于公开，不能当作真密钥使用。
 */
export const KNOWN_PLACEHOLDER_SECRETS = [
  'change-me',
  'change-me-to-a-long-random-string',
  'changeme',
  'change_me',
  'password',
  'secret',
  'your-secret',
  'nmg-secret',
] as const;

/** 单条配置问题。 */
export interface ConfigIssue {
  /** 环境变量名 */
  key: string;
  /** 人可读的原因 */
  message: string;
}

/** 校验结论。 */
export interface ConfigValidationResult {
  /** 生产态下为 true 表示**必须拒绝启动** */
  fatal: boolean;
  issues: ConfigIssue[];
}

function readString(env: Record<string, unknown>, key: string): string {
  const raw = env[key];
  if (raw === undefined || raw === null) return '';
  return String(raw).trim();
}

/** 是否是「公开在仓库里的占位值」。 */
export function isPlaceholderSecret(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return KNOWN_PLACEHOLDER_SECRETS.some(
    (placeholder) => normalized === placeholder || normalized.startsWith(`${placeholder}-`),
  );
}

/**
 * 取出生效的数据库口令。
 *
 * `DATABASE_URL` 优先（与 configuration.ts / data-source.ts 的解析规则保持一致），
 * 否则退回 `DB_PASSWORD`。解析失败时返回空串（= 视为未配置）。
 */
export function resolveDatabasePassword(env: Record<string, unknown>): string {
  const url = readString(env, 'DATABASE_URL');
  if (url) {
    try {
      const parsed = new URL(url);
      return parsed.password ? decodeURIComponent(parsed.password) : '';
    } catch {
      // URL 非法 → 退回分离式环境变量
    }
  }
  return readString(env, 'DB_PASSWORD');
}

/**
 * 取出生效的 CORS 白名单。
 *
 * - 未配置 / `*` → `['*']`（**仅非生产态允许**，生产态会被判为致命问题）；
 * - 否则按逗号切分，逐条 trim，去掉空项。
 */
export function resolveCorsOrigins(env: Record<string, unknown>): string[] {
  const raw = readString(env, 'CORS_ORIGINS');
  if (!raw || raw === '*') return ['*'];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** 单条 origin 是否合法：必须是 `scheme://host[:port]`，且不带路径。 */
export function isValidOrigin(value: string): boolean {
  if (!value) return false;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.pathname !== '/' && parsed.pathname !== '') return false;
  if (parsed.search !== '' || parsed.hash !== '') return false;
  const host = parsed.hostname;
  if (!host) return false;
  if (host.includes('*')) {
    // 只允许 `*.example.com` 这种「子域通配」写法：
    // 通配必须紧跟在主机名最前面，且只能出现一次。
    if (!host.startsWith('*.')) return false;
    const rest = host.slice(2);
    return rest.length > 0 && !rest.includes('*');
  }
  return true;
}

/**
 * 校验运行环境配置。
 *
 * @param env 进程环境变量（`process.env` 或其副本）
 * @returns 致命问题清单与全部问题清单
 */
export function validateRuntimeConfig(
  env: Record<string, unknown>,
): ConfigValidationResult {
  const nodeEnv = readString(env, 'NODE_ENV') || 'development';
  const isProduction = nodeEnv === 'production';
  const issues: ConfigIssue[] = [];

  const add = (key: string, message: string, fatal: boolean): void => {
    issues.push({ key, message: fatal ? `[致命] ${message}` : `[提醒] ${message}` });
  };

  /* --------------------------- JWT_SECRET --------------------------- */
  const jwtSecret = readString(env, 'JWT_SECRET');
  if (!jwtSecret) {
    add(
      'JWT_SECRET',
      '未配置 JWT_SECRET。令牌签名密钥缺失，任何人都能伪造令牌；' +
        '请用 `openssl rand -hex 32` 生成后写入环境变量（不要写进仓库）。',
      isProduction,
    );
  } else if (isPlaceholderSecret(jwtSecret)) {
    add(
      'JWT_SECRET',
      'JWT_SECRET 仍是仓库里的占位值，等同于没有密钥。请重新生成并注入。',
      isProduction,
    );
  } else if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    add(
      'JWT_SECRET',
      `JWT_SECRET 长度不足 ${MIN_JWT_SECRET_LENGTH} 字节（当前 ${jwtSecret.length}）。` +
        '密钥过短会被离线穷举，请用 `openssl rand -hex 32` 重新生成。',
      isProduction,
    );
  }

  /* --------------------------- 数据库口令 --------------------------- */
  const dbPassword = resolveDatabasePassword(env);
  if (!dbPassword) {
    add(
      'DB_PASSWORD',
      '未配置数据库口令。数据库将以空口令连接，等同于无认证。',
      isProduction,
    );
  } else if (isPlaceholderSecret(dbPassword)) {
    add('DB_PASSWORD', '数据库口令仍是仓库里的占位值，请重新生成后注入。', isProduction);
  }

  /* --------------------------- MinIO 密钥 --------------------------- */
  const minioAccessKey = readString(env, 'MINIO_ACCESS_KEY');
  const minioSecretKey = readString(env, 'MINIO_SECRET_KEY');
  if (!minioAccessKey) {
    add('MINIO_ACCESS_KEY', '未配置 MinIO Access Key。', isProduction);
  } else if (isPlaceholderSecret(minioAccessKey)) {
    add('MINIO_ACCESS_KEY', 'MinIO Access Key 仍是仓库里的占位值。', isProduction);
  }
  if (!minioSecretKey) {
    add('MINIO_SECRET_KEY', '未配置 MinIO Secret Key。对象存储将不可用或以匿名访问。', isProduction);
  } else if (isPlaceholderSecret(minioSecretKey)) {
    add('MINIO_SECRET_KEY', 'MinIO Secret Key 仍是仓库里的占位值。', isProduction);
  }

  /* --------------------------- CORS 白名单 --------------------------- */
  const origins = resolveCorsOrigins(env);
  if (origins.includes('*')) {
    add(
      'CORS_ORIGINS',
      'CORS_ORIGINS=* 会反射任意 Origin 并允许携带凭据，正式部署必须收敛到具体域名' +
        '（多个域名用英文逗号分隔）。',
      isProduction,
    );
  } else {
    for (const origin of origins) {
      if (!isValidOrigin(origin)) {
        add(
          'CORS_ORIGINS',
          `CORS 白名单里的 "${origin}" 不是合法的 origin（应为 scheme://host[:port]，不带路径）。`,
          isProduction,
        );
      }
    }
  }

  /* --------------------------- AUTH_MODE --------------------------- */
  const rawAuthMode = readString(env, 'AUTH_MODE');
  const authMode = (rawAuthMode || 'both').toLowerCase();
  if (isProduction && !rawAuthMode) {
    add(
      'AUTH_MODE',
      '生产环境必须**显式**设置 AUTH_MODE（正式上线应为 wechat）。' +
        '未设置时运行时默认是 both —— 也就是 Mock 登录后门默认开着。',
      true,
    );
  } else if (!['mock', 'wechat', 'both'].includes(authMode)) {
    add('AUTH_MODE', `AUTH_MODE 取值非法："${authMode}"（只能是 mock / wechat / both）。`, isProduction);
  } else if (authMode === 'mock' && isProduction) {
    add(
      'AUTH_MODE',
      '生产环境不得使用 AUTH_MODE=mock：/auth/mock/login 会成为公开后门，' +
        '任何人都能凭空造一个用户。正式上线请置 AUTH_MODE=wechat。',
      true,
    );
  } else if (authMode === 'wechat') {
    const appId = readString(env, 'WECHAT_APP_ID');
    const appSecret = readString(env, 'WECHAT_APP_SECRET');
    if (!appId) {
      add('WECHAT_APP_ID', 'AUTH_MODE=wechat 但未配置 WECHAT_APP_ID，微信登录将不可用。', isProduction);
    }
    if (!appSecret) {
      add('WECHAT_APP_SECRET', 'AUTH_MODE=wechat 但未配置 WECHAT_APP_SECRET，微信登录将不可用。', isProduction);
    }
  }

  const fatal = isProduction && issues.length > 0;
  return { fatal, issues };
}

/** 提醒只打印一次（集成测试会反复起应用，避免刷屏）。 */
let warned = false;

/**
 * 供 `ConfigModule.forRoot({ validate })` 使用的校验入口。
 *
 * 生产态下校验不通过 → **抛错终止启动**（这是「拒绝启动」的实现点）；
 * 非生产态 → 只打印提醒，不阻断开发与测试。
 */
export function assertRuntimeConfig(env: Record<string, unknown>): Record<string, unknown> {
  const { fatal, issues } = validateRuntimeConfig(env);
  if (issues.length > 0) {
    const detail = issues.map((issue) => `  - ${issue.key}: ${issue.message}`).join('\n');
    if (fatal) {
      throw new Error(
        `[配置校验] 生产环境配置不完整，拒绝启动：\n${detail}\n` +
          '请补齐上述配置后重启（密钥请通过环境变量或密钥管理服务注入，不要写进仓库）。',
      );
    }
    if (!warned) {
      warned = true;
      // eslint-disable-next-line no-console
      console.warn(`[配置校验] 非生产环境，以下配置存在风险：\n${detail}`);
    }
  }
  return env;
}
