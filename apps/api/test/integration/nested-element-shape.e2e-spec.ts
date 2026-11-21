import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { BUILT_IN_ROLE_CODES, createTestApp, ensureAdmin, login, markVerified, resetDatabase } from '../helpers';

/**
 * 嵌套元素的结构契约（e2e）。
 *
 * 背景：这一轮修好了响应结构校验器的一个**判定条件写反**的 bug（#87）。
 * 修好之后校验器报出来的「元素结构从未被校验」清单是**真的**，
 * 线上所有真实样本里，有 5 个契约类型从未被校验过：
 *
 *   - `VerificationAttachmentDto`  认证申请的附件元素
 *   - `VerificationReviewDto`     认证审核历史元素
 *   - `ResourceAttachmentDto`      资源附件元素
 *   - `VerificationApplicationDto` 校友详情里的认证数组元素
 *   - `EventRegistrationDto`       活动报名列表元素
 *
 * 之所以从未被校验，是因为**线上业务库根本没有这类数据**
 * （没人上传过附件、没人提交过认证、没人报名过活动），
 * 数组永远是空的 → 元素结构一次都没被核对过。
 * 这正是缺陷 #75（附件只返回 `{id, mediaId}`）能长期潜伏的土壤：
 * 形状错了也没人看得见。
 *
 * 本文件用**真实接口 + 真实数据**把这些元素结构逐字段钉住：
 * 造出带附件的认证申请、带审核记录的资源、带报名的活动，
 * 然后断言每个元素都带齐契约声明的字段、且字段类型正确。
 *
 * 断言策略：
 *   - 字段存在 + 类型正确（必填字段缺失即为契约不一致）；
 *   - 可空字段（note / college 等）允许为 null，但**键必须在**；
 *   - 一旦服务端少返回一个字段，这里就会失败 —— 契约与实现当场分叉。
 */

const API = '/api/v1';
const ADMIN_PASSWORD = 'Admin@2026';

/** 契约声明的必填字段（顺序无关），少一个即为结构不一致 */
function expectFields(
  item: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  expect(item).toBeDefined();
  const missing = fields.filter(
    (field) => !Object.prototype.hasOwnProperty.call(item, field) || item[field] === undefined,
  );
  expect(`${label} 缺少字段：${missing.join(',')}`).toBe(`${label} 缺少字段：`);
}

