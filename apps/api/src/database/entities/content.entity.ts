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
import { MediaAsset } from './system.entity';

/** 内容状态（articles / notices 共用） */
export const CONTENT_STATUSES = ['draft', 'published', 'offline'] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

@Entity({ name: 'article_categories' })
export class ArticleCategory {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'name', type: 'varchar', length: 64, nullable: false })
  name: string;

  @Column({ name: 'slug', type: 'varchar', length: 64, nullable: false, unique: true })
  slug: string;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;
}

@Index('idx_articles_published', ['status', 'publishedAt'])
@Entity({ name: 'articles' })
export class Article {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'category_id', type: 'bigint', unsigned: true, nullable: true })
  categoryId: number | null;

  @ManyToOne(() => ArticleCategory, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'category_id' })
  category?: ArticleCategory | null;

  @Column({ name: 'title', type: 'varchar', length: 160, nullable: false })
  title: string;

  @Column({ name: 'summary', type: 'varchar', length: 255, nullable: true })
  summary: string | null;

  @Column({ name: 'body', type: 'mediumtext', nullable: false })
  body: string;

  @Column({ name: 'cover_media_id', type: 'bigint', unsigned: true, nullable: true })
  coverMediaId: number | null;

  @ManyToOne(() => MediaAsset, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'cover_media_id' })
  cover?: MediaAsset | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: [...CONTENT_STATUSES],
    default: 'draft',
  })
  status: ContentStatus;

  @Column({ name: 'published_at', type: 'datetime', precision: 3, nullable: true })
  publishedAt: Date | null;

  @Column({ name: 'view_count', type: 'int', default: 0 })
  viewCount: number;

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

@Entity({ name: 'notices' })
export class Notice {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'title', type: 'varchar', length: 160, nullable: false })
  title: string;

  @Column({ name: 'body', type: 'mediumtext', nullable: false })
  body: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: [...CONTENT_STATUSES],
    default: 'draft',
  })
  status: ContentStatus;

  @Column({ name: 'published_at', type: 'datetime', precision: 3, nullable: true })
  publishedAt: Date | null;

  @Column({ name: 'view_count', type: 'int', default: 0 })
  viewCount: number;

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
