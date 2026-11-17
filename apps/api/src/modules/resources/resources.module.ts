import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminUser } from '../../database/entities/admin.entity';
import {
  ResourcePost,
  ResourcePostAttachment,
  ResourcePostReview,
} from '../../database/entities/resource.entity';
import { User } from '../../database/entities/user.entity';
import { MediaAsset } from '../../database/entities/system.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { ResourcesController } from './resources.controller';
import { ResourcesService } from './resources.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ResourcePost,
      ResourcePostReview,
      ResourcePostAttachment,
      User,
      AdminUser,
      MediaAsset,
    ]),
    NotificationsModule,
  ],
  controllers: [ResourcesController],
  providers: [ResourcesService],
  exports: [ResourcesService],
})
export class ResourcesModule {}
