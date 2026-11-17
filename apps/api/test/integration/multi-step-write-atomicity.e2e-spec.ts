import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, ensureAdmin, login, resetDatabase } from '../helpers';
import { AlumniVerificationService } from '../../src/modules/alumni/alumni.service';
import { MeService } from '../../src/modules/me/me.service';
import { ContentService } from '../../src/modules/content/content.service';

/**
 * 多步写的原子性（缺陷 #118 ~ #120）。
 *
 * 缺陷 #115（管理端账号与角色的多步写）暴露了一个通用形态：
 * **一个业务动作由多次写组成，但这些写不在同一个事务里**。
 * 本套件把仓库里剩下的三处同类问题一次找齐并钉死：
 *
 *   #118 认证「补交材料」是三步写：
 *        改申请状态 → 挂证明材料 → 改用户阶段。
 *        中途失败会留下**状态机不一致**的半成品：
 *        申请已经是「已补交」，但用户阶段还停在旧值（用户依然用不了认证功能），
 *        或者申请状态没变但材料挂上了。
 *   #119 个人资料保存是两步写：
 *        存资料 → 存联系方式（加密）。
 *        第二步失败会留下「名字改了、手机号没存」的结果 ——
 *        而接口返回 500，用户以为什么都没存。
 *   #120 资讯/公告详情用**整行 save** 实现浏览计数：
 *        读出整行 → 改 view_count → 整行写回。
 *        并发的管理端修改会被**这次浏览覆盖回旧值**（静默丢失更新）。
 *
 * 反过来也要防误伤：正常的补交、正常的资料保存、正常的浏览都必须照常成功。
 */
const API = '/api/v1';

