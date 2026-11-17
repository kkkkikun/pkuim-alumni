import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ResponseCode } from '../constants';
import type { AuthenticatedRequest } from '../decorators';

/**
 * 统一异常出口：任何异常都返回 {code, message, data, requestId}。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<AuthenticatedRequest>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: string = ResponseCode.INTERNAL_ERROR;
    let message = '服务器内部错误';
    let details: unknown = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
        code = this.codeFromStatus(status);
      } else if (body && typeof body === 'object') {
        const payload = body as { message?: string | string[]; code?: string; details?: unknown };
        const raw = payload.message;
        if (Array.isArray(raw)) {
          message = raw.join('；');
          details = { errors: raw };
        } else if (typeof raw === 'string') {
          message = raw;
        }
        if (payload.code) {
          code = payload.code;
        } else {
          code = this.codeFromStatus(status);
        }
        if (payload.details) details = payload.details;
      }
    } else if (exception instanceof Error) {
      this.logger.error(`未处理异常: ${exception.message}`, exception.stack);
      message = process.env.NODE_ENV === 'production' ? '服务器内部错误' : exception.message;
    }

    if (status >= 500) {
      this.logger.error(`${request.method} ${request.url} -> ${status} ${message}`);
    } else {
      this.logger.warn(`${request.method} ${request.url} -> ${status} ${code} ${message}`);
    }

    response.status(status).json({
      code,
      message,
      data: null,
      details: details ?? null,
      requestId: request.requestId ?? null,
    });
  }

  private codeFromStatus(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return ResponseCode.VALIDATION_ERROR;
      case HttpStatus.UNAUTHORIZED:
        return ResponseCode.AUTH_REQUIRED;
      case HttpStatus.FORBIDDEN:
        return ResponseCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ResponseCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ResponseCode.CONFLICT;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ResponseCode.RATE_LIMITED;
      default:
        return ResponseCode.INTERNAL_ERROR;
    }
  }
}