describe('嵌套元素结构契约 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  /**
   * 本套件创建的角色编码。
   *
   * ⚠️ `roles` 是**保留表**（`resetDatabase` 不清空），
   *    本套件的角色编码（`shape_verifier` / `shape_resource_reviewer` /
   *    `shape_viewer` / `shape_event_manager`）不在契约的 `AdminRole` 联合里 ——
   *    残留会把角色目录撑成几十个编码，并让 `GET /admin/users`
   *    回显出契约不认的角色编码 → 响应形状校验判负。
   *    所以套件结束前必须把它们删掉。
   */
  const createdRoleCodes: string[] = [];

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
  });

  afterAll(async () => {
    // ⚠️ 清理必须在 `app.close()` **之前**做：
    //    `app.close()` 会连带销毁 TypeORM 的 DataSource，
    //    之后再调 `dataSource.query()` 会直接抛「连接已关闭」，
    //    异常又被下面的 catch 吞掉 → 角色编码永远删不掉。
    try {
      for (const code of createdRoleCodes) {
        // ⚠️ 内置角色编码（契约 `AdminRole` 联合类型里的那 5 个）**绝不删除**。
        if (BUILT_IN_ROLE_CODES.has(code)) continue;
        // ⚠️ `role_permissions` / `admin_user_roles` 指向 `roles` 的外键虽是
        //    ON DELETE CASCADE，但这里**显式**先删子表 —— 清理不依赖库的级联行为。
        await dataSource.query(
          `DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE code = ?)`,
          [code],
        );
        await dataSource.query(
          'DELETE FROM admin_user_roles WHERE role_id IN (SELECT id FROM roles WHERE code = ?)',
          [code],
        );
        await dataSource.query('DELETE FROM roles WHERE code = ?', [code]);
      }
    } catch {
      // 清理失败不影响测试结论（测试库每轮都会重建）
    }
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

  /**
   * 每个用例用**独立的管理员账号** ——
   * `admin_users` / `roles` 是保留表（回归时不会被清空），
   * 同名账号会把上一条用例的权限也带进来，掩盖越权问题。
   */
  async function adminToken(
    permissionCode: string,
    roleCode: string,
    username: string,
  ): Promise<string> {
    // ⚠️ 角色编码在这里被真正建出来（`ensureAdmin` 会 INSERT `roles`），
    //    所以必须**在建的地方**登记，套件结束才能把它删掉。
    if (!createdRoleCodes.includes(roleCode)) createdRoleCodes.push(roleCode);
    await ensureAdmin(dataSource, { roleCode, permissionCode, username });
    const response = await request(app.getHttpServer())
      .post(`${API}/auth/admin/login`)
      .send({ username, password: ADMIN_PASSWORD })
      .expect(200);
    return response.body.data.accessToken as string;
  }

  /** 登记一个媒体资产（只登记，不上传字节） */
  async function mediaAsset(token: string, fileName: string, mimeType = 'image/png'): Promise<number> {
    const response = await request(app.getHttpServer())
      .post(`${API}/uploads/records`)
      .set('Authorization', `Bearer ${token}`)
      .send({ fileName, mimeType, size: 256 })
      .expect(201);
    return response.body.data.id as number;
  }

  /** 提交一条认证申请（可带附件） */
  async function submitVerification(
    token: string,
    openid: string,
    attachmentMediaIds: number[] = [],
  ): Promise<number> {
    const response = await request(app.getHttpServer())
      .post(`${API}/alumni/verification`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        realName: `嵌套结构测试${openid}`,
        college: '经济学院',
        graduationYear: 2015,
        degree: '学士',
        studentIdMasked: '2015****1234',
        remark: '用于校验嵌套元素结构的虚构资料',
        ...(attachmentMediaIds.length ? { attachmentMediaIds } : {}),
      })
      .expect(201);
    return response.body.data.id as number;
  }

  it('#87 认证审核历史元素必须带齐契约声明的字段（含审核人姓名）', async () => {
    const user = await verifiedUser('shape-review');
    const applicationId = await submitVerification(user.accessToken, 'A');

    const token = await adminToken('verification:review', 'shape_verifier', 'admin-shape-verify');
    await request(app.getHttpServer())
      .post(`${API}/admin/verifications/${applicationId}/decision`)
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'request_changes', note: '请补充成绩单' })
      .expect(201);

    const detail = await request(app.getHttpServer())
      .get(`${API}/admin/verifications/${applicationId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const reviews = detail.body.data.reviews as Record<string, unknown>[];
    expect(Array.isArray(reviews)).toBe(true);
    expect(reviews.length).toBeGreaterThan(0);

    const review = reviews[0];
    expectFields(
      review,
      ['id', 'adminId', 'adminName', 'action', 'note', 'createdAt'],
      'VerificationReviewDto',
    );
    expect(typeof review.id).toBe('number');
    expect(typeof review.adminId).toBe('number');
    // 契约声明 adminName 为必填（后台审核记录直接渲染审核人姓名）
    expect(typeof review.adminName).toBe('string');
    expect(String(review.adminName).length).toBeGreaterThan(0);
    expect(typeof review.action).toBe('string');
    expect(typeof review.createdAt).toBe('string');
  });

  it('#87 认证附件元素必须带齐契约声明的 6 个字段', async () => {
    const user = await verifiedUser('shape-attach');
    const asset = await mediaAsset(user.accessToken, 'proof.png');
    const applicationId = await submitVerification(user.accessToken, 'B', [asset]);

    const token = await adminToken('verification:review', 'shape_verifier', 'admin-shape-verify');
    const detail = await request(app.getHttpServer())
      .get(`${API}/admin/verifications/${applicationId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const attachments = detail.body.data.attachments as Record<string, unknown>[];
    expect(Array.isArray(attachments)).toBe(true);
    expect(attachments.length).toBe(1);

    const attachment = attachments[0];
    expectFields(
      attachment,
      ['id', 'mediaId', 'fileName', 'mimeType', 'size', 'uploadedAt'],
      'VerificationAttachmentDto',
    );
    expect(attachment.mediaId).toBe(asset);
    expect(attachment.fileName).toBe('proof.png');
    expect(attachment.mimeType).toBe('image/png');
    expect(attachment.size).toBe(256);
  });

  it('#87 资源审核历史元素必须带齐契约声明的字段（含审核人姓名与快照版本）', async () => {
    const author = await verifiedUser('shape-resource');
    const created = await request(app.getHttpServer())
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({
        type: 'resource',
        title: '带附件的资源',
        body: '这是一段用于测试嵌套元素结构的资源描述，长度满足校验要求。',
      })
      .expect(201);
    const postId = created.body.data.id as number;

    const token = await adminToken('resource:review', 'shape_resource_reviewer', 'admin-shape-resource');
    await request(app.getHttpServer())
      .post(`${API}/admin/resources/${postId}/decision`)
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'approve', note: '内容合规' })
      .expect(201);

    const detail = await request(app.getHttpServer())
      .get(`${API}/admin/resources/${postId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const reviews = detail.body.data.reviews as Record<string, unknown>[];
    expect(Array.isArray(reviews)).toBe(true);
    expect(reviews.length).toBeGreaterThan(0);

    const review = reviews[0];
    expectFields(
      review,
      ['id', 'adminId', 'adminName', 'action', 'note', 'snapshotVersion', 'createdAt'],
      'ResourceReviewDto',
    );
    expect(typeof review.adminName).toBe('string');
    expect(String(review.adminName).length).toBeGreaterThan(0);
    expect(typeof review.snapshotVersion).toBe('number');
  });

  it('#87 资源附件元素必须带齐契约声明的 6 个字段', async () => {
    const author = await verifiedUser('shape-resource-attach');
    const asset = await mediaAsset(author.accessToken, 'doc.pdf', 'application/pdf');
    const created = await request(app.getHttpServer())
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({
        type: 'resource',
        title: '带附件的资源',
        body: '这是一段用于测试嵌套元素结构的资源描述，长度满足校验要求。',
        attachmentMediaIds: [asset],
      })
      .expect(201);
    const postId = created.body.data.id as number;

    const token = await adminToken('resource:review', 'shape_resource_reviewer', 'admin-shape-resource');
    const detail = await request(app.getHttpServer())
      .get(`${API}/admin/resources/${postId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const attachments = detail.body.data.attachments as Record<string, unknown>[];
    expect(Array.isArray(attachments)).toBe(true);
    expect(attachments.length).toBe(1);

    const attachment = attachments[0];
    expectFields(
      attachment,
      ['id', 'mediaId', 'fileName', 'mimeType', 'size', 'uploadedAt'],
      'ResourceAttachmentDto',
    );
    expect(attachment.mediaId).toBe(asset);
    expect(attachment.fileName).toBe('doc.pdf');
    expect(attachment.size).toBe(256);
  });

  it('#87 校友详情里的认证数组元素必须带齐契约声明的字段', async () => {
    const user = await verifiedUser('shape-alumni');
    const applicationId = await submitVerification(user.accessToken, 'C');

    // 审批需要 verification:review，查看校友详情需要 alumni:view —— 两种权限分开拿
    const reviewer = await adminToken(
      'verification:review',
      'shape_verifier',
      'admin-shape-alumni-approve',
    );
    await request(app.getHttpServer())
      .post(`${API}/admin/verifications/${applicationId}/decision`)
      .set('Authorization', `Bearer ${reviewer}`)
      .send({ action: 'approve' })
      .expect(201);

    const token = await adminToken('alumni:view', 'shape_viewer', 'admin-shape-alumni');
    const detail = await request(app.getHttpServer())
      .get(`${API}/admin/alumni/${user.userId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const verifications = detail.body.data.verifications as Record<string, unknown>[];
    expect(Array.isArray(verifications)).toBe(true);
    expect(verifications.length).toBeGreaterThan(0);

    const application = verifications[0];
    expectFields(
      application,
      [
        'id',
        'userId',
        'applicantName',
        'college',
        'graduationYear',
        'degree',
        'studentIdMasked',
        'status',
        'attachments',
        'reviews',
        'submittedAt',
        'decidedAt',
      ],
      'VerificationApplicationDto',
    );
    expect(typeof application.submittedAt).toBe('string');
    expect(Array.isArray(application.attachments)).toBe(true);
    expect(Array.isArray(application.reviews)).toBe(true);
  });

  it('#87 活动报名列表元素必须带齐契约声明的字段（含报名人姓名）', async () => {
    await dataSource.query(
      `INSERT INTO events (title, kind, capacity, registered_count, status, created_at, updated_at)
       VALUES ('嵌套结构测试活动', '校友交流', 10, 0, 'published', NOW(3), NOW(3))`,
    );
    const [eventRow] = await dataSource.query('SELECT id FROM events ORDER BY id DESC LIMIT 1');
    const eventId = Number(eventRow.id);

    const user = await verifiedUser('shape-event');
    await request(app.getHttpServer())
      .post(`${API}/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ note: '希望参加' })
      .expect(201);

    const token = await adminToken('event:manage', 'shape_event_manager', 'admin-shape-event');
    const response = await request(app.getHttpServer())
      .get(`${API}/admin/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const registrations = (response.body.data as { items: Record<string, unknown>[] }).items;
    // ⚠️ 第三轮：报名名单从「裸数组」改为 `{items, meta}` 分页结构。
    expect(Array.isArray(registrations)).toBe(true);
    expect(registrations.length).toBe(1);

    const registration = registrations[0];
    expectFields(
      registration,
      ['id', 'eventId', 'userId', 'userName', 'status', 'note', 'createdAt'],
      'EventRegistrationDto',
    );
    expect(registration.eventId).toBe(eventId);
    expect(registration.userId).toBe(user.userId);
    // 契约声明 userName 为必填（后台报名名单直接渲染报名人）
    expect(typeof registration.userName).toBe('string');
    expect(String(registration.userName).length).toBeGreaterThan(0);
    expect(typeof registration.createdAt).toBe('string');
  });
});
