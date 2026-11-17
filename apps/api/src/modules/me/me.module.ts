import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AlumniProfile, PrivateContact } from '../../database/entities/alumni.entity';
import { User } from '../../database/entities/user.entity';
import { AlumniModule } from '../alumni/alumni.module';
import { ConnectionsModule } from '../connections/connections.module';
import { EventsModule } from '../events/events.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ResourcesModule } from '../resources/resources.module';
import { MeController } from './me.controller';
import { MeRoutesController } from './me-routes.controller';
import { MeService } from './me.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, AlumniProfile, PrivateContact]),
    EventsModule,
    ResourcesModule,
    ConnectionsModule,
    AlumniModule,
    NotificationsModule,
  ],
  controllers: [MeController, MeRoutesController],
  providers: [MeService],
  exports: [MeService],
})
export class MeModule {}
