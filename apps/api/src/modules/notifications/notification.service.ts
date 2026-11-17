import { Injectable, NotFoundException } from '@nestjs/common';
import { paginate } from '../../common/dto/pagination.dto';
import type { PageResult } from '../../common/dto/pagination.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import {
  Notification,
  NotificationDelivery,
  OutboxEvent,
} from '../../database/entities/notification.entity';

export type NotificationTypeValue =
  | 'verification_submitted'
  | 'verification_decision'
  | 'connection_request'
  | 'connection_decision'
  | 'resource_review'
  | 'event_registration'
  | 'event_changed'
  | 'system';

@Injectable()
export class NotificationService {
  constructor(
    @InjectRepository(Notification) private readonly notifications: Repository<Notification>,
    @InjectRepository(NotificationDelivery)
    private readonly deliveries: Repository<NotificationDelivery>,
    @InjectRepository(OutboxEvent) private readonly outbox: Repository<OutboxEvent>,
  ) {}

  async listFor(
    userId: number,
    page: number,
    pageSize: number,
  ): Promise<PageResult<Record<string, unknown>>> {
    const qb = this.notifications
      .createQueryBuilder('n')
      .where('n.userId = :userId', { userId })
      .orderBy('n.id', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);
    const [entities, total] = await qb.getManyAndCount();
    return paginate(
      entities.map((item) => ({
        id: item.id,
        type: item.type,
        title: item.title,
        body: item.body,
        payload: item.payload,
        read: Boolean(item.readAt),
        createdAt: item.createdAt,
      })),
      total,
      page,
      pageSize,
    );
  }

  async unreadCount(userId: number): Promise<number> {
    return this.notifications
      .createQueryBuilder('n')
      .where('n.userId = :userId', { userId })
      .andWhere('n.readAt IS NULL')
      .getCount();
  }

  /**
   * 标记一条通知为已读。
   *
   * ⚠️ 必须判断影响行数（缺陷 #124）：
   *   条件是 `id = :id AND userId = :userId`，
   *   影响 0 行说明「这条通知不存在」或「不是你的」——
   *   原实现**不检查**影响行数，接口无条件返回「已读」，
   *   于是**对不存在的通知也返回 200**（假成功），
   *   而同一个模块的 `GET /notifications/:id` 对不存在返回 **404** ——
   *   同一个对象、两个端点、相反的语义。
   *
   * ⚠️ 已读通知再次标记时值可能不变（MySQL 的 affectedRows 数的是**实际改变**的行），
   *   所以影响 0 行时再查一次存在性，把「已经读过」与「根本不存在」区分开。
   */
  async markRead(userId: number, notificationId: number): Promise<void> {
    const result = await this.notifications
      .createQueryBuilder()
      .update(Notification)
      .set({ readAt: new Date() })
      .where('id = :id', { id: notificationId })
      .andWhere('userId = :userId', { userId })
      .execute();
    if (result.affected) return;
    const exists = await this.notifications.findOne({
      where: { id: notificationId, userId },
    });
    if (!exists) {
      throw new NotFoundException('通知不存在');
    }
  }

  async markAllRead(userId: number): Promise<number> {
    const result = await this.notifications
      .createQueryBuilder()
      .update(Notification)
      .set({ readAt: new Date() })
      .where('userId = :userId', { userId })
      .andWhere('readAt IS NULL')
      .execute();
    return result.affected ?? 0;
  }

  /**
   * 写入站内通知并登记 Outbox 事件。
   *
   * ⚠️ **必须与业务写入同事务**（docs/top.md §597 / docs/CONCURRENCY-DESIGN.md §67
   * 「通知等副作用先写 `outbox_events`（与业务同事务）……避免「业务成功但通知丢失」」）。
   *
   * 为此本方法接受一个可选的 `manager`（业务事务的 EntityManager）：
   * 传入时，三次写入（notification / notification_deliveries / outbox_events）
   * **全部走该事务**；不传时退化为各自独立提交 —— 那种情况下
   * 「业务成功但通知丢失」并不能被消除（这正是缺陷 #99）。
   *
   * 调用方约定：**业务写入与本次调用必须使用同一个 `manager`**，
   * 否则业务写入不在事务里，通知仍会与业务脱节。
   */
  async push(
    userId: number,
    type: NotificationTypeValue,
    title: string,
    body: string,
    payload: Record<string, unknown> = {},
    options: { eventType?: string; aggregateType?: string; aggregateId?: string } = {},
    manager?: EntityManager,
  ): Promise<Notification> {
    const notifications = manager ? manager.getRepository(Notification) : this.notifications;
    const deliveries = manager ? manager.getRepository(NotificationDelivery) : this.deliveries;
    const outbox = manager ? manager.getRepository(OutboxEvent) : this.outbox;

    const notification = await notifications.save(
      notifications.create({ userId, type, title, body, payload }),
    );
    await deliveries.save(
      deliveries.create({ notificationId: notification.id, channel: 'inapp', status: 'pending' }),
    );
    await outbox.save(
      outbox.create({
        aggregateType: options.aggregateType ?? 'notification',
        // ⚠️ `aggregateId` 必须**优先用调用方给的值**（缺陷 #139）：
        //    调用方传的是「这个事件所指向的聚合根 id」（如联系申请 id、
        //    活动 id、认证申请 id），而 `notification.id` 是**通知自己的 id**。
        //    之前这里写死成 `String(notification.id)` → 调用方传的
        //    `aggregateId` 被**静默丢弃** → 事件类型写着
        //    `connection.request.created`，aggregate_id 却指向一条通知，
        //    「按聚合根查事件」永远查不到。
        //    ⚠️ 这个 bug 长期没被发现，是因为老夹具用 TRUNCATE 重置 →
        //    各表的自增计数器都从 1 开始 → 通知 id 恰好等于聚合根 id，
        //    断言**靠巧合**通过（缺陷 #138 改用 DELETE 重置后才暴露）。
        aggregateId: options.aggregateId ?? String(notification.id),
        eventType: options.eventType ?? `notification.${type}`,
        payload: { notificationId: notification.id, userId, type, title },
        status: 'pending',
        availableAt: new Date(),
      }),
    );
    return notification;
  }
}
