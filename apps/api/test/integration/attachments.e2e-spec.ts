import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { BUILT_IN_ROLE_CODES, createTestApp, ensureAdmin, login, markVerified, resetDatabase } from '../helpers';

/**
 * 附件链路（资源 / 认证）端到端测试。
 *
 * 背景（本轮修掉的 4 个真实缺陷）：
 *   #73 `PATCH /resources/:id` 静默丢弃 `attachmentMediaIds`
 *        —— 契约声明了、Swagger 公布了、create 也会落库，唯独 update 不用；
 *           用户改资源换附件时「保存成功」，附件却纹丝不动。
 *   #74 资源 DTO 的数组字段没有元素级校验
 *        —— `attachmentMediaIds: "abc"` 会一路走到 service 里 `.map()` → 500。
 *   #75 附件列表的响应结构与契约不符
 *        —— 契约是 `VerificationAttachmentDto[]` / `ResourceAttachmentDto[]`（含
 *           fileName / mimeType / size），服务端只返回 `{ id, mediaId }`，
 *           后台审核页与资源详情页渲染的文件名/大小**恒为空**。
 *   #77 管理员预览用户上传的证明材料 → 404
 *        —— 私有资产只允许上传者本人取地址，而审核员不是上传者，
 *           审核流程根本走不通。
 *
 * 断言策略：
 *   - 附件替换：既看接口响应的 attachments，也看落库的 resource_post_attachments；
 *   - 校验：畸形数组必须是 400（而不是 500）；
 *   - 形状：附件对象必须带齐契约声明的字段；
 *   - 鉴权：管理员凭权限可取附件地址；普通用户取不到；不相关的管理员也取不到。
 */

const API = '/api/v1';
const ADMIN_PASSWORD = 'Admin@2026';

