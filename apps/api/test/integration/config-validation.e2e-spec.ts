/**
 * 启动期配置校验的用例（docs/SECURITY.md 第 8 节第 1、2、3 条）。
 *
 * ⚠️ 这些用例是**负向验证**：证明「配置不合格时应用确实起不来」，
 *    而不是只写正向用例证明「配置合格时能启动」。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  assertRuntimeConfig,
  DEFAULT_ADMIN_PASSWORD,
  isPlaceholderSecret,
  isValidOrigin,
  resolveAdminCredentials,
  resolveCorsOrigins,
  resolveDatabasePassword,
  validateAdminCredentials,
  validateRuntimeConfig,
} from '../../src/config/config-validation';

/** 一份「生产环境合格」的配置基线。 */
function productionBaseline(): Record<string, unknown> {
  return {
    NODE_ENV: 'production',
    JWT_SECRET: 'a'.repeat(64),
    DATABASE_URL: 'mysql://nmg:s3cr3t@127.0.0.1:3306/nmg_alumni',
    MINIO_ACCESS_KEY: 'nmgadmin',
    MINIO_SECRET_KEY: 'b'.repeat(40),
    CORS_ORIGINS: 'https://alumni.example.com',
    AUTH_MODE: 'wechat',
    WECHAT_APP_ID: 'wx1234567890',
    WECHAT_APP_SECRET: 'c'.repeat(32),
  };
}

