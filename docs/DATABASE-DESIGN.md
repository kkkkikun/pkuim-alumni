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
`idx_alumni_profiles_directory(show_in_directory, region_code, industry_code)`、
`idx_alumni_profiles_graduation_year(graduation_year)`（通讯录按毕业年份筛选，迁移 `AddQueryIndexesAndProtectAuditLogs1730000005000`）。

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
唯一索引 `uk_verification_attachment(application_id, media_id)`。

### verification_reviews
`id, application_id FK→verification_applications, admin_id FK→admin_users, action, note,
snapshot_version INT, created_at` —— **只追加，不覆盖**。
索引 `idx_verification_reviews_app(application_id, created_at)`（按申请查审核历史）。

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
`id, post_id FK→resource_posts, media_id FK→media_assets, created_at`，
唯一索引 `uk_resource_post_attachment(post_id, media_id)`。

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
索引 `idx_event_registration_user(user_id, id)`（「我的活动」按 user_id 排序分页，迁移 `AddRemainingQueryIndexes1730000006000`）。

## 6. 内容

- **articles**：`id, category_id FK→article_categories NULL, title VARCHAR(160), summary VARCHAR(255),
  body MEDIUMTEXT, cover_media_id, status ENUM('draft','published','offline'), published_at, view_count INT,
  created_by FK→admin_users, version, created_at, updated_at`；
  索引 `idx_articles_published(status, published_at)`、`idx_articles_category(category_id, published_at)`（按分类筛选 + 按发布时间倒序）。
- **article_categories**：`id, name, slug UNIQUE, sort_order, created_at`；
  唯一索引 `uk_article_categories_slug(slug)`。
- **notices**：`id, title VARCHAR(160), body MEDIUMTEXT, status ENUM('draft','published','offline'),
  published_at, view_count, created_by FK→admin_users, version, created_at, updated_at`；
  索引 `idx_notices_published(status, published_at)`。

## 7. 通知

- **notifications**：`id, user_id FK→users, type ENUM('verification_submitted','verification_decision',
  'connection_request','connection_decision','resource_review','event_registration','event_changed','system'),
  title VARCHAR(160), body VARCHAR(1000), payload JSON, read_at DATETIME(3) NULL, expires_at DATETIME(3) NULL,
  created_at`；索引 `idx_notifications_user(user_id, read_at, created_at)`、
  `idx_notifications_user_id(user_id, id)`（「我的通知」按 id 倒序分页，迁移 `AddQueryIndexesAndProtectAuditLogs1730000005000`）。
- **notification_deliveries**：`id, notification_id FK→notifications, channel ENUM('inapp','wechat'),
  status ENUM('pending','sent','failed'), attempts INT, last_error VARCHAR(500), sent_at, created_at`；
  索引 `idx_notification_deliveries_notification(notification_id, status)`（按通知查投递记录）。
- **outbox_events**：`id, aggregate_type VARCHAR(64), aggregate_id VARCHAR(64), event_type VARCHAR(64),
  payload JSON, status ENUM('pending','processing','done','failed'), attempts INT,
  available_at DATETIME(3) NOT NULL, processed_at DATETIME(3) NULL, created_at`；
  索引 `idx_outbox_pending(status, available_at)`。

## 8. 管理后台 RBAC

- **admin_users**：`id, username VARCHAR(64) UNIQUE, password_hash VARCHAR(255), display_name VARCHAR(64),
  status ENUM('active','disabled'), last_login_at, created_at, updated_at`；
  唯一索引 `uk_admin_users_username(username)`。
- **roles**：`id, code VARCHAR(32) UNIQUE, name VARCHAR(64), description VARCHAR(255)`；
  唯一索引 `uk_roles_code(code)`。
- **permissions**：`id, code VARCHAR(64) UNIQUE, name VARCHAR(64), description VARCHAR(255)`；
  唯一索引 `uk_permissions_code(code)`。
