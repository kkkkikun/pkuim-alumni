import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AdminUser,
  AdminUserRole,
  Permission,
  Role,
  RolePermission,
} from '../database/entities/admin.entity';
import { AlumniProfile, PrivateContact } from '../database/entities/alumni.entity';
import { User, UserSession } from '../database/entities/user.entity';
import { parseDurationToSeconds } from '../common/utils/duration';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MOCK_AUTH_PROVIDER, MockAuthProvider, WECHAT_AUTH_PROVIDER } from './providers/auth-provider';
import { WechatAuthProvider } from './providers/wechat-auth.provider';
import { SessionService } from './session.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      UserSession,
      AlumniProfile,
      PrivateContact,
      AdminUser,
      AdminUserRole,
      Role,
      RolePermission,
      Permission,
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('app.jwtSecret'),
        signOptions: {
          expiresIn: parseDurationToSeconds(config.get<string>('app.jwtAccessTtl', '2h')),
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    { provide: MOCK_AUTH_PROVIDER, useClass: MockAuthProvider },
    {
      provide: WECHAT_AUTH_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new WechatAuthProvider(
          config.get<string>('app.wechatAppId', ''),
          config.get<string>('app.wechatAppSecret', ''),
          config.get<string>('app.wechatApiBase', 'https://api.weixin.qq.com'),
        ),
    },
  ],
  exports: [AuthService, SessionService],
})
export class AuthModule {}
