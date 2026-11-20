/**
 * 隐私相关的「文档承诺 → 代码落实」用例（docs/SECURITY.md 第 3 节）。
 *
 * 覆盖两条此前**只写在文档里、代码没有落实**的承诺：
 *   1. 第 3 节第 6 条「**学号脱敏存储**（`student_id_masked`）」——
 *      此前服务端完全不脱敏，客户端传完整学号就原样落库；
 *   2. 第 3 节第 6 条「**证明材料存私有桶**」——
 *      此前 `visibility` 完全由客户端决定，证明材料可以被放进 public 桶
 *      （那个桶里的对象拿到地址就能下载）。
 *
 * 两条都是**负向验证**：证明「不满足条件的东西进不来/存不下」。
 *
 * ⚠️ 每个用例都用**全新的用户**：`POST /alumni/verification` 对同一用户只允许
 *    有一份进行中的申请（重复提交返回 409），共用一个用户会让后面的用例互相干扰。
 */

import request from 'supertest';
import type { DataSource } from 'typeorm';
import { createTestApp, ensureAdmin, login, resetDatabase } from '../helpers';

const API = '/api/v1';

describe('隐私硬化 · 学号脱敏与证明材料私有桶', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>['app'];
  let dataSource: DataSource;
  let adminToken: string;
  let userToken: string;
  let userId: number;
  let userSeq = 0;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    await ensureAdmin(dataSource);
    const adminLogin = await request(app.getHttpServer())
      .post(`${API}/auth/admin/login`)
      .send({ username: 'admin-test', password: 'Admin@2026' })
      .expect(200);
    adminToken = adminLogin.body.data.accessToken;

    userSeq += 1;
    const user = await login(app, `mock:privacy-user-${userSeq}`, `隐私测试用户${userSeq}`);
    userToken = user.accessToken;
    userId = user.userId;
  });

  describe('学号脱敏存储', () => {
    const rawStudentId = '201531012345';

    it('提交完整学号 → 落库的是脱敏值，不是明文', async () => {
      const response = await request(app.getHttpServer())
        .post(`${API}/alumni/verification`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          realName: '张三',
          college: '信息科学技术学院',
          graduationYear: 2015,
          degree: '本科',
          studentIdMasked: rawStudentId,
        })
        .expect(201);

      // 保留首尾各 2 位，中间全是 `*`。
      expect(response.body.data.studentIdMasked).not.toBe(rawStudentId);
      expect(response.body.data.studentIdMasked).toBe('20********45');

      const rows = await dataSource.query(
        'SELECT student_id_masked AS masked FROM verification_applications WHERE user_id = ?',
        [userId],
      );
      expect(rows).toHaveLength(1);
      expect(String(rows[0].masked)).not.toBe(rawStudentId);
      expect(String(rows[0].masked)).toContain('*');
    });

    it('库里不能检索到完整学号（负向验证）', async () => {
      await request(app.getHttpServer())
        .post(`${API}/alumni/verification`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          realName: '张三',
          college: '信息科学技术学院',
          graduationYear: 2015,
          degree: '本科',
          studentIdMasked: rawStudentId,
        })
        .expect(201);

      const rows = await dataSource.query(
        'SELECT COUNT(*) AS c FROM verification_applications WHERE student_id_masked LIKE ?',
        [`%${rawStudentId}%`],
      );
      expect(Number(rows[0].c)).toBe(0);
    });

    it('管理员用完整学号搜索仍能命中（脱敏后照样查得到）', async () => {
      await request(app.getHttpServer())
        .post(`${API}/alumni/verification`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          realName: '张三',
          college: '信息科学技术学院',
          graduationYear: 2015,
          degree: '本科',
          studentIdMasked: rawStudentId,
        })
        .expect(201);

      const response = await request(app.getHttpServer())
        .get(`${API}/admin/verifications?keyword=${encodeURIComponent(rawStudentId)}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.data.items.length).toBeGreaterThan(0);
    });
  });

  describe('证明材料必须存私有桶', () => {
    async function registerMedia(visibility: 'public' | 'private'): Promise<number> {
      const response = await request(app.getHttpServer())
        .post(`${API}/uploads/records`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          fileName: 'proof.jpg',
          mimeType: 'image/jpeg',
          size: 1024,
          visibility,
        })
        .expect(201);
      return response.body.data.id as number;
    }

    it('公开桶的文件被当作证明材料引用 → 400（负向验证）', async () => {
      const mediaId = await registerMedia('public');
      const response = await request(app.getHttpServer())
        .post(`${API}/alumni/verification`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          realName: '李四',
          college: '信息科学技术学院',
          graduationYear: 2016,
          degree: '本科',
          studentIdMasked: '201612345678',
          attachmentMediaIds: [mediaId],
        });

      expect(response.status).toBe(400);
      expect(String(response.body.message)).toContain('私有桶');
    });

    it('公开桶的文件不会被写进证明材料关联表', async () => {
      const mediaId = await registerMedia('public');
      await request(app.getHttpServer())
        .post(`${API}/alumni/verification`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          realName: '王五',
          college: '信息科学技术学院',
          graduationYear: 2017,
          degree: '本科',
          studentIdMasked: '201712345678',
          attachmentMediaIds: [mediaId],
        });

      const rows = await dataSource.query(
        'SELECT COUNT(*) AS c FROM verification_attachments WHERE media_id = ?',
        [mediaId],
      );
      expect(Number(rows[0].c)).toBe(0);
    });

    it('私有桶的文件可以被正常引用', async () => {
      const mediaId = await registerMedia('private');
      const response = await request(app.getHttpServer())
        .post(`${API}/alumni/verification`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          realName: '赵六',
          college: '信息科学技术学院',
          graduationYear: 2018,
          degree: '本科',
          studentIdMasked: '201812345678',
          attachmentMediaIds: [mediaId],
        })
        .expect(201);

      expect(response.body.data.attachments).toHaveLength(1);
      expect(response.body.data.attachments[0].mediaId).toBe(mediaId);
    });
  });
});
