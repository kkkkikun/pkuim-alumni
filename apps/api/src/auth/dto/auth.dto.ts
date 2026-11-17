import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class MockLoginDto {
  @ApiPropertyOptional({ description: '演示用 openid；留空自动生成' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  mockOpenid?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  nickname?: string;
}

export class WechatLoginDto {
  @ApiProperty({ description: 'wx.login 得到的 code' })
  @IsString()
  @Length(4, 256)
  code: string;
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @Length(16, 1024)
  refreshToken: string;
}

export class LogoutDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

export class AdminLoginDto {
  @ApiProperty()
  @IsString()
  @Length(3, 64)
  username: string;

  @ApiProperty()
  @IsString()
  @Length(8, 128)
  password: string;
}
