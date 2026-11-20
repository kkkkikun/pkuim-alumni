import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { AuthService } from './auth/auth.service';
import { configurations } from './config/configuration';
import { assertRuntimeConfig } from './config/config-validation';
import { AlumniStageGuard } from './common/guards/alumni-stage.guard';
import { AUTH_CONTEXT, JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { RateLimitGuard } from './common/guards/rate-limit.guard';
import { entities } from './database/entities';
import { migrations } from './database/migrations';
import { AdminModule } from './modules/admin/admin.module';
import { AlumniModule } from './modules/alumni/alumni.module';
import { ConnectionsModule } from './modules/connections/connections.module';
import { ContentModule } from './modules/content/content.module';
import { DirectoryModule } from './modules/directory/directory.module';
import { EventsModule } from './modules/events/events.module';
import { MeModule } from './modules/me/me.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ResourcesModule } from './modules/resources/resources.module';
import { SystemModule } from './modules/system/system.module';
import { UploadsModule } from './modules/uploads/uploads.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: configurations,
      envFilePath: ['.env'],
      // 启动期配置校验：生产态缺 JWT_SECRET / 数据库口令 / MinIO 密钥，
      // 或 CORS 仍为 `*`、或 AUTH_MODE=mock 时**拒绝启动**（见 config/config-validation.ts）。
      validate: assertRuntimeConfig,
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'mysql' as const,
        host: config.get<string>('database.host'),
        port: config.get<number>('database.port'),
        username: config.get<string>('database.username'),
        password: config.get<string>('database.password'),
        database: config.get<string>('database.database'),
        entities,
        migrations,
        synchronize: false,
        migrationsRun: false,
        logging: config.get<boolean>('database.logging') ? ['error', 'warn', 'query'] : ['error'],
        timezone: 'Z',
        charset: 'utf8mb4',
        extra: {
          connectionLimit: 20,
          // BIGINT 主键统一以 number 返回（与 data-source.ts 一致）。
          // 否则 API 返回的 id 是字符串，导致前端类型不一致、
          // 且 dto.targetUserId === fromUserId 这类严格比较失效。
          supportBigNumbers: true,
          bigNumberStrings: false,
        },
      }),
    }),
    AuthModule,
    MeModule,
    AlumniModule,
    DirectoryModule,
    ConnectionsModule,
    ResourcesModule,
    EventsModule,
    ContentModule,
    NotificationsModule,
    UploadsModule,
    AdminModule,
    SystemModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: AUTH_CONTEXT, useExisting: AuthService },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: AlumniStageGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}
