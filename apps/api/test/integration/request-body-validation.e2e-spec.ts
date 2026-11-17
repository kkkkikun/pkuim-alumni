import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, ensureAdmin, login, markVerified, resetDatabase } from '../helpers';

/**
 * 请求体校验盲区（e2e）。
 *
 * 背景（本轮新抓出的 2 个真实缺陷）：
 *   #88 `POST /uploads/records` 的请求体是**普通 interface**
 *        （`CreateUploadBody`）→ 运行时 metatype 是 `Object`，
 *        **ValidationPipe 完全跳过校验**：
 *          - `fileName: 123` → `filename.lastIndexOf` → **500**（应为 400）
 *          - `size: 'abc'` / `size: -999` → 落库时类型转换失败 → **500**
 *          - 契约之外的字段（bucket / objectKey）不被拒绝
 *   #89 `POST /events/:id/registrations` 的请求体是**内联对象字面量**
 *        （`{ note?: string }`）→ 同样 metatype 是 `Object` → 不校验，
 *        `note` 传对象会被直接塞进 TEXT 列。
 *
 * 这两个端点与 #79（管理端 12 个写端点）是**同一类**问题的漏网之鱼：
 * 「DTO 声明了」不等于「运行时真的会校验」——
 * 只有**带 class-validator 装饰器的类**才会被 ValidationPipe 处理，
 * 普通 `interface` / 内联字面量在运行时就是 `Object`，一律跳过。
 *
 * 断言策略：
 *   - 畸形请求体必须是 **400**（而不是 500，也不是悄悄接受）；
 *   - 畸形输入**不能落库**；
 *   - 合法请求仍然通过（DTO 不能把正常流程拦死）。
 */

const API = '/api/v1';
const ADMIN_PASSWORD = 'Admin@2026';

describe('请求体校验盲区 (e2e)', () => {
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

  async function userToken(openid: string) {
    const session = await login(app, openid);
    await markVerified(dataSource, session.userId);
    return session.accessToken as string;
  }

  async function publishedEvent(capacity = 20): Promise<number> {
    await dataSource.query(
      `INSERT INTO events (title, kind, capacity, registered_count, status, created_at, updated_at)
       VALUES ('请求体校验测试活动', '校友交流', ?, 0, 'published', NOW(3), NOW(3))`,
      [capacity],
    );
    const [row] = await dataSource.query('SELECT id FROM events ORDER BY id DESC LIMIT 1');
    return Number(row.id);
  }

  /* ------------------------- #88 媒体登记 ------------------------- */

  it('#88 媒体登记：fileName 不是字符串 → 400（不是 500）', async () => {
    const token = await userToken('body-shape');

    const response = await request(app.getHttpServer())
      .post(`${API}/uploads/records`)
      .set('Authorization', `Bearer ${token}`)
      .send({ fileName: 123, mimeType: 'image/png', size: 10 });

    expect(response.status).toBe(400);
    expect(response.body.message).toBeTruthy();

    // 畸形输入不能落库
    const rows = await dataSource.query('SELECT COUNT(*) AS total FROM media_assets');
    expect(Number(rows[0].total)).toBe(0);
  });

  it('#88 媒体登记：size 不是数字 / 负数 / 超上限 → 400', async () => {
    const token = await userToken('body-shape-size');

    for (const size of ['abc', -999, 10 * 1024 * 1024 + 1]) {
      const response = await request(app.getHttpServer())
        .post(`${API}/uploads/records`)
        .set('Authorization', `Bearer ${token}`)
        .send({ fileName: 'a.png', mimeType: 'image/png', size });

      expect(response.status).toBe(400);
    }

    const rows = await dataSource.query('SELECT COUNT(*) AS total FROM media_assets');
    expect(Number(rows[0].total)).toBe(0);
  });

  it('#88 媒体登记：缺字段 / 非法 mimeType → 400；合法请求仍然通过', async () => {
    const token = await userToken('body-shape-ok');

    // 缺 fileName
    await request(app.getHttpServer())
      .post(`${API}/uploads/records`)
      .set('Authorization', `Bearer ${token}`)
      .send({ mimeType: 'image/png', size: 10 })
      .expect(400);

    // mimeType 不在白名单
    await request(app.getHttpServer())
      .post(`${API}/uploads/records`)
      .set('Authorization', `Bearer ${token}`)
      .send({ fileName: 'a.png', mimeType: 'application/x-msdownload', size: 10 })
      .expect(400);

    // 合法请求不能被 DTO 拦死
    const ok = await request(app.getHttpServer())
      .post(`${API}/uploads/records`)
      .set('Authorization', `Bearer ${token}`)
      .send({ fileName: 'a.png', mimeType: 'image/png', size: 10 })
      .expect(201);
    expect(ok.body.data.fileName).toBe('a.png');
    expect(ok.body.data.size).toBe(10);
  });

  it('#88 媒体登记：契约之外的字段（bucket / objectKey）必须被剥掉', async () => {
    const token = await userToken('body-shape-extra');

    const response = await request(app.getHttpServer())
      .post(`${API}/uploads/records`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fileName: 'a.png',
        mimeType: 'image/png',
        size: 10,
        bucket: 'evil-bucket',
        objectKey: '../../etc/passwd',
      })
      .expect(201);

    // 存储位置必须由服务端决定，不能被客户端指定
    expect(response.body.data.bucket).toBe('nmg-private');
    expect(response.body.data.objectKey).not.toContain('..');
  });

  /* ------------------------- #89 活动报名 ------------------------- */

  it('#89 活动报名：note 不是字符串 / 超长 → 400（不能落库）', async () => {
    const eventId = await publishedEvent();
    const token = await userToken('body-shape-event');

    await request(app.getHttpServer())
      .post(`${API}/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${token}`)
      .send({ note: { evil: true } })
      .expect(400);

    await request(app.getHttpServer())
      .post(`${API}/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${token}`)
      .send({ note: 'x'.repeat(1000) })
      .expect(400);

    const rows = await dataSource.query(
      'SELECT COUNT(*) AS total FROM event_registrations WHERE event_id = ?',
      [eventId],
    );
    expect(Number(rows[0].total)).toBe(0);
  });

  it('#89 活动报名：合法请求仍然通过（DTO 不能把正常流程拦死）', async () => {
    const eventId = await publishedEvent();
    const token = await userToken('body-shape-event-ok');

    await request(app.getHttpServer())
      .post(`${API}/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${token}`)
      .send({ note: '希望参加' })
      .expect(201);

    // 不带 note 也要能报名（契约里 note 是可选的）
    const other = await userToken('body-shape-event-ok-2');
    await request(app.getHttpServer())
      .post(`${API}/events/${eventId}/registrations`)
      .set('Authorization', `Bearer ${other}`)
      .send({})
      .expect(201);
  });
});