describe('启动期配置校验', () => {
  describe('生产环境：缺配置 / 用占位值 → 必须拒绝启动', () => {
    it('缺少 JWT_SECRET 时拒绝启动', () => {
      const env = productionBaseline();
      delete env.JWT_SECRET;
      const { fatal, issues } = validateRuntimeConfig(env);
      expect(fatal).toBe(true);
      expect(issues.some((issue) => issue.key === 'JWT_SECRET')).toBe(true);
      expect(() => assertRuntimeConfig(env)).toThrow(/拒绝启动/);
    });

    it('JWT_SECRET 仍是仓库里的占位值时拒绝启动', () => {
      const env = { ...productionBaseline(), JWT_SECRET: 'change-me-to-a-long-random-string' };
      const { fatal, issues } = validateRuntimeConfig(env);
      expect(fatal).toBe(true);
      expect(issues.some((issue) => issue.key === 'JWT_SECRET')).toBe(true);
    });

    it('JWT_SECRET 过短时拒绝启动', () => {
      const env = { ...productionBaseline(), JWT_SECRET: 'short-secret' };
      const { fatal, issues } = validateRuntimeConfig(env);
      expect(fatal).toBe(true);
      expect(issues.some((issue) => issue.key === 'JWT_SECRET')).toBe(true);
    });

    it('缺少数据库口令时拒绝启动', () => {
      const env = productionBaseline();
      delete env.DATABASE_URL;
      const { fatal, issues } = validateRuntimeConfig(env);
      expect(fatal).toBe(true);
      expect(issues.some((issue) => issue.key === 'DB_PASSWORD')).toBe(true);
    });

    it('DATABASE_URL 里没有口令时拒绝启动', () => {
      const env = { ...productionBaseline(), DATABASE_URL: 'mysql://nmg@127.0.0.1:3306/nmg_alumni' };
      const { fatal, issues } = validateRuntimeConfig(env);
      expect(fatal).toBe(true);
      expect(issues.some((issue) => issue.key === 'DB_PASSWORD')).toBe(true);
    });

    it('缺少 MinIO 密钥时拒绝启动', () => {
      const env = productionBaseline();
      delete env.MINIO_SECRET_KEY;
      const { fatal, issues } = validateRuntimeConfig(env);
      expect(fatal).toBe(true);
      expect(issues.some((issue) => issue.key === 'MINIO_SECRET_KEY')).toBe(true);
    });

    it('CORS_ORIGINS=* 时拒绝启动', () => {
      const env = { ...productionBaseline(), CORS_ORIGINS: '*' };
      const { fatal, issues } = validateRuntimeConfig(env);
      expect(fatal).toBe(true);
      expect(issues.some((issue) => issue.key === 'CORS_ORIGINS')).toBe(true);
    });

    it('CORS_ORIGINS 未配置时拒绝启动', () => {
      const env = productionBaseline();
      delete env.CORS_ORIGINS;
      const { fatal, issues } = validateRuntimeConfig(env);
      expect(fatal).toBe(true);
      expect(issues.some((issue) => issue.key === 'CORS_ORIGINS')).toBe(true);
    });

    it('CORS 白名单里写了非法 origin 时拒绝启动', () => {
      const env = { ...productionBaseline(), CORS_ORIGINS: 'https://a.example.com,not-an-origin' };
      const { fatal, issues } = validateRuntimeConfig(env);
      expect(fatal).toBe(true);
      expect(issues.some((issue) => issue.key === 'CORS_ORIGINS')).toBe(true);
    });

    it('AUTH_MODE=mock（生产环境后门）时拒绝启动', () => {
      const env = { ...productionBaseline(), AUTH_MODE: 'mock' };
      const { fatal, issues } = validateRuntimeConfig(env);
      expect(fatal).toBe(true);
      expect(issues.some((issue) => issue.key === 'AUTH_MODE')).toBe(true);
    });

    it('AUTH_MODE 取值非法时拒绝启动（不能悄悄退回 both）', () => {
      const env = { ...productionBaseline(), AUTH_MODE: 'wechats' };
      const { fatal, issues } = validateRuntimeConfig(env);
      expect(fatal).toBe(true);
      expect(issues.some((issue) => issue.key === 'AUTH_MODE')).toBe(true);
    });

    it('生产环境未显式设置 AUTH_MODE 时拒绝启动（默认 both = 后门默认开着）', () => {
      const env = productionBaseline();
      delete env.AUTH_MODE;
      const { fatal, issues } = validateRuntimeConfig(env);
      expect(fatal).toBe(true);
      expect(issues.some((issue) => issue.key === 'AUTH_MODE')).toBe(true);
    });

    it('AUTH_MODE=wechat 但缺 AppID/AppSecret 时拒绝启动', () => {
      const env = productionBaseline();
      delete env.WECHAT_APP_ID;
      delete env.WECHAT_APP_SECRET;
      const { fatal, issues } = validateRuntimeConfig(env);
      expect(fatal).toBe(true);
      expect(issues.some((issue) => issue.key === 'WECHAT_APP_ID')).toBe(true);
      expect(issues.some((issue) => issue.key === 'WECHAT_APP_SECRET')).toBe(true);
    });
  });

  describe('生产环境：配置齐全 → 放行', () => {
    it('全部配置合格时不拒绝启动', () => {
      const { fatal, issues } = validateRuntimeConfig(productionBaseline());
      expect(issues).toEqual([]);
      expect(fatal).toBe(false);
      expect(() => assertRuntimeConfig(productionBaseline())).not.toThrow();
    });

    it('AUTH_MODE=both 在生产环境只提醒不阻断（切换到 wechat 属人工安排）', () => {
      const env: Record<string, unknown> = { ...productionBaseline(), AUTH_MODE: 'both' };
      delete env.WECHAT_APP_ID;
      delete env.WECHAT_APP_SECRET;
      const { fatal } = validateRuntimeConfig(env);
      expect(fatal).toBe(false);
    });
  });

  describe('非生产环境：只提醒，不阻断', () => {
    it('开发环境缺配置不会阻止启动', () => {
      const env = { NODE_ENV: 'development' };
      const { fatal, issues } = validateRuntimeConfig(env);
      expect(fatal).toBe(false);
      expect(issues.length).toBeGreaterThan(0);
      expect(() => assertRuntimeConfig(env)).not.toThrow();
    });

    it('test 环境缺配置不会阻止启动', () => {
      const env = { NODE_ENV: 'test' };
      expect(() => assertRuntimeConfig(env)).not.toThrow();
    });
  });

  describe('工具函数', () => {
    it('占位值识别', () => {
      expect(isPlaceholderSecret('change-me')).toBe(true);
      expect(isPlaceholderSecret('CHANGE_ME')).toBe(true);
      expect(isPlaceholderSecret('change-me-to-a-long-random-string')).toBe(true);
      expect(isPlaceholderSecret('password')).toBe(true);
      expect(isPlaceholderSecret('a-real-secret-value')).toBe(false);
      expect(isPlaceholderSecret('')).toBe(false);
    });

    // ⚠️ 复核补漏（第二轮）：上一轮的占位值黑名单只认 `-` 分隔，
    //    而**仓库自己的模板**用的是 `_`（CHANGE_ME_xxx）。
    //    这些值长度都 ≥ 32 → 长度检查放行 → 占位值检查也放行
    //    → 用默认 compose 参数起生产环境，校验全绿、照常启动，
    //    而 JWT 密钥是公开在仓库里的常量。
    it('仓库自己的 CHANGE_ME_xxx 写法必须被识别成占位值', () => {
      expect(isPlaceholderSecret('CHANGE_ME_jwt_secret_min_32_chars')).toBe(true);
      expect(isPlaceholderSecret('CHANGE_ME_app_password')).toBe(true);
      expect(isPlaceholderSecret('CHANGE_ME_minio')).toBe(true);
      expect(isPlaceholderSecret('CHANGE_ME_redis')).toBe(true);
      expect(isPlaceholderSecret('CHANGE_ME_admin_password_at_least_12_chars')).toBe(true);
      expect(isPlaceholderSecret('change_me')).toBe(true);
      // 归一化不能误伤正常的强口令
      expect(isPlaceholderSecret('f622d4bb655cad8694f4bd3a66704766')).toBe(false);
      expect(isPlaceholderSecret('nmg-test-secret-please-change-32chars')).toBe(false);
    });

    it('origin 合法性', () => {
      expect(isValidOrigin('https://a.example.com')).toBe(true);
      expect(isValidOrigin('http://127.0.0.1:18080')).toBe(true);
      expect(isValidOrigin('not-an-origin')).toBe(false);
      expect(isValidOrigin('https://a.example.com/path')).toBe(false);
      expect(isValidOrigin('ftp://a.example.com')).toBe(false);
      expect(isValidOrigin('*')).toBe(false);
      // 复核补漏（第二轮）：子域通配不再被接受（文档口径：只认具体域名）
      expect(isValidOrigin('https://*.example.com')).toBe(false);
    });

    it('数据库口令优先取 DATABASE_URL', () => {
      expect(
        resolveDatabasePassword({
          DATABASE_URL: 'mysql://nmg:p%40ss@127.0.0.1:3306/db',
          DB_PASSWORD: 'other',
        }),
      ).toBe('p@ss');
      expect(resolveDatabasePassword({ DB_PASSWORD: 'plain' })).toBe('plain');
      expect(resolveDatabasePassword({})).toBe('');
    });

    it('CORS 白名单解析', () => {
      expect(resolveCorsOrigins({ CORS_ORIGINS: 'https://a.com, https://b.com' })).toEqual([
        'https://a.com',
        'https://b.com',
      ]);
      expect(resolveCorsOrigins({ CORS_ORIGINS: '*' })).toEqual(['*']);
      expect(resolveCorsOrigins({})).toEqual(['*']);
    });
  });

  // ---------------------------------------------------------------------
  // 管理员引导账号的口令（第二轮新增）
  //
  // 背景：`Admin@2026` 这个默认口令**公开在仓库里**（seed 脚本、docs、README），
  //       等同于「谁都能登进管理后台」；而 Seed 每次都会把口令**重置**成它，
  //       运维手工改过的强口令也活不过下一次 Seed。
  // ---------------------------------------------------------------------
  describe('管理员引导账号的口令', () => {
    it('生产环境未设置 ADMIN_BOOTSTRAP_PASSWORD 时判定为致命', () => {
      const { fatal, issues } = validateAdminCredentials({ NODE_ENV: 'production' });
      expect(fatal).toBe(true);
      expect(issues.some((issue) => issue.key === 'ADMIN_BOOTSTRAP_PASSWORD')).toBe(true);
    });

    it('生产环境用仓库里的默认口令时判定为致命', () => {
      const { fatal, issues } = validateAdminCredentials({
        NODE_ENV: 'production',
        ADMIN_BOOTSTRAP_PASSWORD: DEFAULT_ADMIN_PASSWORD,
      });
      expect(fatal).toBe(true);
      expect(issues.some((issue) => issue.key === 'ADMIN_BOOTSTRAP_PASSWORD')).toBe(true);
    });

    it('生产环境用占位口令时判定为致命', () => {
      const { fatal } = validateAdminCredentials({
        NODE_ENV: 'production',
        ADMIN_BOOTSTRAP_PASSWORD: 'CHANGE_ME_admin_password_at_least_12_chars',
      });
      expect(fatal).toBe(true);
    });

    it('生产环境口令过短时判定为致命', () => {
      const { fatal } = validateAdminCredentials({
        NODE_ENV: 'production',
        ADMIN_BOOTSTRAP_PASSWORD: 'shortpass1',
      });
      expect(fatal).toBe(true);
    });

    it('生产环境给了合规口令时放行', () => {
      const { fatal, issues } = validateAdminCredentials({
        NODE_ENV: 'production',
        ADMIN_BOOTSTRAP_PASSWORD: 'a-strong-admin-password',
      });
      expect(issues).toEqual([]);
      expect(fatal).toBe(false);
    });

    it('开发/测试环境不因默认口令而阻断', () => {
      const { fatal } = validateAdminCredentials({ NODE_ENV: 'test' });
      expect(fatal).toBe(false);
    });

    it('取值优先取环境变量', () => {
      expect(
        resolveAdminCredentials({
          ADMIN_BOOTSTRAP_USERNAME: 'ops',
          ADMIN_BOOTSTRAP_PASSWORD: 'another-strong-password',
        }),
      ).toEqual({ username: 'ops', password: 'another-strong-password' });
      // 没给就退回仓库默认值（仅开发/测试）
      expect(resolveAdminCredentials({})).toEqual({
        username: 'admin',
        password: DEFAULT_ADMIN_PASSWORD,
      });
    });
  });
});

