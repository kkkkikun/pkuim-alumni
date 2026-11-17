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
import { ContentModule } from '../content/content.module';
import { DirectoryModule } from '../directory/directory.module';
import { EventsModule } from '../events/events.module';
import { ResourcesModule } from '../resources/resources.module';
import { UploadsModule } from '../uploads/uploads.module';
import { AdminController } from './admin.controller';
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
    DirectoryModule,
    ResourcesModule,
    EventsModule,
    ContentModule,
    UploadsModule,
  ],
  controllers: [AdminController, AdminUsersController],
})
export class AdminModule {}
