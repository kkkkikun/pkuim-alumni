import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators';
import type { AuthenticatedRequest } from '../common/decorators';
import { AuthService } from './auth.service';
import { AdminLoginDto, LogoutDto, MockLoginDto, RefreshTokenDto, WechatLoginDto } from './dto/auth.dto';

@ApiTags('认证')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('wechat/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '微信 code 登录' })
  loginWithWechat(@Body() dto: WechatLoginDto) {
    return this.authService.loginWithWechat(dto);
  }

  @Public()
  @Post('mock/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mock 登录（小程序注册前的开发通道）' })
  loginWithMock(@Body() dto: MockLoginDto) {
    return this.authService.loginWithMock(dto);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '刷新令牌（旧 refresh 立即失效）' })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '登出并吊销会话' })
  async logout(@Body() dto: LogoutDto): Promise<void> {
    await this.authService.logout(dto.refreshToken);
  }

  @Public()
  @Post('admin/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '管理后台登录' })
  adminLogin(@Body() dto: AdminLoginDto) {
    return this.authService.adminLogin(dto);
  }

  @Get('session')
  @ApiOperation({ summary: '当前会话信息' })
  async session(@Req() request: AuthenticatedRequest) {
    return {
      user: request.user
        ? {
            id: request.user.id,
            openid: request.user.openid,
            nickname: request.user.nickname,
            role: request.user.role,
            stage: request.user.stage,
            isAdmin: request.user.isAdmin,
            permissions: request.user.permissions,
          }
        : null,
      // 契约要求会话带 stage：管理员会话为 'admin'，用户会话为用户当前身份阶段
      stage: request.user
        ? request.user.isAdmin
          ? 'admin'
          : request.user.stage
        : null,
    };
  }
}
