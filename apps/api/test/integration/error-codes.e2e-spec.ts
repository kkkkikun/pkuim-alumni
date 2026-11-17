import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTestApp, ensureAdmin, login, markVerified, resetDatabase } from '../helpers';

/**
 * 错误码必须**真的能被返回**（缺陷 #109 / #110）。
 *
 * 契约（packages/contracts/src/common.ts）是客户端判断的唯一事实来源。
 * 契约里声明了、服务端却从不返回的错误码是**死码** ——
 * 客户端按契约写的判断分支永远走不到，而且**没有任何报错**：
 *
 *   - `VERIFICATION_REQUIRED`：身份阶段不够时，此前抛的是普通 `ForbiddenException`
 *     → 被统一异常过滤器按状态码映射成通用的 `FORBIDDEN`。
 *     客户端因此无法区分「你没认证 → 去认证页」与「你没权限」，
 *     而这正是两种完全不同的用户引导。
 *   - `AUTH_FAILED`：凭据无效（密码错 / 令牌失效）时，此前一律返回 `AUTH_REQUIRED`，
 *     于是「没带令牌」与「令牌无效」被混为一谈。
 *
 * 同一个错误码必须**只在它该出现的时候出现**：
 * 普通越权仍然必须是 `FORBIDDEN` —— 把所有 403 都改成 VERIFICATION_REQUIRED
 * 同样是错的。
 */
const API = '/api/v1';

describe('错误码必须真的能被返回（缺陷 #109 ~ #110）', () => {
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

  it('#109 身份阶段不够 → 403 且 code 必须是 VERIFICATION_REQUIRED', async () => {
    const session = await login(app, 'code-unverified');
    // 注意：**没有** markVerified —— 该用户处于 logged_in 阶段

    const res = await server()
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ type: 'resource', title: '未认证用户发布的资源', body: '一段足够长的资源描述正文内容。' })
      .expect(403);

    expect(res.body.code).toBe('VERIFICATION_REQUIRED');
    expect(res.body.code).not.toBe('FORBIDDEN');
  });

  it('对照：普通越权（改别人的资源）→ 403 且 code 仍必须是 FORBIDDEN', async () => {
    const owner = await login(app, 'code-owner');
    await markVerified(dataSource, owner.userId);
    const other = await login(app, 'code-other');
    await markVerified(dataSource, other.userId);

    const created = await server()
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ type: 'resource', title: '别人的资源条目', body: '一段足够长的资源描述正文内容。' })
      .expect(201);

    const res = await server()
      .patch(`${API}/resources/${created.body.data.id}`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .send({ title: '我要改别人的资源标题' })
      .expect(403);

    expect(res.body.code).toBe('FORBIDDEN');
    expect(res.body.code).not.toBe('VERIFICATION_REQUIRED');
  });

  it('#110 管理员密码错误 → 401 且 code 必须是 AUTH_FAILED', async () => {
    await ensureAdmin(dataSource, { username: 'code-admin', password: 'Admin@2026' });

    const res = await server()
      .post(`${API}/auth/admin/login`)
      // ⚠️ 密码必须**长度合规**（DTO 要求 8~128 位），
      //    否则请求在校验阶段就被拦下（400 VALIDATION_ERROR），
      //    根本走不到凭据比对 —— 那测的就不是 AUTH_FAILED 了。
      .send({ username: 'code-admin', password: 'WrongPassword@2026' })
      .expect(401);

    expect(res.body.code).toBe('AUTH_FAILED');
    expect(res.body.code).not.toBe('AUTH_REQUIRED');
  });

  it('对照：完全不带令牌 → 401 且 code 必须是 AUTH_REQUIRED', async () => {
    const res = await server()
      .post(`${API}/resources`)
      .send({ type: 'resource', title: '匿名发布的资源条目', body: '一段足够长的资源描述正文内容。' })
      .expect(401);

    expect(res.body.code).toBe('AUTH_REQUIRED');
    expect(res.body.code).not.toBe('AUTH_FAILED');
  });

  it('#110 刷新令牌无效 → 401 且 code 必须是 AUTH_FAILED', async () => {
    const res = await server()
      .post(`${API}/auth/refresh`)
      .send({ refreshToken: 'not-a-real-refresh-token' })
      .expect(401);

    expect(res.body.code).toBe('AUTH_FAILED');
    expect(res.body.code).not.toBe('AUTH_REQUIRED');
  });
});
