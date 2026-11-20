import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { EventRegistration } from '../../database/entities/event.entity';
import { ConnectionRequestHistory } from '../../database/entities/connection.entity';
import { ResourcePost } from '../../database/entities/resource.entity';
import { Notification } from '../../database/entities/notification.entity';

/**
 * 「我的」首屏聚合（契约 `MeSummaryResponse`）。
 *
 * ## 为什么新增这个接口
 *
 * 小程序「我的」页首屏此前要打 **5 个请求**：
 * `GET /me` + 4 个只为拿**计数**的列表请求
 * （我的活动 / 我的联系申请 / 我的发布 / 未读通知数）。
 * 四个列表接口每次都为了一个数字把整页数据查出来、分页、组装视图 ——
 * 首屏只需要数字，却付出了 5 次往返 + 4 次列表查询的代价。
 *
 * 现在这四个数字由 **1 个聚合接口**给出（`GET /me/summary`），
 * 首屏从 5 个请求降到 **2 个**（`GET /me` + `GET /me/summary`）。
 *
 * ## ⚠️ 未读通知数**不缓存**
 *
 * 「未读数」是需要实时性的数据：缓存它会让红点长期不消，
 * 用户会以为消息丢了。因此它每次都实时 COUNT
 * （口径与 `docs/SECURITY.md` 第 2.1 节一致）。
 */
@Injectable()
export class MeSummaryService {
  constructor(
    @InjectRepository(EventRegistration)
    private readonly registrations: Repository<EventRegistration>,
    @InjectRepository(ConnectionRequestHistory)
    private readonly requests: Repository<ConnectionRequestHistory>,
    @InjectRepository(ResourcePost) private readonly posts: Repository<ResourcePost>,
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
  ) {}

  /**
   * 首屏计数汇总。
   *
   * 四个数字**并发**取（互不依赖），总耗时 = 最慢的那一条，
   * 而不是四条之和。
   */
  async summary(userId: number): Promise<{
    eventCount: number;
    requestCount: number;
    postCount: number;
    unreadCount: number;
  }> {
    const [eventCount, requestCount, postCount, unreadCount] = await Promise.all([
      // 我的活动报名数
      this.registrations.count({ where: { userId } }),
      // 收到的联系申请数（小程序「我的」页展示的是**收到的**申请）
      this.requests.count({ where: { toUserId: userId } }),
      // 我发布的资源 / 需求数
      this.posts.count({ where: { authorId: userId } }),
      // 未读通知数（**实时**，不缓存 —— `readAt IS NULL` 才是「未读」）
      this.notifications.count({ where: { userId, readAt: IsNull() } }),
    ]);
    return { eventCount, requestCount, postCount, unreadCount };
  }
}
