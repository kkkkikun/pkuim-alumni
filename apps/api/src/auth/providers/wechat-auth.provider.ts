import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import type { AuthIdentity, AuthProvider } from './auth-provider';

/**
 * 微信登录失败的两种性质 —— **必须区分**：
 *
 * - `invalid_code`：微信明确拒绝了这个凭据（errcode 非 0、没有 openid、code 为空）。
 *   这是**客户端的问题**（code 过期 / 被用掉 / 不是真的 code），要让用户重新登录。
 * - `unavailable`：微信接口本身不可达（网络超时、连接被拒、微信挂了）。
 *   这是**服务端的问题**，让用户重试没有意义，要告诉用户稍后再试。
 *
 * ⚠️ 缺陷 #148：此前 provider 一律抛普通 `Error`，
 *    被统一异常过滤器按「非 HttpException」映射成 **500 INTERNAL_ERROR** ——
 *    用户明明是「登录凭据不对」，看到的却是「服务器内部错误」。
 *    现在由本类型携带性质，交给 `AuthService` 映射成正确的状态码与错误码。
 */
export type WechatAuthFailureKind = 'invalid_code' | 'unavailable';

export class WechatAuthError extends Error {
  constructor(
    readonly kind: WechatAuthFailureKind,
    message: string,
    /** 仅用于服务端日志的细节（不返回给客户端） */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'WechatAuthError';
  }
}

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
      throw new WechatAuthError('unavailable', '微信登录尚未配置');
    }
    if (!code) {
      throw new WechatAuthError('invalid_code', '缺少登录凭据');
    }
    const url = `${this.apiBase}/sns/jscode2session`;
    let response: { data?: unknown };
    try {
      response = await axios.get(url, {
        params: {
          appid: this.appId,
          secret: this.appSecret,
          js_code: code,
          grant_type: 'authorization_code',
        },
        timeout: 5000,
      });
    } catch (error) {
      // 网络层失败（超时 / 连接被拒 / DNS 失败）→ 微信侧不可用
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`微信登录接口不可达：${detail}`);
      throw new WechatAuthError('unavailable', '微信登录服务暂时不可用', detail);
    }
    const payload = response.data as {
      openid?: string;
      unionid?: string;
      errcode?: number;
      errmsg?: string;
    } | null;
    if (payload?.errcode) {
      this.logger.warn(`微信登录失败: ${payload.errcode} ${payload.errmsg ?? ''}`);
      throw new WechatAuthError(
        'invalid_code',
        '微信登录失败',
        `${payload.errcode} ${payload.errmsg ?? ''}`.trim(),
      );
    }
    if (!payload?.openid) {
      this.logger.warn('微信登录未返回 openid');
      throw new WechatAuthError('invalid_code', '微信登录未返回 openid');
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
