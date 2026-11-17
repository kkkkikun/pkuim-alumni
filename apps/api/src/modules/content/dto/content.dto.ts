import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * 管理端内容写接口的请求体 DTO（资讯 / 公告 / 分类 / 系统设置）。
 *
 * ⚠️ 之前这里是 `Record<string, unknown>` 或普通 TS `interface` ——
 * 运行时 metatype 是 Object，**ValidationPipe 完全跳过校验**（缺陷 #79）。
 * 需求基线 §4.3 明确要求「DTO 校验」。
 *
 * 字段与契约（packages/contracts/src/api.ts）一一对应。
 */

export class CreateArticleBodyDto {
  @ApiPropertyOptional({ description: '分类 id' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  categoryId?: number;

  @ApiProperty({ description: '标题' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  title!: string;

  @ApiPropertyOptional({ description: '摘要' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  summary?: string;

  @ApiProperty({ description: '正文' })
  @IsString()
  @MinLength(1)
  @MaxLength(100000)
  body!: string;

  @ApiPropertyOptional({ description: '封面媒体资源 id' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  coverMediaId?: number;

  @ApiPropertyOptional({ enum: ['draft', 'published'], description: '状态' })
  @IsOptional()
  @IsIn(['draft', 'published'])
  status?: 'draft' | 'published';
}

export class UpdateArticleBodyDto {
  @ApiPropertyOptional({ description: '分类 id' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  categoryId?: number;

  @ApiPropertyOptional({ description: '标题' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional({ description: '摘要' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  summary?: string;

  @ApiPropertyOptional({ description: '正文' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100000)
  body?: string;

  @ApiPropertyOptional({ description: '封面媒体资源 id' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  coverMediaId?: number;

  @ApiPropertyOptional({ enum: ['draft', 'published'], description: '状态' })
  @IsOptional()
  @IsIn(['draft', 'published'])
  status?: 'draft' | 'published';
}

export class CreateNoticeBodyDto {
  @ApiProperty({ description: '标题' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  title!: string;

  @ApiProperty({ description: '正文' })
  @IsString()
  @MinLength(1)
  @MaxLength(100000)
  body!: string;

  @ApiPropertyOptional({ enum: ['draft', 'published'], description: '状态' })
  @IsOptional()
  @IsIn(['draft', 'published'])
  status?: 'draft' | 'published';
}

export class UpdateNoticeBodyDto {
  @ApiPropertyOptional({ description: '标题' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional({ description: '正文' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100000)
  body?: string;

  @ApiPropertyOptional({ enum: ['draft', 'published'], description: '状态' })
  @IsOptional()
  @IsIn(['draft', 'published'])
  status?: 'draft' | 'published';
}

export class CreateCategoryBodyDto {
  @ApiProperty({ description: '分类名称' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name!: string;

  @ApiProperty({ description: '英文标识（唯一）' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  slug!: string;

  @ApiPropertyOptional({ description: '排序值' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateCategoryBodyDto {
  @ApiPropertyOptional({ description: '分类名称' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional({ description: '英文标识（唯一）' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  slug?: string;

  @ApiPropertyOptional({ description: '排序值' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpsertSettingBodyDto {
  @ApiProperty({ description: '配置键' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  key!: string;

  @ApiProperty({ description: '配置值' })
  @IsString()
  @MaxLength(2000)
  value!: string;

  @ApiPropertyOptional({ description: '说明' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;
}
