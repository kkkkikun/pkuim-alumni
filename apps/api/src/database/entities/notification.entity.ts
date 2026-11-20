import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from './user.entity';

/** notifications.type */
export const NOTIFICATION_TYPES = [
  'verification_submitted',
  'verification_decision',
  'connection_request',
  'connection_decision',
  'resource_review',
  'event_registration',
  'event_changed',
  'system',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** notification_deliveries.channel */
export const NOTIFICATION_CHANNELS = ['inapp', 'wechat'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** notification_deliveries.status */
export const DELIVERY_STATUSES = ['pending', 'sent', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** outbox_events.status */
export const OUTBOX_STATUSES = ['pending', 'processing', 'done', 'failed'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

@Index('idx_notifications_user', ['userId', 'readAt', 'createdAt'])
// 「我的通知」是 WHERE user_id=? ORDER BY id DESC —— 需要 (user_id, id) 才能供排序。
@Index('idx_notifications_user_id', ['userId', 'id'])
@Entity({ name: 'notifications' })
export class Notification {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'user_id', type: 'bigint', unsigned: true, nullable: false })
  userId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({
    name: 'type',
    type: 'enum',
    enum: [...NOTIFICATION_TYPES],
  })
  type: NotificationType;

  @Column({ name: 'title', type: 'varchar', length: 160, nullable: false })
  title: string;

  @Column({ name: 'body', type: 'varchar', length: 1000, nullable: false })
  body: string;

  @Column({ name: 'payload', type: 'json', nullable: true })
  payload: Record<string, unknown> | null;

  @Column({ name: 'read_at', type: 'datetime', precision: 3, nullable: true })
  readAt: Date | null;

  @Column({ name: 'expires_at', type: 'datetime', precision: 3, nullable: true })
  expiresAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;
}

@Entity({ name: 'notification_deliveries' })
export class NotificationDelivery {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'notification_id', type: 'bigint', unsigned: true, nullable: false })
  notificationId: number;

  @ManyToOne(() => Notification, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'notification_id' })
  notification?: Notification;

  @Column({
    name: 'channel',
    type: 'enum',
    enum: [...NOTIFICATION_CHANNELS],
    default: 'inapp',
  })
  channel: NotificationChannel;

  @Column({
    name: 'status',
    type: 'enum',
    enum: [...DELIVERY_STATUSES],
    default: 'pending',
  })
  status: DeliveryStatus;

  @Column({ name: 'attempts', type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError: string | null;

  @Column({ name: 'sent_at', type: 'datetime', precision: 3, nullable: true })
  sentAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;
}

@Index('idx_outbox_pending', ['status', 'availableAt'])
@Entity({ name: 'outbox_events' })
export class OutboxEvent {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'aggregate_type', type: 'varchar', length: 64, nullable: false })
  aggregateType: string;

  @Column({ name: 'aggregate_id', type: 'varchar', length: 64, nullable: false })
  aggregateId: string;

  @Column({ name: 'event_type', type: 'varchar', length: 64, nullable: false })
  eventType: string;

  @Column({ name: 'payload', type: 'json', nullable: true })
  payload: Record<string, unknown> | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: [...OUTBOX_STATUSES],
    default: 'pending',
  })
  status: OutboxStatus;

  @Column({ name: 'attempts', type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'available_at', type: 'datetime', precision: 3, nullable: false })
  availableAt: Date;

  @Column({ name: 'processed_at', type: 'datetime', precision: 3, nullable: true })
  processedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;
}
