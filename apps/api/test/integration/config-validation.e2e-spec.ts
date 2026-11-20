/**
 * 启动期配置校验的用例（docs/SECURITY.md 第 8 节第 1、2、3 条）。
 *
 * ⚠️ 这些用例是**负向验证**：证明「配置不合格时应用确实起不来」，
 *    而不是只写正向用例证明「配置合格时能启动」。
 */

import {
  assertRuntimeConfig,
  isPlaceholderSecret,
  isValidOrigin,
  resolveCorsOrigins,
  resolveDatabasePassword,
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

    it('origin 合法性', () => {
      expect(isValidOrigin('https://a.example.com')).toBe(true);
      expect(isValidOrigin('http://127.0.0.1:18080')).toBe(true);
      expect(isValidOrigin('https://*.example.com')).toBe(true);
      expect(isValidOrigin('not-an-origin')).toBe(false);
      expect(isValidOrigin('https://a.example.com/path')).toBe(false);
      expect(isValidOrigin('ftp://a.example.com')).toBe(false);
      expect(isValidOrigin('*')).toBe(false);
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
});
