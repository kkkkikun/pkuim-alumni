# 数据库设计（MySQL 8.4 LTS / InnoDB / utf8mb4）

> 契约基线：`docs/top.md` §5。本文件是 Database / Backend 两个工作流的唯一表结构事实来源。
> 所有结构变更必须通过 TypeORM 迁移文件，禁止生产环境自动同步 Entity。

## 通用约定

- 主键：`id BIGINT UNSIGNED AUTO_INCREMENT`。
- 时间：`DATETIME(3)`，默认 `CURRENT_TIMESTAMP(3)`；`updated_at` 自动 `ON UPDATE CURRENT_TIMESTAMP(3)`。
- 布尔：`TINYINT(1)`，默认 0。
- 乐观锁：`version INT NOT NULL DEFAULT 0`，更新时 `WHERE version = :version` 并 `version = version + 1`。
- 敏感字段加密列统一 `*_cipher VARCHAR(255)`。
- JSON 列使用 MySQL 原生 `JSON` 类型。
- 引擎 `InnoDB`，字符集 `utf8mb4_0900_ai_ci`。
- 外键统一 `ON DELETE CASCADE`（从属数据）或 `SET NULL`（保留历史的引用）。

## 1. 用户与校友

### users
| 列 | 类型 | 说明 |
|---|---|---|
| id | BIGINT UNSIGNED PK | |
| openid | VARCHAR(64) NOT NULL UNIQUE | 微信 openid / mock openid |
| unionid | VARCHAR(64) NULL UNIQUE | |
| nickname | VARCHAR(64) NOT NULL | |
| avatar_url | VARCHAR(512) NULL | |
| status | ENUM('active','disabled','locked') NOT NULL DEFAULT 'active' | |
| stage | ENUM('logged_in','pending_review','verified') NOT NULL DEFAULT 'logged_in' | 身份阶段 |
| source | ENUM('wechat','mock') NOT NULL DEFAULT 'mock' | 登录来源 |
| last_login_at | DATETIME(3) NULL | |
| version | INT NOT NULL DEFAULT 0 | |
| created_at / updated_at | DATETIME(3) | |

索引：`uk_users_openid`、`uk_users_unionid`、`idx_users_stage`。

### user_sessions
| 列 | 类型 | 说明 |
|---|---|---|
| id | BIGINT UNSIGNED PK | |
| user_id | BIGINT UNSIGNED NOT NULL FK→users | |
| refresh_token_hash | CHAR(64) NOT NULL UNIQUE | 只存哈希 |
| device / ip / user_agent | VARCHAR | |
| expires_at | DATETIME(3) NOT NULL | |
| revoked_at | DATETIME(3) NULL | 登出/轮换即吊销 |
| created_at / updated_at | | |

索引：`uk_user_sessions_token`、`idx_user_sessions_user_revoked(user_id, revoked_at)`。

### alumni_profiles
| 列 | 类型 | 说明 |
|---|---|---|
| id | BIGINT UNSIGNED PK | |
| user_id | BIGINT UNSIGNED NOT NULL UNIQUE FK→users | |
| display_name | VARCHAR(64) NOT NULL | 通讯录展示名 |
| real_name | VARCHAR(64) NULL | 真实姓名 |
| college | VARCHAR(64) NULL | 毕业院系 |
| degree | VARCHAR(64) NULL | 学位 |
| graduation_year | SMALLINT UNSIGNED NULL | |
| region_code | VARCHAR(32) NULL FK→regions | 盟市 |
| industry_code | VARCHAR(32) NULL FK→industries | 行业 |
| direction | VARCHAR(128) NULL | 专业方向 |
| intro | VARCHAR(1000) NULL | 交流意向 |
| verified | TINYINT(1) NOT NULL DEFAULT 0 | 是否已认证校友 |
| verified_at | DATETIME(3) NULL | |
| verified_by | BIGINT UNSIGNED NULL FK→admin_users | 审核管理员（管理员在 admin_users 表） |
| show_in_directory | TINYINT(1) NOT NULL DEFAULT 0 | 是否出现在通讯录 |
| show_college / show_industry / show_region | TINYINT(1) DEFAULT 1 | 字段级可见性 |
| show_direction | TINYINT(1) DEFAULT 1 | 专业方向可见性（与契约 `PrivacySettings.showDirection` 对齐的补充列） |
| accept_contact_requests | TINYINT(1) DEFAULT 1 | 是否接受联系申请 |
| allow_contact_share | TINYINT(1) DEFAULT 1 | 是否允许向已建立连接的对方向展示联系方式 |
| version | INT NOT NULL DEFAULT 0 | |
| created_at / updated_at | | |

