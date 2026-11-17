import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createTestApp, login, markVerified, resetDatabase } from '../helpers';

/**
 * 分页边界验证。
 *
 * 背景：所有列表接口共用 `PaginationQueryDto`（page ≥ 1，pageSize 1..100）。
 *       分页参数直接拼进 SQL 的 offset/limit，**一旦校验失效就是越界读取**：
 *       page=0 会算出负 offset，pageSize=0 会让 LIMIT 0 或除零。
 *       此外越界参数必须返回 400 而不是被静默纠正（静默纠正会让调用方
 *       以为自己翻到了第 1 页，实际拿的是空集）。
 */

const API = '/api/v1';

describe('分页边界', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  let token: string;

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
    await resetDatabase(dataSource);

    const session = await login(app, 'page-user', '分页用户');
    token = session.accessToken;
    await markVerified(dataSource, session.userId);
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => request(app.getHttpServer());

  it('默认分页参数生效（page=1, pageSize=20）', async () => {
    const res = await server()
      .get(`${API}/resources`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.data.meta.page).toBe(1);
    expect(res.body.data.meta.pageSize).toBe(20);
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });

  it('page=0 → 400', async () => {
    await server()
      .get(`${API}/resources?page=0`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('page=-1 → 400', async () => {
    await server()
      .get(`${API}/resources?page=-1`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('pageSize=0 → 400', async () => {
    await server()
      .get(`${API}/resources?pageSize=0`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('pageSize 超过上限（101）→ 400', async () => {
    await server()
      .get(`${API}/resources?pageSize=101`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('pageSize=100（上限）→ 允许', async () => {
    const res = await server()
      .get(`${API}/resources?pageSize=100`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.data.meta.pageSize).toBe(100);
  });

  it('非数字分页参数 → 400', async () => {
    await server()
      .get(`${API}/resources?page=abc`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);

    await server()
      .get(`${API}/resources?pageSize=xyz`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('超出总页数 → 200 且 items 为空，meta 自洽', async () => {
    const res = await server()
      .get(`${API}/resources?page=99999&pageSize=20`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.meta.page).toBe(99999);
    expect(res.body.data.meta.total).toBeGreaterThanOrEqual(0);
    expect(res.body.data.meta.totalPages).toBe(
      Math.ceil(res.body.data.meta.total / res.body.data.meta.pageSize),
    );
  });
});
