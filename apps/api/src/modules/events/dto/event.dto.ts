import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

/**
 * 管理端活动写接口的请求体 DTO。
 *
 * ⚠️ 之前这里是 `Record<string, unknown>` —— 运行时 metatype 是 Object，
 * **ValidationPipe 完全跳过校验**（缺陷 #79）：
 * 畸形输入不被拦、非法状态值一路打到数据库 ENUM 约束（500）、
 * 未声明字段也不会被剥掉。需求基线 §4.3 明确要求「DTO 校验」。
 *
 * 字段与契约（packages/contracts/src/api.ts 的 CreateEventBody / UpdateEventBody）
 * 一一对应。
 */

export class CreateEventBodyDto {
  @ApiProperty({ description: '活动标题' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  title!: string;

  @ApiProperty({ description: '活动类型（如 沙龙 / 讲座 / 聚会）' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  kind!: string;

  @ApiPropertyOptional({ description: '地区编码' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  regionCode?: string;

  @ApiPropertyOptional({ description: '地点' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  place?: string;

  @ApiPropertyOptional({ description: '活动介绍' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: '开始时间（ISO 8601）' })
  @IsOptional()
  @IsISO8601()
  startsAt?: string;

  @ApiPropertyOptional({ description: '结束时间（ISO 8601）' })
  @IsOptional()
  @IsISO8601()
  endsAt?: string;

  @ApiProperty({ description: '人数上限' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  capacity!: number;

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

export class UpdateEventBodyDto {
  @ApiPropertyOptional({ description: '活动标题' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional({ description: '活动类型' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  kind?: string;

  @ApiPropertyOptional({ description: '地区编码' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  regionCode?: string;

  @ApiPropertyOptional({ description: '地点' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  place?: string;

  @ApiPropertyOptional({ description: '活动介绍' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: '开始时间（ISO 8601）' })
  @IsOptional()
  @IsISO8601()
  startsAt?: string;

  @ApiPropertyOptional({ description: '结束时间（ISO 8601）' })
  @IsOptional()
  @IsISO8601()
  endsAt?: string;

  @ApiPropertyOptional({ description: '人数上限' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  capacity?: number;

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

/**
 * 活动报名的请求体。
 *
 * ⚠️ 之前这里是**内联对象字面量**（`{ note?: string }`）——
 * 运行时 metatype 是 `Object`，**ValidationPipe 完全跳过校验**（缺陷 #89）：
 * `note` 传对象会被直接塞进 TEXT 列，传超长字符串也不拦。
 *
 * 字段与契约 `packages/contracts/src/api.ts` 的 `RegisterEventBody` 一一对应。
 */
export class RegisterEventBodyDto {
  @ApiPropertyOptional({ description: '报名备注', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
