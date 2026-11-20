import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 请求上下文（当前请求的来源 IP）。
 *
 * ⚠️ 为什么需要它：`admin_action_logs.ip` 这一列**从建表起就从未被写过** ——
 *    列表接口却把 `ip` 字段返回给管理端，于是「来源 IP」列**恒为空**，
 *    事后追溯时拿不到任何来源信息。
 *
 *    而管理端写接口的审计写入发生在 service 深处（有时还在事务回调里），
 *    一路把 `request` 传下去既啰嗦又容易漏 —— 这里用 `AsyncLocalStorage`
 *    把「当前请求」隐式带进整个调用链：中间件/拦截器写进去，
 *    审计写入时随取随用。
 *
 *    取不到时返回 null（**不编造**），与「此前恒为空」不同的是：
 *    现在有值就有值，没有值就是「这次请求确实拿不到 IP」。
 */

export interface RequestContextValue {
  /** 客户端 IP（已按 Express 的 `trust proxy` 设置解析）。 */
  ip: string | null;
}

@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<RequestContextValue>();

  /** 在给定上下文里执行（请求进入时调用）。 */
  run<T>(value: RequestContextValue, fn: () => T): T {
    return this.storage.run(value, fn);
  }

  /** 当前请求的客户端 IP；不在请求上下文里时为 null。 */
  get ip(): string | null {
    return this.storage.getStore()?.ip ?? null;
  }
}
