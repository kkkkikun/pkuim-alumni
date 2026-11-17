import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from './user.entity';

/** media_assets.visibility */
export const MEDIA_VISIBILITIES = ['public', 'private'] as const;
export type MediaVisibility = (typeof MEDIA_VISIBILITIES)[number];

/** idempotency_records.status */
export const IDEMPOTENCY_STATUSES = ['in_progress', 'completed'] as const;
export type IdempotencyStatus = (typeof IDEMPOTENCY_STATUSES)[number];

@Index('idx_media_uploader', ['uploaderId', 'createdAt'])
@Entity({ name: 'media_assets' })
export class MediaAsset {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'file_name', type: 'varchar', length: 255, nullable: false })
  fileName: string;

  @Column({ name: 'mime_type', type: 'varchar', length: 128, nullable: false })
  mimeType: string;

  @Column({ name: 'size', type: 'bigint', unsigned: true, nullable: false })
  size: number;

  @Column({ name: 'bucket', type: 'varchar', length: 64, nullable: false })
  bucket: string;

  @Column({ name: 'object_key', type: 'varchar', length: 512, nullable: false })
  objectKey: string;

  /** 认证证明材料等敏感文件必须为 private */
  @Column({
    name: 'visibility',
    type: 'enum',
    enum: [...MEDIA_VISIBILITIES],
    default: 'private',
  })
  visibility: MediaVisibility;

  @Column({ name: 'uploader_id', type: 'bigint', unsigned: true, nullable: true })
  uploaderId: number | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'uploader_id' })
  uploader?: User | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;
}

@Index('uk_idempotency', ['scope', 'idemKey'], { unique: true })
@Entity({ name: 'idempotency_records' })
export class IdempotencyRecord {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'scope', type: 'varchar', length: 64, nullable: false })
  scope: string;

  @Column({ name: 'idem_key', type: 'varchar', length: 128, nullable: false })
  idemKey: string;

  @Column({ name: 'user_id', type: 'bigint', unsigned: true, nullable: true })
  userId: number | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user?: User | null;

  @Column({ name: 'request_hash', type: 'char', length: 64, nullable: false })
  requestHash: string;

  @Column({ name: 'response_body', type: 'json', nullable: true })
  responseBody: Record<string, unknown> | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: [...IDEMPOTENCY_STATUSES],
    default: 'in_progress',
  })
  status: IdempotencyStatus;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;

  @Column({ name: 'expires_at', type: 'datetime', precision: 3, nullable: false })
  expiresAt: Date;
}

@Entity({ name: 'system_settings' })
export class SystemSetting {
  @PrimaryColumn({ name: 'key', type: 'varchar', length: 64 })
  key: string;

  @Column({ name: 'value', type: 'text', nullable: false })
  value: string;

  @Column({ name: 'description', type: 'varchar', length: 255, nullable: true })
  description: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt: Date;
}
