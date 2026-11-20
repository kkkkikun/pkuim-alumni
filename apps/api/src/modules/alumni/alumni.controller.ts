import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public } from '../../common/decorators';
import type { RequestUser } from '../../common/decorators';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { DirectoryService } from '../directory/directory.service';
import { AlumniVerificationService } from './alumni.service';
import { SubmitVerificationDto } from './dto/verification.dto';

/**
 * `/alumni` 命名空间只承载**面向普通用户的公开查询**与**认证流程**。
 *
 * ⚠️ 曾经的 `GET /alumni`（管理端校友列表）已删除（见 docs/KNOWN-ISSUES.md #72）：
 *   - 它把管理端能力放在了公开路径空间（`alumni:view` 权限端点 + 公开名片接口混同），
 *     与 docs/top.md §4.3 的收敛原则冲突（用户管理同理：`/users` → `/admin/users`）；
 *   - 它与 `GET /admin/alumni` 重复，且只透传了 9 个筛选项里的 4 个，
 *     其余 5 个被静默丢弃 —— 典型的「筛选框是摆设」缺陷；
 *   - 两端客户端都没有调用它。
 *   管理端校友列表统一走 `GET /admin/alumni`（9 个筛选项全部真正生效）。
 */
@ApiTags('校友认证')
@Controller('alumni')
export class AlumniController {
  constructor(
    private readonly alumniService: AlumniVerificationService,
    private readonly directoryService: DirectoryService,
  ) {}

  @Get('verification/:id/history')
  @ApiOperation({ summary: '认证审核历史（只追加）' })
  history(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.alumniService.history(id, user.id, user.isAdmin);
  }

  @Get(':id')
  @Public()
  @ApiOperation({ summary: '校友公开名片（仅已认证且授权公开者可见）' })
  profile(@Param('id', ParseIntPipe) id: number) {
    return this.directoryService.detail(0, id);
  }

  @Post('verification')
  @ApiOperation({ summary: '提交校友身份认证申请' })
  submit(@CurrentUser() user: RequestUser, @Body() dto: SubmitVerificationDto) {
    return this.alumniService.submit(user.id, dto);
  }

  @Put('verification/:id/resubmit')
  @ApiOperation({ summary: '补充材料后重新提交' })
  resubmit(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SubmitVerificationDto,
  ) {
    return this.alumniService.resubmit(id, user.id, dto);
  }

  // 注意路由顺序：`verification/mine` 必须注册在 `verification/:id` 之前，
  // 否则 "mine" 会被 :id 抢先匹配并被 ParseIntPipe 拒绝（400）。
  @Get('verification/mine')
  @ApiOperation({ summary: '我的认证记录（分页）' })
  mine(@CurrentUser() user: RequestUser, @Query() query: PaginationQueryDto) {
    // ⚠️ 第三轮：此前返回**全部**认证申请（裸数组、无上限）——
    //    提交过多次认证的用户每次都要把整份历史拉下来。
    //    现在与其它列表接口口径统一：`{items, meta}`。
    return this.alumniService.minePaged(user.id, query.page, query.pageSize);
  }

  @Get('verification/:id')
  @ApiOperation({ summary: '认证申请详情' })
  detail(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number) {
    return this.alumniService.detail(id, user.id, user.isAdmin);
  }
}
