import { NestFactory, Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { buildValidationPipe } from './common/pipes/validation.pipe';
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

  const cors = process.env.CORS_ORIGINS ?? '*';
  app.enableCors({
    origin: cors === '*' ? true : cors.split(',').map((item) => item.trim()),
    credentials: true,
  });

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
