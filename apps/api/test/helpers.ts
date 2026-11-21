import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import type { Logger } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { IdempotencyInterceptor } from '../src/common/interceptors/idempotency.interceptor';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { buildValidationPipe } from '../src/common/pipes/validation.pipe';
import { applyHttpHardening } from '../src/common/middleware/apply-http-hardening';

export interface TestContext {
  app: INestApplication;
  dataSource: DataSource;
}

/** 起测试应用时可覆盖的 HTTP 硬化参数。 */
export interface TestAppOptions {
  /** `CORS_ORIGINS` 原始值 */
  corsOrigins?: string;
  /** 是否按生产态处理（影响 CORS 与 HSTS） */
  isProduction?: boolean;
  /** 是否强制下发 HSTS */
  forceHsts?: boolean;
}

/** 启动真实 Nest 应用（连接真实 MySQL / Redis）。 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  const dataSourceRef = moduleRef.get<DataSource>(DataSource);
  app.useGlobalPipes(buildValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new IdempotencyInterceptor(dataSourceRef));
  app.useGlobalInterceptors(new TransformInterceptor());
  app.setGlobalPrefix('api/v1', { exclude: ['healthz'] });
  // 安全响应头 + CORS 白名单：与生产同款（main.ts 走的是同一个入口）。
  applyHttpHardening(app, {
    corsOrigins: options.corsOrigins ?? process.env.CORS_ORIGINS ?? '',
    isProduction: options.isProduction ?? false,
    forceHsts: options.forceHsts ?? false,
  });
  await app.init();
  const dataSource = moduleRef.get<DataSource>(DataSource);

  // ⚠️ 套件结束前体检：确认这个套件没有把事务遗留在连接上。
  // 遗留事务会让**后续**套件随机出现「表定义已变」/「死锁」，
  // 表现为「单独跑绿、整条回归链跑红」—— 必须在这里当场点名。
  const originalClose = app.close.bind(app);
  app.close = async () => {
    await reportLeftoverTransactions(dataSource, '套件结束（app.close）');
    return originalClose();
  };

  return { app, dataSource };
}

/**
 * 测试要**清空**的业务数据表。
 *
 * 这些表会被测试写入，且残留会互相干扰 —— 例如上一轮建好的资讯分类
 * 会让下一轮的「创建分类」直接撞唯一索引（`uk_article_categories_slug`），
 * 表现为「单独跑这个套件是绿的，整条回归链跑就红」。
 */
const CLEANED_TABLES = new Set([
  'notification_deliveries',
  'notifications',
  'outbox_events',
  'event_registrations',
  'events',
  'resource_post_attachments',
  'resource_post_reviews',
  'resource_posts',
  'contact_share_grants',
  'connection_request_history',
  'connection_pairs',
  'verification_attachments',
  'verification_reviews',
  'verification_applications',
  'private_contacts',
  'alumni_profiles',
  'user_sessions',
  'users',
  'admin_action_logs',
  'article_categories',
  'articles',
  'notices',
  'media_assets',
  'idempotency_records',
]);

/**
 * **保留**的表：测试的固定基座，清空会让测试失去依赖。
 *
 * - 字典与权限：`regions` / `industries` / `permissions` / `roles` /
 *   `role_permissions` / `system_settings` —— seed 灌入，测试按字典编码筛选；
 * - 管理员账号：`admin_users` / `admin_user_roles` —— `ensureAdmin()` 幂等授予权限；
 * - `migrations` —— TypeORM 的迁移记录，清掉会导致迁移状态丢失。
 */
const PRESERVED_TABLES = new Set([
  'migrations',
  'regions',
  'industries',
  'permissions',
  'roles',
  'role_permissions',
  'system_settings',
  'admin_users',
  'admin_user_roles',
]);

/**
 * 清空业务表（保留字典、角色与迁移记录）。
 *
 * 表清单**从 information_schema 动态获取**，并与上面两张清单做差集校验：
 * 任何一张没被显式归类的表都会让本函数直接抛错。
 * 手工维护清单必然漏表 —— 之前就漏了 `article_categories`，
 * 导致「单独跑绿、连跑红」这种最难查的偶发失败。
 */
