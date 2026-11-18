import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTestApp, resetDatabase } from '../helpers';

/**
 * 微信登录失败语义（缺陷 #148 的对照用例）。
 *
 * ⚠️ 缺陷 #148：微信拒绝登录凭据时，服务端返回 **500 INTERNAL_ERROR**，
 *    契约里的 `AUTH_FAILED`（401）从未在微信登录路径上出现过。
 *    用户明明是「登录码不对」，看到的却是「服务器内部错误」。
 *
 * 本用例用**本地假微信服务器**（`WECHAT_API_BASE` 是现成的测试缝）精确制造四种情形：
 *
 *   | js_code 前缀        | 假服务器行为            | 期望响应                        |
 *   |---------------------|-------------------------|---------------------------------|
 *   | `valid_`            | 返回 openid             | 200，登录成功                   |
 *   | `errcode_`          | 返回 errcode=40029      | 401 AUTH_FAILED（凭据无效）     |
 *   | `noopenid_`         | 返回 200 但没有 openid  | 401 AUTH_FAILED（凭据无效）     |
 *   | `unreachable_`      | 直接掐断连接            | 502 INTERNAL_ERROR（微信不可达）|
 *
 * ⚠️ **防误报断言**：每个用例都断言假服务器**确实收到了请求**。
 *    没有这条断言，测试可能「因为别的原因绿」——
 *    比如环境变量没生效、请求打到了真实微信 API（同样会返回 40029），
 *    那样「401」就成了假阳性。
 */
interface FakeWechat {
  baseUrl: string;
  requests: string[];
  close: () => Promise<void>;
}

async function startFakeWechat(): Promise<FakeWechat> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const code = url.searchParams.get('js_code') ?? '';
    requests.push(code);
    if (code.startsWith('unreachable_')) {
      // 模拟「微信接口不可达」：直接掐断连接（axios 会拿到 ECONNRESET）
      req.socket.destroy();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (code.startsWith('valid_')) {
      res.end(
        JSON.stringify({ openid: 'o_fake_openid_001', session_key: 'sk_fake', unionid: 'u_fake' }),
      );
      return;
    }
    if (code.startsWith('noopenid_')) {
      res.end(JSON.stringify({ session_key: 'sk_fake' }));
      return;
    }
    // 其余一律按「微信拒绝凭据」处理（errcode 40029）
    res.end(
      JSON.stringify({ errcode: 40029, errmsg: 'invalid code, hints: [req_id: fake-secret-hint]' }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe('微信登录 · 失败语义（缺陷 #148）', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let fake: FakeWechat;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    fake = await startFakeWechat();
    // 必须在**应用启动前**改环境变量：ConfigService 的工厂在启动时求值一次，
    // 之后再改 process.env 不会生效。
    for (const key of ['WECHAT_APP_ID', 'WECHAT_APP_SECRET', 'WECHAT_API_BASE', 'AUTH_MODE']) {
      savedEnv[key] = process.env[key];
    }
    process.env.WECHAT_APP_ID = 'wx_fake_appid';
    process.env.WECHAT_APP_SECRET = 'fake_app_secret';
    process.env.WECHAT_API_BASE = fake.baseUrl;
    process.env.AUTH_MODE = 'both';
    ({ app, dataSource } = await createTestApp());
  });

  afterAll(async () => {
    await app?.close();
    await fake?.close();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    fake.requests.length = 0;
  });

  it('微信拒绝凭据（errcode）→ 401 AUTH_FAILED，且不泄露微信内部细节', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/wechat/login')
      .send({ code: 'errcode_code_0001' })
      .expect(401);

    expect(response.body.code).toBe('AUTH_FAILED');
    expect(response.body.data).toBeNull();
    // 微信返回的 errmsg 里带 hints / req_id —— 只进服务端日志，不返回给客户端
    expect(JSON.stringify(response.body)).not.toContain('hints');
    expect(JSON.stringify(response.body)).not.toContain('fake-secret-hint');
    // 防误报：请求必须真的打到了假服务器
    expect(fake.requests).toContain('errcode_code_0001');
  });

  it('微信返回 200 但没有 openid → 401 AUTH_FAILED（不是 500）', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/wechat/login')
      .send({ code: 'noopenid_code_0002' })
      .expect(401);

    expect(response.body.code).toBe('AUTH_FAILED');
    expect(fake.requests).toContain('noopenid_code_0002');
  });

  it('微信接口不可达 → 502 INTERNAL_ERROR（区分「服务端故障」与「凭据无效」）', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/wechat/login')
      .send({ code: 'unreachable_code_0003' })
      .expect(502);

    expect(response.body.code).toBe('INTERNAL_ERROR');
    expect(fake.requests).toContain('unreachable_code_0003');
  });

  it('正常凭据 → 200，签发令牌并落库', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/wechat/login')
      .send({ code: 'valid_code_0004' })
      .expect(200);

    expect(response.body.code).toBe('OK');
    expect(response.body.data.accessToken).toEqual(expect.any(String));
    expect(response.body.data.user.openid).toBe('o_fake_openid_001');
    expect(response.body.data.stage).toBe('logged_in');
    expect(fake.requests).toContain('valid_code_0004');

    const rows = await dataSource.query('SELECT openid FROM users WHERE openid = ?', [
      'o_fake_openid_001',
    ]);
    expect(rows).toHaveLength(1);
  });

  it('登录失败不会留下任何用户行（凭据无效不建号）', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/wechat/login')
      .send({ code: 'errcode_code_0005' })
      .expect(401);

    const rows = await dataSource.query('SELECT id FROM users');
    expect(rows).toHaveLength(0);
  });

  it('code 长度不合法 → 400 VALIDATION_ERROR（DTO 拦截，不进微信）', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/wechat/login')
      .send({ code: 'ab' })
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(fake.requests).toHaveLength(0);
  });
});
