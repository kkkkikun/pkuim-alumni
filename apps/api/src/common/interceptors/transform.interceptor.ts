import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { randomUUID } from 'node:crypto';
import { HEADER_REQUEST_ID } from '../constants';
import type { AuthenticatedRequest } from '../decorators';

/** 为每个请求生成/透传 requestId，并统一响应信封。 */
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, unknown> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const incoming = request.headers[HEADER_REQUEST_ID];
    const requestId = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
    request.requestId = requestId;

    return next.handle().pipe(
      map((data) => {
        // 已经是信封结构的响应不再包装
        if (data && typeof data === 'object' && 'code' in (data as Record<string, unknown>)) {
          return { ...(data as Record<string, unknown>), requestId };
        }
        return { code: 'OK', message: 'success', data: data ?? null, requestId };
      }),
    );
  }
}
