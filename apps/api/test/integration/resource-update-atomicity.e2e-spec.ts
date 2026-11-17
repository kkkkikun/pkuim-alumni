import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ResourcePostAttachment } from '../../src/database/entities/resource.entity';
import { createTestApp, login, markVerified, resetDatabase } from '../helpers';

/**
 * 资源「修改」的多步写完整性（缺陷 #131 / #132）。
 *
 * `resources.service.update()` 有**两个写动作**：
 *   1) 内容写入（标题 / 正文 / 行业 / 地区 / version / 状态回退到 pending）
 *   2) 附件**整体替换**（先删光旧附件，再挂新附件）
 *
 * 修复前这两步既**不在一个事务里**，而且**附件归属校验排在内容写入之后**：
 *
 *   - #131：请求带着**别人**的 mediaId → 服务端返回 400「附件不属于当前用户」，
 *     但**内容其实已经被改了**（标题、正文、version、状态全变了）。
 *     客户端拿到 400 会以为「什么都没发生」，实际已经改了 ——
 *     「校验失败却留下副作用」是最难排查的一类问题。
 *
 *   - #132：附件那一步失败时（写库失败），**内容写入已经提交**，
 *     留下一份「内容是新的、附件是旧的（甚至被删空了）」的半成品。
 *     `create()` 早就用事务把「内容 + 附件 + 通知」包起来了，
 *     `update()` 却漏了 —— 同一个模块，两种写法。
 *
 * 对照用例（防误伤）：不带附件字段的普通修改必须照常成功；
 * 带**本人**合法附件的修改必须真的替换附件。
 */
const API = '/api/v1';

describe('资源修改的多步写完整性（缺陷 #131 / #132）', () => {
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

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function verifiedUser(openid: string) {
    const session = await login(app, openid);
    await markVerified(dataSource, session.userId);
    return session;
  }

  /** 登记一个媒体资产（只登记，不上传字节；附件外键需要真实的 media 行） */
  async function mediaAsset(token: string, fileName: string): Promise<number> {
    const response = await request(app.getHttpServer())
      .post(`${API}/uploads/records`)
      .set('Authorization', `Bearer ${token}`)
      .send({ fileName, mimeType: 'image/png', size: 128 })
      .expect(201);
    return response.body.data.id as number;
  }

  async function createPost(token: string, title = '原始标题') {
    const response = await request(app.getHttpServer())
      .post(`${API}/resources`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'resource',
        title,
        body: '这是一段用于测试的资源描述正文，长度满足最小长度要求。',
      })
      .expect(201);
    return response.body.data as { id: number; title: string; version: number; status: string };
  }

  async function readPost(id: number) {
    const [row] = await dataSource.query(
      'SELECT id, title, body, version, status FROM resource_posts WHERE id = ?',
      [id],
    );
    return row as { id: number; title: string; body: string; version: number; status: string };
  }

  async function attachmentMediaIds(postId: number): Promise<number[]> {
    const rows = await dataSource.query(
      'SELECT media_id FROM resource_post_attachments WHERE post_id = ? ORDER BY id',
      [postId],
    );
    return (rows as { media_id: number }[]).map((row) => Number(row.media_id));
  }

  it('#131 附件归属校验失败 → 内容必须**一点都没改**', async () => {
    const author = await verifiedUser('res-update-author');
    const other = await verifiedUser('res-update-other');
    const otherAsset = await mediaAsset(other.accessToken, 'other.png');

    const created = await createPost(author.accessToken, '原始标题');
    const before = await readPost(created.id);

    await request(app.getHttpServer())
      .patch(`${API}/resources/${created.id}`)
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({ title: '被拒绝的标题', attachmentMediaIds: [otherAsset] })
      .expect(400);

    const after = await readPost(created.id);
    // 关键断言：请求被拒了，内容就必须是**原封不动**的
    expect(after.title).toBe(before.title);
    expect(after.body).toBe(before.body);
    expect(Number(after.version)).toBe(Number(before.version));
    expect(after.status).toBe(before.status);
  });

  it('#132 附件写入失败 → 内容写入必须整体回滚', async () => {
    const author = await verifiedUser('res-atomic-author');
    const asset = await mediaAsset(author.accessToken, 'own.png');

    const created = await createPost(author.accessToken, '回滚前的标题');
    const before = await readPost(created.id);

    // 故障注入点必须打在**仓储原型**上：
    // 事务内的 `manager.getRepository(X)` 是**新实例**，打在实例上不生效。
    //
    // ⚠️ 但 `Repository` 继承自 `EntityManager`，`save` 只存在于**同一个原型**上 ——
    //    原型级注入会命中**所有**仓储（包括内容写入）。
    //    所以这里必须**按实体类型**精确拦截：只让附件写失败，内容写照常成功。
    //    否则本用例会「假通过」——它会退化成「第一次写就失败」，根本测不到回滚。
    const attachmentRepo = dataSource.getRepository(ResourcePostAttachment);
    const repositoryPrototype = Object.getPrototypeOf(attachmentRepo) as {
      save: (entity: unknown, options?: unknown) => Promise<unknown>;
    };
    const originalSave = repositoryPrototype.save;
    jest
      .spyOn(repositoryPrototype, 'save')
      .mockImplementation(async function (this: unknown, entity: unknown, options?: unknown) {
        const target = Array.isArray(entity) ? entity[0] : entity;
        if (target instanceof ResourcePostAttachment) {
          throw new Error('注入故障：附件写入失败');
        }
        return originalSave.call(this, entity, options);
      });

    const response = await request(app.getHttpServer())
      .patch(`${API}/resources/${created.id}`)
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({ title: '不该留下的标题', attachmentMediaIds: [asset] });
    // eslint-disable-next-line no-console
    console.log('[#132] 响应：', response.status, JSON.stringify(response.body));
    expect(response.status).toBe(500);
    const after = await readPost(created.id);
    // 整体回滚：内容、版本、状态都必须回到原值
    expect(after.title).toBe(before.title);
    expect(Number(after.version)).toBe(Number(before.version));
    expect(after.status).toBe(before.status);
  });

  it('对照：不带附件字段的普通修改 → 照常成功', async () => {
    const author = await verifiedUser('res-plain-author');
    const created = await createPost(author.accessToken, '旧的标题内容');

    const updated = await request(app.getHttpServer())
      .patch(`${API}/resources/${created.id}`)
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({ title: '新的标题内容' })
      .expect(200);

    expect(updated.body.data.title).toBe('新的标题内容');
    expect(Number(updated.body.data.version)).toBe(Number(created.version) + 1);
    const after = await readPost(created.id);
    expect(after.title).toBe('新的标题内容');
  });

  it('对照：带本人合法附件的修改 → 附件真的被替换', async () => {
    const author = await verifiedUser('res-attach-author');
    const assetA = await mediaAsset(author.accessToken, 'a.png');
    const assetB = await mediaAsset(author.accessToken, 'b.png');

    const created = await createPost(author.accessToken);
    await request(app.getHttpServer())
      .patch(`${API}/resources/${created.id}`)
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({ attachmentMediaIds: [assetA] })
      .expect(200);
    expect(await attachmentMediaIds(created.id)).toEqual([assetA]);

    const updated = await request(app.getHttpServer())
      .patch(`${API}/resources/${created.id}`)
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send({ title: '换附件的标题', attachmentMediaIds: [assetB] })
      .expect(200);
    expect(updated.body.data.title).toBe('换附件的标题');
    expect(await attachmentMediaIds(created.id)).toEqual([assetB]);
  });
});