describe('附件链路 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  /**
   * 本套件创建的角色编码。
   *
   * ⚠️ `roles` 是**保留表**（`resetDatabase` 不清空），
   *    本套件的角色编码（`attachment_reviewer` / `attachment_other` /
   *    `attachment_no_res`）不在契约的 `AdminRole` 联合里 ——
   *    残留会把角色目录撑成几十个编码，并让 `GET /admin/users`
   *    回显出契约不认的角色编码 → 响应形状校验判负。
   *    所以套件结束前必须把它们删掉。
   */
  const createdRoleCodes: string[] = [];

  /**
   * 本套件创建的管理员账号。
   *
   * ⚠️ `admin_users` 是**保留表**（`resetDatabase` 不清空），
   *    不清理的话这些账号会跨套件、跨运行一直留在库里。
   */
  const createdUsernames: string[] = [];

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
  });

  afterAll(async () => {
    // ⚠️ 清理必须在 `app.close()` **之前**做：
    //    `app.close()` 会连带销毁 TypeORM 的 DataSource，
    //    之后再调 `dataSource.query()` 会直接抛「连接已关闭」，
    //    异常又被下面的 catch 吞掉 → 角色编码永远删不掉。
    try {
      // 先删本套件建的管理员账号（审计日志外键是 ON DELETE RESTRICT，
      // 必须先删它自己产生的审计记录，否则删账号会被数据库拒绝）。
      if (createdUsernames.length) {
        const placeholders = createdUsernames.map(() => '?').join(',');
        await dataSource.query(
          `DELETE FROM admin_action_logs WHERE admin_id IN
             (SELECT id FROM admin_users WHERE username IN (${placeholders}))`,
          createdUsernames,
        );
        await dataSource.query(
          `DELETE FROM admin_user_roles WHERE admin_user_id IN
             (SELECT id FROM admin_users WHERE username IN (${placeholders}))`,
          createdUsernames,
        );
        await dataSource.query(
          `DELETE FROM admin_users WHERE username IN (${placeholders})`,
          createdUsernames,
        );
      }
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

  /** 登记一个媒体资产（只登记，不上传字节；附件外键需要真实的 media 行） */
  async function mediaAsset(token: string, fileName: string, mimeType = 'image/png'): Promise<number> {
    const response = await request(app.getHttpServer())
      .post(`${API}/uploads/records`)
      .set('Authorization', `Bearer ${token}`)
      .send({ fileName, mimeType, size: 128 })
      .expect(201);
    return response.body.data.id as number;
  }

  async function verifiedUser(openid: string) {
    const session = await login(app, openid);
    await markVerified(dataSource, session.userId);
    return session;
  }

  async function adminToken(
    permissionCode: string,
    roleCode = 'attachment_reviewer',
    username?: string,
  ): Promise<string> {
    // ⚠️ 角色编码在这里被真正建出来（`ensureAdmin` 会 INSERT `roles`），
    //    所以必须**在建的地方**登记，套件结束才能把它删掉。
    if (!createdRoleCodes.includes(roleCode)) createdRoleCodes.push(roleCode);
    // ⚠️ **管理员账号必须按角色区分**（缺陷 #158 同一族，第四轮复核发现）：
    //    管理端的 RBAC 身份是**按管理员 id 缓存**的（`CacheKeys.adminRbac`，
    //    TTL ≤30 秒），而 `ensureAdmin` 是**直接写库**、绕过了 API ——
    //    写完角色**不会**让缓存失效。
    //    所以同一个管理员先后挂上不同角色时，**先登录那次的缓存会被后续沿用**：
    //    拿到的令牌带着**旧角色的权限点** → 明明该有的权限没有 → 403。
    //    在**干净库**上（CI 每次都是干净库）必然踩到；
    //    在跑脏的库上旧角色早就攒下了那个权限 → 反而通过 —— 这类
    //    「单独跑绿、连跑红 / 干净库红、脏库绿」的偶发失败最难查。
    //    修法：**一个角色一个管理员账号**，各���的缓存条目互不干扰。
    const account = username ?? `admin_${roleCode}`;
    if (!createdUsernames.includes(account)) createdUsernames.push(account);
    await ensureAdmin(dataSource, { roleCode, permissionCode, username: account });
    const response = await request(app.getHttpServer())
      .post(`${API}/auth/admin/login`)
      .send({ username: account, password: ADMIN_PASSWORD })
      .expect(200);
    return response.body.data.accessToken as string;
  }

  /* ------------------------- #73 附件替换 ------------------------- */

  it('#73 作者修改资源时提交附件列表 → 附件真的被替换（不是静默丢弃）', async () => {
    const author = await verifiedUser('att-author');
    const assetA = await mediaAsset(author.accessToken, 'a.png');
    const assetB = await mediaAsset(author.accessToken, 'b.png');
    const assetC = await mediaAsset(author.accessToken, 'c.png');

    const created = await request(app.getHttpServer())
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({
        type: 'resource',
        title: '带附件的资源',
        body: '这是一段用于测试的资源描述内容，长度满足校验要求。',
        attachmentMediaIds: [assetA, assetB],
      })
      .expect(201);
    const postId = created.body.data.id as number;

    const rows = await dataSource.query(
      'SELECT media_id FROM resource_post_attachments WHERE post_id = ? ORDER BY media_id',
      [postId],
    );
    expect(rows.map((row: { media_id: number }) => row.media_id)).toEqual([assetA, assetB]);

    // 修改时提交新的附件列表 → 整体替换
    const updated = await request(app.getHttpServer())
      .patch(`${API}/resources/${postId}`)
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({ title: '换了附件的资源', attachmentMediaIds: [assetC] })
      .expect(200);

    const afterRows = await dataSource.query(
      'SELECT media_id FROM resource_post_attachments WHERE post_id = ? ORDER BY media_id',
      [postId],
    );
    expect(afterRows.map((row: { media_id: number }) => row.media_id)).toEqual([assetC]);
    expect(updated.body.data.attachments.map((item: { mediaId: number }) => item.mediaId)).toEqual([
      assetC,
    ]);
  });

  it('#73 只改标题不动附件 → 附件保持原样', async () => {
    const author = await verifiedUser('att-keep');
    const assetA = await mediaAsset(author.accessToken, 'keep.png');

    const created = await request(app.getHttpServer())
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({
        type: 'resource',
        title: '保留附件的资源',
        body: '这是一段用于测试的资源描述内容，长度满足校验要求。',
        attachmentMediaIds: [assetA],
      })
      .expect(201);
    const postId = created.body.data.id as number;

    await request(app.getHttpServer())
      .patch(`${API}/resources/${postId}`)
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({ title: '只改标题' })
      .expect(200);

    const rows = await dataSource.query(
      'SELECT media_id FROM resource_post_attachments WHERE post_id = ?',
      [postId],
    );
    expect(rows).toHaveLength(1);
  });

  /* ------------------------- #74 数组元素校验 ------------------------- */

  it('#74 附件列表类型非法 → 400（不是 500）', async () => {
    const author = await verifiedUser('att-bad');

    // 不是数组
    await request(app.getHttpServer())
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({
        type: 'resource',
        title: '畸形附件列表',
        body: '这是一段用于测试的资源描述内容，长度满足校验要求。',
        attachmentMediaIds: 'not-an-array',
      })
      .expect(400);

    // 元素不是数字
    await request(app.getHttpServer())
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({
        type: 'resource',
        title: '畸形附件元素',
        body: '这是一段用于测试的资源描述内容，长度满足校验要求。',
        attachmentMediaIds: ['abc'],
      })
      .expect(400);

    // 修改接口同样要拦
    const asset = await mediaAsset(author.accessToken, 'ok.png');
    const created = await request(app.getHttpServer())
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({
        type: 'resource',
        title: '正常资源',
        body: '这是一段用于测试的资源描述内容，长度满足校验要求。',
        attachmentMediaIds: [asset],
      })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`${API}/resources/${created.body.data.id}`)
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({ attachmentMediaIds: { nope: true } })
      .expect(400);
  });

  /* ------------------------- #75 附件响应结构 ------------------------- */

  it('#75 认证申请详情返回完整附件信息（fileName / mimeType / size / uploadedAt）', async () => {
    const user = await login(app, 'att-verify');
    const asset = await mediaAsset(user.accessToken, 'proof.png', 'image/png');

    const submitted = await request(app.getHttpServer())
      .post(`${API}/alumni/verification`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        realName: '附件测试校友',
        college: '经济学院',
        graduationYear: 2015,
        degree: '学士',
        studentIdMasked: '2015****1234',
        remark: '测试用虚构资料',
        attachmentMediaIds: [asset],
      })
      .expect(201);

    const attachment = submitted.body.data.attachments?.[0];
    expect(attachment).toBeDefined();
    expect(attachment.mediaId).toBe(asset);
    expect(attachment.fileName).toBe('proof.png');
    expect(attachment.mimeType).toBe('image/png');
    expect(attachment.size).toBe(128);
    expect(typeof attachment.uploadedAt).toBe('string');

    // 管理端审核详情也必须带齐 —— 后台审核页要渲染文件名与大小
    const token = await adminToken('verification:review');
    const detail = await request(app.getHttpServer())
      .get(`${API}/admin/verifications/${submitted.body.data.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const adminAttachment = detail.body.data.attachments?.[0];
    expect(adminAttachment.fileName).toBe('proof.png');
    expect(adminAttachment.size).toBe(128);
  });

  it('#75 资源详情返回完整附件信息（fileName / mimeType / size / uploadedAt）', async () => {
    const author = await verifiedUser('att-res-shape');
    const asset = await mediaAsset(author.accessToken, 'doc.pdf', 'application/pdf');

    const created = await request(app.getHttpServer())
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({
        type: 'resource',
        title: '带附件的资源详情',
        body: '这是一段用于测试的资源描述内容，长度满足校验要求。',
        attachmentMediaIds: [asset],
      })
      .expect(201);

    const attachment = created.body.data.attachments?.[0];
    expect(attachment.mediaId).toBe(asset);
    expect(attachment.fileName).toBe('doc.pdf');
    expect(attachment.mimeType).toBe('application/pdf');
    expect(attachment.size).toBe(128);
    expect(typeof attachment.uploadedAt).toBe('string');
  });

  /* ------------------------- #77 管理员预览附件 ------------------------- */

  it('#77 管理员凭审核权限可取证明材料地址；普通用户取不到', async () => {
    const user = await login(app, 'att-preview');
    const asset = await mediaAsset(user.accessToken, 'private-proof.png');

    const submitted = await request(app.getHttpServer())
      .post(`${API}/alumni/verification`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        realName: '预览测试校友',
        college: '经济学院',
        graduationYear: 2015,
        degree: '学士',
        studentIdMasked: '2015****1234',
        remark: '测试用虚构资料',
        attachmentMediaIds: [asset],
      })
      .expect(201);
    const applicationId = submitted.body.data.id as number;

    // 管理员：按「附件确实挂在这个待审对象上」鉴权 → 能取到预签名地址
    const token = await adminToken('verification:review');
    const asAdmin = await request(app.getHttpServer())
      .get(`${API}/admin/verifications/${applicationId}/attachments/${asset}/url`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(typeof asAdmin.body.data.url).toBe('string');
    expect(asAdmin.body.data.url.length).toBeGreaterThan(0);

    // 普通用户：私有资产只允许上传者本人取；这里连上传者本人之外的都取不到
    const other = await login(app, 'att-other');
    await request(app.getHttpServer())
      .get(`${API}/admin/verifications/${applicationId}/attachments/${asset}/url`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .expect(403);

    // 上传者本人走通用接口可以取（归属校验仍然有效）
    await request(app.getHttpServer())
      .get(`${API}/uploads/${asset}/url`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    // 无关的管理员（有别的权限点）不能取别人的证明材料
    const otherAdmin = await adminToken('resource:review', 'attachment_other');
    await request(app.getHttpServer())
      .get(`${API}/admin/verifications/${applicationId}/attachments/${asset}/url`)
      .set('Authorization', `Bearer ${otherAdmin}`)
      .expect(403);
  });

  it('#77 管理员凭资源审核权限可取资源附件地址；附件不挂在这条资源上 → 404', async () => {
    const author = await verifiedUser('att-res-preview');
    const asset = await mediaAsset(author.accessToken, 'res-private.pdf', 'application/pdf');

    const created = await request(app.getHttpServer())
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({
        type: 'resource',
        title: '待审核的带附件资源',
        body: '这是一段用于测试的资源描述内容，长度满足校验要求。',
        attachmentMediaIds: [asset],
      })
      .expect(201);
    const postId = created.body.data.id as number;

    // 审核员：凭 resource:review 权限 + 「附件确实挂在该资源上」→ 能取到地址
    //
    // ⚠️ 这里**必须用自己的角色**（`attachment_resource`），不能沿用默认的
    //    `attachment_reviewer`：默认角色在本套件里被 `verification:review` 用过，
    //    而 `ensureAdmin` 是 `INSERT IGNORE` —— 角色与权限点是**多对多**，
    //    同一个角色先后拿到哪个权限，取决于**哪个用例先跑**。
    //    在**干净库**上（CI 每次都是干净库）默认角色只有 `verification:review`，
    //    本用例就 403；而在跑脏的库上它早已攒下 `resource:review` → 反而通过。
    //    这正是「单独跑绿、连跑红」那一类偶发失败的根源（缺陷 #158 同一族）。
    const token = await adminToken('resource:review', 'attachment_resource');
    const asAdmin = await request(app.getHttpServer())
      .get(`${API}/admin/resources/${postId}/attachments/${asset}/url`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(typeof asAdmin.body.data.url).toBe('string');
    expect(asAdmin.body.data.url.length).toBeGreaterThan(0);

    // 附件挂在**别人**的资源上 → 404（不泄露附件是否存在）
    const other = await verifiedUser('att-res-preview-other');
    const otherAsset = await mediaAsset(other.accessToken, 'other-res.pdf', 'application/pdf');
    await request(app.getHttpServer())
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .send({
        type: 'resource',
        title: '别人的带附件资源',
        body: '这是一段用于测试的资源描述内容，长度满足校验要求。',
        attachmentMediaIds: [otherAsset],
      })
      .expect(201);

    await request(app.getHttpServer())
      .get(`${API}/admin/resources/${postId}/attachments/${otherAsset}/url`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    // 没有 resource:review 权限的管理员 → 403
    const otherAdmin = await adminToken('verification:review', 'attachment_no_res');
    await request(app.getHttpServer())
      .get(`${API}/admin/resources/${postId}/attachments/${asset}/url`)
      .set('Authorization', `Bearer ${otherAdmin}`)
      .expect(403);
  });

  /* ------------------------- #78 附件归属 ------------------------- */

  it('#78 引用他人的媒体 id → 400（不能把别人的私有文件挂到自己的内容上）', async () => {
    const victim = await verifiedUser('att-victim');
    const victimAsset = await mediaAsset(victim.accessToken, 'victim-private.png');

    const attacker = await verifiedUser('att-attacker');

    // 资源：不能引用别人的媒体
    await request(app.getHttpServer())
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${attacker.accessToken}`)
      .send({
        type: 'resource',
        title: '试图挂别人附件',
        body: '这是一段用于测试的资源描述内容，长度满足校验要求。',
        attachmentMediaIds: [victimAsset],
      })
      .expect(400);

    // 认证申请：同样不能引用别人的媒体
    await request(app.getHttpServer())
      .post(`${API}/alumni/verification`)
      .set('Authorization', `Bearer ${attacker.accessToken}`)
      .send({
        realName: '试图挂别人材料',
        college: '经济学院',
        graduationYear: 2015,
        degree: '学士',
        studentIdMasked: '2015****1234',
        remark: '测试用虚构资料',
        attachmentMediaIds: [victimAsset],
      })
      .expect(400);

    // 结论：附件没有落库
    const rows = await dataSource.query(
      'SELECT COUNT(*) AS total FROM resource_post_attachments WHERE media_id = ?',
      [victimAsset],
    );
    expect(Number(rows[0].total)).toBe(0);
  });

  it('#77 附件不属于该审核对象 → 404（不泄露附件是否存在）', async () => {    const user = await login(app, 'att-mismatch');
    const asset = await mediaAsset(user.accessToken, 'other-proof.png');

    const submitted = await request(app.getHttpServer())
      .post(`${API}/alumni/verification`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        realName: '不匹配测试校友',
        college: '经济学院',
        graduationYear: 2015,
        degree: '学士',
        studentIdMasked: '2015****1234',
        remark: '测试用虚构资料',
      })
      .expect(201);

    const token = await adminToken('verification:review');
    await request(app.getHttpServer())
      .get(`${API}/admin/verifications/${submitted.body.data.id}/attachments/${asset}/url`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});
