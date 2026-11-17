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
import { Industry } from './dictionary.entity';
import { Region } from './dictionary.entity';
import { MediaAsset } from './system.entity';
import { User } from './user.entity';
import { REVIEW_ACTIONS, ReviewAction } from './verification.entity';

/** resource_posts.type */
export const RESOURCE_TYPES = ['resource', 'demand'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

/** resource_posts.status */
export const RESOURCE_STATUSES = [
  'draft',
  'pending',
  'published',
  'rejected',
  'offline',
  'withdrawn',
] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

@Index('idx_resource_status', ['status', 'publishedAt'])
@Index('idx_resource_author', ['authorId', 'createdAt'])
@Index('idx_resource_filter', ['industryCode', 'regionCode', 'status'])
@Entity({ name: 'resource_posts' })
export class ResourcePost {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'author_id', type: 'bigint', unsigned: true, nullable: false })
  authorId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'author_id' })
  author?: User;

  @Column({
    name: 'type',
    type: 'enum',
    enum: [...RESOURCE_TYPES],
    default: 'resource',
  })
  type: ResourceType;

  @Column({ name: 'title', type: 'varchar', length: 120, nullable: false })
  title: string;

  @Column({ name: 'body', type: 'text', nullable: false })
  body: string;

  @Column({ name: 'industry_code', type: 'varchar', length: 32, nullable: true })
  industryCode: string | null;

  @ManyToOne(() => Industry, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'industry_code' })
  industry?: Industry | null;

  @Column({ name: 'region_code', type: 'varchar', length: 32, nullable: true })
  regionCode: string | null;

  @ManyToOne(() => Region, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'region_code' })
  region?: Region | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: [...RESOURCE_STATUSES],
    default: 'draft',
  })
  status: ResourceStatus;

  /** 乐观锁版本号：审核/修改时按 `WHERE id=? AND status='pending' AND version=?` 条件更新 */
  @Column({ name: 'version', type: 'int', default: 0 })
  version: number;

  @Column({ name: 'published_at', type: 'datetime', precision: 3, nullable: true })
  publishedAt: Date | null;

  @Column({ name: 'created_by', type: 'bigint', unsigned: true, nullable: true })
  createdBy: number | null;

  @ManyToOne(() => AdminUser, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'created_by' })
  creator?: AdminUser | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt: Date;
}

/**
 * 资源审核历史（只追加，不覆盖）。
 * 每个审核动作追加一行，携带当时的 version 快照。
 */
@Index('idx_resource_reviews_post', ['postId', 'createdAt'])
@Entity({ name: 'resource_post_reviews' })
export class ResourcePostReview {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'post_id', type: 'bigint', unsigned: true, nullable: false })
  postId: number;

  @ManyToOne(() => ResourcePost, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'post_id' })
  post?: ResourcePost;

  @Column({ name: 'admin_id', type: 'bigint', unsigned: true, nullable: false })
  adminId: number;

  @ManyToOne(() => AdminUser, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'admin_id' })
  admin?: AdminUser;

  @Column({
    name: 'action',
    type: 'enum',
    enum: [...REVIEW_ACTIONS],
  })
  action: ReviewAction;

  @Column({ name: 'note', type: 'varchar', length: 500, nullable: true })
  note: string | null;

  @Column({ name: 'snapshot_version', type: 'int', default: 0 })
  snapshotVersion: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;
}

@Index('uk_resource_post_attachment', ['postId', 'mediaId'], { unique: true })
@Entity({ name: 'resource_post_attachments' })
export class ResourcePostAttachment {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'post_id', type: 'bigint', unsigned: true, nullable: false })
  postId: number;

  @ManyToOne(() => ResourcePost, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'post_id' })
  post?: ResourcePost;

  @Column({ name: 'media_id', type: 'bigint', unsigned: true, nullable: false })
  mediaId: number;

  @ManyToOne(() => MediaAsset, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'media_id' })
  media?: MediaAsset;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;
}
