import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AlumniProfile, PrivateContact } from '../../database/entities/alumni.entity';
import { User } from '../../database/entities/user.entity';
import { EventRegistration } from '../../database/entities/event.entity';
import { ConnectionRequestHistory } from '../../database/entities/connection.entity';
import { ResourcePost } from '../../database/entities/resource.entity';
import { Notification } from '../../database/entities/notification.entity';
import { AlumniModule } from '../alumni/alumni.module';
import { ConnectionsModule } from '../connections/connections.module';
import { EventsModule } from '../events/events.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ResourcesModule } from '../resources/resources.module';
import { MeController } from './me.controller';
import { MeRoutesController } from './me-routes.controller';
import { MeService } from './me.service';
import { MeSummaryService } from './me-summary.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      AlumniProfile,
      PrivateContact,
      EventRegistration,
      ConnectionRequestHistory,
      ResourcePost,
      Notification,
    ]),
    EventsModule,
    ResourcesModule,
    ConnectionsModule,
    AlumniModule,
    NotificationsModule,
  ],
  controllers: [MeController, MeRoutesController],
  providers: [MeService, MeSummaryService],
  exports: [MeService, MeSummaryService],
})
export class MeModule {}
