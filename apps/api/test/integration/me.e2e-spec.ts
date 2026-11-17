import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, login, resetDatabase } from '../helpers';

/**
 * 「我的」系列接口的**响应形状**必须与契约一致。
 *
 * 契约（packages/contracts/src/domain.ts）：
 * - `MeResponse`        = { user, alumniProfile: MyAlumniProfile | null, stage }
 * - `MyAlumniProfile`   = AlumniProfileDto + { privacy, contactPhone, contactWechat, contactEmail }
 * - `PrivacySettings`   = 6 个 boolean 开关
 */
describe('我的 · 接口形状契约 (e2e)', () => {
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

  const server = () => request(app.getHttpServer());

  it('GET /me 返回 user / alumniProfile / stage，档案内嵌隐私开关与自己的联系方式', async () => {
    const session = await login(app, 'shape-user');
    await server()
      .put('/api/v1/me/contacts')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ contactPhone: '13800001111', contactWechat: 'shape_wechat' })
      .expect(200);

    const me = await server()
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);

    expect(me.body.data.user.id).toBe(session.userId);
    expect(me.body.data.stage).toBe('logged_in');

    const profile = me.body.data.alumniProfile;
    expect(profile).not.toBeNull();
    expect(profile.userId).toBe(session.userId);
    // 契约：档案内嵌 privacy
    expect(profile.privacy).toBeDefined();
    expect(typeof profile.privacy.showInDirectory).toBe('boolean');
    expect(typeof profile.privacy.acceptContactRequests).toBe('boolean');
    // 契约：档案内嵌自己的联系方式
    expect(profile.contactPhone).toBe('13800001111');
    expect(profile.contactWechat).toBe('shape_wechat');
    // 布尔字段不能是 MySQL 的 0/1
    expect(profile.verified).not.toBe(0);
    expect(profile.verified).not.toBe(1);
  });

  it('GET /me/profile 与 PATCH /me/profile 都返回 MyAlumniProfile', async () => {
    const session = await login(app, 'shape-profile');

    const before = await server()
      .get('/api/v1/me/profile')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);
    expect(before.body.data.userId).toBe(session.userId);
    expect(before.body.data.privacy).toBeDefined();

    const updated = await server()
      .patch('/api/v1/me/profile')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ displayName: '新昵称', college: '经济学院' })
      .expect(200);
    // 返回的是档案本身，而不是整个 /me 响应
    expect(updated.body.data.displayName).toBe('新昵称');
    expect(updated.body.data.userId).toBe(session.userId);
    expect(updated.body.data.user).toBeUndefined();
  });

  it('GET /me/privacy 与 PUT /me/privacy 都返回 PrivacySettings（布尔）', async () => {
    const session = await login(app, 'shape-privacy');

    const before = await server()
      .get('/api/v1/me/privacy')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);
    expect(before.body.data).toEqual({
      showInDirectory: expect.any(Boolean),
      showCollege: expect.any(Boolean),
      showIndustry: expect.any(Boolean),
      showRegion: expect.any(Boolean),
      // 缺陷 #106：showDirection 补齐为一等可读写开关（契约 PrivacySettings 已同步）
      showDirection: expect.any(Boolean),
      acceptContactRequests: expect.any(Boolean),
      allowContactShare: expect.any(Boolean),
    });

    const updated = await server()
      .put('/api/v1/me/privacy')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ showInDirectory: true, allowContactShare: true, showDirection: true })
      .expect(200);
    expect(updated.body.data.showInDirectory).toBe(true);
    expect(updated.body.data.allowContactShare).toBe(true);
    expect(updated.body.data.showDirection).toBe(true);
    expect(typeof updated.body.data.showCollege).toBe('boolean');
  });

  it('PUT /me/contacts 只返回联系方式对象', async () => {
    const session = await login(app, 'shape-contact');
    const updated = await server()
      .put('/api/v1/me/contacts')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ contactPhone: '13800002222', contactEmail: 'shape@example.com' })
      .expect(200);
    expect(updated.body.data).toEqual({
      contactPhone: '13800002222',
      contactWechat: null,
      contactEmail: 'shape@example.com',
    });
  });

  it('GET /me/contacts 只返回本人联系方式', async () => {
    const session = await login(app, 'shape-contact-get');
    const mine = await server()
      .get('/api/v1/me/contacts')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);
    expect(mine.body.data).toEqual({
      contactPhone: null,
      contactWechat: null,
      contactEmail: null,
    });
  });
});
