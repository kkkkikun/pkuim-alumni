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
 * 占位值黑名单（大小写与分隔符不敏感）。
 * 这些字符串**出现在仓库里**，等于公开，不能当作真密钥使用。
 *
 * ⚠️ 复核补漏（第二轮）：此前这张表只按「精确相等」或「`-` 前缀」匹配，
 *    而仓库自己的模板用的是**下划线**写法
 *    （`docker-compose.prod.yml` 的 `CHANGE_ME_jwt_secret_min_32_chars`、
 *    `infra/env/env.prod.example` 的 `CHANGE_ME_app_password`）——
 *    这些值长度都 ≥ 32、也不是「change-me-xxx」，
 *    于是**整条占位值防线对仓库自己的模板完全失效**：
 *    用默认 compose 参数起生产环境，校验全绿、照常启动，
 *    而 JWT 密钥是**公开在仓库里的常量** —— 任何人都能伪造管理员令牌。
 *    现在统一把 `_` 与 `-` 视作同一个分隔符再比对。
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
  // 常见的弱默认口令（同样公开在无数仓库里）。
  'password123',
  'secret123',
  'admin123',
  '123456',
] as const;

/**
 * 仓库里公开的管理员默认口令。
 *
 * 它出现在 `src/database/seeds/seed.ts` 与 `docs/` 里 —— 等同于没有口令。
 */
export const DEFAULT_ADMIN_PASSWORD = 'Admin@2026';

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

/**
 * 归一化：大小写不敏感，且把 `_` 与 `-` 视作同一个分隔符。
 *
 * 仓库里的占位值有两种写法（`change-me-xxx` 与 `CHANGE_ME_xxx`），
 * 归一化之后它们指向同一类，避免「换个分隔符就绕过校验」。
 */
function canonicalize(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, '-');
}

/** 是否是「公开在仓库里的占位值」。 */
export function isPlaceholderSecret(value: string): boolean {
  const normalized = canonicalize(value);
  if (!normalized) return false;
  return KNOWN_PLACEHOLDER_SECRETS.some((placeholder) => {
    const canonical = canonicalize(placeholder);
    return normalized === canonical || normalized.startsWith(`${canonical}-`);
  });
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
  // ⚠️ 复核补漏（第二轮）：此前允许 `*.example.com` 这种「子域通配」，
  //    与 docs/SECURITY.md 第 8 节「只接受配置里列出的具体域名，不接受通配符」
  //    不一致。以更严格的一侧为准：**通配一律不合法**。
  if (host.includes('*')) return false;
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

/* --------------------------- 管理员引导账号 --------------------------- */

/** 管理员引导账号的取值。 */
export interface AdminCredentials {
  username: string;
  password: string;
}

/** 管理员口令的最小长度（生产态）。 */
export const MIN_ADMIN_PASSWORD_LENGTH = 12;

/**
 * 取管理员引导账号的取值。
 *
 * ⚠️ 默认口令 `Admin@2026` **公开在仓库里**（seed 脚本、`docs/`、README 里都有），
 *    它不是一个口令，而是一个「谁都能登进管理后台」的常量。
 *    生产环境必须由环境变量显式覆盖。
 */
export function resolveAdminCredentials(env: Record<string, unknown>): AdminCredentials {
  return {
    username: readString(env, 'ADMIN_BOOTSTRAP_USERNAME') || 'admin',
    password: readString(env, 'ADMIN_BOOTSTRAP_PASSWORD') || DEFAULT_ADMIN_PASSWORD,
  };
}

/**
 * 校验管理员引导账号的口令。
 *
 * 与 API 启动期校验分开：**API 运行时根本不读这个口令**
 * （管理员账号由 seed 创建），所以它不进 `validateRuntimeConfig`，
 * 而是**建号的那一步**（`src/database/seeds/seed.ts`）必须自己把关。
 */
export function validateAdminCredentials(
  env: Record<string, unknown>,
): { fatal: boolean; issues: ConfigIssue[] } {
  const nodeEnv = readString(env, 'NODE_ENV') || 'development';
  const isProduction = nodeEnv === 'production';
  const issues: ConfigIssue[] = [];
  const rawPassword = readString(env, 'ADMIN_BOOTSTRAP_PASSWORD');

  if (!rawPassword) {
    issues.push({
      key: 'ADMIN_BOOTSTRAP_PASSWORD',
      message: isProduction
        ? '[致命] 生产环境未设置 ADMIN_BOOTSTRAP_PASSWORD：管理员账号将使用仓库里公开的默认口令 ' +
          `"${DEFAULT_ADMIN_PASSWORD}"，任何人都能登进管理后台。请生成一个强口令后写入环境变量。`
        : `[提醒] 未设置 ADMIN_BOOTSTRAP_PASSWORD，将使用仓库里的默认口令（仅限开发/测试）。`,
    });
  } else if (rawPassword === DEFAULT_ADMIN_PASSWORD) {
    issues.push({
      key: 'ADMIN_BOOTSTRAP_PASSWORD',
      message:
        '[致命] ADMIN_BOOTSTRAP_PASSWORD 仍是仓库里的默认口令，等同于没有口令。' +
        '请生成一个强口令（至少 12 位）后写入环境变量。',
    });
  } else if (isPlaceholderSecret(rawPassword)) {
    issues.push({
      key: 'ADMIN_BOOTSTRAP_PASSWORD',
      message: '[致命] ADMIN_BOOTSTRAP_PASSWORD 仍是仓库里的占位值，请重新生成后注入。',
    });
  } else if (rawPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
    issues.push({
      key: 'ADMIN_BOOTSTRAP_PASSWORD',
      message:
        `[致命] ADMIN_BOOTSTRAP_PASSWORD 长度不足 ${MIN_ADMIN_PASSWORD_LENGTH} 位` +
        `（当前 ${rawPassword.length}）。`,
    });
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
