import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AdminActionLog,
  AdminUser,
  AdminUserRole,
  Permission,
  Role,
  RolePermission,
} from '../../database/entities/admin.entity';
import { Article, Notice } from '../../database/entities/content.entity';
import { ConnectionRequestHistory } from '../../database/entities/connection.entity';
import { Event, EventRegistration } from '../../database/entities/event.entity';
import { ResourcePost } from '../../database/entities/resource.entity';
import { SystemSetting } from '../../database/entities/system.entity';
import { User } from '../../database/entities/user.entity';
import { VerificationApplication } from '../../database/entities/verification.entity';
import { AlumniModule } from '../alumni/alumni.module';
// ⚠️ 第三轮：`AdminUsersController` 要在「停用 / 降权」后**主动失效**该管理员的
//    RBAC 缓存（口径见 docs/SECURITY.md 第 2.1 节），因此需要注入 `AuthService`
//    —— `AuthModule` 导出它，所以这里必须 import 进来。
import { AuthModule } from '../../auth/auth.module';
import { ContentModule } from '../content/content.module';
import { DirectoryModule } from '../directory/directory.module';
import { EventsModule } from '../events/events.module';
import { ResourcesModule } from '../resources/resources.module';
import { UploadsModule } from '../uploads/uploads.module';
import { AdminController } from './admin.controller';
import { AdminOpsController } from './admin-ops.controller';
import { AdminUsersController } from './admin-users.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      AdminUser,
      AdminUserRole,
      AdminActionLog,
      Role,
      RolePermission,
      Permission,
      SystemSetting,
      ResourcePost,
      VerificationApplication,
      Event,
      EventRegistration,
      ConnectionRequestHistory,
      Article,
      Notice,
    ]),
    AlumniModule,
    AuthModule,
    DirectoryModule,
    ResourcesModule,
    EventsModule,
    ContentModule,
    UploadsModule,
  ],
  controllers: [AdminController, AdminUsersController, AdminOpsController],
})
export class AdminModule {}
