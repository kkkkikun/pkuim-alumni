import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class CreateResourceDto {
  @ApiProperty({ enum: ['resource', 'demand'], description: 'resource=我能提供 / demand=我有需求' })
  @IsIn(['resource', 'demand'])
  type: 'resource' | 'demand';

  @ApiProperty()
  @IsString()
  @Length(4, 120)
  title: string;

  @ApiProperty()
  @IsString()
  @Length(10, 2000)
  body: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  industryCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  regionCode?: string;

  /**
   * 附件（媒体资源 id 列表）。
   *
   * ⚠️ 必须做**元素级**校验（缺陷 #74）：
   *   只有 @IsOptional() 时，`attachmentMediaIds: "abc"` 会一路穿过管道，
   *   到 service 里执行 `.map()` → TypeError → **500**。
   *   DTO 校验的职责就是把畸形输入挡在 400 这一层。
   */
  @ApiPropertyOptional({ type: [Number], description: '附件媒体资源 id 列表（整体替换）' })
  @IsOptional()
  // @Type(() => Number) 不能省：ValidationPipe 开了 enableImplicitConversion，
  // 而属性上的 design:type=Array 会让 class-transformer 把**任意非数组值**
  // 静默强转成数组（对象 → 空数组）。少了这一行，
  // `attachmentMediaIds: {nope:true}` 会被当成「清空附件」→ 静默丢数据。
  // 加上之后：对象/字符串 → null → @IsArray 失败 → 400。
  @Type(() => Number)
  @IsArray()
  @ArrayMaxSize(9)
  @IsInt({ each: true })
  attachmentMediaIds?: number[];
}

export class UpdateResourceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(4, 120)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(10, 2000)
  body?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  industryCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  regionCode?: string;

  /**
   * 附件（媒体资源 id 列表）。
   *
   * ⚠️ 必须做**元素级**校验（缺陷 #74）：
   *   只有 @IsOptional() 时，`attachmentMediaIds: "abc"` 会一路穿过管道，
   *   到 service 里执行 `.map()` → TypeError → **500**。
   *   DTO 校验的职责就是把畸形输入挡在 400 这一层。
   */
  @ApiPropertyOptional({ type: [Number], description: '附件媒体资源 id 列表（整体替换）' })
  @IsOptional()
  // @Type(() => Number) 不能省：ValidationPipe 开了 enableImplicitConversion，
  // 而属性上的 design:type=Array 会让 class-transformer 把**任意非数组值**
  // 静默强转成数组（对象 → 空数组）。少了这一行，
  // `attachmentMediaIds: {nope:true}` 会被当成「清空附件」→ 静默丢数据。
  // 加上之后：对象/字符串 → null → @IsArray 失败 → 400。
  @Type(() => Number)
  @IsArray()
  @ArrayMaxSize(9)
  @IsInt({ each: true })
  attachmentMediaIds?: number[];
}

export class ResourceDecisionDto {
  @ApiProperty({ enum: ['approve', 'reject', 'request_changes', 'offline'] })
  @IsIn(['approve', 'reject', 'request_changes', 'offline'])
  action: 'approve' | 'reject' | 'request_changes' | 'offline';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ description: '乐观锁版本号，冲突时返回 409' })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(0)
  version?: number;
}

/**
 * 公开资源列表查询。
 *
 * 必须继承 PaginationQueryDto（而不是用交叉类型 `X & PaginationQueryDto`），
 * 否则 Nest 无法识别 metatype，校验与类型转换失效 → skip(NaN) → 500。
 */
export class ResourceQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['resource', 'demand'] })
  @IsOptional()
  @IsIn(['resource', 'demand'])
  type?: 'resource' | 'demand';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  regionCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  industryCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;
}
