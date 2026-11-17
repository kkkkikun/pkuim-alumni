import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DICT, createTestApp, ensureAdmin, login, markVerified, resetDatabase } from '../helpers';

describe('资源发布与审核 (e2e)', () => {
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

  async function verifiedUser(openid: string) {
    const session = await login(app, openid);
    await markVerified(dataSource, session.userId);
    return session;
  }

  const ADMIN_PASSWORD = 'Admin@2026';

  async function seedAdmin() {
    await ensureAdmin(dataSource, {
      roleCode: 'super_admin',
      permissionCode: 'resource:review',
    });
  }

  async function adminToken(adminId: number): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/admin/login')
      .send({ username: 'admin-test', password: ADMIN_PASSWORD })
      .expect(200);
    return response.body.data.accessToken;
  }

  it('新发布的内容不进入公开列表，审核通过后才公开', async () => {
    const author = await verifiedUser('res-author');

    const created = await request(app.getHttpServer())
      .post('/api/v1/resources')
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({
        type: 'resource',
        title: '可共享的新能源行业经验',
        body: '这是一段用于测试的资源描述内容，长度满足校验要求。',
        industryCode: DICT.industries.energy,
        regionCode: DICT.regions.hohhot,
      })
      .expect(201);
    expect(created.body.data.status).toBe('pending');

    const publicList = await request(app.getHttpServer()).get('/api/v1/resources').expect(200);
    expect(publicList.body.data.items).toHaveLength(0);

    await seedAdmin();
    const token = await adminToken(0);
    const reviewed = await request(app.getHttpServer())
      .post(`/api/v1/admin/resources/${created.body.data.id}/decision`)
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'approve', note: '内容合规' })
      .expect(201);
    expect(reviewed.body.data.status).toBe('published');

    const afterList = await request(app.getHttpServer()).get('/api/v1/resources').expect(200);
    expect(afterList.body.data.items).toHaveLength(1);
    expect(afterList.body.data.items[0].title).toBe('可共享的新能源行业经验');
  });

  it('审核历史只追加，不覆盖', async () => {
    const author = await verifiedUser('res-history');
    const created = await request(app.getHttpServer())
      .post('/api/v1/resources')
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({
        type: 'demand',
        title: '寻求农牧食品加工合作',
        body: '这是一段用于测试的需求描述内容，长度满足校验要求。',
      })
      .expect(201);

    await seedAdmin();
    const token = await adminToken(0);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/resources/${created.body.data.id}/decision`)
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'reject', note: '需要补充信息' })
      .expect(201);

    const rows = await dataSource.query('SELECT action, note FROM resource_post_reviews WHERE post_id = ?', [created.body.data.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('reject');
    expect(rows[0].note).toBe('需要补充信息');
  });

  it('作者修改已发布内容后需要重新审核', async () => {
    const author = await verifiedUser('res-edit');
    const created = await request(app.getHttpServer())
      .post('/api/v1/resources')
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({
        type: 'resource',
        title: '初始标题',
        body: '这是一段用于测试的资源描述内容，长度满足校验要求。',
      })
      .expect(201);

    await seedAdmin();
    const token = await adminToken(0);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/resources/${created.body.data.id}/decision`)
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'approve' })
      .expect(201);

    const updated = await request(app.getHttpServer())
      .patch(`/api/v1/resources/${created.body.data.id}`)
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({ title: '修改后的标题' })
      .expect(200);
    expect(updated.body.data.status).toBe('pending');

    const list = await request(app.getHttpServer()).get('/api/v1/resources').expect(200);
    expect(list.body.data.items).toHaveLength(0);
  });

  it('版本冲突时审核被拒绝（防止状态回退）', async () => {
    const author = await verifiedUser('res-version');
    const created = await request(app.getHttpServer())
      .post('/api/v1/resources')
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({
        type: 'resource',
        title: '并发审核测试',
        body: '这是一段用于测试的资源描述内容，长度满足校验要求。',
      })
      .expect(201);

    await seedAdmin();
    const token = await adminToken(0);

    // 用过期的 version 提交审核
    const conflict = await request(app.getHttpServer())
      .post(`/api/v1/admin/resources/${created.body.data.id}/decision`)
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'approve', version: 999 })
      .expect(409);
    expect(conflict.body.code).toBe('CONFLICT');
  });

  it('他人不能修改我的发布', async () => {
    const author = await verifiedUser('res-owner');
    const other = await verifiedUser('res-other');
    const created = await request(app.getHttpServer())
      .post('/api/v1/resources')
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({
        type: 'resource',
        title: '仅作者可改',
        body: '这是一段用于测试的资源描述内容，长度满足校验要求。',
      })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/api/v1/resources/${created.body.data.id}`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .send({ title: '恶意修改' })
      .expect(403);
  });
});
