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
import { User } from './user.entity';

/** verification_applications.status */
export const VERIFICATION_STATUSES = [
  'pending',
  'needs_more_material',
  'approved',
  'rejected',
  'resubmitted',
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** 审核动作（与资源审核共用同一组动作） */
export const REVIEW_ACTIONS = [
  'approve',
  'reject',
  'request_changes',
  'offline',
] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

@Index('idx_verification_status', ['status', 'submittedAt'])
@Index('idx_verification_user', ['userId', 'submittedAt'])
@Entity({ name: 'verification_applications' })
export class VerificationApplication {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'user_id', type: 'bigint', unsigned: true, nullable: false })
  userId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ name: 'real_name', type: 'varchar', length: 64, nullable: false })
  realName: string;

  @Column({ name: 'college', type: 'varchar', length: 64, nullable: false })
  college: string;

  @Column({ name: 'graduation_year', type: 'smallint', unsigned: true, nullable: false })
  graduationYear: number;

  @Column({ name: 'degree', type: 'varchar', length: 64, nullable: true })
  degree: string | null;

  /** 学号脱敏 */
  @Column({ name: 'student_id_masked', type: 'varchar', length: 32, nullable: true })
  studentIdMasked: string | null;

  @Column({ name: 'remark', type: 'varchar', length: 500, nullable: true })
  remark: string | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: [...VERIFICATION_STATUSES],
    default: 'pending',
  })
  status: VerificationStatus;

  @Column({ name: 'decided_by', type: 'bigint', unsigned: true, nullable: true })
  decidedBy: number | null;

  @ManyToOne(() => AdminUser, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'decided_by' })
  decider?: AdminUser | null;

  @Column({ name: 'decision_note', type: 'varchar', length: 500, nullable: true })
  decisionNote: string | null;

  @Column({ name: 'submitted_at', type: 'datetime', precision: 3, nullable: false })
  submittedAt: Date;

  @Column({ name: 'decided_at', type: 'datetime', precision: 3, nullable: true })
  decidedAt: Date | null;

  /** 乐观锁版本号 */
  @Column({ name: 'version', type: 'int', default: 0 })
  version: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt: Date;
}

@Index('uk_verification_attachment', ['applicationId', 'mediaId'], { unique: true })
@Entity({ name: 'verification_attachments' })
export class VerificationAttachment {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'application_id', type: 'bigint', unsigned: true, nullable: false })
  applicationId: number;

  @ManyToOne(() => VerificationApplication, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'application_id' })
  application?: VerificationApplication;

  @Column({ name: 'media_id', type: 'bigint', unsigned: true, nullable: false })
  mediaId: number;

  @ManyToOne(() => MediaAsset, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'media_id' })
  media?: MediaAsset;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;
}

/**
 * 认证审核历史（只追加，不覆盖）。
 * 见 docs/top.md §5.2「认证审核历史不能覆盖」与 contracts VerificationReviewDto。
 */
@Index('idx_verification_reviews_app', ['applicationId', 'createdAt'])
@Entity({ name: 'verification_reviews' })
export class VerificationReview {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'application_id', type: 'bigint', unsigned: true, nullable: false })
  applicationId: number;

  @ManyToOne(() => VerificationApplication, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'application_id' })
  application?: VerificationApplication;

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

  /** 审核时的内容版本快照 */
  @Column({ name: 'snapshot_version', type: 'int', default: 0 })
  snapshotVersion: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;
}
