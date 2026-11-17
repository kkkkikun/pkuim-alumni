import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, login, resetDatabase } from '../helpers';

/**
 * 通知「标记已读」的语义（缺陷 #124 / #125）。
 *
 * 同一个模块里，两个端点对**同一个对象**给出**相反的语义**：
 *   GET  /notifications/:id      通知不存在 → **404 NOT_FOUND** ✓
 *   POST /notifications/:id/read 通知不存在 → **200「已读」** ✗（假成功）
 *
 * 根因（#124）：标记已读用的是条件更新
 * `WHERE id = :id AND userId = :userId`，但**没有看影响行数** ——
 * 影响 0 行（不存在 / 不是你的）也照样返回「已读」。
 *
 * 根因（#125）：这段更新逻辑在**控制器里重复实现**了一遍，
 * 而 `NotificationService.markRead()` 里还有一份**从未被调用**的同名实现
 * —— 两份实现迟早漂移，这正是「修了一处、另一处还错」的土壤。
 *
 * 反过来也要防误伤：自己的通知必须能标已读、重复标记必须幂等。
 */
const API = '/api/v1';

describe('通知标记已读的语义 (e2e)', () => {
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

  async function insertNotification(userId: number, title: string): Promise<number> {
    await dataSource.query(
      `INSERT INTO notifications (user_id, type, title, body, payload, read_at, created_at)
       VALUES (?, 'system', ?, '通知正文', NULL, NULL, NOW(3))`,
      [userId, title],
    );
    const [row] = await dataSource.query(
      'SELECT id FROM notifications WHERE title = ? ORDER BY id DESC LIMIT 1',
      [title],
    );
    return Number(row.id);
  }

  it('#124 标记不存在的通知 → 404（此前是 200「已读」的假成功）', async () => {
    const user = await login(app, 'notif-missing');

    const response = await server()
      .post(`${API}/notifications/999999/read`)
      .set('Authorization', `Bearer ${user.accessToken}`);

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('#124 标记别人的通知 → 404（不能改动他人数据，也不泄露其存在性）', async () => {
    const owner = await login(app, 'notif-owner');
    const other = await login(app, 'notif-other');
    const notificationId = await insertNotification(owner.userId, '别人的通知');

    const response = await server()
      .post(`${API}/notifications/${notificationId}/read`)
      .set('Authorization', `Bearer ${other.accessToken}`);

    expect(response.status).toBe(404);

    // 对方的通知必须仍是未读
    const [row] = await dataSource.query(
      'SELECT read_at FROM notifications WHERE id = ?',
      [notificationId],
    );
    expect(row.read_at).toBeNull();
  });

  it('#124 对照：标记自己的通知 → 200 且真的写入了已读时间', async () => {
    const user = await login(app, 'notif-own');
    const notificationId = await insertNotification(user.userId, '我自己的通知');

    const response = await server()
      .post(`${API}/notifications/${notificationId}/read`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    expect(response.body.data.read).toBe(true);

    const [row] = await dataSource.query(
      'SELECT read_at FROM notifications WHERE id = ?',
      [notificationId],
    );
    expect(row.read_at).not.toBeNull();
  });

  it('#124 对照：重复标记已读 → 仍然 200（幂等，不得变成 404）', async () => {
    const user = await login(app, 'notif-idempotent');
    const notificationId = await insertNotification(user.userId, '重复标记的通知');

    await server()
      .post(`${API}/notifications/${notificationId}/read`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    await server()
      .post(`${API}/notifications/${notificationId}/read`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    const [row] = await dataSource.query(
      'SELECT read_at FROM notifications WHERE id = ?',
      [notificationId],
    );
    expect(row.read_at).not.toBeNull();
  });

  it('#124 两个端点对「不存在」的语义必须一致（GET 404 / POST 404）', async () => {
    const user = await login(app, 'notif-consistent');

    const detail = await server()
      .get(`${API}/notifications/999999`)
      .set('Authorization', `Bearer ${user.accessToken}`);
    const read = await server()
      .post(`${API}/notifications/999999/read`)
      .set('Authorization', `Bearer ${user.accessToken}`);

    expect(detail.status).toBe(404);
    expect(read.status).toBe(404);
    expect(read.body.code).toBe(detail.body.code);
  });
});