export async function resetDatabase(dataSource: DataSource): Promise<void> {
  const rows = await dataSource.query(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'`,
  );
  const allTables = (rows as { name: string }[]).map((row) => row.name);
  const unknown = allTables.filter(
    (table) => !CLEANED_TABLES.has(table) && !PRESERVED_TABLES.has(table),
  );
  if (unknown.length > 0) {
    throw new Error(
      `测试库存在未归类的表：${unknown.join(', ')}。` +
        `请在 helpers.ts 中明确它属于 CLEANED_TABLES（测试数据）还是 PRESERVED_TABLES（基座），` +
        `否则它会在测试之间悄悄残留。`,
    );
  }

  // ⚠️ 残留事务诊断（缺陷 #127 的排查入口）。
  // 上一个用例若把事务抛在连接上（异常路径没回滚），该连接回到池里后仍带着事务：
  //   1) 它的读视图早于本重置 → 后续读报 "Table definition has changed"；
  //   2) 它持有的间隙锁会让并发 INSERT 死锁 → "Deadlock found when trying to get lock"。
  // 两者都会表现为「单独跑这个套件是绿的，整条回归链跑就红」。
  await reportLeftoverTransactions(dataSource, 'resetDatabase 前');

  // ⚠️ 重置用 **DELETE（数据操作）而不是 TRUNCATE（表定义变更）**，理由有两条：
  //
  //   1) **TRUNCATE 是 DDL** → 它会让**其它事务的读视图失效**，
  //      那些事务之后再读该表就会报 "Table definition has changed"（缺陷 #128 的症状来源）；
  //      而且 DDL 的延迟在这台服务器上会在 2~30 秒之间剧烈波动
  //      → 一次重置 25 张表可能要好几分钟，整条回归链会被拖成小时级。
  //      DELETE 是 DML → 毫秒级，且**不动表结构**。
  //
  //   2) 整段重置放在**一个事务**里 → 原子，不会留下「清了一半」的库。
  //
  // 外键：`FOREIGN_KEY_CHECKS` 是**会话级**变量，必须与 DELETE 落在**同一条连接**上，
  // 否则会因外键约束失败（清空顺序无法保证子表先于父表）。
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    // 清掉这条连接上可能残留的事务（上一个用例异常退出时可能没提交/没回滚）。
    await runner.query('ROLLBACK');
    await runner.query('SET FOREIGN_KEY_CHECKS = 0');
    await runner.startTransaction();
    try {
      for (const table of CLEANED_TABLES) {
        await runner.query(`DELETE FROM \`${table}\``);
      }
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.query('SET FOREIGN_KEY_CHECKS = 1');
    }
  } finally {
    await runner.release();
  }
}

/**
 * 报告测试库里**仍然开着的事务**（正常情况下应为空）。
 *
 * 这不是「顺手加的日志」：残留事务会让后续用例随机出现
 * "Table definition has changed" 与 "Deadlock found"，
 * 是最难定位的一类偶发失败。这里把线程号、状态与正在执行的 SQL 打出来，
 * 便于直接定位到泄漏事务的用例。
 *
 * ⚠️ `information_schema.innodb_trx` 需要**全局 PROCESS** 权限；
 * 应用账号通常没有 —— 这种情况下**静默跳过**（不刷错误日志、不影响测试），
 * 权威检查在回归链脚本里用 root 执行。
 */
let diagnosticsAvailable: boolean | undefined;

/**
 * 静默 logger：诊断查询期间临时换上它。
 *
 * ⚠️ 为什么需要它：TypeORM 在查询失败时会把错误**打到控制台**。
 *    诊断查询在「没有 PROCESS 权限」时**本来就会失败**，
 *    那段「Access denied」噪声夹在测试输出里，**很容易被误读成测试失败**。
 *    `dataSource.options.logger` 是**日志时读取**的，
 *    所以临时换掉它就能让失败**彻底无声**。
 */
const SILENT_LOGGER: Logger = {
  logQuery: () => undefined,
  logQueryError: () => undefined,
  logQuerySlow: () => undefined,
  logSchemaBuild: () => undefined,
  logMigration: () => undefined,
  log: () => undefined,
};

/**
 * 在诊断查询期间把 logger 换成静默版。
 *
 * ⚠️ 类型里 `DataSourceOptions.logger` 是 readonly，只能靠 cast 改写；
 *    但它**是日志时读取**的（不是构造时拷贝），所以换掉就真的静音了。
 */
async function withSilentLogger<T>(dataSource: DataSource, run: () => Promise<T>): Promise<T> {
  const options = dataSource.options as { logger: Logger };
  const original = options.logger;
  options.logger = SILENT_LOGGER;
  try {
    return await run();
  } finally {
    options.logger = original;
  }
}

/**
 * 探针：当前账号有没有 **PROCESS** 权限。
 *
 * `information_schema.user_privileges` 对任何用户都可读，且**只显示自己的权限**，
 * 所以这个探针本身不会失败；
 * 而 `PROCESS` 只能授予全局，因此查到一行 `PROCESS` 就意味着能读 `innodb_trx`。
 */
