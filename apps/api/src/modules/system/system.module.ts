import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AlumniProfile } from '../../database/entities/alumni.entity';
import { Industry, Region } from '../../database/entities/dictionary.entity';
import { User } from '../../database/entities/user.entity';
import { SystemSetting } from '../../database/entities/system.entity';
import { SystemController } from './system.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Region, Industry, AlumniProfile, User, SystemSetting]),
  ],
  controllers: [SystemController],
})
export class SystemModule {}
