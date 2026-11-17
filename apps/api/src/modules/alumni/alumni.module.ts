import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminUser } from '../../database/entities/admin.entity';
import { AlumniProfile } from '../../database/entities/alumni.entity';
import { MediaAsset } from '../../database/entities/system.entity';
import { User } from '../../database/entities/user.entity';
import {
  VerificationApplication,
  VerificationAttachment,
  VerificationReview,
} from '../../database/entities/verification.entity';
import { DirectoryModule } from '../directory/directory.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AlumniController } from './alumni.controller';
import { AlumniVerificationService } from './alumni.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      VerificationApplication,
      VerificationAttachment,
      VerificationReview,
      User,
      AlumniProfile,
      AdminUser,
      MediaAsset,
    ]),
    NotificationsModule,
    DirectoryModule,
  ],
  controllers: [AlumniController],
  providers: [AlumniVerificationService],
  exports: [AlumniVerificationService],
})
export class AlumniModule {}
