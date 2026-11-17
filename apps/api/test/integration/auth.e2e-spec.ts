import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTestApp, login, resetDatabase } from '../helpers';

describe('认证 · Auth (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  it('Mock 登录签发 access/refresh 令牌并返回用户与身份阶段', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/mock/login')
      .send({ mockOpenid: 'tester-1', nickname: '测试校友' })
      .expect(200);

    expect(response.body.code).toBe('OK');
    expect(response.body.data.accessToken).toEqual(expect.any(String));
    expect(response.body.data.refreshToken).toEqual(expect.any(String));
    expect(response.body.data.user.nickname).toBe('测试校友');
    expect(response.body.data.stage).toBe('logged_in');
  });

  it('未登录访问受保护接口返回 401 AUTH_REQUIRED', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/me').expect(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
  });

  it('伪造令牌被拒绝', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
  });

  it('携带有效令牌可读取本人资料', async () => {
    const session = await login(app, 'tester-2');
    const response = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);
    // Mock 提供方会给 openid 加 mock_ 前缀，避免与真实微信 openid 冲突
    expect(response.body.data.user.openid).toBe('mock_tester-2');
    expect(response.body.data.user.id).toBe(session.userId);
  });

  it('刷新令牌会轮换，旧 refresh token 立即失效', async () => {
    const session = await login(app, 'tester-3');

    const refreshed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(200);
    expect(refreshed.body.data.accessToken).toEqual(expect.any(String));
    expect(refreshed.body.data.refreshToken).not.toBe(session.refreshToken);

    // 旧 refresh token 再用必须失败
    const reuse = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(401);
    // ⚠️ 缺陷 #110：复用已失效的 refresh token 属于「凭据无效」，
    //    不是「没带令牌」→ 返回专用的 AUTH_FAILED（此前混成了 AUTH_REQUIRED）。
    expect(reuse.body.code).toBe('AUTH_FAILED');
    expect(reuse.body.code).not.toBe('AUTH_REQUIRED');
  });

  it('登出后 refresh token 失效', async () => {
    const session = await login(app, 'tester-4');
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ refreshToken: session.refreshToken })
      .expect(204);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(401);
  });

  it('GET /auth/session 返回精简用户投影与身份阶段', async () => {
    const session = await login(app, 'tester-session');

    const response = await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);

    // 契约 AuthSessionResponse = { user: SessionUser | null, stage: string | null }
    expect(response.body.data.user.id).toBe(session.userId);
    expect(response.body.data.user.isAdmin).toBe(false);
    expect(response.body.data.user.permissions).toEqual([]);
    expect(response.body.data.stage).toBe('logged_in');
  });

  it('未认证用户不能使用需要认证校友身份的功能', async () => {
    const session = await login(app, 'tester-5');
    const response = await request(app.getHttpServer())
      .get('/api/v1/directory')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(403);
    // ⚠️ 缺陷 #109：身份阶段不够属于「需先完成校友身份认证」，
    //    不是「无权限」→ 返回专用的 VERIFICATION_REQUIRED（此前混成了 FORBIDDEN）。
    //    HTTP 状态码仍是 403，变的只是业务错误码。
    expect(response.body.code).toBe('VERIFICATION_REQUIRED');
    expect(response.body.code).not.toBe('FORBIDDEN');
  });
});
