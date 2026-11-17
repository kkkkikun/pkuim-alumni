import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * 上传相关常量（DTO 与 service 共用，避免两处白名单漂移）。
 */

/** 允许的 MIME 类型 */
export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

/** 允许的文件扩展名 */
export const ALLOWED_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.pdf',
  '.doc',
  '.docx',
] as const;

/** 单个文件大小上限：10MB */
export const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;

/**
 * 登记媒体资源的请求体。
 *
 * ⚠️ 之前这里是**普通 interface**（`CreateUploadBody`，定义在 service 里）——
 * 运行时 metatype 是 `Object`，**ValidationPipe 完全跳过校验**（缺陷 #88）：
 *   - `fileName: 123` → `filename.lastIndexOf()` → **500**（应为 400）
 *   - `size: 'abc'` / `size: -999` → 落库时类型转换失败 → **500**
 *   - 契约之外的字段（bucket / objectKey）不被剥掉
 *
 * 字段与契约 `packages/contracts/src/api.ts` 的 `CreateUploadBody` 一一对应。
 */
export class CreateUploadBodyDto {
  @ApiProperty({ description: '原始文件名（含扩展名）', maxLength: 255 })
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @ApiProperty({ description: 'MIME 类型', enum: ALLOWED_MIME_TYPES })
  @IsString()
  @IsIn(ALLOWED_MIME_TYPES)
  mimeType!: string;

  @ApiProperty({ description: '文件字节数（1 ~ 10MB）' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_UPLOAD_SIZE)
  size!: number;

  @ApiPropertyOptional({ description: '可见性：public / private', enum: ['public', 'private'] })
  @IsOptional()
  @IsIn(['public', 'private'])
  visibility?: 'public' | 'private';
}
