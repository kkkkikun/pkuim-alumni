import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTestApp, login, markVerified, resetDatabase } from '../helpers';

/**
 * **已登录端点的可见性口径**：403 与 404 的分界（第十二轮）。
 *
 * 背景：
 *   `docs/API-SPEC.md` 第 13.2 节把两种失败语义分得很清楚：
 *     - **不可见 → 404**：「这个对象对你不存在」（不泄露存在性）；
 *     - **无权 → 403**：「对象存在，但你没有权限」（只是**不是你的**）。
 *   第十一轮把**公开**读端点这一半做成了自动化（`public-read-visibility.e2e-spec.ts`
 *   + `infra/scripts/check-read-visibility.mjs`），**已登录**端点这一半此前
 *   只有人工抽查 —— 而它恰恰是最容易改坏的一半：把「不是你的」从 403 改成 404
 *   （或反过来）会改变客户端的引导逻辑，**却没有任何机制会报警**。
 *
 * 本套件是那一半的**运行时**防线（静态那一层是 `check-read-visibility.mjs`）：
 *   真的起一个应用、真的写库造出对象、真的用**另一个登录用户**去请求，
 *   断言客户端拿到的**状态码**与文档写的一致。
 *
 * ⚠️ 本套件**钉住现状**，不认可现状：
 *   「无权 → 403」「不可见 → 404」是 `docs/API-SPEC.md` 第 13.2 节写明的口径；
 *   一旦有人改坏（或产品拍板后改了），这些用例会红 ——
 *   那正是提醒同步 API-SPEC / KNOWN-ISSUES / 校验器登记表的时刻。
 */
const API = '/api/v1';