索引：`uk_alumni_profiles_user`、`idx_alumni_profiles_region`、`idx_alumni_profiles_industry`、
`idx_alumni_profiles_directory(show_in_directory, region_code, industry_code)`。

### private_contacts
| 列 | 类型 | 说明 |
|---|---|---|
| user_id | BIGINT UNSIGNED PK FK→users | 与用户 1:1 |
| phone_cipher / wechat_cipher / email_cipher | VARCHAR(255) NULL | 加密存储，禁止出现在任何列表接口 |
| updated_at | DATETIME(3) | |

### verification_applications
| 列 | 类型 | 说明 |
|---|---|---|
| id | BIGINT UNSIGNED PK | |
| user_id | BIGINT UNSIGNED NOT NULL FK→users | |
| real_name | VARCHAR(64) NOT NULL | |
| college | VARCHAR(64) NOT NULL | |
| graduation_year | SMALLINT UNSIGNED NOT NULL | |
| degree | VARCHAR(64) NULL | |
| student_id_masked | VARCHAR(32) NULL | 学号脱敏 |
| remark | VARCHAR(500) NULL | |
| status | ENUM('pending','needs_more_material','approved','rejected','resubmitted') NOT NULL DEFAULT 'pending' | |
| decided_by | BIGINT UNSIGNED NULL FK→admin_users | |
| decision_note | VARCHAR(500) NULL | |
| submitted_at | DATETIME(3) NOT NULL | |
| decided_at | DATETIME(3) NULL | |
| version | INT NOT NULL DEFAULT 0 | |
| created_at / updated_at | | |

索引：`idx_verification_status(status, submitted_at)`、`idx_verification_user(user_id, submitted_at)`。

### verification_attachments
`id, application_id FK→verification_applications, media_id FK→media_assets, created_at`；
唯一索引 `uk_verification_attachment(app_id, media_id)`。

## 2. 字典

- **regions**：`code VARCHAR(32) PK`（12 盟市 + `OUTSIDE`）、`name VARCHAR(64)`、`level ENUM('city','outside')`、`sort_order INT`。
- **industries**：`code VARCHAR(32) PK`、`name VARCHAR(64)`、`sort_order INT`。

## 3. 校友关系（并发重点）

### connection_pairs
| 列 | 类型 | 说明 |
|---|---|---|
| id | BIGINT UNSIGNED PK | |
| user_a_id / user_b_id | BIGINT UNSIGNED NOT NULL FK→users | **规范化：user_a_id < user_b_id** |
| status | ENUM('active','revoked') NOT NULL DEFAULT 'active' | |
| established_at | DATETIME(3) NOT NULL | |
| revoked_at | DATETIME(3) NULL | |
| version | INT NOT NULL DEFAULT 0 | |
| created_at / updated_at | | |

唯一索引 `uk_connection_pairs(user_a_id, user_b_id)` —— 一对用户只能有一条连接关系。

### connection_request_history
| 列 | 类型 | 说明 |
|---|---|---|
| id | BIGINT UNSIGNED PK | |
| from_user_id / to_user_id | BIGINT UNSIGNED NOT NULL FK→users | |
| pair_key | VARCHAR(64) NOT NULL | `min(from,to):max(from,to)` |
| pending_guard | VARCHAR(64) NULL | 状态为 pending 时等于 pair_key，否则 NULL |
| pair_id | BIGINT UNSIGNED NULL FK→connection_pairs | 接受后回填 |
| message | VARCHAR(500) NOT NULL | |
| status | ENUM('pending','accepted','rejected','cancelled','expired') NOT NULL DEFAULT 'pending' | |
| decided_by | BIGINT UNSIGNED NULL FK→admin_users | |
| decided_at | DATETIME(3) NULL | |
| created_at / updated_at | | |

唯一索引 `uk_connection_request_pending(pending_guard)` —— MySQL 唯一索引允许多个 NULL，
因此「同一对用户同时只能存在一条 pending 申请」，历史记录（rejected/cancelled）可保留多条。
索引：`idx_request_to(to_user_id, status)`、`idx_request_from(from_user_id, status)`、`idx_request_pair(pair_key)`。

