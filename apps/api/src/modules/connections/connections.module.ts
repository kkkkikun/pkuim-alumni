import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AlumniProfile, PrivateContact } from '../../database/entities/alumni.entity';
import {
  ConnectionPair,
  ConnectionRequestHistory,
  ContactShareGrant,
} from '../../database/entities/connection.entity';
import { User } from '../../database/entities/user.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ConnectionRequestHistory,
      ConnectionPair,
      ContactShareGrant,
      User,
      AlumniProfile,
      PrivateContact,
    ]),
    NotificationsModule,
  ],
  controllers: [ConnectionsController],
  providers: [ConnectionsService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
