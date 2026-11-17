import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DICT, createTestApp, login, markVerified, resetDatabase, setProfile } from '../helpers';

describe('通讯录 · 隐私过滤 (e2e)', () => {
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

  async function seedAlumni(openid: string, overrides: Record<string, unknown> = {}) {
    const session = await login(app, openid);
    await markVerified(dataSource, session.userId);
    await setProfile(dataSource, session.userId, {
      display_name: `校友-${openid}`,
      college: '经济学院',
      graduation_year: 2015,
      region_code: DICT.regions.hohhot,
      industry_code: DICT.industries.digital,
      direction: '软件开发',
      show_in_directory: 1,
      show_college: 1,
      show_industry: 1,
      show_region: 1,
      show_direction: 1,
      ...overrides,
    });
    return session;
  }

  it('只返回授权公开的校友', async () => {
    const viewer = await seedAlumni('viewer-1');
    await seedAlumni('public-1', { show_in_directory: 1 });
    await seedAlumni('hidden-1', { show_in_directory: 0 });

    const response = await request(app.getHttpServer())
      .get('/api/v1/directory')
      .set('Authorization', `Bearer ${viewer.accessToken}`)
      .expect(200);

    const names = response.body.data.items.map((item: { displayName: string }) => item.displayName);
    expect(names).toContain('校友-public-1');
    expect(names).not.toContain('校友-hidden-1');
    expect(response.body.data.meta.total).toBe(1);
  });

  it('未认证用户不出现在通讯录', async () => {
    const viewer = await seedAlumni('viewer-2');
    const pending = await login(app, 'pending-1');
    await setProfile(dataSource, pending.userId, { show_in_directory: 1 });

    const response = await request(app.getHttpServer())
      .get('/api/v1/directory')
      .set('Authorization', `Bearer ${viewer.accessToken}`)
      .expect(200);

    const ids = response.body.data.items.map((item: { userId: number }) => item.userId);
    expect(ids).not.toContain(pending.userId);
  });

  it('按对方的字段可见开关裁剪字段', async () => {
    const viewer = await seedAlumni('viewer-3');
    await seedAlumni('partial-1', {
      show_college: 0,
      show_industry: 0,
      show_region: 0,
      show_direction: 0,
    });

    const response = await request(app.getHttpServer())
      .get('/api/v1/directory')
      .set('Authorization', `Bearer ${viewer.accessToken}`)
      .expect(200);

    const item = response.body.data.items[0];
    expect(item.college).toBeNull();
    expect(item.industryCode).toBeNull();
    expect(item.regionCode).toBeNull();
    expect(item.direction).toBeNull();
  });

  it('通讯录响应中绝不包含联系方式字段', async () => {
    const viewer = await seedAlumni('viewer-4');
    await seedAlumni('peer-4', {});
    const contactUser = await login(app, 'peer-4-contact');
    await request(app.getHttpServer())
      .put('/api/v1/me/contacts')
      .set('Authorization', `Bearer ${contactUser.accessToken}`)
      .send({
        contactPhone: '13800000001',
        contactWechat: 'pku_contact',
        contactEmail: 'contact@example.com',
      })
      .expect(200);

    const response = await request(app.getHttpServer())
      .get('/api/v1/directory')
      .set('Authorization', `Bearer ${viewer.accessToken}`)
      .expect(200);

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('phoneCipher');
    expect(serialized).not.toContain('contactPhone');
    expect(serialized).not.toContain('wechat');
  });

  it('地区与行业筛选生效', async () => {
    const viewer = await seedAlumni('viewer-5');
    await seedAlumni('a-5', { region_code: DICT.regions.hohhot, industry_code: DICT.industries.digital });
    await seedAlumni('b-5', { region_code: DICT.regions.baotou, industry_code: DICT.industries.energy });

    const byRegion = await request(app.getHttpServer())
      .get('/api/v1/directory?regionCode=' + DICT.regions.baotou)
      .set('Authorization', `Bearer ${viewer.accessToken}`)
      .expect(200);
    expect(byRegion.body.data.items).toHaveLength(1);
    expect(byRegion.body.data.items[0].regionCode).toBe(DICT.regions.baotou);

    const byIndustry = await request(app.getHttpServer())
      .get('/api/v1/directory?industryCode=' + DICT.industries.digital)
      .set('Authorization', `Bearer ${viewer.accessToken}`)
      .expect(200);
    expect(byIndustry.body.data.items).toHaveLength(1);
    expect(byIndustry.body.data.items[0].industryCode).toBe(DICT.industries.digital);
  });

  it('未公开资料的详情不可访问（不泄露存在性）', async () => {
    const viewer = await seedAlumni('viewer-6');
    const hidden = await seedAlumni('hidden-6', { show_in_directory: 0 });

    await request(app.getHttpServer())
      .get(`/api/v1/directory/${hidden.userId}`)
      .set('Authorization', `Bearer ${viewer.accessToken}`)
      .expect(404);
  });
});
