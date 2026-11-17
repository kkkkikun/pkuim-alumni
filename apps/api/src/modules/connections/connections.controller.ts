import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { CurrentUser } from '../../common/decorators';
import type { RequestUser } from '../../common/decorators';
import { RequireAlumniStage } from '../../common/guards/alumni-stage.guard';
import { ConnectionsService } from './connections.service';
import {
  ContactGrantDto,
  CreateConnectionRequestDto,
  ListRequestsQueryDto,
} from './dto/connection.dto';

@ApiTags('校友连接')
@Controller('connections')
export class ConnectionsController {
  constructor(private readonly connectionsService: ConnectionsService) {}

  @Post('requests')
  @RequireAlumniStage('verified')
  @ApiOperation({ summary: '提交联系申请（双向确认的第一步）' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateConnectionRequestDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.connectionsService.createRequest(user.id, dto);
    // 首次创建 201 Created；命中既有待处理申请（幂等）200 OK
    res.status(result.idempotent ? HttpStatus.OK : HttpStatus.CREATED);
    return result;
  }

  @Get('requests')
  @RequireAlumniStage('verified')
  @ApiOperation({ summary: '我发出 / 收到的联系申请' })
  list(@CurrentUser() user: RequestUser, @Query() query: ListRequestsQueryDto) {
    return this.connectionsService.listRequests(
      user.id,
      query.direction ?? 'incoming',
      query.status,
      query.page,
      query.pageSize,
    );
  }

  @Get('requests/:id')
  @RequireAlumniStage('verified')
  @ApiOperation({ summary: '联系申请详情' })
  detail(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number) {
    return this.connectionsService.requestDetail(id, user.id);
  }

  @Post('requests/:id/accept')
  @RequireAlumniStage('verified')
  @ApiOperation({ summary: '接受联系申请（建立正式连接关系）' })
  accept(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number) {
    return this.connectionsService.accept(id, user.id);
  }

  @Post('requests/:id/reject')
  // ⚠️ 这个 POST **不创建任何资源**（只是改状态）→
  // Nest 对 POST 的默认是 201 Created，而 201 的语义是「本次请求创建了新资源」，
  // 且应当带 Location 头 —— 这里两样都不成立（缺陷 #126）。
  @HttpCode(HttpStatus.OK)
  @RequireAlumniStage('verified')
  @ApiOperation({ summary: '拒绝联系申请' })
  reject(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number) {
    return this.connectionsService.reject(id, user.id);
  }

  @Post('requests/:id/cancel')
  // ⚠️ 这个 POST **不创建任何资源**（只是改状态）→
  // Nest 对 POST 的默认是 201 Created，而 201 的语义是「本次请求创建了新资源」，
  // 且应当带 Location 头 —— 这里两样都不成立（缺陷 #126）。
  @HttpCode(HttpStatus.OK)
  @RequireAlumniStage('verified')
  @ApiOperation({ summary: '撤回我发出的申请' })
  cancel(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number) {
    return this.connectionsService.cancel(id, user.id);
  }

  @Get()
  @RequireAlumniStage('verified')
  @ApiOperation({ summary: '已建立的连接列表（联系方式按双方授权显示）' })
  listConnections(@CurrentUser() user: RequestUser, @Query() query: PaginationQueryDto) {
    return this.connectionsService.listConnections(user.id, query.page, query.pageSize);
  }

  @Get(':id')
  @RequireAlumniStage('verified')
  @ApiOperation({ summary: '连接关系详情（仅关系双方可见）' })
  connectionDetail(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number) {
    return this.connectionsService.getConnection(id, user.id);
  }

  @Delete(':id')
  @RequireAlumniStage('verified')
  @ApiOperation({ summary: '解除连接关系' })
  revoke(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number) {
    return this.connectionsService.revokeConnection(id, user.id);
  }

  @Put(':id/contact-grant')
  @RequireAlumniStage('verified')
  @ApiOperation({ summary: '授权 / 撤回向对方展示联系方式' })
  grant(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ContactGrantDto,
  ) {
    return this.connectionsService.setContactGrant(id, user.id, dto.allow);
  }
}
