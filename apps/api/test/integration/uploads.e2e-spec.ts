import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, login, markVerified, resetDatabase } from '../helpers';

/**
 * 文件上传链路补测（直传 + 登记 + 直传地址 + 字节流接收）。
 *
 * 背景：上传是**唯一一条真正依赖外部对象存储**的链路，
 *       此前从未被集成测试调用过 —— 端点覆盖分析里
 *       `POST /uploads`、`POST /uploads/records`、`POST /uploads/:id/content`
 *       三条全未覆盖。
 *       这类链路最容易坏在「配置对但没人调过」上：
 *       桶不存在、MIME 白名单、上传令牌签名、对象存储连通性，
 *       任何一处出问题都会变成运行时的 500。
 *
 * 本套件真实连 MinIO，把整条链路跑通，并验证负向边界。
 */

const API = '/api/v1';

/** 1x1 的最小 PNG（合法 PNG 头 + 结尾），足够通过白名单校验。 */
const PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('文件上传链路', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const ctx: {
    aliceToken?: string;
    bobToken?: string;
    assetId?: number;
    uploadToken?: string;
  } = {};

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
    await resetDatabase(dataSource);

    const alice = await login(app, 'up-alice', '上传甲');
    const bob = await login(app, 'up-bob', '上传乙');
    ctx.aliceToken = alice.accessToken;
    ctx.bobToken = bob.accessToken;
    await markVerified(dataSource, alice.userId);
    await markVerified(dataSource, bob.userId);
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => request(app.getHttpServer());

  /* ------------------------- 路径二：登记 + 直传 ------------------------- */

  it('登记媒体资源 → 返回直传地址与上传令牌', async () => {
    const created = await server()
      .post(`${API}/uploads/records`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({
        fileName: 'test.png',
        mimeType: 'image/png',
        size: PNG_BUFFER.length,
        visibility: 'private',
      })
      .expect(201);

    ctx.assetId = created.body.data.id as number;
    expect(created.body.data.fileName).toBe('test.png');
    expect(created.body.data.visibility).toBe('private');
    expect(created.body.data.objectKey).toContain('private/');

    const uploadUrl = String(created.body.data.uploadUrl);
    expect(uploadUrl).toContain(`/uploads/${ctx.assetId}/content`);
    const tokenMatch = /token=([\w.-]+)/.exec(uploadUrl);
    expect(tokenMatch).not.toBeNull();
    ctx.uploadToken = tokenMatch![1];
  });

  it('凭上传令牌接收字节流 → 写入对象存储并回写文件大小', async () => {
    const received = await server()
      .post(`${API}/uploads/${ctx.assetId}/content?token=${ctx.uploadToken}`)
      .attach('file', PNG_BUFFER, { filename: 'test.png', contentType: 'image/png' })
      .expect(201);

    expect(received.body.data.id).toBe(ctx.assetId);
    expect(received.body.data.size).toBe(PNG_BUFFER.length);
    expect(received.body.data.mimeType).toBe('image/png');
  });

  it('上传令牌无效或过期 → 401（拒绝写入）', async () => {
    await server()
      .post(`${API}/uploads/${ctx.assetId}/content?token=forged.token`)
      .attach('file', PNG_BUFFER, { filename: 'test.png', contentType: 'image/png' })
      .expect(401);
  });

  /* ------------------------- 路径一：直传 ------------------------- */

  it('直传文件（multipart）→ 登记并写入对象存储', async () => {
    const uploaded = await server()
      .post(`${API}/uploads`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .field('visibility', 'private')
      .attach('file', PNG_BUFFER, { filename: 'direct.png', contentType: 'image/png' })
      .expect(201);

    expect(uploaded.body.data.fileName).toBe('direct.png');
    expect(uploaded.body.data.visibility).toBe('private');
    expect(uploaded.body.data.size).toBe(PNG_BUFFER.length);
  });

  it('直传公开可见文件 → 返回可访问的下载地址', async () => {
    const uploaded = await server()
      .post(`${API}/uploads`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .field('visibility', 'public')
      .attach('file', PNG_BUFFER, { filename: 'public.png', contentType: 'image/png' })
      .expect(201);

    expect(uploaded.body.data.visibility).toBe('public');
    expect(String(uploaded.body.data.url)).toContain('http');
  });

  /* ------------------------- 负向边界 ------------------------- */

  it('不支持的文件类型 / 扩展名 → 400', async () => {
    await server()
      .post(`${API}/uploads/records`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({ fileName: 'evil.exe', mimeType: 'application/octet-stream', size: 10 })
      .expect(400);

    await server()
      .post(`${API}/uploads/records`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({ fileName: 'note.txt', mimeType: 'text/plain', size: 10 })
      .expect(400);
  });

  it('未登录不能登记 / 直传 → 401', async () => {
    await server()
      .post(`${API}/uploads/records`)
      .send({ fileName: 'x.png', mimeType: 'image/png', size: 10 })
      .expect(401);

    await server()
      .post(`${API}/uploads`)
      .attach('file', PNG_BUFFER, { filename: 'x.png', contentType: 'image/png' })
      .expect(401);
  });

  it('取下载地址需登录；他人资产不可取 → 404', async () => {
    // 本人取自己的资产 → 200
    await server()
      .get(`${API}/uploads/${ctx.assetId}/url`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(200);

    // 匿名 → 401
    await server().get(`${API}/uploads/${ctx.assetId}/url`).expect(401);

    // **他人**取同一资产 → 不得泄露私有文件的下载地址
    await server()
      .get(`${API}/uploads/${ctx.assetId}/url`)
      .set('Authorization', `Bearer ${ctx.bobToken}`)
      .expect(404);
  });
});