// -----------------------------------------------------------------------
// 部署模板自检（第二轮新增）
//
// 上一轮把「生产环境 AUTH_MODE=mock / 缺密钥」改成拒绝启动之后，
// **仓库自己的部署模板**就与代码对不上了：
//   - `infra/env/env.prod.example` 里仍是 AUTH_MODE=mock
//     → `init-env.sh` 生成的 .env.prod 会让生产 API **起不来**；
//   - `docker-compose.prod.yml` 的默认值是 `CHANGE_ME_*`
//     → 占位值长度够、格式又逃过黑名单 → 用默认值起生产环境，
//        JWT 密钥是**公开常量**，任何人都能伪造管理员令牌。
// 这组用例把「模板 ↔ 启动期校验」这条关系钉住，防止再次漂移。
// -----------------------------------------------------------------------
describe('部署模板与启动期校验的一致性', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

  function readRepoFile(relativePath: string): string {
    return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
  }

  /** 取 .env 风格文件里的某个键。 */
  function envValue(content: string, key: string): string | undefined {
    const match = new RegExp(`^${key}=(.*)$`, 'm').exec(content);
    return match ? match[1].trim() : undefined;
  }

  it('生产环境模板不得把 AUTH_MODE 设成 mock（会被启动期校验拒绝启动）', () => {
    const template = readRepoFile('infra/env/env.prod.example');
    expect(envValue(template, 'NODE_ENV')).toBe('production');
    expect(envValue(template, 'AUTH_MODE')).not.toBe('mock');
    expect(envValue(template, 'AUTH_MODE')).toBeDefined();
  });

  it('compose 的默认 AUTH_MODE 不得是 mock', () => {
    const compose = readRepoFile('docker-compose.prod.yml');
    const match = /AUTH_MODE:\s*\$\{AUTH_MODE:-([^}]+)\}/.exec(compose);
    expect(match).not.toBeNull();
    expect(match?.[1]).not.toBe('mock');
  });

  it('模板与 compose 里的占位密钥必须能被占位值识别命中', () => {
    const template = readRepoFile('infra/env/env.prod.example');
    const templateKeys = [
      'JWT_SECRET',
      'MYSQL_PASSWORD',
      'MYSQL_ROOT_PASSWORD',
      'REDIS_PASSWORD',
      'MINIO_ROOT_PASSWORD',
      'ADMIN_BOOTSTRAP_PASSWORD',
    ];
    const missed: string[] = [];
    for (const key of templateKeys) {
      const value = envValue(template, key);
      if (value === undefined || !isPlaceholderSecret(value)) missed.push(`模板:${key}`);
    }

    const compose = readRepoFile('docker-compose.prod.yml');
    const composeKeys = [
      'JWT_SECRET',
      'MYSQL_PASSWORD',
      'REDIS_PASSWORD',
      'MINIO_ROOT_PASSWORD',
      'ADMIN_BOOTSTRAP_PASSWORD',
    ];
    for (const key of composeKeys) {
      const match = new RegExp(`${key}:\\s*\\$\\{${key}:-([^}]+)\\}`).exec(compose);
      if (!match || !isPlaceholderSecret(match[1])) missed.push(`compose:${key}`);
    }

    expect(missed).toEqual([]);
  });
});
