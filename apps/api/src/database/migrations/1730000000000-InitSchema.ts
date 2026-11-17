import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 初始数据库结构（MySQL 8.4 / InnoDB / utf8mb4_0900_ai_ci）。
 *
 * 结构事实来源：docs/DATABASE-DESIGN.md（表、列、类型、索引、外键）与 docs/top.md §5/§6。
 *
 * 约定：
 * - 主键 `id BIGINT UNSIGNED AUTO_INCREMENT`；时间 `DATETIME(3)`；
 * - `updated_at` 自动 `ON UPDATE CURRENT_TIMESTAMP(3)`；
 * - 布尔 `TINYINT(1)`；乐观锁 `version INT NOT NULL DEFAULT 0`；
 * - 敏感字段 `*_cipher VARCHAR(255)`；JSON 使用 MySQL 原生 JSON；
 * - 外键：从属数据 CASCADE，保留历史的引用 SET NULL。
 *
 * 本迁移为手写、可重复执行：表使用 CREATE TABLE IF NOT EXISTS，
 * 索引与外键通过 information_schema 存在性检查后再创建。
 */
export class InitSchema1730000000000 implements MigrationInterface {
  name = 'InitSchema1730000000000';

  private readonly tableOptions =
    'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.createTables(queryRunner);
    await this.createIndexes(queryRunner);
    await this.createForeignKeys(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 与建表顺序相反，逐表删除；IF EXISTS 保证可重复执行
    const tables = [
      'system_settings',
      'idempotency_records',
      'media_assets',
      'admin_action_logs',
      'role_permissions',
      'admin_user_roles',
      'permissions',
      'roles',
      'admin_users',
      'outbox_events',
      'notification_deliveries',
      'notifications',
      'notices',
      'articles',
      'article_categories',
      'event_registrations',
      'events',
      'resource_post_attachments',
      'resource_post_reviews',
      'resource_posts',
      'verification_reviews',
      'verification_attachments',
      'verification_applications',
      'contact_share_grants',
      'connection_request_history',
      'connection_pairs',
      'industries',
      'regions',
      'private_contacts',
      'alumni_profiles',
      'user_sessions',
      'users',
    ];

    for (const table of tables) {
      await queryRunner.query(`DROP TABLE IF EXISTS \`${table}\``);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 表                                                                    */
  /* ------------------------------------------------------------------ */

  private async createTables(queryRunner: QueryRunner): Promise<void> {
    // ---------- 字典 ----------
    await this.createTable(
      queryRunner,
      'regions',
      '`code` VARCHAR(32) NOT NULL,' +
        '`name` VARCHAR(64) NOT NULL,' +
        "`level` ENUM('city','outside') NOT NULL DEFAULT 'city'," +
        '`sort_order` INT NOT NULL DEFAULT 0,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`code`)',
    );

    await this.createTable(
      queryRunner,
      'industries',
      '`code` VARCHAR(32) NOT NULL,' +
        '`name` VARCHAR(64) NOT NULL,' +
        '`sort_order` INT NOT NULL DEFAULT 0,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`code`)',
    );

    // ---------- 用户与校友 ----------
    await this.createTable(
      queryRunner,
      'users',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`openid` VARCHAR(64) NOT NULL,' +
        '`unionid` VARCHAR(64) NULL,' +
        '`nickname` VARCHAR(64) NOT NULL,' +
        '`avatar_url` VARCHAR(512) NULL,' +
        "`status` ENUM('active','disabled','locked') NOT NULL DEFAULT 'active'," +
        "`stage` ENUM('logged_in','pending_review','verified') NOT NULL DEFAULT 'logged_in'," +
        "`source` ENUM('wechat','mock') NOT NULL DEFAULT 'mock'," +
        '`last_login_at` DATETIME(3) NULL,' +
        '`version` INT NOT NULL DEFAULT 0,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        '`updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    await this.createTable(
      queryRunner,
      'user_sessions',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`user_id` BIGINT UNSIGNED NOT NULL,' +
        '`refresh_token_hash` CHAR(64) NOT NULL,' +
        '`device` VARCHAR(128) NULL,' +
        '`ip` VARCHAR(45) NULL,' +
        '`user_agent` VARCHAR(512) NULL,' +
        '`expires_at` DATETIME(3) NOT NULL,' +
        '`revoked_at` DATETIME(3) NULL,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        '`updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    await this.createTable(
      queryRunner,
      'alumni_profiles',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`user_id` BIGINT UNSIGNED NOT NULL,' +
        '`display_name` VARCHAR(64) NOT NULL,' +
        '`real_name` VARCHAR(64) NULL,' +
        '`college` VARCHAR(64) NULL,' +
        '`degree` VARCHAR(64) NULL,' +
        '`graduation_year` SMALLINT UNSIGNED NULL,' +
        '`region_code` VARCHAR(32) NULL,' +
        '`industry_code` VARCHAR(32) NULL,' +
        '`direction` VARCHAR(128) NULL,' +
        '`intro` VARCHAR(1000) NULL,' +
        '`verified` TINYINT(1) NOT NULL DEFAULT 0,' +
        '`verified_at` DATETIME(3) NULL,' +
        '`verified_by` BIGINT UNSIGNED NULL,' +
        '`show_in_directory` TINYINT(1) NOT NULL DEFAULT 0,' +
        '`show_college` TINYINT(1) NOT NULL DEFAULT 1,' +
        '`show_industry` TINYINT(1) NOT NULL DEFAULT 1,' +
        '`show_region` TINYINT(1) NOT NULL DEFAULT 1,' +
        '`show_direction` TINYINT(1) NOT NULL DEFAULT 1,' +
        '`accept_contact_requests` TINYINT(1) NOT NULL DEFAULT 1,' +
        '`allow_contact_share` TINYINT(1) NOT NULL DEFAULT 1,' +
        '`version` INT NOT NULL DEFAULT 0,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        '`updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    await this.createTable(
      queryRunner,
      'private_contacts',
      '`user_id` BIGINT UNSIGNED NOT NULL,' +
        '`phone_cipher` VARCHAR(255) NULL,' +
        '`wechat_cipher` VARCHAR(255) NULL,' +
        '`email_cipher` VARCHAR(255) NULL,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        '`updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`user_id`)',
    );

    // ---------- 管理后台（认证审核等表引用 admin_users，需先建） ----------
    await this.createTable(
      queryRunner,
      'admin_users',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`username` VARCHAR(64) NOT NULL,' +
        '`password_hash` VARCHAR(255) NOT NULL,' +
        '`display_name` VARCHAR(64) NOT NULL,' +
        "`status` ENUM('active','disabled') NOT NULL DEFAULT 'active'," +
        '`last_login_at` DATETIME(3) NULL,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        '`updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    // ---------- 文件 ----------
    await this.createTable(
      queryRunner,
      'media_assets',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`file_name` VARCHAR(255) NOT NULL,' +
        '`mime_type` VARCHAR(128) NOT NULL,' +
        '`size` BIGINT UNSIGNED NOT NULL,' +
        '`bucket` VARCHAR(64) NOT NULL,' +
        '`object_key` VARCHAR(512) NOT NULL,' +
        "`visibility` ENUM('public','private') NOT NULL DEFAULT 'private'," +
        '`uploader_id` BIGINT UNSIGNED NULL,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    // ---------- 认证审核 ----------
    await this.createTable(
      queryRunner,
      'verification_applications',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`user_id` BIGINT UNSIGNED NOT NULL,' +
        '`real_name` VARCHAR(64) NOT NULL,' +
        '`college` VARCHAR(64) NOT NULL,' +
        '`graduation_year` SMALLINT UNSIGNED NOT NULL,' +
        '`degree` VARCHAR(64) NULL,' +
        '`student_id_masked` VARCHAR(32) NULL,' +
        '`remark` VARCHAR(500) NULL,' +
        "`status` ENUM('pending','needs_more_material','approved','rejected','resubmitted') NOT NULL DEFAULT 'pending'," +
        '`decided_by` BIGINT UNSIGNED NULL,' +
        '`decision_note` VARCHAR(500) NULL,' +
        '`submitted_at` DATETIME(3) NOT NULL,' +
        '`decided_at` DATETIME(3) NULL,' +
        '`version` INT NOT NULL DEFAULT 0,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        '`updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    await this.createTable(
      queryRunner,
      'verification_attachments',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`application_id` BIGINT UNSIGNED NOT NULL,' +
        '`media_id` BIGINT UNSIGNED NOT NULL,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    // 认证审核历史：只追加，不覆盖（docs/top.md §5.2 + contracts VerificationReviewDto）
    await this.createTable(
      queryRunner,
      'verification_reviews',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`application_id` BIGINT UNSIGNED NOT NULL,' +
        '`admin_id` BIGINT UNSIGNED NOT NULL,' +
        "`action` ENUM('approve','reject','request_changes','offline') NOT NULL," +
        '`note` VARCHAR(500) NULL,' +
        '`snapshot_version` INT NOT NULL DEFAULT 0,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    // ---------- 校友关系 ----------
    await this.createTable(
      queryRunner,
      'connection_pairs',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`user_a_id` BIGINT UNSIGNED NOT NULL,' +
        '`user_b_id` BIGINT UNSIGNED NOT NULL,' +
        "`status` ENUM('active','revoked') NOT NULL DEFAULT 'active'," +
        '`established_at` DATETIME(3) NOT NULL,' +
        '`revoked_at` DATETIME(3) NULL,' +
        '`version` INT NOT NULL DEFAULT 0,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        '`updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    await this.createTable(
      queryRunner,
      'connection_request_history',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`from_user_id` BIGINT UNSIGNED NOT NULL,' +
        '`to_user_id` BIGINT UNSIGNED NOT NULL,' +
        '`pair_key` VARCHAR(64) NOT NULL,' +
        '`pending_guard` VARCHAR(64) NULL,' +
        '`pair_id` BIGINT UNSIGNED NULL,' +
        '`message` VARCHAR(500) NOT NULL,' +
        "`status` ENUM('pending','accepted','rejected','cancelled','expired') NOT NULL DEFAULT 'pending'," +
        '`decided_by` BIGINT UNSIGNED NULL,' +
        '`decided_at` DATETIME(3) NULL,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        '`updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    await this.createTable(
      queryRunner,
      'contact_share_grants',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`pair_id` BIGINT UNSIGNED NOT NULL,' +
        '`user_id` BIGINT UNSIGNED NOT NULL,' +
        '`allow` TINYINT(1) NOT NULL DEFAULT 0,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        '`updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    // ---------- 资源与需求 ----------
    await this.createTable(
      queryRunner,
      'resource_posts',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`author_id` BIGINT UNSIGNED NOT NULL,' +
        "`type` ENUM('resource','demand') NOT NULL DEFAULT 'resource'," +
        '`title` VARCHAR(120) NOT NULL,' +
        '`body` TEXT NOT NULL,' +
        '`industry_code` VARCHAR(32) NULL,' +
        '`region_code` VARCHAR(32) NULL,' +
        "`status` ENUM('draft','pending','published','rejected','offline','withdrawn') NOT NULL DEFAULT 'draft'," +
        '`version` INT NOT NULL DEFAULT 0,' +
        '`published_at` DATETIME(3) NULL,' +
        '`created_by` BIGINT UNSIGNED NULL,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        '`updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    await this.createTable(
      queryRunner,
      'resource_post_reviews',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`post_id` BIGINT UNSIGNED NOT NULL,' +
        '`admin_id` BIGINT UNSIGNED NOT NULL,' +
        "`action` ENUM('approve','reject','request_changes','offline') NOT NULL," +
        '`note` VARCHAR(500) NULL,' +
        '`snapshot_version` INT NOT NULL DEFAULT 0,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    await this.createTable(
      queryRunner,
      'resource_post_attachments',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`post_id` BIGINT UNSIGNED NOT NULL,' +
        '`media_id` BIGINT UNSIGNED NOT NULL,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    // ---------- 活动 ----------
    await this.createTable(
      queryRunner,
      'events',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`title` VARCHAR(120) NOT NULL,' +
        '`kind` VARCHAR(32) NOT NULL,' +
        '`region_code` VARCHAR(32) NULL,' +
        '`place` VARCHAR(255) NULL,' +
        '`description` TEXT NULL,' +
        '`starts_at` DATETIME(3) NULL,' +
        '`ends_at` DATETIME(3) NULL,' +
        '`capacity` INT NOT NULL DEFAULT 0,' +
        '`registered_count` INT NOT NULL DEFAULT 0,' +
        "`status` ENUM('draft','published','closed','cancelled') NOT NULL DEFAULT 'draft'," +
        '`cover_media_id` BIGINT UNSIGNED NULL,' +
        '`created_by` BIGINT UNSIGNED NULL,' +
        '`version` INT NOT NULL DEFAULT 0,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        '`updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    await this.createTable(
      queryRunner,
      'event_registrations',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`event_id` BIGINT UNSIGNED NOT NULL,' +
        '`user_id` BIGINT UNSIGNED NOT NULL,' +
        "`status` ENUM('registered','cancelled','attended') NOT NULL DEFAULT 'registered'," +
        '`note` VARCHAR(500) NULL,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        '`updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    // ---------- 内容 ----------
    await this.createTable(
      queryRunner,
      'article_categories',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`name` VARCHAR(64) NOT NULL,' +
        '`slug` VARCHAR(64) NOT NULL,' +
        '`sort_order` INT NOT NULL DEFAULT 0,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    await this.createTable(
      queryRunner,
      'articles',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`category_id` BIGINT UNSIGNED NULL,' +
        '`title` VARCHAR(160) NOT NULL,' +
        '`summary` VARCHAR(255) NULL,' +
        '`body` MEDIUMTEXT NOT NULL,' +
        '`cover_media_id` BIGINT UNSIGNED NULL,' +
        "`status` ENUM('draft','published','offline') NOT NULL DEFAULT 'draft'," +
        '`published_at` DATETIME(3) NULL,' +
        '`view_count` INT NOT NULL DEFAULT 0,' +
        '`created_by` BIGINT UNSIGNED NULL,' +
        '`version` INT NOT NULL DEFAULT 0,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        '`updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    await this.createTable(
      queryRunner,
      'notices',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`title` VARCHAR(160) NOT NULL,' +
        '`body` MEDIUMTEXT NOT NULL,' +
        "`status` ENUM('draft','published','offline') NOT NULL DEFAULT 'draft'," +
        '`published_at` DATETIME(3) NULL,' +
        '`view_count` INT NOT NULL DEFAULT 0,' +
        '`created_by` BIGINT UNSIGNED NULL,' +
        '`version` INT NOT NULL DEFAULT 0,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        '`updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    // ---------- 通知 ----------
    await this.createTable(
      queryRunner,
      'notifications',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`user_id` BIGINT UNSIGNED NOT NULL,' +
        "`type` ENUM('verification_submitted','verification_decision','connection_request','connection_decision','resource_review','event_registration','event_changed','system') NOT NULL," +
        '`title` VARCHAR(160) NOT NULL,' +
        '`body` VARCHAR(1000) NOT NULL,' +
        '`payload` JSON NULL,' +
        '`read_at` DATETIME(3) NULL,' +
        '`expires_at` DATETIME(3) NULL,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    await this.createTable(
      queryRunner,
      'notification_deliveries',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`notification_id` BIGINT UNSIGNED NOT NULL,' +
        "`channel` ENUM('inapp','wechat') NOT NULL DEFAULT 'inapp'," +
        "`status` ENUM('pending','sent','failed') NOT NULL DEFAULT 'pending'," +
        '`attempts` INT NOT NULL DEFAULT 0,' +
        '`last_error` VARCHAR(500) NULL,' +
        '`sent_at` DATETIME(3) NULL,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    await this.createTable(
      queryRunner,
      'outbox_events',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`aggregate_type` VARCHAR(64) NOT NULL,' +
        '`aggregate_id` VARCHAR(64) NOT NULL,' +
        '`event_type` VARCHAR(64) NOT NULL,' +
        '`payload` JSON NULL,' +
        "`status` ENUM('pending','processing','done','failed') NOT NULL DEFAULT 'pending'," +
        '`attempts` INT NOT NULL DEFAULT 0,' +
        '`available_at` DATETIME(3) NOT NULL,' +
        '`processed_at` DATETIME(3) NULL,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    // ---------- RBAC ----------
    await this.createTable(
      queryRunner,
      'roles',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`code` VARCHAR(32) NOT NULL,' +
        '`name` VARCHAR(64) NOT NULL,' +
        '`description` VARCHAR(255) NULL,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    await this.createTable(
      queryRunner,
      'permissions',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`code` VARCHAR(64) NOT NULL,' +
        '`name` VARCHAR(64) NOT NULL,' +
        '`description` VARCHAR(255) NULL,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    await this.createTable(
      queryRunner,
      'admin_user_roles',
      '`admin_user_id` BIGINT UNSIGNED NOT NULL,' +
        '`role_id` BIGINT UNSIGNED NOT NULL,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`admin_user_id`, `role_id`)',
    );

    await this.createTable(
      queryRunner,
      'role_permissions',
      '`role_id` BIGINT UNSIGNED NOT NULL,' +
        '`permission_id` BIGINT UNSIGNED NOT NULL,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`role_id`, `permission_id`)',
    );

    await this.createTable(
      queryRunner,
      'admin_action_logs',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`admin_id` BIGINT UNSIGNED NOT NULL,' +
        '`action` VARCHAR(64) NOT NULL,' +
        '`target_type` VARCHAR(32) NULL,' +
        '`target_id` VARCHAR(64) NULL,' +
        '`detail` JSON NULL,' +
        '`ip` VARCHAR(45) NULL,' +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`id`)',
    );

    // ---------- 系统 ----------
    await this.createTable(
      queryRunner,
      'idempotency_records',
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
        '`scope` VARCHAR(64) NOT NULL,' +
        '`idem_key` VARCHAR(128) NOT NULL,' +
        '`user_id` BIGINT UNSIGNED NULL,' +
        '`request_hash` CHAR(64) NOT NULL,' +
        '`response_body` JSON NULL,' +
        "`status` ENUM('in_progress','completed') NOT NULL DEFAULT 'in_progress'," +
        '`created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),' +
        '`expires_at` DATETIME(3) NOT NULL,' +
        'PRIMARY KEY (`id`)',
    );

    await this.createTable(
      queryRunner,
      'system_settings',
      '`key` VARCHAR(64) NOT NULL,' +
        '`value` TEXT NOT NULL,' +
        '`description` VARCHAR(255) NULL,' +
        '`updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),' +
        'PRIMARY KEY (`key`)',
    );
  }

  /* ------------------------------------------------------------------ */
  /* 索引与唯一约束                                                        */
  /* ------------------------------------------------------------------ */

  private async createIndexes(queryRunner: QueryRunner): Promise<void> {
    const indexes: Array<{
      table: string;
      name: string;
      columns: string;
      unique?: boolean;
    }> = [
      // users
      { table: 'users', name: 'uk_users_openid', columns: '`openid`', unique: true },
      { table: 'users', name: 'uk_users_unionid', columns: '`unionid`', unique: true },
      { table: 'users', name: 'idx_users_stage', columns: '`stage`' },
      // user_sessions
      {
        table: 'user_sessions',
        name: 'uk_user_sessions_token',
        columns: '`refresh_token_hash`',
        unique: true,
      },
      {
        table: 'user_sessions',
        name: 'idx_user_sessions_user_revoked',
        columns: '`user_id`, `revoked_at`',
      },
      // alumni_profiles
      {
        table: 'alumni_profiles',
        name: 'uk_alumni_profiles_user',
        columns: '`user_id`',
        unique: true,
      },
      {
        table: 'alumni_profiles',
        name: 'idx_alumni_profiles_region',
        columns: '`region_code`',
      },
      {
        table: 'alumni_profiles',
        name: 'idx_alumni_profiles_industry',
        columns: '`industry_code`',
      },
      {
        table: 'alumni_profiles',
        name: 'idx_alumni_profiles_directory',
        columns: '`show_in_directory`, `region_code`, `industry_code`',
      },
      // verification
      {
        table: 'verification_applications',
        name: 'idx_verification_status',
        columns: '`status`, `submitted_at`',
      },
      {
        table: 'verification_applications',
        name: 'idx_verification_user',
        columns: '`user_id`, `submitted_at`',
      },
      {
        table: 'verification_attachments',
        name: 'uk_verification_attachment',
        columns: '`application_id`, `media_id`',
        unique: true,
      },
      {
        table: 'verification_reviews',
        name: 'idx_verification_reviews_app',
        columns: '`application_id`, `created_at`',
      },
      // connection_pairs
      {
        table: 'connection_pairs',
        name: 'uk_connection_pairs',
        columns: '`user_a_id`, `user_b_id`',
        unique: true,
      },
      // connection_request_history
      {
        table: 'connection_request_history',
        name: 'uk_connection_request_pending',
        columns: '`pending_guard`',
        unique: true,
      },
      {
        table: 'connection_request_history',
        name: 'idx_request_to',
        columns: '`to_user_id`, `status`',
      },
      {
        table: 'connection_request_history',
        name: 'idx_request_from',
        columns: '`from_user_id`, `status`',
      },
      {
        table: 'connection_request_history',
        name: 'idx_request_pair',
        columns: '`pair_key`',
      },
      // contact_share_grants
      {
        table: 'contact_share_grants',
        name: 'uk_contact_grant',
        columns: '`pair_id`, `user_id`',
        unique: true,
      },
      // resource_posts
      {
        table: 'resource_posts',
        name: 'idx_resource_status',
        columns: '`status`, `published_at`',
      },
      {
        table: 'resource_posts',
        name: 'idx_resource_author',
        columns: '`author_id`, `created_at`',
      },
      {
        table: 'resource_posts',
        name: 'idx_resource_filter',
        columns: '`industry_code`, `region_code`, `status`',
      },
      {
        table: 'resource_post_reviews',
        name: 'idx_resource_reviews_post',
        columns: '`post_id`, `created_at`',
      },
      {
        table: 'resource_post_attachments',
        name: 'uk_resource_post_attachment',
        columns: '`post_id`, `media_id`',
        unique: true,
      },
      // events
      { table: 'events', name: 'idx_events_status', columns: '`status`, `starts_at`' },
      {
        table: 'event_registrations',
        name: 'uk_event_registration',
        columns: '`event_id`, `user_id`',
        unique: true,
      },
      // content
      {
        table: 'article_categories',
        name: 'uk_article_categories_slug',
        columns: '`slug`',
        unique: true,
      },
      {
        table: 'articles',
        name: 'idx_articles_published',
        columns: '`status`, `published_at`',
      },
      // notifications
      {
        table: 'notifications',
        name: 'idx_notifications_user',
        columns: '`user_id`, `read_at`, `created_at`',
      },
      {
        table: 'notification_deliveries',
        name: 'idx_notification_deliveries_notification',
        columns: '`notification_id`, `status`',
      },
      { table: 'outbox_events', name: 'idx_outbox_pending', columns: '`status`, `available_at`' },
      // rbac
      {
        table: 'admin_users',
        name: 'uk_admin_users_username',
        columns: '`username`',
        unique: true,
      },
      { table: 'roles', name: 'uk_roles_code', columns: '`code`', unique: true },
      {
        table: 'permissions',
        name: 'uk_permissions_code',
        columns: '`code`',
        unique: true,
      },
      {
        table: 'admin_action_logs',
        name: 'idx_admin_action_logs_admin',
        columns: '`admin_id`, `created_at`',
      },
      // system
      { table: 'media_assets', name: 'idx_media_uploader', columns: '`uploader_id`, `created_at`' },
      {
        table: 'idempotency_records',
        name: 'uk_idempotency',
        columns: '`scope`, `idem_key`',
        unique: true,
      },
    ];

    for (const index of indexes) {
      await this.createIndex(queryRunner, index.table, index.name, index.columns, index.unique);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 外键                                                                  */
  /* ------------------------------------------------------------------ */

  private async createForeignKeys(queryRunner: QueryRunner): Promise<void> {
    const foreignKeys: Array<{
      table: string;
      name: string;
      column: string;
      refTable: string;
      refColumn: string;
      onDelete: 'CASCADE' | 'SET NULL';
    }> = [
      // user_sessions
      {
        table: 'user_sessions',
        name: 'fk_user_sessions_user',
        column: 'user_id',
        refTable: 'users',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      // alumni_profiles
      {
        table: 'alumni_profiles',
        name: 'fk_alumni_profiles_user',
        column: 'user_id',
        refTable: 'users',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'alumni_profiles',
        name: 'fk_alumni_profiles_region',
        column: 'region_code',
        refTable: 'regions',
        refColumn: 'code',
        onDelete: 'SET NULL',
      },
      {
        table: 'alumni_profiles',
        name: 'fk_alumni_profiles_industry',
        column: 'industry_code',
        refTable: 'industries',
        refColumn: 'code',
        onDelete: 'SET NULL',
      },
      {
        // verified_by 存的是「审核管理员」id，管理员在 admin_users 表
        table: 'alumni_profiles',
        name: 'fk_alumni_profiles_verified_by',
        column: 'verified_by',
        refTable: 'admin_users',
        refColumn: 'id',
        onDelete: 'SET NULL',
      },
      // private_contacts
      {
        table: 'private_contacts',
        name: 'fk_private_contacts_user',
        column: 'user_id',
        refTable: 'users',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      // media_assets
      {
        table: 'media_assets',
        name: 'fk_media_assets_uploader',
        column: 'uploader_id',
        refTable: 'users',
        refColumn: 'id',
        onDelete: 'SET NULL',
      },
      // verification
      {
        table: 'verification_applications',
        name: 'fk_verification_applications_user',
        column: 'user_id',
        refTable: 'users',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'verification_applications',
        name: 'fk_verification_applications_decided_by',
        column: 'decided_by',
        refTable: 'admin_users',
        refColumn: 'id',
        onDelete: 'SET NULL',
      },
      {
        table: 'verification_attachments',
        name: 'fk_verification_attachments_application',
        column: 'application_id',
        refTable: 'verification_applications',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'verification_attachments',
        name: 'fk_verification_attachments_media',
        column: 'media_id',
        refTable: 'media_assets',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'verification_reviews',
        name: 'fk_verification_reviews_application',
        column: 'application_id',
        refTable: 'verification_applications',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'verification_reviews',
        name: 'fk_verification_reviews_admin',
        column: 'admin_id',
        refTable: 'admin_users',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      // connection_pairs
      {
        table: 'connection_pairs',
        name: 'fk_connection_pairs_user_a',
        column: 'user_a_id',
        refTable: 'users',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'connection_pairs',
        name: 'fk_connection_pairs_user_b',
        column: 'user_b_id',
        refTable: 'users',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      // connection_request_history
      {
        table: 'connection_request_history',
        name: 'fk_connection_request_from_user',
        column: 'from_user_id',
        refTable: 'users',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'connection_request_history',
        name: 'fk_connection_request_to_user',
        column: 'to_user_id',
        refTable: 'users',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'connection_request_history',
        name: 'fk_connection_request_pair',
        column: 'pair_id',
        refTable: 'connection_pairs',
        refColumn: 'id',
        onDelete: 'SET NULL',
      },
      {
        table: 'connection_request_history',
        name: 'fk_connection_request_decided_by',
        column: 'decided_by',
        refTable: 'admin_users',
        refColumn: 'id',
        onDelete: 'SET NULL',
      },
      // contact_share_grants
      {
        table: 'contact_share_grants',
        name: 'fk_contact_share_grants_pair',
        column: 'pair_id',
        refTable: 'connection_pairs',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'contact_share_grants',
        name: 'fk_contact_share_grants_user',
        column: 'user_id',
        refTable: 'users',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      // resource_posts
      {
        table: 'resource_posts',
        name: 'fk_resource_posts_author',
        column: 'author_id',
        refTable: 'users',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'resource_posts',
        name: 'fk_resource_posts_industry',
        column: 'industry_code',
        refTable: 'industries',
        refColumn: 'code',
        onDelete: 'SET NULL',
      },
      {
        table: 'resource_posts',
        name: 'fk_resource_posts_region',
        column: 'region_code',
        refTable: 'regions',
        refColumn: 'code',
        onDelete: 'SET NULL',
      },
      {
        table: 'resource_posts',
        name: 'fk_resource_posts_created_by',
        column: 'created_by',
        refTable: 'admin_users',
        refColumn: 'id',
        onDelete: 'SET NULL',
      },
      {
        table: 'resource_post_reviews',
        name: 'fk_resource_post_reviews_post',
        column: 'post_id',
        refTable: 'resource_posts',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'resource_post_reviews',
        name: 'fk_resource_post_reviews_admin',
        column: 'admin_id',
        refTable: 'admin_users',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'resource_post_attachments',
        name: 'fk_resource_post_attachments_post',
        column: 'post_id',
        refTable: 'resource_posts',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'resource_post_attachments',
        name: 'fk_resource_post_attachments_media',
        column: 'media_id',
        refTable: 'media_assets',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      // events
      {
        table: 'events',
        name: 'fk_events_region',
        column: 'region_code',
        refTable: 'regions',
        refColumn: 'code',
        onDelete: 'SET NULL',
      },
      {
        table: 'events',
        name: 'fk_events_cover_media',
        column: 'cover_media_id',
        refTable: 'media_assets',
        refColumn: 'id',
        onDelete: 'SET NULL',
      },
      {
        table: 'events',
        name: 'fk_events_created_by',
        column: 'created_by',
        refTable: 'admin_users',
        refColumn: 'id',
        onDelete: 'SET NULL',
      },
      {
        table: 'event_registrations',
        name: 'fk_event_registrations_event',
        column: 'event_id',
        refTable: 'events',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'event_registrations',
        name: 'fk_event_registrations_user',
        column: 'user_id',
        refTable: 'users',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      // content
      {
        table: 'articles',
        name: 'fk_articles_category',
        column: 'category_id',
        refTable: 'article_categories',
        refColumn: 'id',
        onDelete: 'SET NULL',
      },
      {
        table: 'articles',
        name: 'fk_articles_cover_media',
        column: 'cover_media_id',
        refTable: 'media_assets',
        refColumn: 'id',
        onDelete: 'SET NULL',
      },
      {
        table: 'articles',
        name: 'fk_articles_created_by',
        column: 'created_by',
        refTable: 'admin_users',
        refColumn: 'id',
        onDelete: 'SET NULL',
      },
      {
        table: 'notices',
        name: 'fk_notices_created_by',
        column: 'created_by',
        refTable: 'admin_users',
        refColumn: 'id',
        onDelete: 'SET NULL',
      },
      // notifications
      {
        table: 'notifications',
        name: 'fk_notifications_user',
        column: 'user_id',
        refTable: 'users',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'notification_deliveries',
        name: 'fk_notification_deliveries_notification',
        column: 'notification_id',
        refTable: 'notifications',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      // rbac
      {
        table: 'admin_user_roles',
        name: 'fk_admin_user_roles_admin',
        column: 'admin_user_id',
        refTable: 'admin_users',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'admin_user_roles',
        name: 'fk_admin_user_roles_role',
        column: 'role_id',
        refTable: 'roles',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'role_permissions',
        name: 'fk_role_permissions_role',
        column: 'role_id',
        refTable: 'roles',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'role_permissions',
        name: 'fk_role_permissions_permission',
        column: 'permission_id',
        refTable: 'permissions',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'admin_action_logs',
        name: 'fk_admin_action_logs_admin',
        column: 'admin_id',
        refTable: 'admin_users',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      // system
      {
        table: 'idempotency_records',
        name: 'fk_idempotency_records_user',
        column: 'user_id',
        refTable: 'users',
        refColumn: 'id',
        onDelete: 'SET NULL',
      },
    ];

    for (const fk of foreignKeys) {
      await this.createForeignKey(queryRunner, fk);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 工具方法                                                              */
  /* ------------------------------------------------------------------ */

  private async createTable(
    queryRunner: QueryRunner,
    table: string,
    columns: string,
  ): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS \`${table}\` (${columns}) ${this.tableOptions}`,
    );
  }

  private async createIndex(
    queryRunner: QueryRunner,
    table: string,
    name: string,
    columns: string,
    unique = false,
  ): Promise<void> {
    const rows = (await queryRunner.query(
      'SELECT COUNT(*) AS `count` FROM information_schema.STATISTICS ' +
        'WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?',
      [table, name],
    )) as Array<{ count: number | string }>;

    if (Number(rows[0]?.count ?? 0) > 0) {
      return;
    }

    await queryRunner.query(
      `CREATE ${unique ? 'UNIQUE ' : ''}INDEX \`${name}\` ON \`${table}\` (${columns})`,
    );
  }

  private async createForeignKey(
    queryRunner: QueryRunner,
    fk: {
      table: string;
      name: string;
      column: string;
      refTable: string;
      refColumn: string;
      onDelete: 'CASCADE' | 'SET NULL';
    },
  ): Promise<void> {
    const rows = (await queryRunner.query(
      'SELECT COUNT(*) AS `count` FROM information_schema.TABLE_CONSTRAINTS ' +
        'WHERE constraint_schema = DATABASE() AND table_name = ? AND constraint_name = ?',
      [fk.table, fk.name],
    )) as Array<{ count: number | string }>;

    if (Number(rows[0]?.count ?? 0) > 0) {
      return;
    }

    await queryRunner.query(
      `ALTER TABLE \`${fk.table}\` ADD CONSTRAINT \`${fk.name}\` ` +
        `FOREIGN KEY (\`${fk.column}\`) REFERENCES \`${fk.refTable}\` (\`${fk.refColumn}\`) ` +
        `ON DELETE ${fk.onDelete}`,
    );
  }
}
