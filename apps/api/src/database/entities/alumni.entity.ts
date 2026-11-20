import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { AdminUser } from './admin.entity';
import { Region } from './dictionary.entity';
import { Industry } from './dictionary.entity';
import { User, boolTransformer } from './user.entity';

@Index('uk_alumni_profiles_user', ['userId'], { unique: true })
@Index('idx_alumni_profiles_region', ['regionCode'])
@Index('idx_alumni_profiles_industry', ['industryCode'])
@Index('idx_alumni_profiles_directory', ['showInDirectory', 'regionCode', 'industryCode'])
// 通讯录按毕业年份筛选。
@Index('idx_alumni_profiles_graduation_year', ['graduationYear'])
@Entity({ name: 'alumni_profiles' })
export class AlumniProfile {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'user_id', type: 'bigint', unsigned: true, nullable: false })
  userId: number;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  /** 通讯录展示名（可脱敏） */
  @Column({ name: 'display_name', type: 'varchar', length: 64, nullable: false })
  displayName: string;

  @Column({ name: 'real_name', type: 'varchar', length: 64, nullable: true })
  realName: string | null;

  @Column({ name: 'college', type: 'varchar', length: 64, nullable: true })
  college: string | null;

  @Column({ name: 'degree', type: 'varchar', length: 64, nullable: true })
  degree: string | null;

  @Column({ name: 'graduation_year', type: 'smallint', unsigned: true, nullable: true })
  graduationYear: number | null;

  @Column({ name: 'region_code', type: 'varchar', length: 32, nullable: true })
  regionCode: string | null;

  @ManyToOne(() => Region, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'region_code' })
  region?: Region | null;

  @Column({ name: 'industry_code', type: 'varchar', length: 32, nullable: true })
  industryCode: string | null;

  @ManyToOne(() => Industry, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'industry_code' })
  industry?: Industry | null;

  @Column({ name: 'direction', type: 'varchar', length: 128, nullable: true })
  direction: string | null;

  /** 交流意向 */
  @Column({ name: 'intro', type: 'varchar', length: 1000, nullable: true })
  intro: string | null;

  @Column({
    name: 'verified',
    type: 'tinyint',
    unsigned: true,
    default: 0,
    transformer: boolTransformer,
  })
  verified: boolean;

  @Column({ name: 'verified_at', type: 'datetime', precision: 3, nullable: true })
  verifiedAt: Date | null;

  /** 审核管理员（admin_users.id） */
  @Column({ name: 'verified_by', type: 'bigint', unsigned: true, nullable: true })
  verifiedBy: number | null;

  @ManyToOne(() => AdminUser, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'verified_by' })
  verifiedByAdmin?: AdminUser;

  @Column({
    name: 'show_in_directory',
    type: 'tinyint',
    unsigned: true,
    default: 0,
    transformer: boolTransformer,
  })
  showInDirectory: boolean;

  @Column({
    name: 'show_college',
    type: 'tinyint',
    unsigned: true,
    default: 1,
    transformer: boolTransformer,
  })
  showCollege: boolean;

  @Column({
    name: 'show_industry',
    type: 'tinyint',
    unsigned: true,
    default: 1,
    transformer: boolTransformer,
  })
  showIndustry: boolean;

  @Column({
    name: 'show_region',
    type: 'tinyint',
    unsigned: true,
    default: 1,
    transformer: boolTransformer,
  })
  showRegion: boolean;

  @Column({
    name: 'show_direction',
    type: 'tinyint',
    unsigned: true,
    default: 1,
    transformer: boolTransformer,
  })
  showDirection: boolean;

  @Column({
    name: 'accept_contact_requests',
    type: 'tinyint',
    unsigned: true,
    default: 1,
    transformer: boolTransformer,
  })
  acceptContactRequests: boolean;

  @Column({
    name: 'allow_contact_share',
    type: 'tinyint',
    unsigned: true,
    default: 1,
    transformer: boolTransformer,
  })
  allowContactShare: boolean;

  /** 乐观锁版本号，由业务层按 DATABASE-DESIGN.md §10 的条件更新 SQL 维护 */
  @Column({ name: 'version', type: 'int', default: 0 })
  version: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt: Date;
}

/**
 * 私人联系方式：与用户 1:1，仅存密文。
 * 隐私硬规则：任何列表接口都不得 SELECT 本表列。
 */
@Entity({ name: 'private_contacts' })
export class PrivateContact {
  @PrimaryColumn({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ name: 'phone_cipher', type: 'varchar', length: 255, nullable: true })
  phoneCipher: string | null;

  @Column({ name: 'wechat_cipher', type: 'varchar', length: 255, nullable: true })
  wechatCipher: string | null;

  @Column({ name: 'email_cipher', type: 'varchar', length: 255, nullable: true })
  emailCipher: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt: Date;
}
