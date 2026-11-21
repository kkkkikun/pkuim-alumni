import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError, Repository } from 'typeorm';
import { AuthService } from '../../src/auth/auth.service';
import { createTestApp, login, markVerified, resetDatabase, setProfile } from '../helpers';

/**
 * 用户侧**写操作**的错误语义对账（第九轮）。
 *
 * 背景：
 *   管理端那一侧在第八轮钉死了（缺陷 #190：分类 slug 重复此前返回 500）。
 *   用户侧（校友本人）的写端点此前**逐条都没核过** ——
 *   连接申请、联系方式授权、活动报名、资源附件、认证附件、
 *   用户 openid / unionid、会话 refreshToken……
 *
 *   口径与 API-SPEC「用户侧写操作的错误语义」一致：
 *     - 400 参数问题（`VALIDATION_ERROR`）
 *     - 404 对象不存在（`NOT_FOUND`）
 *     - 409 冲突（`CONFLICT`）—— **唯一键冲突必须落到这里**
 *     - 幂等命中 → 200（同一个动作重复提交**不是错误**）
 *   并明确禁止：把数据库异常直接抛成 500。
 *
 * ⚠️ 怎么稳定地制造「撞唯一键」？
 *   真并发（两个请求同时插同一行）在测试里是**偶发**的 ——
 *   写用例时靠「碰运气」拿到冲突，跑十次可能只红一次，那不叫回归防线。
 *   所以这里用**故障注入**代替运气：
 *   让持久层在写指定实体时抛出**真实的重复键错误**
 *   （`QueryFailedError` + `ER_DUP_ENTRY` / `errno=1062`，
 *   与 MySQL 驱动抛出来的形态一致），
 *   然后断言端点给出的是 **409 `CONFLICT`**，而不是 500。
 *   注入只影响被点名的实体，其余读写照常走真实数据库。
 */
const API = '/api/v1';

