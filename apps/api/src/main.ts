import { NestFactory, Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { buildValidationPipe } from './common/pipes/validation.pipe';
import { applyHttpHardening } from './common/middleware/apply-http-hardening';
import { API_PREFIX } from './common/constants';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  app.setGlobalPrefix(API_PREFIX, { exclude: ['healthz'] });
  app.useGlobalPipes(buildValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  // 顺序要求：幂等拦截器在最外层，才能把「已包装」的响应体写入幂等记录；
  // TransformInterceptor 在内层，先把返回值包装成 {code,message,data}。
  app.useGlobalInterceptors(new IdempotencyInterceptor(app.get(DataSource)));
  app.useGlobalInterceptors(new TransformInterceptor());

  // 安全响应头 + CORS 白名单（与集成测试共用同一份实现，见 common/middleware/apply-http-hardening.ts）。
  // ⚠️ 此前这里是 `origin: cors === '*' ? true : ...` + `credentials: true`：
  //    等于「反射任意 Origin 且允许携带凭据」，正式部署必须收敛到具体域名。
  applyHttpHardening(app);

  // ---- 反向代理信任（限流按真实客户端 IP 计数的前提）------------------
  // ⚠️ 此前**没有**设置 trust proxy：Express 取到的 `req.ip` 是直连对端地址，
  //    也就是 **nginx 容器的 IP**。于是所有走 nginx 的匿名请求（浏览、登录、
  //    直传登记）都落进**同一个 IP 计数桶** —— 限流实际变成「全站共享配额」，
  //    且无法区分攻击者。API 端口只绑 127.0.0.1（仅 nginx 可达），
  //    因此信任 1 跳的 X-Forwarded-For 是安全的。
  //    跳数可用 TRUST_PROXY_HOPS 调整；设为 0 表示不信任任何代理。
  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 1);
  if (Number.isInteger(trustProxyHops) && trustProxyHops > 0) {
    const instance = app.getHttpAdapter().getInstance?.() as
      | { set?: (key: string, value: unknown) => void }
      | undefined;
    instance?.set?.('trust proxy', trustProxyHops);
  }

  const swaggerConfig = new DocumentBuilder()
    .setTitle('内蒙古北京大学校友会数字化平台 API')
    .setDescription('校友通讯录、双向连接、资源审核、活动报名与通知的 REST 接口')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  const port = Number(process.env.PORT ?? 8000);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`[nmg-api] listening on :${port}${API_PREFIX}`);
}

void bootstrap();
