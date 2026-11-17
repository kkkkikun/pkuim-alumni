import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  ValueTransformer,
} from 'typeorm';

/** users.status */
export const USER_STATUSES = ['active', 'disabled', 'locked'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** users.stage —— 身份阶段（guest 为未登录态，不落库） */
export const USER_STAGES = ['logged_in', 'pending_review', 'verified'] as const;
export type UserStage = (typeof USER_STAGES)[number];

/** users.source */
export const USER_SOURCES = ['wechat', 'mock'] as const;
export type UserSource = (typeof USER_SOURCES)[number];

export const boolTransformer: ValueTransformer = {
  /**
   * undefined → undefined：TypeORM 不写入该列，交由数据库默认值生效
   * （例如 show_college 默认 1、verified 默认 0）。
   * 显式 null → null：仅用于确实可空的布尔列。
   */
  to(value: boolean | null | undefined): number | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return value ? 1 : 0;
  },
  from(value: number | null): boolean | null {
    return value === null || value === undefined ? null : value === 1;
  },
};

@Index('uk_users_openid', ['openid'], { unique: true })
@Index('uk_users_unionid', ['unionid'], { unique: true })
@Index('idx_users_stage', ['stage'])
@Entity({ name: 'users' })
export class User {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'openid', type: 'varchar', length: 64, nullable: false })
  openid: string;

  @Column({ name: 'unionid', type: 'varchar', length: 64, nullable: true })
  unionid: string | null;

  @Column({ name: 'nickname', type: 'varchar', length: 64, nullable: false })
  nickname: string;

  @Column({ name: 'avatar_url', type: 'varchar', length: 512, nullable: true })
  avatarUrl: string | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: [...USER_STATUSES],
    default: 'active',
  })
  status: UserStatus;

  @Column({
    name: 'stage',
    type: 'enum',
    enum: [...USER_STAGES],
    default: 'logged_in',
  })
  stage: UserStage;

  @Column({
    name: 'source',
    type: 'enum',
    enum: [...USER_SOURCES],
    default: 'mock',
  })
  source: UserSource;

  @Column({ name: 'last_login_at', type: 'datetime', precision: 3, nullable: true })
  lastLoginAt: Date | null;

  /** 乐观锁版本号，由业务层按 DATABASE-DESIGN.md §10 的条件更新 SQL 维护 */
  @Column({ name: 'version', type: 'int', default: 0 })
  version: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt: Date;
}

@Index('uk_user_sessions_token', ['refreshTokenHash'], { unique: true })
@Index('idx_user_sessions_user_revoked', ['userId', 'revokedAt'])
@Entity({ name: 'user_sessions' })
export class UserSession {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'user_id', type: 'bigint', unsigned: true, nullable: false })
  userId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  /** 只存 refresh token 哈希 */
  @Column({ name: 'refresh_token_hash', type: 'char', length: 64, nullable: false })
  refreshTokenHash: string;

  @Column({ name: 'device', type: 'varchar', length: 128, nullable: true })
  device: string | null;

  @Column({ name: 'ip', type: 'varchar', length: 45, nullable: true })
  ip: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 512, nullable: true })
  userAgent: string | null;

  @Column({ name: 'expires_at', type: 'datetime', precision: 3, nullable: false })
  expiresAt: Date;

  @Column({ name: 'revoked_at', type: 'datetime', precision: 3, nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt: Date;
}
