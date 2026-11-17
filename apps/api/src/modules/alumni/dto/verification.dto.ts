import {
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class SubmitVerificationDto {
  @ApiProperty()
  @IsString()
  @Length(2, 64)
  realName: string;

  @ApiProperty()
  @IsString()
  @Length(2, 64)
  college: string;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1900)
  @Max(2100)
  graduationYear: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  degree?: string;

  @ApiProperty({ description: '学号（脱敏存储）' })
  @IsString()
  @Length(4, 32)
  studentIdMasked: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;

  @ApiPropertyOptional({ type: [Number], description: '证明材料 media id 列表' })
  @IsOptional()
  // @Type(() => Number) 不能省：ValidationPipe 开了 enableImplicitConversion，
  // 属性上的 design:type=Array 会让 class-transformer 把**任意非数组值**
  // 静默强转成数组（对象 → 空数组），畸形输入就会被当成「没传附件」。
  @Type(() => Number)
  @IsArray()
  @ArrayMaxSize(9)
  @IsInt({ each: true })
  attachmentMediaIds?: number[];
}

export class VerificationDecisionDto {
  @ApiProperty({ enum: ['approve', 'reject', 'request_changes'] })
  @IsIn(['approve', 'reject', 'request_changes'])
  action: 'approve' | 'reject' | 'request_changes';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  version?: number;
}