describe('用户侧写操作的错误语义（第九轮）', () => {
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

  /* ------------------------------ 工具 ------------------------------ */

  /** 构造一个与 MySQL 驱动形态一致的重复键错误。 */
  const duplicateKeyError = (): QueryFailedError => {
    const driverError = Object.assign(
      new Error("Duplicate entry 'x' for key 'users.uk_users_openid'"),
      { code: 'ER_DUP_ENTRY', errno: 1062 },
    );
    return new QueryFailedError('INSERT ...', [], driverError);
  };

  /**
   * 让持久层在写指定实体时抛重复键错误。
   *
   * ⚠️ `Repository.save` 与 `EntityManager.save` **都要打**：
   *    业务代码两种写法都有（`repo.save(...)` 与 `manager.save(...)`），
   *    只打一个的话，另���条路径的注入会「没生效」——
   *    用例照样绿，但根本没测到东西。
   */
  function simulateDuplicateKey(entityNames: string[]): () => void {
    const targets = new Set(entityNames);
    const originalRepositorySave = Repository.prototype.save;
    const originalManagerSave = EntityManager.prototype.save;
    const isTarget = (entity: unknown): boolean => {
      const list = Array.isArray(entity) ? entity : [entity];
      return list.some(
        (item) => targets.has((item as { constructor?: { name?: string } })?.constructor?.name ?? ''),
      );
    };
    const repositorySpy = jest
      .spyOn(Repository.prototype, 'save')
      .mockImplementation(async function (this: Repository<object>, entity: unknown, ...rest: unknown[]) {
        if (isTarget(entity)) throw duplicateKeyError();
        return (originalRepositorySave as (...args: unknown[]) => Promise<unknown>).call(
          this,
          entity,
          ...rest,
        );
      });
    const managerSpy = jest
      .spyOn(EntityManager.prototype, 'save')
      .mockImplementation(async function (this: EntityManager, entity: unknown, ...rest: unknown[]) {
        if (isTarget(entity)) throw duplicateKeyError();
        return (originalManagerSave as (...args: unknown[]) => Promise<unknown>).call(
          this,
          entity,
          ...rest,
        );
      });
    return () => {
      repositorySpy.mockRestore();
      managerSpy.mockRestore();
    };
  }

  /** 建一个「已认证 + 接受联系申请 + 允许共享联系方式」的校友。 */
  async function seedAlumni(openid: string) {
    const session = await login(app, openid);
    await markVerified(dataSource, session.userId);
    await setProfile(dataSource, session.userId, {
      display_name: `校友-${openid}`,
      show_in_directory: 1,
      accept_contact_requests: 1,
      allow_contact_share: 1,
    });
    return session;
  }

  async function createEvent(capacity = 5): Promise<number> {
    await dataSource.query(
      `INSERT INTO events (title, kind, capacity, registered_count, status, created_at, updated_at)
       VALUES ('语义对账活动', '校友交流', ?, 0, 'published', NOW(3), NOW(3))`,
      [capacity],
    );
    const [row] = await dataSource.query('SELECT id FROM events ORDER BY id DESC LIMIT 1');
    return Number(row.id);
  }

  /** 直接登记一条「本人上传」的媒体资产（附件归属校验只看这张表）。 */
  async function createMediaAsset(uploaderId: number, visibility = 'private'): Promise<number> {
    const objectKey = `semantics/${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`;
    await dataSource.query(
      `INSERT INTO media_assets (file_name, mime_type, size, bucket, object_key, visibility, uploader_id, created_at)
       VALUES ('proof.pdf', 'application/pdf', 1024, 'nmg-private', ?, ?, ?, NOW(3))`,
      [objectKey, visibility, uploaderId],
    );
    const [row] = await dataSource.query('SELECT id FROM media_assets WHERE object_key = ?', [
      objectKey,
    ]);
    return Number(row.id);
  }

  /* ------------------------- 幂等：重复提交不是错误 ------------------------- */

  it('重复提交同一对用户的联系申请 → 幂等返回既有申请（200，不是 409/500）', async () => {
    const a = await seedAlumni('idem-a');
    const b = await seedAlumni('idem-b');

    const first = await server()
      .post(`${API}/connections/requests`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ targetUserId: b.userId, message: '希望交流行业经验' })
      .expect(201);
    expect(first.body.data.idempotent).toBe(false);

    const second = await server()
      .post(`${API}/connections/requests`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ targetUserId: b.userId, message: '希望交流行业经验' });

    expect(second.status).toBe(200);
    expect(second.body.data.idempotent).toBe(true);
    expect(second.body.data.id).toBe(first.body.data.id);

    const [rows] = await dataSource.query(
      'SELECT COUNT(*) AS c FROM connection_request_history WHERE from_user_id = ? AND to_user_id = ?',
      [a.userId, b.userId],
    );
    expect(Number(rows.c)).toBe(1);
  });

  it('重复设置联系方式授权 → 幂等（200），库里只有一条授权行', async () => {
    const a = await seedAlumni('grant-a');
    const b = await seedAlumni('grant-b');
    const created = await server()
      .post(`${API}/connections/requests`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ targetUserId: b.userId, message: '希望建立联系' })
      .expect(201);
    await server()
      .post(`${API}/connections/requests/${created.body.data.id}/accept`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(201);
    const list = await server()
      .get(`${API}/connections`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(200);
    const pairId = list.body.data.items[0].id;

    await server()
      .put(`${API}/connections/${pairId}/contact-grant`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ allow: true })
      .expect(200);
    const again = await server()
      .put(`${API}/connections/${pairId}/contact-grant`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ allow: true });
    expect(again.status).toBe(200);
    expect(again.status).toBeLessThan(500);

    const [rows] = await dataSource.query(
      'SELECT COUNT(*) AS c FROM contact_share_grants WHERE pair_id = ?',
      [pairId],
    );
    expect(Number(rows.c)).toBe(1);
  });

  it('同一活动重复报名 → 幂等（200 + idempotent），只产生一条报名记录', async () => {
    const eventId = await createEvent();
    const user = await seedAlumni('event-idem');

    await server()
      .post(`${API}/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({})
      .expect(201);
    const again = await server()
      .post(`${API}/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({});
    expect(again.status).toBe(200);
    expect(again.body.data.idempotent).toBe(true);

    const [rows] = await dataSource.query(
      'SELECT COUNT(*) AS c FROM event_registrations WHERE event_id = ? AND user_id = ?',
      [eventId, user.userId],
    );
    expect(Number(rows.c)).toBe(1);
  });

  it('并发首登同一 openid → 两个请求都成功，库里只有一个用户（不得 500）', async () => {
    const responses = await Promise.all([
      server().post(`${API}/auth/mock/login`).send({ mockOpenid: 'race-openid' }),
      server().post(`${API}/auth/mock/login`).send({ mockOpenid: 'race-openid' }),
    ]);
    for (const response of responses) {
      expect(response.status).toBeLessThan(500);
      expect(response.status).toBe(200);
    }
    const [rows] = await dataSource.query('SELECT COUNT(*) AS c FROM users WHERE openid = ?', [
      'mock_race-openid',
    ]);
    expect(Number(rows.c)).toBe(1);
  });

  /* ------------------- 唯一键冲突：必须是 409，不得是 500 ------------------- */

  it('活动报名撞唯一键 → 409 CONFLICT（不得是 5xx），且名额计数回滚', async () => {
    const eventId = await createEvent(5);
    const user = await seedAlumni('event-dup');
    const restore = simulateDuplicateKey(['EventRegistration']);
    try {
      const response = await server()
        .post(`${API}/events/${eventId}/registrations`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({});
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONFLICT');
    } finally {
      restore();
    }
    // 冲突时事务整体回滚：名额没有被占用
    const [rows] = await dataSource.query('SELECT registered_count FROM events WHERE id = ?', [
      eventId,
    ]);
    expect(Number(rows.registered_count)).toBe(0);
  });

  it('联系申请撞唯一键且读不到既有申请 → 409 CONFLICT（不得是 5xx）', async () => {
    const a = await seedAlumni('req-dup-a');
    const b = await seedAlumni('req-dup-b');
    const restore = simulateDuplicateKey(['ConnectionRequestHistory']);
    try {
      const response = await server()
        .post(`${API}/connections/requests`)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({ targetUserId: b.userId, message: '这是撞上唯一键的申请' });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONFLICT');
    } finally {
      restore();
    }
  });

  it('联系方式授权撞唯一键且读不到既有行 → 409 CONFLICT（不得是 5xx）', async () => {
    const a = await seedAlumni('cg-dup-a');
    const b = await seedAlumni('cg-dup-b');
    const created = await server()
      .post(`${API}/connections/requests`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ targetUserId: b.userId, message: '希望建立联系' })
      .expect(201);
    await server()
      .post(`${API}/connections/requests/${created.body.data.id}/accept`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(201);
    const list = await server()
      .get(`${API}/connections`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(200);
    const pairId = list.body.data.items[0].id;

    const restore = simulateDuplicateKey(['ContactShareGrant']);
    try {
      const response = await server()
        .put(`${API}/connections/${pairId}/contact-grant`)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({ allow: true });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONFLICT');
    } finally {
      restore();
    }
  });

  it('资源附件撞唯一键 → 409 CONFLICT（不得是 5xx），内容不留下半成品', async () => {
    const user = await seedAlumni('res-dup');
    const mediaId = await createMediaAsset(user.userId);
    const restore = simulateDuplicateKey(['ResourcePostAttachment']);
    try {
      const response = await server()
        .post(`${API}/resources`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({
          type: 'resource',
          title: '带附件的资源发布',
          body: '这是一段用于错误语义对账的正文，长度满足最小长度要求。',
          attachmentMediaIds: [mediaId],
        });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONFLICT');
    } finally {
      restore();
    }
    const [posts] = await dataSource.query('SELECT COUNT(*) AS c FROM resource_posts');
    expect(Number(posts.c)).toBe(0);
  });

  it('认证附件撞唯一键 → 409 CONFLICT（不得是 5xx）', async () => {
    const user = await seedAlumni('ver-dup');
    const mediaId = await createMediaAsset(user.userId);
    const restore = simulateDuplicateKey(['VerificationAttachment']);
    try {
      const response = await server()
        .post(`${API}/alumni/verification`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({
          realName: '语义对账',
          college: '北京大学',
          graduationYear: 2015,
          studentIdMasked: '2015123456',
          attachmentMediaIds: [mediaId],
        });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONFLICT');
    } finally {
      restore();
    }
  });

  it('会话令牌撞唯一键 → 409 CONFLICT（不得是 5xx）', async () => {
    const restore = simulateDuplicateKey(['UserSession']);
    try {
      const response = await server()
        .post(`${API}/auth/mock/login`)
        .send({ mockOpenid: 'session-dup', nickname: '会话撞键' });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONFLICT');
    } finally {
      restore();
    }
  });

  it('用户行撞唯一键（重试耗尽）→ 409 CONFLICT（不得是 5xx）', async () => {
    const restore = simulateDuplicateKey(['User']);
    try {
      const response = await server()
        .post(`${API}/auth/mock/login`)
        .send({ mockOpenid: 'user-dup', nickname: '用户撞键' });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONFLICT');
    } finally {
      restore();
    }
  });

  it('同一个 unionid 已绑定另一个账号 → 409 CONFLICT（业务冲突，不是服务端故障）', async () => {
    await dataSource.query(
      `INSERT INTO users (openid, unionid, nickname, status, stage, source, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 'verified', 'mock', NOW(3), NOW(3))`,
      ['mock_union-owner', 'union-already-taken', '已占用', ],
    );
    const authService = app.get(AuthService, { strict: false });
    await expect(
      authService.issueUserLogin(
        {
          openid: 'mock_union-newcomer',
          unionid: 'union-already-taken',
          nickname: '后来者',
          source: 'mock',
        },
        null,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  /* --------------------------- 不存在 → 404 --------------------------- */

  it('给不存在的活动报名 → 404 NOT_FOUND（不是 500）', async () => {
    const user = await seedAlumni('missing-event');
    const response = await server()
      .post(`${API}/events/999999/registrations`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({});
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('给不存在的连接关系授权 → 404 NOT_FOUND（不是 500）', async () => {
    const user = await seedAlumni('missing-pair');
    const response = await server()
      .put(`${API}/connections/999999/contact-grant`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ allow: true });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('改不存在的资源 → 404 NOT_FOUND（不是 500）', async () => {
    const user = await seedAlumni('missing-resource');
    const response = await server()
      .patch(`${API}/resources/999999`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ title: '改一个不存在的内容' });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });
});
