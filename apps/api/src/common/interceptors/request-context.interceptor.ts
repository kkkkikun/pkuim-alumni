import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { RequestContextService } from '../services/request-context.service';

/**
 * 把「当前请求的来源 IP」放进请求上下文（见 `RequestContextService`）。
 *
 * 目的：让审计日志能记下**来源 IP** —— `admin_action_logs.ip` 这一列
 * 建表至今从未被写过，管理端「来源 IP」列恒为空。
 *
 * 必须注册成**全局拦截器**，且要在写审计日志的调用链**之外层**，
 * 这样事务回调里也能随取随用。
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  constructor(private readonly context: RequestContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request & { ip?: string }>();
    const ip = typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null;
    return this.context.run({ ip }, () => next.handle());
  }
}
