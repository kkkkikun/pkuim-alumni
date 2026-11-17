import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, ensureAdmin, login, markVerified, resetDatabase } from '../helpers';

/**
 * 状态筛选参数的枚举校验（e2e）。
 *
 * 背景（本轮新抓出并修复的 2 类缺陷）：
 *   #92 管理端 7 个列表的状态筛选写的是 `status?: string`（或只有 TS 联合类型），
 *        **没有任何枚举校验**。后果不抛异常：
 *        传 `status=bogus` → 服务端直接拿去查库 → 返回**空列表** →
 *        用户看到「筛选后没有数据」，极易误判成「数据丢了 / 功能坏了」，
 *        而不是「参数写错了」。同一批字段里 `userStatus` 却有 `@IsIn` ——
 *        不一致本身就是信号。
 *   #91 认证审核的 `action` 同样只有 TS 联合类型 → 非法值一路走到 service，
 *        被 `statusMap` 判空后抛 **409 Conflict**；
 *        而资源审核的同类非法输入是 400 —— 同一类非法参数，两种错误码，
 *        且 409 的语义是「状态冲突」，用来表达「参数非法」本身就不对。
 *
 * 断言策略：
 *   - 非法枚举值必须 **400**（而不是 200 + 空列表，也不是 409）；
 *   - 合法枚举值必须仍然能正常筛选（DTO 不能把正常流程拦死）。
 */

const API = '/api/v1';
const ADMIN_PASSWORD = 'Admin@2026';

describe('状态筛选枚举校验 (e2e)', () => {
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

  /** 每个列表用独立的管理员账号（admin_users / roles 是保留表，不会被清空） */
  async function adminToken(
    permissionCode: string,
    roleCode: string,
    username: string,
  ): Promise<string> {
    await ensureAdmin(dataSource, { roleCode, permissionCode, username });
    const response = await request(app.getHttpServer())
      .post(`${API}/auth/admin/login`)
      .send({ username, password: ADMIN_PASSWORD })
      .expect(200);
    return response.body.data.accessToken as string;
  }

  it('#92 认证 / 资源 / 资讯 / 公告 / 活动 的非法状态筛选 → 400', async () => {
    const cases: Array<{ path: string; permission: string; role: string; user: string }> = [
      { path: '/admin/verifications', permission: 'verification:review', role: 'q_verifier', user: 'admin-q-verifier' },
      { path: '/admin/resources', permission: 'resource:review', role: 'q_resource', user: 'admin-q-resource' },
      { path: '/admin/articles', permission: 'content:manage', role: 'q_content', user: 'admin-q-content' },
      { path: '/admin/notices', permission: 'content:manage', role: 'q_notice', user: 'admin-q-notice' },
      { path: '/admin/events', permission: 'event:manage', role: 'q_event', user: 'admin-q-event' },
    ];

    for (const item of cases) {
      const token = await adminToken(item.permission, item.role, item.user);
      const response = await request(app.getHttpServer())
        .get(`${API}${item.path}?status=bogus-status`)
        .set('Authorization', `Bearer ${token}`);

      expect(`${item.path} → ${response.status}`).toBe(`${item.path} → 400`);
    }
  });

  it('#92 校友列表的非法 stage / 账号列表的非法 status → 400', async () => {
    const viewer = await adminToken('alumni:view', 'q_viewer', 'admin-q-viewer');
    const stageResponse = await request(app.getHttpServer())
      .get(`${API}/admin/alumni?stage=bogus-stage`)
      .set('Authorization', `Bearer ${viewer}`);
    expect(stageResponse.status).toBe(400);

    const manager = await adminToken('admin:manage', 'q_manager', 'admin-q-manager');
    const userResponse = await request(app.getHttpServer())
      .get(`${API}/admin/users?status=bogus-status`)
      .set('Authorization', `Bearer ${manager}`);
    expect(userResponse.status).toBe(400);
  });

  it('#92 联系申请列表的非法状态 → 400', async () => {
    const session = await login(app, 'query-filter-user');
    await markVerified(dataSource, session.userId);

    const response = await request(app.getHttpServer())
      .get(`${API}/me/connection-requests?status=bogus-status`)
      .set('Authorization', `Bearer ${session.accessToken}`);

    expect(response.status).toBe(400);
  });

  it('#92 合法状态筛选仍然可用（DTO 不能把正常流程拦死）', async () => {
    const verifier = await adminToken(
      'verification:review',
      'q_verifier_ok',
      'admin-q-verifier-ok',
    );
    await request(app.getHttpServer())
      .get(`${API}/admin/verifications?status=pending`)
      .set('Authorization', `Bearer ${verifier}`)
      .expect(200);

    const viewer = await adminToken('alumni:view', 'q_viewer_ok', 'admin-q-viewer-ok');
    await request(app.getHttpServer())
      .get(`${API}/admin/alumni?stage=verified`)
      .set('Authorization', `Bearer ${viewer}`)
      .expect(200);

    const session = await login(app, 'query-filter-user-ok');
    await markVerified(dataSource, session.userId);
    await request(app.getHttpServer())
      .get(`${API}/me/connection-requests?status=pending`)
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);
  });

  it('#91 认证审核的非法 action → 400（此前是 409 Conflict，与资源审核不一致）', async () => {
    const session = await login(app, 'query-filter-apply');
    await markVerified(dataSource, session.userId);

    const submitted = await request(app.getHttpServer())
      .post(`${API}/alumni/verification`)
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({
        realName: '审核动作测试校友',
        college: '经济学院',
        graduationYear: 2015,
        degree: '学士',
        studentIdMasked: '2015****1234',
        remark: '用于校验审核动作枚举的虚构资料',
      })
      .expect(201);

    const token = await adminToken(
      'verification:review',
      'q_verifier_action',
      'admin-q-verifier-action',
    );

    const response = await request(app.getHttpServer())
      .post(`${API}/admin/verifications/${submitted.body.data.id}/decision`)
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'bogus-action' });

    expect(response.status).toBe(400);
  });
});
