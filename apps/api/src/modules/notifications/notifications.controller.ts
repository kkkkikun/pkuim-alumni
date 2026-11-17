import { Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { paginate } from '../../common/dto/pagination.dto';
import type { PageResult } from '../../common/dto/pagination.dto';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { CurrentUser } from '../../common/decorators';
import type { RequestUser } from '../../common/decorators';
import { Notification } from '../../database/entities/notification.entity';
import { NotificationService } from './notification.service';

export interface NotificationView {
  id: number;
  type: string;
  title: string;
  body: string;
  payload: Record<string, unknown> | null;
  read: boolean;
  createdAt: Date;
}

@ApiTags('通知')
@Controller('notifications')
export class NotificationsController {
  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    private readonly notificationService: NotificationService,
  ) {}

  @Get()
  @ApiOperation({ summary: '站内通知列表' })
  async list(
    @CurrentUser() user: RequestUser,
    @Query() query: PaginationQueryDto,
  ): Promise<PageResult<NotificationView>> {
    const qb = this.notifications
      .createQueryBuilder('n')
      .where('n.userId = :userId', { userId: user.id })
      .orderBy('n.id', 'DESC')
      .skip(query.offset)
      .take(query.take);
    const [entities, total] = await qb.getManyAndCount();
    return paginate(
      entities.map((item) => this.toView(item)),
      total,
      query.page,
      query.pageSize,
    );
  }

  @Get('unread-count')
  @ApiOperation({ summary: '未读通知数量' })
  async unreadCount(@CurrentUser() user: RequestUser) {
    const count = await this.notifications
      .createQueryBuilder('n')
      .where('n.userId = :userId', { userId: user.id })
      .andWhere('n.readAt IS NULL')
      .getCount();
    return { unread: count };
  }

  @Post(':id/read')
  // ⚠️ 这个 POST **不创建任何资源**（只是改状态）→
  // Nest 对 POST 的默认是 201 Created，而 201 的语义是「本次请求创建了新资源」，
  // 且应当带 Location 头 —— 这里两样都不成立（缺陷 #126）。
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '标记已读' })
  async markRead(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number) {
    // 逻辑收敛到 service（缺陷 #125）：
    // 控制器原先**重复实现**了一遍同样的更新，而 service 里的同名方法是**死代码**
    // （从未被调用）—— 两份实现迟早漂移（这正是 #81 / #113 那类缺陷的土壤）。
    // 由 service 判断影响行数：通知不存在 → 404（与 GET /notifications/:id 一致）。
    await this.notificationService.markRead(user.id, id);
    return { id, read: true };
  }

  @Post('read-all')
  // ⚠️ 这个 POST **不创建任何资源**（只是改状态）→
  // Nest 对 POST 的默认是 201 Created，而 201 的语义是「本次请求创建了新资源」，
  // 且应当带 Location 头 —— 这里两样都不成立（缺陷 #126）。
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '全部标记已读' })
  async markAllRead(@CurrentUser() user: RequestUser) {
    const result = await this.notifications
      .createQueryBuilder()
      .update(Notification)
      .set({ readAt: new Date() })
      .where('userId = :userId', { userId: user.id })
      .andWhere('readAt IS NULL')
      .execute();
    return { updated: result.affected ?? 0 };
  }

  @Get(':id')
  @ApiOperation({ summary: '通知详情' })
  async detail(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<NotificationView> {
    const item = await this.notifications.findOne({ where: { id, userId: user.id } });
    if (!item) throw new NotFoundException('通知不存在');
    return this.toView(item);
  }

  private toView(item: Notification): NotificationView {
    return {
      id: item.id,
      type: item.type,
      title: item.title,
      body: item.body,
      payload: item.payload,
      read: Boolean(item.readAt),
      createdAt: item.createdAt,
    };
  }
}
