import { Body, Controller, Get, Patch, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators';
import type { RequestUser } from '../../common/decorators';
import { UpdateContactDto, UpdatePrivacyDto, UpdateProfileDto } from './dto/me.dto';
import { MeService } from './me.service';

@ApiTags('我的')
@Controller('me')
export class MeController {
  constructor(private readonly meService: MeService) {}

  @Get()
  @ApiOperation({ summary: '当前用户资料、隐私设置与联系方式' })
  getMe(@CurrentUser() user: RequestUser) {
    return this.meService.getMe(user.id);
  }

  @Get('profile')
  @ApiOperation({ summary: '我的校友档案（我方视角，含隐私开关与我的联系方式）' })
  getProfile(@CurrentUser() user: RequestUser) {
    return this.meService.getProfile(user.id);
  }

  @Patch('profile')
  @ApiOperation({ summary: '更新校友资料' })
  updateProfile(@CurrentUser() user: RequestUser, @Body() dto: UpdateProfileDto) {
    return this.meService.updateProfile(user.id, dto);
  }

  @Get('privacy')
  @ApiOperation({ summary: '我的隐私与授权开关' })
  getPrivacy(@CurrentUser() user: RequestUser) {
    return this.meService.getPrivacy(user.id);
  }

  @Get('contacts')
  @ApiOperation({ summary: '我的联系方式（仅本人可见）' })
  getContacts(@CurrentUser() user: RequestUser) {
    return this.meService.getMe(user.id).then((me) => me.contact);
  }

  @Put('contacts')
  @ApiOperation({ summary: '更新联系方式（加密存储，仅本人可见）' })
  updateContacts(@CurrentUser() user: RequestUser, @Body() dto: UpdateContactDto) {
    return this.meService.updateContact(user.id, dto);
  }

  @Patch('contacts')
  @ApiOperation({ summary: '更新联系方式（加密存储，仅本人可见）' })
  patchContacts(@CurrentUser() user: RequestUser, @Body() dto: UpdateContactDto) {
    return this.meService.updateContact(user.id, dto);
  }

  @Put('privacy')
  @ApiOperation({ summary: '更新隐私与授权开关' })
  updatePrivacy(@CurrentUser() user: RequestUser, @Body() dto: UpdatePrivacyDto) {
    return this.meService.updatePrivacy(user.id, dto);
  }
}
