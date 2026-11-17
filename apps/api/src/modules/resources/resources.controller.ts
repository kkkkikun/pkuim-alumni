import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public } from '../../common/decorators';
import type { RequestUser } from '../../common/decorators';
import { RequireAlumniStage } from '../../common/guards/alumni-stage.guard';
import {
  CreateResourceDto,
  ResourceQueryDto,
  UpdateResourceDto,
} from './dto/resource.dto';
import { ResourcesService } from './resources.service';

@ApiTags('资源与需求')
@Controller('resources')
export class ResourcesController {
  constructor(private readonly resourcesService: ResourcesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: '公开列表（仅已审核通过的内容）' })
  list(@Query() query: ResourceQueryDto) {
    return this.resourcesService.listPublic({
      page: query.page,
      pageSize: query.pageSize,
      type: query.type,
      regionCode: query.regionCode,
      industryCode: query.industryCode,
      keyword: query.keyword,
    });
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: '详情' })
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.resourcesService.detail(id);
  }

  @Post()
  @RequireAlumniStage('verified')
  @ApiOperation({ summary: '发布资源 / 需求（进入审核队列）' })
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateResourceDto) {
    return this.resourcesService.create(user.id, dto, true);
  }

  @Patch(':id')
  @RequireAlumniStage('verified')
  @ApiOperation({ summary: '修改已发布内容（需重新审核）' })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateResourceDto,
  ) {
    return this.resourcesService.update(id, user.id, dto);
  }

  @Post(':id/submit')
  // ⚠️ 这个 POST **不创建任何资源**（只是改状态）→
  // Nest 对 POST 的默认是 201 Created，而 201 的语义是「本次请求创建了新资源」，
  // 且应当带 Location 头 —— 这里两样都不成立（缺陷 #126）。
  @HttpCode(HttpStatus.OK)
  @RequireAlumniStage('verified')
  @ApiOperation({ summary: '提交审核' })
  submit(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number) {
    return this.resourcesService.submit(id, user.id);
  }

  @Post(':id/withdraw')
  // ⚠️ 这个 POST **不创建任何资源**（只是改状态）→
  // Nest 对 POST 的默认是 201 Created，而 201 的语义是「本次请求创建了新资源」，
  // 且应当带 Location 头 —— 这里两样都不成立（缺陷 #126）。
  @HttpCode(HttpStatus.OK)
  @RequireAlumniStage('verified')
  @ApiOperation({ summary: '撤回发布' })
  withdraw(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number) {
    return this.resourcesService.withdraw(id, user.id);
  }
}