### contact_share_grants
`id, pair_id FK→connection_pairs, user_id FK→users, allow TINYINT(1) NOT NULL DEFAULT 0, created_at, updated_at`；
唯一索引 `uk_contact_grant(pair_id, user_id)`。

## 4. 资源与需求（并发重点）

### resource_posts
`id, author_id FK→users, type ENUM('resource','demand'), title VARCHAR(120), body TEXT,
industry_code, region_code, status ENUM('draft','pending','published','rejected','offline','withdrawn')
NOT NULL DEFAULT 'draft', version INT NOT NULL DEFAULT 0, published_at DATETIME(3) NULL, created_by…`
索引：`idx_resource_status(status, published_at)`、`idx_resource_author(author_id, created_at)`、
`idx_resource_filter(industry_code, region_code, status)`。

### resource_post_reviews
`id, post_id FK→resource_posts, admin_id FK→admin_users, action ENUM('approve','reject','request_changes','offline'),
note VARCHAR(500), snapshot_version INT NOT NULL, created_at` —— **只追加，不覆盖**。
索引 `idx_resource_reviews_post(post_id, created_at)`。

### resource_post_attachments
`id, post_id FK→resource_posts, media_id FK→media_assets, created_at`，唯一索引 `(post_id, media_id)`。

## 5. 活动（并发重点）

### events
`id, title VARCHAR(120), kind VARCHAR(32), region_code, place VARCHAR(255), description TEXT,
starts_at DATETIME(3) NULL, ends_at DATETIME(3) NULL, capacity INT NOT NULL DEFAULT 0,
registered_count INT NOT NULL DEFAULT 0, status ENUM('draft','published','closed','cancelled'),
cover_media_id BIGINT UNSIGNED NULL, created_by BIGINT UNSIGNED NULL FK→admin_users, version INT NOT NULL DEFAULT 0,
created_at, updated_at`
索引：`idx_events_status(status, starts_at)`。

### event_registrations
`id, event_id FK→events, user_id FK→users, status ENUM('registered','cancelled','attended'),
note VARCHAR(500), created_at, updated_at`
唯一索引 `uk_event_registration(event_id, user_id)` —— 取消后复用同一行（status 改回 registered）。

## 6. 内容

- **articles**：`id, category_id FK→article_categories NULL, title VARCHAR(160), summary VARCHAR(255),
  body MEDIUMTEXT, cover_media_id, status ENUM('draft','published','offline'), published_at, view_count INT,
  created_by FK→admin_users, version, created_at, updated_at`；索引 `idx_articles_published(status, published_at)`。
- **article_categories**：`id, name, slug UNIQUE, sort_order, created_at`。
- **notices**：`id, title VARCHAR(160), body MEDIUMTEXT, status ENUM('draft','published','offline'),
  published_at, view_count, created_by FK→admin_users, version, created_at, updated_at`。

## 7. 通知

- **notifications**：`id, user_id FK→users, type ENUM('verification_submitted','verification_decision',
  'connection_request','connection_decision','resource_review','event_registration','event_changed','system'),
  title VARCHAR(160), body VARCHAR(1000), payload JSON, read_at DATETIME(3) NULL, expires_at DATETIME(3) NULL,
  created_at`；索引 `idx_notifications_user(user_id, read_at, created_at)`。
- **notification_deliveries**：`id, notification_id FK→notifications, channel ENUM('inapp','wechat'),
  status ENUM('pending','sent','failed'), attempts INT, last_error VARCHAR(500), sent_at, created_at`。
- **outbox_events**：`id, aggregate_type VARCHAR(64), aggregate_id VARCHAR(64), event_type VARCHAR(64),
  payload JSON, status ENUM('pending','processing','done','failed'), attempts INT,
  available_at DATETIME(3) NOT NULL, processed_at DATETIME(3) NULL, created_at`；
  索引 `idx_outbox_pending(status, available_at)`。

## 8. 管理后台 RBAC

- **admin_users**：`id, username VARCHAR(64) UNIQUE, password_hash VARCHAR(255), display_name VARCHAR(64),
  status ENUM('active','disabled'), last_login_at, created_at, updated_at`。
