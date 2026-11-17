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
import { User, boolTransformer } from './user.entity';

/** connection_pairs.status */
export const CONNECTION_PAIR_STATUSES = ['active', 'revoked'] as const;
export type ConnectionPairStatus = (typeof CONNECTION_PAIR_STATUSES)[number];

/** connection_request_history.status */
export const CONNECTION_REQUEST_STATUSES = [
  'pending',
  'accepted',
  'rejected',
  'cancelled',
  'expired',
] as const;
export type ConnectionRequestStatus = (typeof CONNECTION_REQUEST_STATUSES)[number];

@Index('uk_connection_pairs', ['userAId', 'userBId'], { unique: true })
@Entity({ name: 'connection_pairs' })
export class ConnectionPair {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  /** 规范化：始终满足 user_a_id < user_b_id */
  @Column({ name: 'user_a_id', type: 'bigint', unsigned: true, nullable: false })
  userAId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_a_id' })
  userA?: User;

  @Column({ name: 'user_b_id', type: 'bigint', unsigned: true, nullable: false })
  userBId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_b_id' })
  userB?: User;

  @Column({
    name: 'status',
    type: 'enum',
    enum: [...CONNECTION_PAIR_STATUSES],
    default: 'active',
  })
  status: ConnectionPairStatus;

  @Column({ name: 'established_at', type: 'datetime', precision: 3, nullable: false })
  establishedAt: Date;

  @Column({ name: 'revoked_at', type: 'datetime', precision: 3, nullable: true })
  revokedAt: Date | null;

  /** 乐观锁版本号 */
  @Column({ name: 'version', type: 'int', default: 0 })
  version: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt: Date;
}

/**
 * 联系申请历史（只追加）。
 * `pending_guard` 在 status='pending' 时等于 pair_key，否则为 NULL；
 * 唯一索引 uk_connection_request_pending 保证同一对用户同时只有一条 pending 申请
 * （MySQL 唯一索引允许多个 NULL）。
 */
@Index('uk_connection_request_pending', ['pendingGuard'], { unique: true })
@Index('idx_request_to', ['toUserId', 'status'])
@Index('idx_request_from', ['fromUserId', 'status'])
@Index('idx_request_pair', ['pairKey'])
@Entity({ name: 'connection_request_history' })
export class ConnectionRequestHistory {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'from_user_id', type: 'bigint', unsigned: true, nullable: false })
  fromUserId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'from_user_id' })
  fromUser?: User;

  @Column({ name: 'to_user_id', type: 'bigint', unsigned: true, nullable: false })
  toUserId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'to_user_id' })
  toUser?: User;

  /** `min(from,to):max(from,to)` */
  @Column({ name: 'pair_key', type: 'varchar', length: 64, nullable: false })
  pairKey: string;

  @Column({ name: 'pending_guard', type: 'varchar', length: 64, nullable: true })
  pendingGuard: string | null;

  /** 接受后回填 */
  @Column({ name: 'pair_id', type: 'bigint', unsigned: true, nullable: true })
  pairId: number | null;

  @ManyToOne(() => ConnectionPair, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'pair_id' })
  pair?: ConnectionPair | null;

  @Column({ name: 'message', type: 'varchar', length: 500, nullable: false })
  message: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: [...CONNECTION_REQUEST_STATUSES],
    default: 'pending',
  })
  status: ConnectionRequestStatus;

  @Column({ name: 'decided_by', type: 'bigint', unsigned: true, nullable: true })
  decidedBy: number | null;

  @ManyToOne(() => AdminUser, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'decided_by' })
  decider?: AdminUser | null;

  @Column({ name: 'decided_at', type: 'datetime', precision: 3, nullable: true })
  decidedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt: Date;
}

@Index('uk_contact_grant', ['pairId', 'userId'], { unique: true })
@Entity({ name: 'contact_share_grants' })
export class ContactShareGrant {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'pair_id', type: 'bigint', unsigned: true, nullable: false })
  pairId: number;

  @ManyToOne(() => ConnectionPair, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'pair_id' })
  pair?: ConnectionPair;

  @Column({ name: 'user_id', type: 'bigint', unsigned: true, nullable: false })
  userId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  /** 是否授权向已建立连接的对方向展示联系方式 */
  @Column({
    name: 'allow',
    type: 'tinyint',
    unsigned: true,
    default: 0,
    transformer: boolTransformer,
  })
  allow: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt: Date;
}
