import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class DirectoryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '姓名 / 院系 / 方向关键词' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;

  @ApiPropertyOptional({ description: '盟市编码' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  regionCode?: string;

  @ApiPropertyOptional({ description: '行业编码' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  industryCode?: string;

  @ApiPropertyOptional({ description: '毕业年份' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1900)
  @Max(2100)
  graduationYear?: number;
}
