import { Injectable } from '@nestjs/common';

export interface AuthIdentity {
  openid: string;
  unionid: string | null;
  nickname: string | null;
  source: 'wechat' | 'mock';
}

export interface AuthProvider {
  readonly name: string;
  /** 用登录凭据换取身份；失败时抛出异常 */
  exchange(code: string): Promise<AuthIdentity>;
  /** 提供方是否已配置可用 */
  available(): boolean;
}

export const MOCK_AUTH_PROVIDER = Symbol('MOCK_AUTH_PROVIDER');
export const WECHAT_AUTH_PROVIDER = Symbol('WECHAT_AUTH_PROVIDER');

/**
 * Mock 提供方：小程序尚未注册时使用。
 * code 形如 `mock:openid123`；留空则生成一次性 openid。
 */
@Injectable()
export class MockAuthProvider implements AuthProvider {
  readonly name = 'mock';

  async exchange(code: string): Promise<AuthIdentity> {
    const raw = (code ?? '').trim();
    let openid: string;
    if (!raw) {
      openid = `mock_${Math.random().toString(36).slice(2, 18)}`;
    } else if (raw.startsWith('mock:')) {
      openid = raw.slice(5).trim();
      if (!openid) throw new Error('Mock openid 不能为空');
    } else {
      openid = raw.startsWith('mock_') ? raw : `mock_${raw}`;
    }
    return { openid, unionid: null, nickname: null, source: 'mock' };
  }

  available(): boolean {
    return true;
  }
}