- **roles**：`id, code VARCHAR(32) UNIQUE, name VARCHAR(64), description VARCHAR(255)`。
- **permissions**：`id, code VARCHAR(64) UNIQUE, name VARCHAR(64), description VARCHAR(255)`。
- **admin_user_roles**：`admin_user_id FK, role_id FK` 复合主键。
- **role_permissions**：`role_id FK, permission_id FK` 复合主键。
- **admin_action_logs**：`id, admin_id FK→admin_users, action VARCHAR(64), target_type VARCHAR(32),
  target_id VARCHAR(64), detail JSON, ip VARCHAR(45), created_at`；索引 `(admin_id, created_at)`。

初始角色与权限（Seed 写入）：

| 角色 code | 权限 |
|---|---|
| super_admin | 全部 |
| alumni_reviewer | alumni:view, alumni:manage, verification:review, audit:view |
| resource_reviewer | resource:review, resource:manage, audit:view |
| content_admin | content:manage, notification:broadcast, audit:view |
| event_admin | event:manage, audit:view |

## 9. 系统

- **media_assets**：`id, file_name VARCHAR(255), mime_type VARCHAR(128), size BIGINT,
  bucket VARCHAR(64), object_key VARCHAR(512), visibility ENUM('public','private'),
  uploader_id BIGINT UNSIGNED NULL, created_at`；索引 `idx_media_uploader(uploader_id, created_at)`。
- **idempotency_records**：`id, scope VARCHAR(64), idem_key VARCHAR(128), user_id BIGINT UNSIGNED NULL,
  request_hash CHAR(64), response_body JSON, status ENUM('in_progress','completed'),
  created_at, expires_at`；唯一索引 `uk_idempotency(scope, idem_key)`。
- **system_settings**：`key VARCHAR(64) PK, value TEXT, description VARCHAR(255), updated_at`。

## 10. 并发与一致性策略（落到 SQL 形态）

| 场景 | 机制 |
|---|---|
| 活动报名不超卖 | 事务内 `UPDATE events SET registered_count = registered_count + 1 WHERE id = :id AND status='published' AND (capacity = 0 OR registered_count < capacity)`；影响行数为 0 → `CONFLICT`；同时唯一索引 `uk_event_registration` 防重复；失败整体回滚 |
| 重复报名 | 唯一索引冲突 → 幂等返回既有报名记录（不报错） |
| A、B 互相同时申请 | `pending_guard` 唯一索引保证同一对只有一条 pending；后到者返回既有申请 |
| 重复接受申请 | `UPDATE connection_request_history SET status='accepted' WHERE id=:id AND status='pending'` 条件更新，重复点击影响行数为 0 → 幂等返回当前状态 |
| 重复建立连接 | `INSERT ... ON DUPLICATE KEY UPDATE` 依赖 `uk_connection_pairs` |
| 两个管理员同时审核 | `UPDATE resource_posts SET status=:s, version = version + 1 WHERE id=:id AND status='pending' AND version=:v`；影响行数 0 → `CONFLICT`；审核历史表只追加 |
| 用户在审核期间修改内容 | 修改即 `version+1` 并回到 `pending`；审核携带 `version`，不匹配即冲突 |
| 重复提交（发布/报名/申请） | `idempotency_records` 唯一索引 + 请求哈希校验，命中则回放上次响应 |
| 联系方式越权 | 联系方式仅存 `private_contacts`（加密）；读取路径必须同时满足：存在 active 连接对 + 双方 `allow_contact_share=1` + 存在 `contact_share_grants.allow=1` |
| 未审核内容公开 | 公开列表查询固定 `status='published'`（资源）/ `status='published'`（内容）/ `users.stage='verified'`（通讯录） |

## 11. 隐私硬规则（必须同时在 SQL 层与服务层落实）

1. `private_contacts` 的任何列不得出现在通讯录、用户列表、连接列表的 SELECT 中；
2. 通讯录查询必须 JOIN `alumni_profiles.show_in_directory = 1` 且 `users.stage='verified'`；
3. 字段级可见性按 `show_college / show_industry / show_region` 二次裁剪；
4. 未建立连接关系时，`connection_pairs` 不存在，双方联系方式互相不可见；
5. 任一方 `allow_contact_share=0` 或撤回授权后，另一方立即无法读取。