- **admin_user_roles**：`admin_user_id FK, role_id FK` 复合主键。
- **role_permissions**：`role_id FK, permission_id FK` 复合主键。
- **admin_action_logs**：`id, admin_id FK→admin_users, action VARCHAR(64), target_type VARCHAR(32),
  target_id VARCHAR(64), detail JSON, ip VARCHAR(45), created_at`；索引 `idx_admin_action_logs_admin(admin_id, created_at)`。

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
- **idempotency_records**：`id, scope VARCHAR(255), idem_key VARCHAR(128), user_id BIGINT UNSIGNED NULL,
  request_hash CHAR(64), response_body JSON, status ENUM('in_progress','completed'),
  created_at, expires_at`；唯一索引 `uk_idempotency(scope, idem_key)`。
  ⚠️ `scope` 的长度是 **255**（不是 64）：scope 是「方法 + **实际路径** + 用户 id」，
  长路径会超过 64 字符（缺陷 #140）→ 由迁移 `WidenIdempotencyScope1730000004000` 放宽。
  实体声明必须与之一致（否则 `synchronize: true` 的环境会把列缩回去）。
- **system_settings**：`key VARCHAR(64) PK, value TEXT, description VARCHAR(255), updated_at`。

## 10. 并发与一致性策略（落到 SQL 形态）

| 场景 | 机制 |
|---|---|
| 活动报名不超卖 | 事务内 `UPDATE events SET registered_count = registered_count + 1 WHERE id = :id AND status='published' AND (capacity = 0 OR registered_count < capacity)`；影响行数为 0 → `CONFLICT`；同时唯一索引 `uk_event_registration` 防重复；失败整体回滚 |
| 重复报名 | **先查后插**撞唯一索引 `uk_event_registration` → **409 `CONFLICT`**（并发撞键；顺序重复提交命中既有报名行 → 幂等返回，不报错） |
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

## 12. 唯一键的口径与对账（第十轮）

本文件里写出的**唯一索引 / 主键**就是「生产库里真实存在的唯一约束」，
三者必须**一致**：本文件（口径）↔ 实体声明（`@Column({unique:true})` /
类级 `@Index(..., {unique:true})` / `@PrimaryColumn`）↔ 迁移
（`apps/api/src/database/migrations/*` 里**真正创建的**索引与主键）。

⚠️ 为什么必须三方一致：生产库 `synchronize: false`，**真正约束数据的是迁移**。
「实体里有、迁移里没建」= 生产库**根本没有那道防线** ——
撞键不会报错，数据库会**静默写出重复行**，
而业务代码里「捕获重复键 → 409」的那一段**永远不会触发**。

| 层次 | 谁来核 | 怎么核 |
|---|---|---|
| 实体 ↔ 迁移（静态） | `node infra/scripts/check-error-semantics.mjs` | 扫全量实体抽出唯一键，再扫迁移抽出**真正创建**的唯一约束（`uk_*` 与复合主键），缺一个即报错；唯一键列的**长度 / 可空性**也要一致 |
| 迁移 ↔ 库（实况） | `node infra/scripts/check-unique-index-db.mjs` | 只读 `information_schema.statistics`：登记表要求的每一道唯一约束**在库里必须真的存在** |
| 登记表 ↔ 实现 | `check-error-semantics.mjs` | 少登记一条唯一键 → 报错；「撞键时返回什么、在哪处置」必须写清并能在代码里找到 |
| **本文件 ↔ 迁移（索引清单）** | `check-error-semantics.mjs`（第十一轮新增） | 本文件里写出的**每一个** `uk_*` / `idx_*` 索引名，迁移里必须**真的创建**它（否则报 `DOC_INDEX_NOT_IN_MIGRATION`）；迁移里创建的每一个索引，本文件的清单里也必须**写明**（否则报 `MIGRATION_INDEX_NOT_IN_DOC`）。实测：42 ↔ 42 逐条对齐 |

### 12.1 实体 ↔ 迁移的三层对账（第十二轮新增）

对账不再只到**唯一键**：生产库跑的是迁移，**实体声明了而迁移没建**的东西
（索引 / 外键 / 列）在生产库上**根本不存在**。`check-error-semantics.mjs`
现在逐条核三层：

