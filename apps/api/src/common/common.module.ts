import { Global, Module } from '@nestjs/common';
import { RequestContextService } from './services/request-context.service';

/**
 * 全局基础模块。
 *
 * 目前只提供**请求上下文**（来源 IP）—— 它要被管理端的审计写入、
 * 全局拦截器等多个模块共用，必须是**同一个实例**（`AsyncLocalStorage` 挂在实例上），
 * 所以用 `@Global()` 导出，任何模块都能注入。
 */
@Global()
@Module({
  providers: [RequestContextService],
  exports: [RequestContextService],
})
export class CommonModule {}
