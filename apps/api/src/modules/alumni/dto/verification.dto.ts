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

  // ⚠️ 服务端会**再脱敏一次**（docs/SECURITY.md 第 3 节第 6 条「学号脱敏存储」）：
  //    客户端即使传了完整学号，落库的也是脱敏后的值（保留首尾各 2 位）。
  @ApiProperty({ description: '学号（服务端会统一脱敏后存储，保留首尾各 2 位）' })
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