describe('已登录端点的可见性口径：403 与 404 的分界（第十二轮）', () => {
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

  /** 取最近一次 INSERT 的自增 id（不同驱动返回结构不一致，LAST_INSERT_ID() 最稳）。 */
  const lastInsertId = async (): Promise<number> => {
    const rows = await dataSource.query('SELECT LAST_INSERT_ID() AS id');
    return Number((rows[0] as { id?: number | string } | undefined)?.id ?? 0);
  };

  /** 造一个**已认证**校友（`@RequireAlumniStage('verified')` 需要 stage='verified'）。 */
  const createVerifiedAlumni = async (openid: string): Promise<{ userId: number; token: string }> => {
    const session = await login(app, openid);
    await markVerified(dataSource, session.userId);
    return { userId: session.userId, token: session.accessToken };
  };

  const insertConnectionPair = async (
    userAId: number,
    userBId: number,
    status: 'active' | 'revoked',
  ): Promise<number> => {
    await dataSource.query(
      `INSERT INTO connection_pairs (user_a_id, user_b_id, status, established_at, revoked_at, version)
       VALUES (?, ?, ?, NOW(3), ?, 0)`,
      [userAId, userBId, status, status === 'revoked' ? new Date() : null],
    );
    return lastInsertId();
  };

  const insertConnectionRequest = async (
    fromUserId: number,
    toUserId: number,
    status: 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired',
  ): Promise<number> => {
    await dataSource.query(
      `INSERT INTO connection_request_history
         (from_user_id, to_user_id, pair_key, pending_guard, message, status)
       VALUES (?, ?, ?, NULL, '申请留言', ?)`,
      [fromUserId, toUserId, `${Math.min(fromUserId, toUserId)}:${Math.max(fromUserId, toUserId)}`, status],
    );
    return lastInsertId();
  };

  const insertVerificationApplication = async (userId: number): Promise<number> => {
    await dataSource.query(
      `INSERT INTO verification_applications
         (user_id, real_name, college, graduation_year, status, submitted_at)
       VALUES (?, '张三', '信息学院', 2015, 'pending', NOW(3))`,
      [userId],
    );
    return lastInsertId();
  };

  const insertNotification = async (userId: number): Promise<number> => {
    await dataSource.query(
      `INSERT INTO notifications (user_id, type, title, body)
       VALUES (?, 'system', '测试通知', '通知正文')`,
      [userId],
    );
    return lastInsertId();
  };

  const insertResource = async (authorId: number, status: string): Promise<number> => {
    await dataSource.query(
      `INSERT INTO resource_posts (author_id, type, title, body, status, version, published_at)
       VALUES (?, 'resource', '可见性测试资源', '正文', ?, 0, ?)`,
      [authorId, status, status === 'published' ? new Date() : null],
    );
    return lastInsertId();
  };

  const insertMediaAsset = async (
    uploaderId: number,
    visibility: 'public' | 'private',
  ): Promise<number> => {
    await dataSource.query(
      `INSERT INTO media_assets (file_name, mime_type, size, bucket, object_key, visibility, uploader_id)
       VALUES ('test.pdf', 'application/pdf', 1, 'nmg', 'test/test.pdf', ?, ?)`,
      [visibility, uploaderId],
    );
    return lastInsertId();
  };

  /** 造一个**未认证**校友（`stage='logged_in'`）—— 通讯录里**看不见**。 */
  const insertUnverifiedAlumni = async (openid: string): Promise<number> => {
    await dataSource.query(
      `INSERT INTO users (openid, nickname, source, status, stage, created_at, updated_at)
       VALUES (?, ?, 'mock', 'active', 'logged_in', NOW(3), NOW(3))`,
      [openid, `未认证校友${openid}`],
    );
    const userId = await lastInsertId();
    await dataSource.query(
      `INSERT INTO alumni_profiles (user_id, display_name, college, verified, show_in_directory)
       VALUES (?, ?, '信息学院', 0, 1)`,
      [userId, `未认证校友${openid}`],
    );
    return userId;
  };

  /* --------------------------- 连接关系 --------------------------- */

  it('连接详情：不是关系双方 → 403 FORBIDDEN（对象存在，只是不是你的）', async () => {
    const owner = await createVerifiedAlumni('conn-owner');
    const partner = await createVerifiedAlumni('conn-partner');
    const stranger = await createVerifiedAlumni('conn-stranger');
    const pairId = await insertConnectionPair(owner.userId, partner.userId, 'active');

    const response = await server()
      .get(`${API}/connections/${pairId}`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .expect(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('连接详情：不存在 → 404 NOT_FOUND', async () => {
    const user = await createVerifiedAlumni('conn-missing');
    const response = await server()
      .get(`${API}/connections/999999999`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('连接详情：关系**已解除** → 404（不泄露「这条关系存在过」）', async () => {
    const owner = await createVerifiedAlumni('conn-revoked-owner');
    const partner = await createVerifiedAlumni('conn-revoked-partner');
    const pairId = await insertConnectionPair(owner.userId, partner.userId, 'revoked');

    const response = await server()
      .get(`${API}/connections/${pairId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  /* --------------------------- 联系申请 --------------------------- */

  it('联系申请详情：不是申请双方 → 403 FORBIDDEN', async () => {
    const sender = await createVerifiedAlumni('req-sender');
    const receiver = await createVerifiedAlumni('req-receiver');
    const stranger = await createVerifiedAlumni('req-stranger');
    const requestId = await insertConnectionRequest(sender.userId, receiver.userId, 'pending');

    const response = await server()
      .get(`${API}/connections/requests/${requestId}`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .expect(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('联系申请详情：发起方看得到自己的申请 → 200', async () => {
    const sender = await createVerifiedAlumni('req-sender-2');
    const receiver = await createVerifiedAlumni('req-receiver-2');
    const requestId = await insertConnectionRequest(sender.userId, receiver.userId, 'pending');

    await server()
      .get(`${API}/connections/requests/${requestId}`)
      .set('Authorization', `Bearer ${sender.token}`)
      .expect(200);
  });

  /* --------------------------- 校友认证 --------------------------- */

  it('认证申请详情：不是本人 → 403 FORBIDDEN', async () => {
    const owner = await createVerifiedAlumni('ver-owner');
    const stranger = await createVerifiedAlumni('ver-stranger');
    const applicationId = await insertVerificationApplication(owner.userId);

    const response = await server()
      .get(`${API}/alumni/verification/${applicationId}`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .expect(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('认证申请详情：本人看得到自己的申请 → 200', async () => {
    const owner = await createVerifiedAlumni('ver-owner-2');
    const applicationId = await insertVerificationApplication(owner.userId);

    await server()
      .get(`${API}/alumni/verification/${applicationId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
  });

  it('认证申请详情：不存在 → 404 NOT_FOUND', async () => {
    const user = await createVerifiedAlumni('ver-missing');
    const response = await server()
      .get(`${API}/alumni/verification/999999999`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  /* --------------------------- 资源（发布方） --------------------------- */

  it('修改资源：不是作者 → 403 FORBIDDEN', async () => {
    const author = await createVerifiedAlumni('res-author');
    const stranger = await createVerifiedAlumni('res-stranger');
    const postId = await insertResource(author.userId, 'published');

    const response = await server()
      .patch(`${API}/resources/${postId}`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .send({ title: '越权改标题' })
      .expect(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('修改资源：内容不存在 → 404 NOT_FOUND', async () => {
    const user = await createVerifiedAlumni('res-missing');
    const response = await server()
      .patch(`${API}/resources/999999999`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: '改一个不存在的资源' })
      .expect(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  /* --------------------------- 通知与附件 --------------------------- */

  it('通讯录详情：未认证的校友 → 404 NOT_FOUND（不区分「不存在」与「不可见」）', async () => {
    const requester = await createVerifiedAlumni('dir-requester');
    const targetId = await insertUnverifiedAlumni('dir-target');

    const response = await server()
      .get(`${API}/directory/${targetId}`)
      .set('Authorization', `Bearer ${requester.token}`)
      .expect(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('通知详情：别人的通知 → 404 NOT_FOUND（按 id + userId 查，查不到即 404）', async () => {
    const owner = await createVerifiedAlumni('notif-owner');
    const stranger = await createVerifiedAlumni('notif-stranger');
    const notificationId = await insertNotification(owner.userId);

    const response = await server()
      .get(`${API}/notifications/${notificationId}`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .expect(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('附件地址：别人的**私有**资产 → 404 NOT_FOUND（不泄露「该文件存在」）', async () => {
    const owner = await createVerifiedAlumni('asset-owner');
    const stranger = await createVerifiedAlumni('asset-stranger');
    const assetId = await insertMediaAsset(owner.userId, 'private');

    const response = await server()
      .get(`${API}/uploads/${assetId}/url`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .expect(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });
});
