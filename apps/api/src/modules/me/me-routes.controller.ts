import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { CurrentUser } from '../../common/decorators';
import type { RequestUser } from '../../common/decorators';
import { AlumniVerificationService } from '../alumni/alumni.service';
import { ConnectionsService } from '../connections/connections.service';
import { ListRequestsQueryDto } from '../connections/dto/connection.dto';
import { EventsService } from '../events/events.service';
import { NotificationService } from '../notifications/notification.service';
import { ResourcesService } from '../resources/resources.service';

/**
 * 「我的」聚合路由：契约中 /me/** 下的业务子路由在此集中提供，
 * 避免各业务模块重复声明同一前缀。
 */
@ApiTags('我的')
@Controller('me')
export class MeRoutesController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly resourcesService: ResourcesService,
    private readonly connectionsService: ConnectionsService,
    private readonly alumniService: AlumniVerificationService,
    private readonly notificationsService: NotificationService,
  ) {}

  @Get('events')
  @ApiOperation({ summary: '我的活动报名记录' })
  myEvents(@CurrentUser() user: RequestUser, @Query() query: PaginationQueryDto) {
    return this.eventsService.myRegistrations(user.id, query.page, query.pageSize);
  }

  @Get('resources')
  @ApiOperation({ summary: '我发布的资源与需求（含审核状态）' })
  myResources(
    @CurrentUser() user: RequestUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.resourcesService.myPosts(user.id, query.page, query.pageSize);
  }

  @Get('connections')
  @ApiOperation({ summary: '已建立的连接列表' })
  myConnections(@CurrentUser() user: RequestUser, @Query() query: PaginationQueryDto) {
    return this.connectionsService.listConnections(user.id, query.page, query.pageSize);
  }

  @Get('connection-requests')
  @ApiOperation({ summary: '我发出 / 收到的联系申请' })
  myConnectionRequests(@CurrentUser() user: RequestUser, @Query() query: ListRequestsQueryDto) {
    return this.connectionsService.listRequests(
      user.id,
      query.direction === 'outgoing' ? 'outgoing' : 'incoming',
      query.status,
      query.page,
      query.pageSize,
    );
  }

  @Get('verifications')
  @ApiOperation({ summary: '我的认证申请与审核历史' })
  myVerifications(@CurrentUser() user: RequestUser, @Query() query: PaginationQueryDto) {
    return this.alumniService.minePaged(user.id, query.page, query.pageSize);
  }

  @Get('notifications')
  @ApiOperation({ summary: '我的站内通知' })
  myNotifications(
    @CurrentUser() user: RequestUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.notificationsService.listFor(user.id, query.page, query.pageSize);
  }
}
