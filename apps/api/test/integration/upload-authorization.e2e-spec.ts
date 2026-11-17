import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, login, markVerified, resetDatabase } from '../helpers';

/**
 * 上传链路的**写入授权**（缺陷 #104）。
 *
 * 背景：`assertOwnership()` 的判定是
 *   「public 资产直接放行；private 资产只有上传者本人可取地址」。
 * 这对**下载**是对的（公开资产任何人都能看），
 * 但 `intent=upload` 返回的不是下载地址，而是**带写入能力的签名直传地址** ——
 * 拿到它就能把那个对象**覆盖掉**。
 *
 * 于是形成一条横向越权写入：
 *   乙 → `GET /uploads/{甲的public资产}/url?intent=upload` → 拿到写入地址
 *      → `POST /uploads/{id}/content?token=...` → **覆盖甲的文件**
 *
 * ⚠️ 既有测试只覆盖了「他人**私有**资产取**下载**地址 → 404」，
 *    「他人 **public** 资产取 **upload** 地址」这条路径从未被验证过。
 */
const API = '/api/v1';

/** 1x1 的最小 PNG（合法 PNG 头 + 结尾），足够通过白名单校验。 */
const PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** 与上面不同的一段字节，便于验证对象确实被换掉了。 */
const OTHER_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('上传写入授权（缺陷 #104）', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const ctx: { aliceToken?: string; bobToken?: string } = {};

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    // resetDatabase 会清空 users / user_sessions —— 令牌必须在重置之后签发
    const alice = await login(app, `up-authz-alice-${Date.now()}`, '上传甲');
    const bob = await login(app, `up-authz-bob-${Date.now()}`, '上传乙');
    ctx.aliceToken = alice.accessToken;
    ctx.bobToken = bob.accessToken;
    await markVerified(dataSource, alice.userId);
    await markVerified(dataSource, bob.userId);
  });

  const server = () => request(app.getHttpServer());

  /** 甲登记一个指定可见性的媒体资源。 */
  async function registerAsset(visibility: 'public' | 'private'): Promise<number> {
    const res = await server()
      .post(`${API}/uploads/records`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({
        fileName: '甲的文件.png',
        mimeType: 'image/png',
        size: PNG_BUFFER.length,
        visibility,
      })
      .expect(201);
    return res.body.data.id;
  }

  it('#104 他人对我的 public 资产索取 upload 直传地址 → 必须 404（写入能力不得外泄）', async () => {
    const assetId = await registerAsset('public');

    const res = await server()
      .get(`${API}/uploads/${assetId}/url?intent=upload`)
      .set('Authorization', `Bearer ${ctx.bobToken}`);

    expect(res.status).toBe(404);
    expect(res.body.data?.uploadUrl ?? res.body.data?.url).toBeFalsy();
  });

  it('#104 他人对我的 public 资产覆盖文件 → 必须失败（不得替换对象存储里的字节）', async () => {
    const assetId = await registerAsset('public');

    // 乙先拿到写入地址（修复前这里会成功）
    const target = await server()
      .get(`${API}/uploads/${assetId}/url?intent=upload`)
      .set('Authorization', `Bearer ${ctx.bobToken}`);
    const uploadUrl: string | undefined = target.body.data?.uploadUrl ?? target.body.data?.url;
    expect(uploadUrl).toBeFalsy();

    // 即便乙自己伪造一个地址（令牌是按 assetId 签的，拿不到就换资产）
    const own = await server()
      .post(`${API}/uploads/records`)
      .set('Authorization', `Bearer ${ctx.bobToken}`)
      .send({
        fileName: '乙的文件.png',
        mimeType: 'image/png',
        size: PNG_BUFFER.length,
        visibility: 'public',
      })
      .expect(201);
    const ownAssetId = own.body.data.id;

    // 乙拿**自己**的资产地址，但把路径改成甲的资产 → 令牌与 assetId 绑定，必须失败
    const ownTarget = await server()
      .get(`${API}/uploads/${ownAssetId}/url?intent=upload`)
      .set('Authorization', `Bearer ${ctx.bobToken}`)
      .expect(200);
    const ownUploadUrl: string = ownTarget.body.data.url;
    const forged = ownUploadUrl.replace(`/uploads/${ownAssetId}/content`, `/uploads/${assetId}/content`);

    const forgedRes = await server()
      .post(forged.replace(/^https?:\/\/[^/]+/, ''))
      .attach('file', OTHER_PNG_BUFFER, { filename: '恶意.png', contentType: 'image/png' });
    expect(forgedRes.status).toBeGreaterThanOrEqual(400);
  });

  it('对照：甲对自己的 public 资产取 upload 直传地址 → 200', async () => {
    const assetId = await registerAsset('public');

    await server()
      .get(`${API}/uploads/${assetId}/url?intent=upload`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .expect(200);
  });

  it('对照：乙对甲的 public 资产取**下载**地址 → 200（公开资产允许下载，这是设计意图）', async () => {
    const assetId = await registerAsset('public');

    await server()
      .get(`${API}/uploads/${assetId}/url`)
      .set('Authorization', `Bearer ${ctx.bobToken}`)
      .expect(200);
  });

  it('对照：乙对甲的 private 资产取 upload 直传地址 → 404（原本就正确）', async () => {
    const assetId = await registerAsset('private');

    await server()
      .get(`${API}/uploads/${assetId}/url?intent=upload`)
      .set('Authorization', `Bearer ${ctx.bobToken}`)
      .expect(404);
  });
});
