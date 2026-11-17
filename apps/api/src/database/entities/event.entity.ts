import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { AdminUser } from './admin.entity';
import { Region } from './dictionary.entity';
import { MediaAsset } from './system.entity';
import { User } from './user.entity';

/** events.status */
export const EVENT_STATUSES = ['draft', 'published', 'closed', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** event_registrations.status */
export const REGISTRATION_STATUSES = [
  'registered',
  'cancelled',
  'attended',
] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

@Index('idx_events_status', ['status', 'startsAt'])
@Entity({ name: 'events' })
export class Event {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'title', type: 'varchar', length: 120, nullable: false })
  title: string;

  /** 活动类型，如 reunion / lecture / industry / charity */
  @Column({ name: 'kind', type: 'varchar', length: 32, nullable: false })
  kind: string;

  @Column({ name: 'region_code', type: 'varchar', length: 32, nullable: true })
  regionCode: string | null;

  @ManyToOne(() => Region, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'region_code' })
  region?: Region | null;

  @Column({ name: 'place', type: 'varchar', length: 255, nullable: true })
  place: string | null;

  @Column({ name: 'description', type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'starts_at', type: 'datetime', precision: 3, nullable: true })
  startsAt: Date | null;

  @Column({ name: 'ends_at', type: 'datetime', precision: 3, nullable: true })
  endsAt: Date | null;

  /** 0 表示不限名额 */
  @Column({ name: 'capacity', type: 'int', default: 0 })
  capacity: number;

  /** 已报名人数，由事务内条件更新维护 */
  @Column({ name: 'registered_count', type: 'int', default: 0 })
  registeredCount: number;

  @Column({
    name: 'status',
    type: 'enum',
    enum: [...EVENT_STATUSES],
    default: 'draft',
  })
  status: EventStatus;

  @Column({ name: 'cover_media_id', type: 'bigint', unsigned: true, nullable: true })
  coverMediaId: number | null;

  @ManyToOne(() => MediaAsset, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'cover_media_id' })
  cover?: MediaAsset | null;

  @Column({ name: 'created_by', type: 'bigint', unsigned: true, nullable: true })
  createdBy: number | null;

  @ManyToOne(() => AdminUser, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'created_by' })
  creator?: AdminUser | null;

  /** 乐观锁版本号 */
  @Column({ name: 'version', type: 'int', default: 0 })
  version: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt: Date;
}

/**
 * 活动报名。
 * 唯一索引 uk_event_registration(event_id, user_id) 保证同一用户同一活动只有一条报名记录；
 * 取消报名复用同一行（status 改回 'registered'）。
 */
@Index('uk_event_registration', ['eventId', 'userId'], { unique: true })
@Entity({ name: 'event_registrations' })
export class EventRegistration {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'event_id', type: 'bigint', unsigned: true, nullable: false })
  eventId: number;

  @ManyToOne(() => Event, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event?: Event;

  @Column({ name: 'user_id', type: 'bigint', unsigned: true, nullable: false })
  userId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({
    name: 'status',
    type: 'enum',
    enum: [...REGISTRATION_STATUSES],
    default: 'registered',
  })
  status: RegistrationStatus;

  @Column({ name: 'note', type: 'varchar', length: 500, nullable: true })
  note: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt: Date;
}
