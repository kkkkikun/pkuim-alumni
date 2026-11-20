import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTestApp, resetDatabase } from '../helpers';

/**
 * 登录方式开关 `AUTH_MODE`（此前是**死配置**）。
 *
 * ⚠️ `.env.prod` 里一直写着 `AUTH_MODE=both`，但**没有任何代码读它** →
 *    Mock 登录与微信登录**永远同时可用** → 生产环境里
 *    `POST /api/v1/auth/mock/login` 是一个**公开可用的后门**
 *    （任何人都能凭空造出一个用户），运营也无法「只留微信登录」。
 *
 * 本用例锁定三种取值的语义：
 *   - `wechat`：Mock 登录被拒（403 FORBIDDEN），微信登录照常；
 *   - `mock`  ：微信登录被拒（403 FORBIDDEN），Mock 登录照常；
 *   - `both`  ：两个都开（由 wechat-login.e2e-spec.ts 覆盖）。
 *   - **非法取值**：按最严口径处理（关闭 Mock 登录）——
 *     此前是把任何拼错的取值当成 `both`，等于「配置写错就把后门打开」。
 *
 * ⚠️ `ConfigService` 的配置工厂在**应用启动时**求值一次，
 *    之后再改 `process.env` 不生效 → 每个取值必须**各起一个应用实例**。
 */
describe('登录方式开关 · AUTH_MODE', () => {
  const savedAuthMode = process.env.AUTH_MODE;

  afterAll(() => {
    if (savedAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = savedAuthMode;
  });

  describe('AUTH_MODE=wechat（正式对外：堵掉 Mock 后门）', () => {
    let app: INestApplication;
    let dataSource: DataSource;

    beforeAll(async () => {
      process.env.AUTH_MODE = 'wechat';
      ({ app, dataSource } = await createTestApp());
    });

    afterAll(async () => {
      await app?.close();
    });

    beforeEach(async () => {
      await resetDatabase(dataSource);
    });

    it('Mock 登录被拒 → 403 FORBIDDEN', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/mock/login')
        .send({ mockOpenid: 'mode-test-1', nickname: '测试校友' })
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      expect(response.body.data).toBeNull();
    });

    it('被拒的 Mock 登录不会造出用户', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/mock/login')
        .send({ mockOpenid: 'mode-test-2' })
        .expect(403);

      const rows = await dataSource.query('SELECT id FROM users');
      expect(rows).toHaveLength(0);
    });
  });

  describe('AUTH_MODE=mock（小程序尚未注册的开发态）', () => {
    let app: INestApplication;
    let dataSource: DataSource;

    beforeAll(async () => {
      process.env.AUTH_MODE = 'mock';
      ({ app, dataSource } = await createTestApp());
    });

    afterAll(async () => {
      await app?.close();
    });

    beforeEach(async () => {
      await resetDatabase(dataSource);
    });

    it('微信登录被拒 → 403 FORBIDDEN（不会去打微信接口）', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/wechat/login')
        .send({ code: 'mode-test-code' })
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
    });

    it('Mock 登录照常可用', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/mock/login')
        .send({ mockOpenid: 'mode-test-3', nickname: '测试校友' })
        .expect(200);

      expect(response.body.code).toBe('OK');
      expect(response.body.data.accessToken).toEqual(expect.any(String));
    });
  });

  describe('AUTH_MODE 取值非法（fail-closed：不得退回 both 把后门打开）', () => {
    let app: INestApplication;
    let dataSource: DataSource;

    beforeAll(async () => {
      // 模拟「配置写错一个字母」：此前这类取值会被当成 both → Mock 后门自动打开。
      process.env.AUTH_MODE = 'wechats';
      ({ app, dataSource } = await createTestApp());
    });

    afterAll(async () => {
      await app?.close();
    });

    beforeEach(async () => {
      await resetDatabase(dataSource);
    });

    it('Mock 登录被拒 → 403 FORBIDDEN', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/mock/login')
        .send({ mockOpenid: 'mode-test-4', nickname: '测试校友' })
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
    });

    it('被拒的 Mock 登录不会造出用户', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/mock/login')
        .send({ mockOpenid: 'mode-test-5' })
        .expect(403);

      const rows = await dataSource.query('SELECT id FROM users');
      expect(rows).toHaveLength(0);
    });
  });
});
