import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import type { AuthIdentity, AuthProvider } from './auth-provider';

/**
 * 微信提供方：code2session。
 * 真实 openid / session_key 只在服务端处理，绝不下发给客户端。
 */
@Injectable()
export class WechatAuthProvider implements AuthProvider {
  readonly name = 'wechat';
  private readonly logger = new Logger(WechatAuthProvider.name);

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly apiBase: string = 'https://api.weixin.qq.com',
  ) {}

  async exchange(code: string): Promise<AuthIdentity> {
    if (!this.available()) {
      throw new Error('微信登录尚未配置');
    }
    if (!code) {
      throw new Error('缺少登录凭据');
    }
    const url = `${this.apiBase}/sns/jscode2session`;
    const response = await axios.get(url, {
      params: {
        appid: this.appId,
        secret: this.appSecret,
        js_code: code,
        grant_type: 'authorization_code',
      },
      timeout: 5000,
    });
    const payload = response.data as {
      openid?: string;
      unionid?: string;
      errcode?: number;
      errmsg?: string;
    };
    if (payload.errcode) {
      this.logger.warn(`微信登录失败: ${payload.errcode} ${payload.errmsg ?? ''}`);
      throw new Error(`微信登录失败: ${payload.errmsg ?? payload.errcode}`);
    }
    if (!payload.openid) {
      throw new Error('微信登录未返回 openid');
    }
    return {
      openid: payload.openid,
      unionid: payload.unionid ?? null,
      nickname: null,
      source: 'wechat',
    };
  }

  available(): boolean {
    return Boolean(this.appId && this.appSecret);
  }
}
