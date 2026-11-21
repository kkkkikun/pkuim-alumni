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

  // ⚠️ 长度必须与迁移 `WidenIdempotencyScope1730000004000` 一致（**255**）：
  //   缺陷 #140 —— scope 是「方法 + 实际路径 + 用户 id」，
  //   长路径会超过 64 字符，MySQL 直接报 `Data too long` → 幂等请求 500。
  //   迁移把列放宽到了 255，而**实体一直没跟着改** ——
  //   于是实体声明（64）与库里真实结构（255）分叉：
  //   一旦哪个环境开着 `synchronize: true`（或有人跑 `migration:generate`），
  //   就会把列**缩回** 64 → 缺陷 #140 原形复发。
  //   第十轮由「实体 ↔ 迁移」对账（`check-error-semantics.mjs` 的 R5）抓出并修正。
  @Column({ name: 'scope', type: 'varchar', length: 255, nullable: false })
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
