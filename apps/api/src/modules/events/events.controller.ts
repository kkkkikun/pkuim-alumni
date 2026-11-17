import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { EventListQueryDto } from '../../common/dto/list-query.dto';
import { CurrentUser, Public } from '../../common/decorators';
import type { RequestUser } from '../../common/decorators';
import { RequireAlumniStage } from '../../common/guards/alumni-stage.guard';
import { RegisterEventBodyDto } from './dto/event.dto';
import { EventsService } from './events.service';

@ApiTags('活动')
@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: '活动列表' })
  list(@Query() query: EventListQueryDto) {
    return this.eventsService.list({
      page: query.page,
      pageSize: query.pageSize,
      regionCode: query.regionCode,
    });
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: '活动详情' })
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.eventsService.detail(id);
  }

  @Post(':id/registrations')
  @RequireAlumniStage('verified')
  @ApiOperation({ summary: '活动报名（容量受控，重复报名幂等）' })
  async register(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: RegisterEventBodyDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.eventsService.register(id, user.id, body?.note);
    // 首次报名 201 Created；重复报名（幂等命中）200 OK
    res.status(result.idempotent ? HttpStatus.OK : HttpStatus.CREATED);
    return result;
  }

  @Delete(':id/registrations')
  @RequireAlumniStage('verified')
  @ApiOperation({ summary: '取消报名（回收名额）' })
  cancel(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number) {
    return this.eventsService.cancel(id, user.id);
  }
}
