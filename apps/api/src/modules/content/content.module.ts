import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Article, ArticleCategory, Notice } from '../../database/entities/content.entity';
import { SystemSetting } from '../../database/entities/system.entity';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';
import { ViewCounterService } from './view-counter.service';

@Module({
  imports: [TypeOrmModule.forFeature([Article, ArticleCategory, Notice, SystemSetting])],
  controllers: [ContentController],
  providers: [ContentService, ViewCounterService],
  exports: [ContentService, ViewCounterService],
})
export class ContentModule {}
