/**
 * 实体统一出口（barrel）。
 *
 * 约定：
 * - TS 属性使用 camelCase，数据库列使用 snake_case（显式 `name` 指定）。
 * - 表名与 DATABASE-DESIGN.md 完全一致。
 * - 迁移文件为唯一事实来源，生产环境禁止 synchronize。
 */
export * from './user.entity';
export * from './alumni.entity';
export * from './dictionary.entity';
export * from './verification.entity';
export * from './connection.entity';
export * from './resource.entity';
export * from './event.entity';
export * from './content.entity';
export * from './notification.entity';
export * from './admin.entity';
export * from './system.entity';

import { User, UserSession } from './user.entity';
import { AlumniProfile, PrivateContact } from './alumni.entity';
import { Industry, Region } from './dictionary.entity';
import {
  VerificationApplication,
  VerificationAttachment,
  VerificationReview,
} from './verification.entity';
import {
  ConnectionPair,
  ConnectionRequestHistory,
  ContactShareGrant,
} from './connection.entity';
import {
  ResourcePost,
  ResourcePostAttachment,
  ResourcePostReview,
} from './resource.entity';
import { Event, EventRegistration } from './event.entity';
import { Article, ArticleCategory, Notice } from './content.entity';
import {
  Notification,
  NotificationDelivery,
  OutboxEvent,
} from './notification.entity';
import {
  AdminActionLog,
  AdminUser,
  AdminUserRole,
  Permission,
  Role,
  RolePermission,
} from './admin.entity';
import { IdempotencyRecord, MediaAsset, SystemSetting } from './system.entity';

/** 全部实体类，供 TypeORM DataSource 使用 */
export const entities = [
  User,
  UserSession,
  AlumniProfile,
  PrivateContact,
  Region,
  Industry,
  VerificationApplication,
  VerificationAttachment,
  VerificationReview,
  ConnectionPair,
  ConnectionRequestHistory,
  ContactShareGrant,
  ResourcePost,
  ResourcePostReview,
  ResourcePostAttachment,
  Event,
  EventRegistration,
  Article,
  ArticleCategory,
  Notice,
  Notification,
  NotificationDelivery,
  OutboxEvent,
  AdminUser,
  Role,
  Permission,
  AdminUserRole,
  RolePermission,
  AdminActionLog,
  MediaAsset,
  IdempotencyRecord,
  SystemSetting,
];
