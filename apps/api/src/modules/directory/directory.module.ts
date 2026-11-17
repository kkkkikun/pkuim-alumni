import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AlumniProfile, PrivateContact } from '../../database/entities/alumni.entity';
import { ConnectionPair, ConnectionRequestHistory } from '../../database/entities/connection.entity';
import { User } from '../../database/entities/user.entity';
import { DirectoryController } from './directory.controller';
import { DirectoryService } from './directory.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AlumniProfile,
      PrivateContact,
      User,
      ConnectionPair,
      ConnectionRequestHistory,
    ]),
  ],
  controllers: [DirectoryController],
  providers: [DirectoryService],
  exports: [DirectoryService],
})
export class DirectoryModule {}
