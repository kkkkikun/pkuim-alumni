import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, MaxLength, Min } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';
import { ToBoolean } from '../../../common/dto/transforms';

export class CreateConnectionRequestDto {
  @ApiProperty({ description: '目标校友用户 id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetUserId: number;

  @ApiProperty({ description: '交流说明（6-500 字）' })
  @IsString()
  @Length(6, 500)
  message: string;
}

export class ContactGrantDto {
  @ApiProperty({ description: '是否允许向对方展示我的联系方式' })
  @ToBoolean()
  @IsBoolean()
  allow: boolean;
}

export class ListRequestsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['incoming', 'outgoing'], default: 'incoming' })
  @IsOptional()
  @IsString()
  direction?: 'incoming' | 'outgoing';

  @ApiPropertyOptional({
    enum: ['pending', 'accepted', 'rejected', 'cancelled', 'expired'],
    description: '联系申请状态',
  })
  @IsOptional()
  @IsIn(['pending', 'accepted', 'rejected', 'cancelled', 'expired'])
  status?: 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';
}

export class RevokeConnectionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}