| 层 | 核什么 | 不一致时报什么 |
|---|---|---|
| **全部索引**（含非唯一 `idx_*`） | 实体类级 `@Index` ↔ 迁移里创建的索引：名字、所在表、列集合、唯一性 | `MIGRATION_INDEX_MISSING`（实体有迁移没有）/ `MIGRATION_INDEX_NOT_DECLARED`（迁移有实体没有）/ `MIGRATION_INDEX_COLUMN_MISMATCH` / `MIGRATION_INDEX_UNIQUENESS_MISMATCH` / `MIGRATION_INDEX_TABLE_MISMATCH` |
| **外键** | 实体 `@ManyToOne` / `@OneToOne` + `@JoinColumn` ↔ 迁移的 `FOREIGN KEY`：列、目标表、目标列 | `ENTITY_FOREIGN_KEY_MISSING` / `MIGRATION_FOREIGN_KEY_NOT_DECLARED` / `FOREIGN_KEY_TARGET_MISMATCH` |
| **全部列** | 每一列的类型 / 长度 / 可空性；以及两边各自多出来的列 | `MIGRATION_COLUMN_DEF_MISMATCH` / `MIGRATION_COLUMN_MISSING` / `MIGRATION_COLUMN_NOT_DECLARED` / `MIGRATION_TABLE_MISSING` |

⚠️ **口径**：只报**能由迁移与实体直接判定**的分歧 ——
枚举**取值**、精度、`unsigned`、`ON DELETE` 行为、默认值一律**不判**。
⚠️ **主键等价**仍不算缺陷（唯一索引的列就是主键时，主键天然唯一）。
实测：32 张表 / 40 条实体索引 / 46 条实体外键 / 271 列**逐条对齐**。

两条**已知的等价形态**（不算不一致）：

- **主键等价于唯一键**（自然键主键与复合主键都算）：`admin_user_roles` / `role_permissions` /
  `private_contacts` / `system_settings` / `regions` / `industries`
  由主键提供唯一性，迁移里**不必**再建一条同列的唯一索引
  （那是重复约束 = 写放大）。
- **索引名可以不同**：对账按**列集合**判定，不按索引名判定。

⚠️ 新增唯一键的顺序：**先写迁移 → 再改实体 → 再登记失败语义**，
三者缺一即报错（`check-error-semantics.mjs` 会当场点名）。

### 12.2 三层对账的**库内实况**（第十四轮新增）

12.1 那张表核的是「**实体 ↔ 迁移**」（静态）。
它证明得了「迁移里**写了**创建那道索引 / 外键 / 列」，
证明不了「**这个库里真的有**」——
迁移没被应用过、库是从旧备份恢复的、有人手工 `DROP` 过，静态脚本**一律看不见**。

第十四轮把这一层也补上了（**只读**，全程只查 `information_schema`）：

| 层次 | 谁来核 | 怎么核 |
|---|---|---|
| 实体 ↔ **库（实况）** | `node infra/scripts/check-migration-schema-db.mjs` | 只读 `information_schema` 的 `columns` / `statistics` / `key_column_usage`：实体声明的**每一条**索引 / 外键 / 列，在库里必须**真的存在**且**逐条一致**（列集合、唯一性、指向、类型、长度、可空性）；**反向**也查：库里多出来的索引 / 外键 / 列同样报 |

判定码：`DB_TABLE_MISSING` / `DB_INDEX_MISSING` / `DB_INDEX_COLUMN_MISMATCH` /
`DB_INDEX_UNIQUENESS_MISMATCH` / `DB_INDEX_NOT_DECLARED` /
`DB_FOREIGN_KEY_MISSING` / `DB_FOREIGN_KEY_TARGET_MISMATCH` /
`DB_FOREIGN_KEY_NOT_DECLARED` / `DB_COLUMN_MISSING` / `DB_COLUMN_DEF_MISMATCH` /
`DB_COLUMN_NOT_DECLARED`。

实测（MySQL 8.4，`nmg_alumni_test`）：**32 张表 / 40 条实体索引 / 46 条实体外键 /
271 列逐条对齐，0 处出入**。反向验证 5 例（`check-migration-schema-db-selftest.sh`）
全部被抓出、退出码非 0，基线退出码 0；已接进 CI。

⚠️ **口径与 12.1 一致**（枚举取值、精度、`unsigned`、默认值、`ON DELETE` 不判），
另加两条**等价形态**（不算不一致）：

- **主键等价**：唯一索引的列就是主键时，主键天然唯一（不必再建同列的唯一索引）。
- **MySQL 自动建的外键支撑索引**：MySQL 会为没有可用索引的外键自动建一条同名索引
  （例如 `fk_alumni_profiles_verified_by`）—— 那不是索引契约的一部分。
  实体里 `unique: true` 的列由一条唯一索引兜着，同样不算「实体没声明」。