async function hasProcessPrivilege(dataSource: DataSource): Promise<boolean> {
  try {
    const rows = await withSilentLogger(
      dataSource,
      async () =>
        dataSource.query(
          "SELECT COUNT(*) AS c FROM information_schema.user_privileges WHERE privilege_type = 'PROCESS'",
        ) as Promise<{ c: number }[]>,
    );
    return Number(rows[0]?.c ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function reportLeftoverTransactions(
  dataSource: DataSource,
  context: string,
): Promise<void> {
  if (diagnosticsAvailable === false) return;
  if (diagnosticsAvailable === undefined) {
    diagnosticsAvailable = await hasProcessPrivilege(dataSource);
    if (!diagnosticsAvailable) return;
  }
  let rows: { trx_id: string; trx_state: string; trx_started: string; trx_query: string }[] = [];
  try {
    rows = await withSilentLogger(
      dataSource,
      async () =>
        dataSource.query(
          `SELECT trx_id, trx_state, trx_started, trx_query
             FROM information_schema.innodb_trx`,
        ) as Promise<typeof rows>,
    );
  } catch {
    // 没有 PROCESS 权限：诊断不可用，但不能影响测试
    diagnosticsAvailable = false;
    return;
  }
  if (rows.length === 0) return;
  const detail = rows
    .map((row) => `  - ${row.trx_id} ${row.trx_state} 起于 ${row.trx_started}：${row.trx_query}`)
    .join('\n');
  // 带上**当前用例文件**：泄漏事务的来源往往就是它，
  // 没有文件名就只能靠 jest 的输出顺序去猜。
  let where = '（当前用例未知）';
  try {
    const state = (
      globalThis as unknown as {
        expect?: { getState?: () => { testPath?: string } };
      }
    ).expect?.getState?.();
    if (state?.testPath) where = state.testPath.split('/').pop() ?? state.testPath;
  } catch {
    /* 非 jest 环境取不到就忽略 */
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[测试诊断] ${context}（来自 ${where}）发现 ${rows.length} 个未结束的事务：\n${detail}\n` +
      '这些事务会污染后续用例（表定义已变 / 死锁）。请检查对应用例是否漏了回滚。',
  );
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  userId: number;
}

/** Seed 中的字典编码（见 src/database/seeds/fixtures.ts）。 */
export const DICT = {
  regions: {
    hohhot: 'HHS',
    baotou: 'BTS',
    ordos: 'ORDS',
    chifeng: 'CFS',
    tongliao: 'TLS',
    outside: 'OUTSIDE',
  },
  industries: {
    digital: 'DIGI',
    energy: 'ENER',
    agriFood: 'AGFO',
    lawFinance: 'LFIN',
    education: 'EDUR',
    business: 'BIZM',
    culture: 'CULT',
  },
} as const;

/**
 * 契约里的 **5 个内置角色编码**（`packages/contracts` 的 `AdminRole` 联合类型）。
 *
 * ⚠️ `roles` 是**保留表**（`resetDatabase` 不清空），测试夹具造出来的角色编码
 *    会跨套件、跨轮次一直留在库里 → 角色目录被撑到几十上百个编码。
 *    而 `GET /admin/users` 的响应会回显管理员实际持有的角色编码，
 *    契约只认下面这 5 个 —— 残留的夹具角色会让**响应形状校验**直接判负。
 *
 *    所以测试套件在 `afterAll` 里清理自己造出来的角色编码时，
 *    **必须先排除下面这 5 个**（它们由 seed 灌入，是产品的固定基座）。
 */
export const BUILT_IN_ROLE_CODES: ReadonlySet<string> = new Set([
  'super_admin',
  'alumni_reviewer',
  'resource_reviewer',
  'content_admin',
  'event_admin',
]);

/**
 * 幂等创建测试管理员（含角色与权限），可重复调用。
 * 供需要管理员身份的用例（资源审核 / 认证审核）使用。
 */
export async function ensureAdmin(
  dataSource: DataSource,
  options: {
    username?: string;
    password?: string;
    roleCode?: string;
    permissionCode?: string;
  } = {},
): Promise<number> {
  const username = options.username ?? 'admin-test';
  const password = options.password ?? 'Admin@2026';
  const roleCode = options.roleCode ?? 'super_admin';
  const permissionCode = options.permissionCode ?? 'resource:review';

  const passwordHash = await bcrypt.hash(password, 10);
  await dataSource.query(
    `INSERT INTO admin_users (username, password_hash, display_name, status, created_at, updated_at)
     VALUES (?, ?, '测试管理员', 'active', NOW(3), NOW(3))
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), status = 'active'`,
    [username, passwordHash],
  );
  const [admin] = await dataSource.query('SELECT id FROM admin_users WHERE username = ?', [username]);
  const adminId = Number(admin.id);

  await dataSource.query(
    `INSERT INTO roles (code, name, description, created_at) VALUES (?, ?, '', NOW(3))
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [roleCode, roleCode],
  );
  const [role] = await dataSource.query('SELECT id FROM roles WHERE code = ?', [roleCode]);

  await dataSource.query(
    `INSERT INTO permissions (code, name, description, created_at) VALUES (?, ?, '', NOW(3))
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [permissionCode, permissionCode],
  );
  const [perm] = await dataSource.query('SELECT id FROM permissions WHERE code = ?', [permissionCode]);

  await dataSource.query(
    'INSERT IGNORE INTO admin_user_roles (admin_user_id, role_id) VALUES (?, ?)',
    [adminId, Number(role.id)],
  );
  await dataSource.query(
    'INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
    [Number(role.id), Number(perm.id)],
  );
  return adminId;
}

/** Mock 登录并返回令牌。 */
export async function login(
  app: INestApplication,
  mockOpenid: string,
  nickname = '测试校友',
): Promise<LoginResult> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/auth/mock/login')
    .send({ mockOpenid, nickname })
    .expect(200);
  return {
    accessToken: response.body.data.accessToken,
    refreshToken: response.body.data.refreshToken,
    userId: response.body.data.user.id,
  };
}

/**
 * 直接把用户置为已认证校友（跳过人工审核流程，聚焦被测业务）。
 *
 * 注意：必须同时补齐**认证申请与审核记录** ——
 * 业务不变量是「stage='verified' ⟺ profile.verified=1 ⟺ 存在 approved 的认证申请与审核记录」
 * （见 alumni.service.ts 与 infra/scripts/check-data-integrity.sh 的 C1 / E3 / E6）。
 * 只改 stage 会让测试库数据与生产约束脱节。
 */
export async function markVerified(dataSource: DataSource, userId: number): Promise<void> {
  await dataSource.query('UPDATE users SET stage = ? WHERE id = ?', ['verified', userId]);
  await dataSource.query('UPDATE alumni_profiles SET verified = 1, show_in_directory = 1 WHERE user_id = ?', [userId]);

  const existing = await dataSource.query(
    'SELECT id FROM verification_applications WHERE user_id = ? AND status = ? ORDER BY id DESC LIMIT 1',
    [userId, 'approved'],
  );
  if (Array.isArray(existing) && existing.length > 0) {
    return;
  }

  const profiles = await dataSource.query(
    'SELECT real_name, display_name, college, graduation_year, degree FROM alumni_profiles WHERE user_id = ?',
    [userId],
  );
  const profile = Array.isArray(profiles) ? profiles[0] : undefined;
  const realName = profile?.real_name || profile?.display_name || '测试校友';
  const college = profile?.college || '未填写';
  const graduationYear = profile?.graduation_year ?? 2015;

  const inserted = await dataSource.query(
    `INSERT INTO verification_applications
       (user_id, real_name, college, graduation_year, degree, student_id_masked, remark,
        status, submitted_at, decided_at, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', NOW(3), NOW(3), 0, NOW(3), NOW(3))`,
    [
      userId,
      realName,
      college,
      graduationYear,
      profile?.degree ?? null,
      `SN${String(userId).padStart(8, '0')}`,
      '【集成测试】直接置为已认证校友时补录的通过记录。',
    ],
  );

  // INSERT 的返回结构在不同驱动下不一致（ResultSetHeader 无 `id` 字段），
  // 用 LAST_INSERT_ID() 取值最稳妥。
  const idRows = await dataSource.query('SELECT LAST_INSERT_ID() AS id');
  const applicationId = Number(
    (idRows[0] as { id?: number | string } | undefined)?.id ??
      (inserted[0] as { id?: number | string; insertId?: number | string } | undefined)?.insertId ??
      0,
  );
  if (applicationId > 0) {
    // verification_reviews.admin_id 是 NOT NULL，必须给一个真实管理员
    const adminRows = await dataSource.query(
      "SELECT id FROM admin_users WHERE status = 'active' ORDER BY id LIMIT 1",
    );
    let adminId = Number((adminRows[0] as { id?: number | string } | undefined)?.id ?? 0);
    if (!adminId) {
      adminId = await ensureAdmin(dataSource);
    }
    await dataSource.query(
      `INSERT INTO verification_reviews (application_id, admin_id, action, note, snapshot_version, created_at)
       VALUES (?, ?, 'approve', '【集成测试】补录的审核通过记录。', 0, NOW(3))`,
      [applicationId, adminId],
    );
  }
}

export async function setProfile(
  dataSource: DataSource,
  userId: number,
  fields: Record<string, unknown>,
): Promise<void> {
  const allowed = [
    'display_name',
    'college',
    'graduation_year',
    'region_code',
    'industry_code',
    'direction',
    'intro',
    'show_in_directory',
    'show_college',
    'show_industry',
    'show_region',
    'show_direction',
    'accept_contact_requests',
    'allow_contact_share',
  ];
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) continue;
    await dataSource.query(
      `UPDATE alumni_profiles SET ${key} = ? WHERE user_id = ?`,
      [value, userId],
    );
  }
}
