import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, ensureAdmin, login, resetDatabase } from '../helpers';

const ADMIN_PASSWORD = 'Admin@2026';

describe('校友身份认证 · 提交与审核 (e2e)', () => {
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

  async function seedAdmin(): Promise<void> {
    await ensureAdmin(dataSource, {
      roleCode: 'alumni_reviewer',
      permissionCode: 'verification:review',
    });
  }

  async function adminToken(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/admin/login')
      .send({ username: 'admin-test', password: ADMIN_PASSWORD })
      .expect(200);
    return response.body.data.accessToken;
  }

  it('完整流程：提交认证 → 管理员审核通过 → 获得校友权限', async () => {
    const user = await login(app, 'verify-user');

    // 未认证时不能使用通讯录
    await request(app.getHttpServer())
      .get('/api/v1/directory')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(403);

    const submitted = await request(app.getHttpServer())
      .post('/api/v1/alumni/verification')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        realName: '测试校友',
        college: '经济学院',
        graduationYear: 2015,
        degree: '学士',
        studentIdMasked: '2015****1234',
        remark: '测试用虚构资料',
      })
      .expect(201);
    expect(submitted.body.data.status).toBe('pending');

    // 用户进入待审核状态
    const [stageRow] = await dataSource.query('SELECT stage FROM users WHERE id = ?', [user.userId]);
    expect(stageRow.stage).toBe('pending_review');

    await seedAdmin();
    const token = await adminToken();

    const queue = await request(app.getHttpServer())
      .get('/api/v1/admin/verifications?status=pending')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(queue.body.data.items).toHaveLength(1);

    const decided = await request(app.getHttpServer())
      .post(`/api/v1/admin/verifications/${submitted.body.data.id}/decision`)
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'approve', note: '资料核验通过' })
      .expect(201);
    expect(decided.body.data.status).toBe('approved');

    // 用户升级为已认证校友
    const [after] = await dataSource.query('SELECT stage FROM users WHERE id = ?', [user.userId]);
    expect(after.stage).toBe('verified');
    const [profile] = await dataSource.query(
      'SELECT verified, real_name, college FROM alumni_profiles WHERE user_id = ?',
      [user.userId],
    );
    expect(Number(profile.verified)).toBe(1);
    expect(profile.real_name).toBe('测试校友');

    // 现在可以访问通讯录
    await request(app.getHttpServer())
      .get('/api/v1/directory')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    // 审核历史只追加
    const reviews = await dataSource.query(
      'SELECT action, note FROM verification_reviews WHERE application_id = ?',
      [submitted.body.data.id],
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0].action).toBe('approve');
  });

  it('要求补充材料后用户状态回到未认证，可重新提交', async () => {
    const user = await login(app, 'verify-user-2');
    const submitted = await request(app.getHttpServer())
      .post('/api/v1/alumni/verification')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        realName: '待补充校友',
        college: '法学院',
        graduationYear: 2018,
        studentIdMasked: '2018****9999',
      })
      .expect(201);

    await seedAdmin();
    const token = await adminToken();

    await request(app.getHttpServer())
      .post(`/api/v1/admin/verifications/${submitted.body.data.id}/decision`)
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'request_changes', note: '请补充毕业证照片' })
      .expect(201);

    const [stageRow] = await dataSource.query('SELECT stage FROM users WHERE id = ?', [user.userId]);
    expect(stageRow.stage).toBe('logged_in');

    const resubmitted = await request(app.getHttpServer())
      .put(`/api/v1/alumni/verification/${submitted.body.data.id}/resubmit`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        realName: '待补充校友',
        college: '法学院',
        graduationYear: 2018,
        studentIdMasked: '2018****9999',
      })
      .expect(200);
    expect(resubmitted.body.data.status).toBe('resubmitted');

    const reviews = await dataSource.query(
      'SELECT action FROM verification_reviews WHERE application_id = ? ORDER BY id ASC',
      [submitted.body.data.id],
    );
    expect(reviews).toHaveLength(1);
  });

  it('GET /alumni/verification/mine 返回我的认证申请列表', async () => {
    const user = await login(app, 'verify-mine');
    const submitted = await request(app.getHttpServer())
      .post('/api/v1/alumni/verification')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        realName: '我的认证记录',
        college: '工学院',
        graduationYear: 2013,
        studentIdMasked: '2013****7777',
      })
      .expect(201);

    const mine = await request(app.getHttpServer())
      .get('/api/v1/alumni/verification/mine')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    // ⚠️ 第三轮：`/alumni/verification/mine` 从「裸数组（全部申请、无上限）」
    //    改为 `{items, meta}` 分页结构。
    expect(mine.body.data.items).toHaveLength(1);
    expect(mine.body.data.items[0].id).toBe(submitted.body.data.id);
    expect(mine.body.data.items[0].status).toBe('pending');
    expect(mine.body.data.meta.total).toBe(1);
  });

  it('同一用户不能同时提交两条进行中的认证', async () => {
    const user = await login(app, 'verify-user-3');
    const body = {
      realName: '重复提交',
      college: '工学院',
      graduationYear: 2012,
      studentIdMasked: '2012****1111',
    };
    await request(app.getHttpServer())
      .post('/api/v1/alumni/verification')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send(body)
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/alumni/verification')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send(body)
      .expect(409);
  });
});
