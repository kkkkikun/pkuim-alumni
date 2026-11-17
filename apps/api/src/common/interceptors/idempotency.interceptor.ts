import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, QueryFailedError } from 'typeorm';
import { Observable, catchError, from, mergeMap, of, switchMap, throwError } from 'rxjs';
import { HEADER_IDEMPOTENCY_KEY, ResponseCode } from '../constants';
import type { AuthenticatedRequest } from '../decorators';
import { IdempotencyRecord } from '../../database/entities/system.entity';

/**
 * 幂等拦截器：写接口携带 `Idempotency-Key` 时，
 * 同一 (scope, key) 只执行一次，后续请求回放首次响应。
 * 数据库唯一索引 uk_idempotency(scope, idem_key) 兜底并发。
 *
 * 生命周期（缺陷 #101 ~ #103 修完后的语义）：
 *   1) **成功** → 记录状态 `completed` + 存档响应体 → 后续同键同体回放（200）；
 *   2) **失败** → **释放**幂等键 → 客户端可以用**同一个键**安全重试
 *      （幂等键的本职就是「安全重试」，失败后把键卡住等于让重试永远失败）；
 *   3) **过期**（超过 `expires_at`，默认 24 小时）→ 释放旧记录 → 本次重新执行，
 *      而不是回放一份可能早已过时的响应（docs/API-SPEC.md §13「在有效期内」）。
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(private readonly dataSource: DataSource) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest & { body?: unknown }>();
    const method = request.method.toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return next.handle();
    }

    const header = request.headers[HEADER_IDEMPOTENCY_KEY];
    const idemKey = typeof header === 'string' && header.length > 0 ? header : null;
    if (!idemKey) {
      return next.handle();
    }

    const userId = request.user?.id ?? null;
    // 匿名请求**不启用幂等**：
    //   匿名写接口（登录等）无法按用户隔离幂等键 —— 不同用户共用同一 scope 时，
    //   后一个请求会拿到前一个请求的**响应回放**（登录接口会回放他人令牌）。
    //   与其冒这个风险，不如对匿名请求直接放行。
    if (userId === null) {
      return next.handle();
    }

    // scope 必须包含用户维度：唯一索引是 (scope, idem_key)，
    // 若 scope 只有「方法 + 路径」，两个用户使用同一幂等键时
    // 后者会拿到前者的响应回放（跨用户数据泄露）。
    //
    // ⚠️ scope 里的「路径」必须是**实际路径**（含资源 id），不能是**路由模板**（缺陷 #140）：
    //   路由模板形如 `/connections/:id/contact-grant` → 无论打的是 17 号还是 18 号连接，
    //   都落进**同一个 scope** → 第二个请求被当成「回放」，
    //   返回第一个资源的响应，而第二个资源**根本没有被写入** ——
    //   客户端却收到 200，像是成功了（静默的数据丢失）。
    //   实际路径（`request.originalUrl`）才是「这次请求打到了哪里」的唯一标识。
    const actualUrl = request.originalUrl ?? request.url ?? request.path ?? '';
    const actualPath = actualUrl.split('?')[0];
    const scope = `${method}:${actualPath}:u${userId}`;
    // 请求哈希除了请求体，还要覆盖**方法 + 实际路径（含查询串）**：
    //   同一路径但查询串不同（如分页参数）也是**不同的请求**，
    //   必须按契约返回 409 `IDEMPOTENCY_CONFLICT`，而不是回放另一份响应。
    const requestHash = createHash('sha256')
      .update(`${method}\n${actualUrl}\n${JSON.stringify(request.body ?? {})}`)
      .digest('hex');

    return from(this.claim(scope, idemKey, userId, requestHash)).pipe(
      switchMap((claim) => {
        if (claim.kind === 'replay') {
          // 回放必须返回 200 OK：POST 默认 201，若不改状态码，
          // 客户端/压测会把「幂等回放」误判为「又创建了一条」。
          const res = context.switchToHttp().getResponse();
          if (res && typeof res.status === 'function') {
            res.status(HttpStatus.OK);
            if (typeof res.setHeader === 'function') {
              res.setHeader('Idempotent-Replay', 'true');
            }
          }
          return of(claim.response);
        }
        if (claim.kind === 'conflict') {
          throw this.idempotencyConflict('幂等键正在处理中，请稍后重试');
        }

        // 业务真正执行。注意区分「业务失败」与「业务成功但存档失败」——
        // 前者要释放幂等键让客户端能重试，后者绝不能释放（否则会重复执行）。
        let handlerSucceeded = false;
        return next.handle().pipe(
          switchMap((value) => {
            handlerSucceeded = true;
            return from(this.complete(scope, idemKey, value)).pipe(
              switchMap(() => of(value)),
              // ⚠️ 存档失败但业务已成功：把成功响应还给客户端。
              //    若这里抛错，客户端会以为写失败而重试 →
              //    重试又会因为记录仍在 in_progress 拿到 409 → 客户端彻底卡住。
              //    记录保留（防止重复执行），失败原因落日志。
              catchError((error) => {
                this.logger.error(
                  `幂等响应存档失败（scope=${scope}）：${(error as Error).message}`,
                );
                return of(value);
              }),
            );
          }),
          catchError((error) => {
            if (handlerSucceeded) {
              // 业务已成功 → 保留记录，绝不重复执行
              return throwError(() => error);
            }
            // ⚠️ 业务失败 → 释放幂等键（缺陷 #101）。
            //    修复前记录永远停在 in_progress，
            //    客户端用同一个键重试只会拿到 409「正在处理中」——
            //    幂等键反而成了「一次失败、永不重试」的地雷。
            return from(this.release(scope, idemKey)).pipe(
              mergeMap(() => throwError(() => error)),
              catchError(() => throwError(() => error)),
            );
          }),
        );
      }),
    );
  }

  /**
   * 占用幂等键。
   *
   * @returns 'claimed' = 本次执行；'replay' = 回放已完成请求的响应；
   *          'conflict' = 同一个键正在处理中
   */
  private async claim(
    scope: string,
    idemKey: string,
    userId: number | null,
    requestHash: string,
  ): Promise<
    | { kind: 'claimed' }
    | { kind: 'replay'; response: unknown }
    | { kind: 'conflict' }
  > {
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);
    const repo = this.dataSource.getRepository(IdempotencyRecord);
    try {
      await repo.save({
        scope,
        idemKey,
        userId,
        requestHash,
        status: 'in_progress',
        expiresAt,
      });
      return { kind: 'claimed' };
    } catch (error) {
      if (!(error instanceof QueryFailedError)) throw error;
      let existing = await repo.findOne({ where: { scope, idemKey } });
      if (!existing) throw error;

      // ⚠️ 已过有效期（缺陷 #102）：`expires_at` 修复前**只写不读**，
      //    于是「24 小时有效期」形同虚设 —— 过期后仍然回放旧响应，
      //    而且记录永不过期（表无限增长）。
      //    现在过期即释放：本次重新执行，而不是回放一份早已过时的响应。
      if (existing.expiresAt && existing.expiresAt.getTime() <= Date.now()) {
        await repo.delete({ id: existing.id });
        try {
          await repo.save({
            scope,
            idemKey,
            userId,
            requestHash,
            status: 'in_progress',
            expiresAt,
          });
          return { kind: 'claimed' };
        } catch (retryError) {
          if (!(retryError instanceof QueryFailedError)) throw retryError;
          // 并发：另一个请求刚好抢到 → 按它的状态判定
          existing = await repo.findOne({ where: { scope, idemKey } });
          if (!existing) throw retryError;
        }
      }

      if (existing.requestHash !== requestHash) {
        throw this.idempotencyConflict('幂等键已用于不同的请求内容');
      }
      if (existing.status === 'completed') {
        return { kind: 'replay', response: existing.responseBody };
      }
      return { kind: 'conflict' };
    }
  }

  /** 业务失败：释放幂等键，让客户端可以用同一个键重试。 */
  private async release(scope: string, idemKey: string): Promise<void> {
    try {
      await this.dataSource.getRepository(IdempotencyRecord).delete({ scope, idemKey });
    } catch (error) {
      this.logger.warn(
        `释放幂等键失败（scope=${scope}）：${(error as Error).message}（该键将保持占用直到过期）`,
      );
    }
  }

  private async complete(scope: string, idemKey: string, value: unknown): Promise<void> {
    // ⚠️ 这里必须用**参数绑定**的原生 SQL：
    //   1) `update(..., { responseBody: () => JSON.stringify(v) })` —— TypeORM 会把函数体
    //      当作裸 SQL 拼进语句，JSON 文本没有引号 → "You have an error in your SQL syntax"；
    //   2) `update(..., { responseBody: v })` —— TypeORM 对 JSON 列做内联序列化，
    //      同样会产出无引号的 JSON 字面量 → 同样的语法错误。
    // 参数绑定时 mysql2 会把 JSON 作为字符串参数传入，MySQL 再解析为 JSON 列值。
    await this.dataSource.query(
      'UPDATE `idempotency_records` SET `status` = ?, `response_body` = ? WHERE `scope` = ? AND `idem_key` = ?',
      ['completed', JSON.stringify(value ?? null), scope, idemKey],
    );
  }

  /**
   * 幂等冲突必须返回**专用**错误码 `IDEMPOTENCY_CONFLICT`，
   * 而不是通用的 `CONFLICT`（缺陷 #103）。
   *
   * 依据：`packages/contracts/src/common.ts` 的 ErrorCode 里有这一项，
   * `docs/CONCURRENCY-DESIGN.md` §66 也写明「请求体哈希不一致返回 `IDEMPOTENCY_CONFLICT`」。
   * 修复前抛的是普通 `ConflictException` → 被统一异常过滤器映射成 `CONFLICT`
   * → 契约里这个错误码**从来不会被返回**，客户端按契约判断永远匹配不上。
   */
  private idempotencyConflict(message: string): HttpException {
    return new HttpException(
      { code: ResponseCode.IDEMPOTENCY_CONFLICT, message },
      HttpStatus.CONFLICT,
    );
  }
}
