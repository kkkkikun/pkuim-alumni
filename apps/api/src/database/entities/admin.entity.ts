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

/** admin_users.status */
export const ADMIN_STATUSES = ['active', 'disabled'] as const;
export type AdminStatus = (typeof ADMIN_STATUSES)[number];

/** 内置角色 code（见 DATABASE-DESIGN.md §8） */
export const ADMIN_ROLE_CODES = [
  'super_admin',
  'alumni_reviewer',
  'resource_reviewer',
  'content_admin',
  'event_admin',
] as const;
export type AdminRoleCode = (typeof ADMIN_ROLE_CODES)[number];

@Entity({ name: 'admin_users' })
export class AdminUser {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'username', type: 'varchar', length: 64, nullable: false, unique: true })
  username: string;

  /** bcrypt 哈希，绝不返回给前端 */
  @Column({ name: 'password_hash', type: 'varchar', length: 255, nullable: false })
  passwordHash: string;

  @Column({ name: 'display_name', type: 'varchar', length: 64, nullable: false })
  displayName: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: [...ADMIN_STATUSES],
    default: 'active',
  })
  status: AdminStatus;

  @Column({ name: 'last_login_at', type: 'datetime', precision: 3, nullable: true })
  lastLoginAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt: Date;
}

@Entity({ name: 'roles' })
export class Role {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'code', type: 'varchar', length: 32, nullable: false, unique: true })
  code: AdminRoleCode | string;

  @Column({ name: 'name', type: 'varchar', length: 64, nullable: false })
  name: string;

  @Column({ name: 'description', type: 'varchar', length: 255, nullable: true })
  description: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;
}

@Entity({ name: 'permissions' })
export class Permission {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'code', type: 'varchar', length: 64, nullable: false, unique: true })
  code: string;

  @Column({ name: 'name', type: 'varchar', length: 64, nullable: false })
  name: string;

  @Column({ name: 'description', type: 'varchar', length: 255, nullable: true })
  description: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;
}

@Index('uk_admin_user_roles', ['adminUserId', 'roleId'], { unique: true })
@Entity({ name: 'admin_user_roles' })
export class AdminUserRole {
  @PrimaryColumn({ name: 'admin_user_id', type: 'bigint', unsigned: true })
  adminUserId: number;

  @ManyToOne(() => AdminUser, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'admin_user_id' })
  adminUser?: AdminUser;

  @PrimaryColumn({ name: 'role_id', type: 'bigint', unsigned: true })
  roleId: number;

  @ManyToOne(() => Role, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'role_id' })
  role?: Role;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;
}

@Index('uk_role_permissions', ['roleId', 'permissionId'], { unique: true })
@Entity({ name: 'role_permissions' })
export class RolePermission {
  @PrimaryColumn({ name: 'role_id', type: 'bigint', unsigned: true })
  roleId: number;

  @ManyToOne(() => Role, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'role_id' })
  role?: Role;

  @PrimaryColumn({ name: 'permission_id', type: 'bigint', unsigned: true })
  permissionId: number;

  @ManyToOne(() => Permission, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'permission_id' })
  permission?: Permission;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;
}

@Index('idx_admin_action_logs_admin', ['adminId', 'createdAt'])
@Entity({ name: 'admin_action_logs' })
export class AdminActionLog {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'admin_id', type: 'bigint', unsigned: true, nullable: false })
  adminId: number;

  @ManyToOne(() => AdminUser, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'admin_id' })
  admin?: AdminUser;

  @Column({ name: 'action', type: 'varchar', length: 64, nullable: false })
  action: string;

  @Column({ name: 'target_type', type: 'varchar', length: 32, nullable: true })
  targetType: string | null;

  @Column({ name: 'target_id', type: 'varchar', length: 64, nullable: true })
  targetId: string | null;

  @Column({ name: 'detail', type: 'json', nullable: true })
  detail: Record<string, unknown> | null;

  @Column({ name: 'ip', type: 'varchar', length: 45, nullable: true })
  ip: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;
}
