import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * 管理端**管理员账号**写接口的请求体 DTO。
 *
 * ⚠️ 之前这里是普通 TS `interface` —— 运行时 metatype 是 Object，
 * **ValidationPipe 完全跳过校验**（缺陷 #79）：
 * `status: 'bogus'` 这类非法值会一路走到数据库 ENUM 约束（500）。
 * 需求基线 §4.3 明确要求「DTO 校验」。
 *
 * 字段与契约（packages/contracts/src/api.ts 的 UpdateAdminUserBody）一致。
 */

export class CreateAdminUserBodyDto {
  @ApiProperty({ description: '登录名（3~32 位）' })
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  username!: string;

  @ApiPropertyOptional({ description: '显示名' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  displayName?: string;

  @ApiPropertyOptional({ description: '初始密码（至少 8 位）' })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  password?: string;

  @ApiPropertyOptional({ type: [String], description: '角色编码列表' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  roles?: string[];

  @ApiPropertyOptional({ enum: ['active', 'disabled'], description: '账号状态' })
  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: 'active' | 'disabled';
}

export class UpdateAdminUserBodyDto {
  @ApiPropertyOptional({ description: '显示名' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  displayName?: string;

  @ApiPropertyOptional({ description: '重置密码（至少 8 位）' })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  password?: string;

  @ApiPropertyOptional({ type: [String], description: '角色编码列表（整体替换）' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  roles?: string[];

  @ApiPropertyOptional({ enum: ['active', 'disabled'], description: '账号状态' })
  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: 'active' | 'disabled';
}

export class UpdateUserStatusBodyDto {
  @ApiProperty({ enum: ['active', 'disabled', 'locked'], description: '账号状态' })
  @IsIn(['active', 'disabled', 'locked'])
  status!: 'active' | 'disabled' | 'locked';

  @ApiPropertyOptional({ description: '原因（会写入审计日志）' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