describe('多步写的原子性 (e2e)', () => {
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

  /* ---------------------------- #118 补交材料 ---------------------------- */

  describe('#118 认证补交材料：三步写必须同生共死', () => {
    /** 提交申请 → 管理员要求补材料 → 返回申请 id */
    async function needsMoreMaterial(openid: string): Promise<{
      userId: number;
      token: string;
      applicationId: number;
    }> {
      const user = await login(app, openid);
      const submitted = await server()
        .post(`${API}/alumni/verification`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({
          realName: '待补充校友',
          college: '法学院',
          graduationYear: 2018,
          studentIdMasked: '2018****9999',
        })
        .expect(201);

      await ensureAdmin(dataSource, {
        roleCode: 'alumni_reviewer',
        permissionCode: 'verification:review',
      });
      const adminRes = await server()
        .post(`${API}/auth/admin/login`)
        .send({ username: 'admin-test', password: 'Admin@2026' })
        .expect(200);

      await server()
        .post(`${API}/admin/verifications/${submitted.body.data.id}/decision`)
        .set('Authorization', `Bearer ${adminRes.body.data.accessToken}`)
        .send({ action: 'request_changes', note: '请补充毕业证照片' })
        .expect(201);

      return {
        userId: user.userId,
        token: user.accessToken,
        applicationId: submitted.body.data.id as number,
      };
    }

    it('#118 最后一步失败 → 前两步必须整体回滚（申请状态不得变）', async () => {
      const { token, applicationId } = await needsMoreMaterial('atomic-resubmit');

      // 注入故障：改用户阶段这一步直接抛错。
      // ⚠️ 必须打在**仓储原型**上：事务里的仓储是 `manager.getRepository(User)`
      // 新建的另一个实例，只改注入实例上的方法**拦不住**事务内的那次写入。
      const service = app.get(AlumniVerificationService) as unknown as {
        users: { update: (...args: unknown[]) => Promise<unknown> };
      };
      const repoProto = Object.getPrototypeOf(service.users) as {
        update: (...args: unknown[]) => Promise<unknown>;
      };
      const original = repoProto.update;
      repoProto.update = async () => {
        throw new Error('注入故障：用户阶段更新失败');
      };
      try {
        await server()
          .put(`${API}/alumni/verification/${applicationId}/resubmit`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            realName: '待补充校友',
            college: '法学院',
            graduationYear: 2018,
            studentIdMasked: '2018****9999',
          })
          .expect(500);
      } finally {
        repoProto.update = original;
      }

      // 关键断言：申请状态必须回滚到「待补充材料」
      const rows = await dataSource.query(
        'SELECT status FROM verification_applications WHERE id = ?',
        [applicationId],
      );
      expect(rows[0].status).toBe('needs_more_material');
    });

    it('#118 对照：正常补交照常生效（状态推进 + 用户阶段回到待审核）', async () => {
      const { userId, token, applicationId } = await needsMoreMaterial('atomic-resubmit-ok');

      await server()
        .put(`${API}/alumni/verification/${applicationId}/resubmit`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          realName: '待补充校友',
          college: '法学院',
          graduationYear: 2018,
          studentIdMasked: '2018****9999',
        })
        .expect(200);

      const rows = await dataSource.query(
        'SELECT status FROM verification_applications WHERE id = ?',
        [applicationId],
      );
      expect(rows[0].status).toBe('resubmitted');

      const [stageRow] = await dataSource.query('SELECT stage FROM users WHERE id = ?', [userId]);
      expect(stageRow.stage).toBe('pending_review');
    });
  });

  /* ---------------------------- #119 个人资料 ---------------------------- */

  describe('#119 个人资料 + 联系方式必须同事务', () => {
    it('#119 联系方式写入失败 → 资料改动必须回滚', async () => {
      const user = await login(app, 'atomic-profile');

      const service = app.get(MeService) as unknown as {
        updateContact: (...args: unknown[]) => Promise<unknown>;
      };
      const original = service.updateContact.bind(service);
      service.updateContact = async () => {
        throw new Error('注入故障：联系方式写入失败');
      };
      try {
        await server()
          .patch(`${API}/me/profile`)
          .set('Authorization', `Bearer ${user.accessToken}`)
          .send({ displayName: '半途而废的新名字', contactPhone: '13800000001' })
          .expect(500);
      } finally {
        service.updateContact = original;
      }

      const rows = await dataSource.query(
        'SELECT display_name FROM alumni_profiles WHERE user_id = ?',
        [user.userId],
      );
      expect(rows[0].display_name).not.toBe('半途而废的新名字');
    });

    it('#119 对照：正常保存照常生效（资料 + 联系方式都落库）', async () => {
      const user = await login(app, 'atomic-profile-ok');

      await server()
        .patch(`${API}/me/profile`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ displayName: '正常的新名字', contactPhone: '13800000002' })
        .expect(200);

      const rows = await dataSource.query(
        'SELECT display_name FROM alumni_profiles WHERE user_id = ?',
        [user.userId],
      );
      expect(rows[0].display_name).toBe('正常的新名字');

      const contacts = await dataSource.query(
        'SELECT phone_cipher FROM private_contacts WHERE user_id = ?',
        [user.userId],
      );
      expect(contacts).toHaveLength(1);
      expect(contacts[0].phone_cipher).toBeTruthy();
    });
  });

  /* ---------------------------- #120 浏览计数 ---------------------------- */

  describe('#120 浏览计数只能动计数列，不能整行写回', () => {
    async function insertPublishedArticle(title: string): Promise<number> {
      await dataSource.query(
        `INSERT INTO articles
           (title, summary, body, status, published_at, view_count, version, created_at, updated_at)
         VALUES (?, '摘要', '正文', 'published', NOW(3), 5, 0, NOW(3), NOW(3))`,
        [title],
      );
      const rows = await dataSource.query('SELECT id FROM articles WHERE title = ?', [title]);
      return Number(rows[0].id);
    }

    it('#120 浏览详情不得覆盖并发中的管理端修改', async () => {
      const articleId = await insertPublishedArticle('原标题');

      const service = app.get(ContentService) as unknown as {
        articles: { findOne: (...args: unknown[]) => Promise<unknown> };
      };
      const repo = service.articles;
      const original = repo.findOne.bind(repo);
      // 模拟并发：读到文章之后、管理端恰好改了标题
      repo.findOne = async (...args: unknown[]) => {
        const result = (await original(...args)) as { id?: number } | null;
        if (result && result.id === articleId) {
          await dataSource.query('UPDATE articles SET title = ? WHERE id = ?', [
            '并发改的标题',
            articleId,
          ]);
        }
        return result;
      };
      try {
        await server().get(`${API}/articles/${articleId}`).expect(200);
      } finally {
        repo.findOne = original;
      }

      const rows = await dataSource.query(
        'SELECT title, view_count FROM articles WHERE id = ?',
        [articleId],
      );
      // 关键断言：并发中的标题必须还在（不能被这次浏览覆盖回旧值）
      expect(rows[0].title).toBe('并发改的标题');
      // 浏览计数照常累加
      expect(Number(rows[0].view_count)).toBe(6);
    });

    it('#120 对照：正常浏览只让计数 +1，且不刷新「更新时间」', async () => {
      const articleId = await insertPublishedArticle('正常浏览的标题');
      const before = await dataSource.query(
        'SELECT updated_at FROM articles WHERE id = ?',
        [articleId],
      );

      const response = await server().get(`${API}/articles/${articleId}`).expect(200);
      expect(response.body.data.viewCount).toBe(6);

      const rows = await dataSource.query(
        'SELECT title, view_count, updated_at FROM articles WHERE id = ?',
        [articleId],
      );
      expect(rows[0].title).toBe('正常浏览的标题');
      expect(Number(rows[0].view_count)).toBe(6);
      // 浏览不是「编辑」：更新时间不得被刷新
      expect(String(rows[0].updated_at)).toBe(String(before[0].updated_at));
    });
  });
});
