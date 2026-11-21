# API 规范（REST / OpenAPI）

> 契约基线：`packages/contracts/src/**`（前后端唯一事实来源）。本文件是接口的人类可读版本；
> 两者不一致时以 `packages/contracts` 为准，并同步修正本文件。
> 前缀：`/api/v1`。统一响应信封：`{code, message, data, requestId}`。

## 第三轮的契约变更（迁移说明）

> 这一轮**允许变更对外响应结构**（前两轮不允许）。共三类，客户端必须同步。

| 端点 | 改动前 | 改动后 |
|---|---|---|
| `GET /admin/events/:id/registrations` | 裸数组（**全部**报名记录，无上限） | `{items, meta}`，入参 `page` / `pageSize` |
| `GET /alumni/verification/mine` | 裸数组（**全部**认证申请，无上限） | `{items, meta}`，入参 `page` / `pageSize` |
| `GET /admin/roles`、`GET /admin/permissions`、`GET /admin/settings` | 裸数组（全表，无上限） | `{items, meta}`，入参 `page` / `pageSize` |
| `GET /articles`、`GET /notices`、`GET /resources`（**列表**） | `body` 是整篇正文（MEDIUMTEXT，`pageSize=100` 时单次响应可达数十 MB） | `body` 只返回**前 200 字摘要**；完整正文走详情接口。管理端列表不变（仍为全文） |
| `GET /me/summary` | —（不存在） | **新增**：一次返回「我的」首屏的四个计数（`eventCount` / `requestCount` / `postCount` / `unreadCount`），替代此前 4 个只为拿数字的列表请求 |

- 角色 / 权限点 / 设置项的**条目结构**此前契约写窄了（写成 `AdminRole[]` 等代码联合类型，
  实际返回的是目录整行）。第三轮起契约写清楚：`AdminRoleDto` / `AdminPermissionDto` / `SystemSettingDto`。
- **第四轮**把角色 / 权限点的**代码**字段也放宽了（`docs/KNOWN-ISSUES.md` #182）：
  `roles.code` / `permissions.code` 在库里是 `VARCHAR` **自由文本列**（目录表），
  服务端按库里实际代码返回，服务端自己的入参 DTO 也是 `roles?: string[]`（比契约更宽）——
  契约却写成封闭联合 `AdminRole`，**比实现窄**。
  故 `AdminRoleDto.code` / `AdminPermissionDto.code` / `AdminUserDto.roles` /
  `UpdateAdminUserBody.roles` 改为 `string` / `string[]`。
  `AdminRole` / `AdminPermission` 两个联合**保留** —— 它们描述的是「系统内置的那几个」，
  由 RBAC 三方对账（契约联合 ≡ 种子角色 ≡ 前端矩阵）保证不会漂移。
  ⚠️ 这**不是**放宽校验：值域校验仍由「内置目录一致性」那一层负责。
- `viewCount` 的**一致性口径**由「即时一致」改为**最终一致**：
  详情接口返回的值 = 库里的基线值 + 尚未落库的增量（用户看到的数字当场就是对的），
  但数据库行里的 `view_count` 可能滞后最多一个刷回周期（60 秒）。
  详见 `docs/SECURITY.md` 第 2.2 节。

> **发布顺序**：上表这些改动要求**服务端与两端客户端同一发布窗口上线**
> （逐端点的两个方向破坏形态、发布前核对清单与回滚说明见 `docs/RELEASE-ORDER.md`）。

## 通用约定

| 项 | 约定 |
|---|---|
| 认证 | `Authorization: Bearer <accessToken>`；access token 有效期 2h，refresh token 30d 且可吊销 |
| 请求标识 | 请求可携带 `X-Request-Id`，未携带则服务端生成并在响应回传 |
| 幂等 | 写接口可携带 `Idempotency-Key`；同一 (scope, key) 在有效期内（默认 24h）只执行一次并回放原响应。scope = `METHOD:实际路径:u{用户ID}` —— **路径取本次请求的真实路径（含资源 id，如 `/api/v1/connections/17/contact-grant`），不是路由模板**（模板会让「一把钥匙开两个不同资源」互相串扰，缺陷 #140）；**含用户维度**（不同用户用同一幂等键互不影响）；匿名请求不启用幂等。请求指纹（方法 + 路径 + 查询串 + 请求体）不一致、或同键正在处理中 → 409 `IDEMPOTENCY_CONFLICT`（**专用码**，不是通用 `CONFLICT`）；**请求失败会释放幂等键**，客户端可用同一键安全重试；超过有效期后同键**重新执行**而不是回放旧响应。客户端注意：**重试同一个动作必须沿用同一把钥匙**，每次现生成新钥匙等于没有幂等 |
| 分页 | 入参 `page`（≥1）、`pageSize`（1~100）；出参 `{items, meta:{page,pageSize,total,totalPages}}`。**第三轮起，所有列表接口一律是这个形状**（此前有三个端点返回裸数组，见下方「第三轮的契约变更」） |
| 列表正文 | `GET /articles`、`GET /notices`、`GET /resources` 的**列表**响应里，`body` 只返回**前 200 字的摘要**（末尾带 `…`）；完整正文走对应的详情接口（`GET /articles/:id` 等）。管理端列表（`/admin/*`）仍返回**全文** —— 后台编辑弹窗直接回填列表行里的正文，截断会导致保存时静默截断正文 |
| 错误码 | `VALIDATION_ERROR`（入参校验失败，400）`AUTH_REQUIRED`（**未携带**有效令牌，401）`AUTH_FAILED`（**凭据无效**：密码错 / 令牌失效 / 账号停用，401）`FORBIDDEN`（无权限，403）`NOT_FOUND`（对象不存在，404）`CONFLICT`（业务状态冲突，409）`RATE_LIMITED`（429）`VERIFICATION_REQUIRED`（**需先完成校友身份认证**，403 —— 与 `FORBIDDEN` 区分开，客户端据此引导到认证页）`IDEMPOTENCY_CONFLICT`（幂等键用于不同内容或正在处理中，409 —— 专用码，不是通用 `CONFLICT`）`INTERNAL_ERROR`（500） |
| 限流 | 读接口 240 次/分钟，��接口 30 次/分钟，登录与刷新 20 次/分钟（按用户或 IP） |
| 权限 | 用户侧接口需登录；管理端接口需管理员令牌且具备对应权限点 |

## 1. 认证 `/auth`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| POST | `/auth/wechat/login` | 微信 `wx.login` code 换会话；body `{code}` | 公开 |
| POST | `/auth/mock/login` | Mock 登录（小程序未注册阶段）；body `{mockOpenid?, nickname?}` | 公开（`AUTH_MODE` 控制） |
| POST | `/auth/refresh` | 刷新令牌；body `{refreshToken}`；旧 refresh 立即失效（轮换） | 公开 |
| POST | `/auth/logout` | 吊销 refresh token | 登录 |
| POST | `/auth/admin/login` | 管理后台登录；body `{username,password}` | 公开 |
| GET | `/auth/session` | 当前会话（用户或管理员）；返回 `{user:{id,openid,nickname,role,stage,isAdmin,permissions}, stage}`，管理员会话 `stage='admin'` | 登录 |

`/auth/wechat/login`、`/auth/mock/login` 返回 `{accessToken, refreshToken, expiresIn, tokenType, user, alumniProfile, stage}`。
`stage` ∈ `logged_in | pending_review | verified`，前端据此控制功能可用性；**后端同样强制校验**。

## 2. 我 `/me`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/me` | 当前用户 + 校友资料（含隐私开关与我的联系方式，仅本人） |
| GET | `/me/summary` | 「我的」页首屏计数汇总（`eventCount` / `requestCount` / `postCount` / `unreadCount`）。**一次请求给全**，替代此前 4 个只为拿数字的列表请求 |
| GET | `/me/profile` | 我的校友档案（我方视角：档案 + 隐私开关 + 我的联系方式） |
| PATCH | `/me/profile` | 更新资料（`displayName/college/degree/graduationYear/regionCode/industryCode/direction/intro`） |
| GET | `/me/contacts` | 我的联系方式（仅本人可见） |
| PUT | `/me/contacts` | 更新联系方式（加密存储，仅本人可见） |
| PATCH | `/me/contacts` | 更新联系方式（兼容别名，建议改用 `PUT`） |
| GET | `/me/privacy` | 我的隐私与授权开关 |
| PUT | `/me/privacy` | 更新隐私开关（通讯录可见、字段可见、是否接受联系申请、是否允许共享联系方式） |
| GET | `/me/connections` | 已建立的连接列表（含对方是否已共享联系方式） |
| GET | `/me/connection-requests` | 我发出的 / 收到的联系申请（`direction=outgoing|incoming`） |
| GET | `/me/resources` | 我发布的资源与需求（含审核状态） |
| GET | `/me/events` | 我的活动报名 |
| GET | `/me/verifications` | 我的认证申请与审核历史 |
| GET | `/me/notifications` | 我的通知（未读数见 `/notifications/unread-count`） |

## 3. 校友与认证 `/alumni`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| POST | `/alumni/verification` | 提交认证申请（含 `attachmentMediaIds` 证明材料） | 登录 |
| GET | `/alumni/verification/:id` | 认证申请详情 | 本人或审核员 |
| GET | `/alumni/verification/:id/history` | 审核历史（只追加） | 本人或审核员 |
| GET | `/alumni/verification/mine` | 我的全部认证申请（按时间倒序，**分页**：`page` / `pageSize`，出参 `{items, meta}`） | 本人 |
| PUT | `/alumni/verification/:id/resubmit` | 补充材料后重新提交 | 本人 |
| GET | `/alumni/:id` | 校友**公开名片**（与通讯录条目同构，不含联系方式与私密字段） | 公开 |
| PATCH | `/admin/users/:id/status` | 启用/停用账号 | `alumni:manage` |
| POST | `/admin/users/:id/status` | 启用/停用账号（兼容别名，建议改用 `PATCH`） | `alumni:manage` |
| GET | `/admin/users/:id` | 用户详情 | `alumni:view` |

审核决策：`POST /admin/verifications/:id/decision`，body `{action: approve|reject|request_changes, note?}`。
附件预览：`GET /admin/verifications/:id/attachments/:mediaId/url` 与
`GET /admin/resources/:id/attachments/:mediaId/url` 返回预签名下载地址。
**不能**直接用 `GET /uploads/:id/url` —— 那是**资产归属**语义
（私有资产只有上传者本人可取），审核员取不到 → 审核流程走不通。
这两个端点按「附件确实挂在被审核的那个对象上」鉴权，再叠加权限点（详见 KNOWN-ISSUES #77）。
`request_changes` 表示要求补充材料（状态 `needs_more_material`），用户可重新提交（状态 `resubmitted`）。

> ⚠️ `/alumni` 命名空间**只承载公开名片与认证流程**。管理端校友列表统一走
> `GET /admin/alumni`（`alumni:view`，9 个筛选项全部真正生效）。
> 曾经的 `GET /alumni`（管理端列表）已删除：它把管理端能力放在公开路径空间，
> 与 `GET /admin/alumni` 重复，且 9 个筛选项里有 5 个被静默丢弃。
> 详见 docs/KNOWN-ISSUES.md #72。

## 4. 通讯录 `/directory`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/directory` | 查询参数 `keyword, regionCode, industryCode, graduationYear, page, pageSize` |
| GET | `/directory/:id` | 校友公开名片 |

**强制过滤（服务端）**：`users.stage='verified'` 且 `alumni_profiles.show_in_directory=1`；
再按对方 `show_college/show_industry/show_region` 裁剪字段。
响应中**永远不包含**联系方式。返回项附带 `connectionState`（none/pending_outgoing/pending_incoming/connected）。

## 5. 连接 `/connections`

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/connections/requests` | 提交联系申请；body `{targetUserId, message}` |
| GET | `/connections/requests/:id` | 申请详情 |
| POST | `/connections/requests/:id/accept` | 接受（仅接收方；接受后建立正式连接关系） |
| POST | `/connections/requests/:id/reject` | 拒绝（不产生连接关系） |
| POST | `/connections/requests/:id/cancel` | 发起方撤回 |
| GET | `/connections` | 已建立的连接列表 |
| GET | `/connections/requests` | 我发出 / 收到的联系申请（`direction=incoming\|outgoing`） |
| GET | `/connections/:id` | 连接关系详情（仅关系双方可见） |
| DELETE | `/connections/:id` | 解除连接关系 |
| PUT | `/connections/:id/contact-grant` | 授权/撤回向对方展示联系方式；body `{allow: boolean}` |

联系方式读取规则（四重校验，任一不满足即不返回）：
存在 `connection_pairs.status='active'`、双方 `alumni_profiles.allow_contact_share=1`、
且双方 `contact_share_grants.allow=1`。任一方撤回授权后立即不可见。

## 6. 资源与需求 `/resources`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/resources` | 公开列表（仅 `status='published'`），支持 `type/regionCode/industryCode/keyword` |
| GET | `/resources/:id` | 详情（未发布仅作者与管理员可见） |
| POST | `/resources` | 发布（草稿或直接提交审核）；body `{type,title,body,industryCode?,regionCode?,attachmentMediaIds?}` |
| PATCH | `/resources/:id` | 修改（已发布内容修改后回到 `pending` 并 `version+1`） |
| POST | `/resources/:id/submit` | 提交审核 |
| POST | `/resources/:id/withdraw` | 作者撤回 |
| GET | `/resources/:id` | 详情响应中已内含 `reviews` 审核历史（只追加） |

## 7. 活动 `/events`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/events` | 活动列表（`status='published'`） |
| GET | `/events/:id` | 活动详情（含 `myRegistration`） |
| POST | `/events/:id/registrations` | 报名；body `{note?}` |
| DELETE | `/events/:id/registrations` | 取消报名（名额回收） |

报名成功返回 `201`；重复报名返回既有报名（幂等，`200`）；名额已满返回 `CONFLICT`（409）。

## 8. 内容 `/articles` `/notices`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/articles` | 资讯列表（`categoryId, page, pageSize`） |
| GET | `/articles/:id` | 资讯详情 |
| GET | `/articles/categories` | 资讯分类列表（公开只读） |
| POST | `/admin/articles/categories` | 新建分类（管理端） | `content:manage` |
| PATCH | `/admin/articles/categories/:id` | 修改分类（管理端） | `content:manage` |
| DELETE | `/admin/articles/categories/:id` | 删除分类（管理端） | `content:manage` |
| GET | `/notices` | 公告列表 |
| GET | `/notices/:id` | 公告详情 |
| GET | `/home/feed` | 聚合首页（重点位 + 三个 Tab + 近期活动 + 公告条） |

## 9. 通知 `/notifications`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/notifications` | 站内通知列表（分页） |
| GET | `/notifications/:id` | 通知详情 |
| GET | `/notifications/unread-count` | 未读通知数量 `{unread}` |
| POST | `/notifications/:id/read` | 标记单条已读 |
| POST | `/notifications/read-all` | 全部标记已读 `{updated}` |

事件来源：认证提交/审核结果、联系申请/接受/拒绝、资源审核结果、活动报名成功、活动变更。

## 10. 上传 `/uploads`

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/uploads` | multipart 上传（字段 `file`）→ `{id, fileName, mimeType, size, bucket, objectKey, visibility, url}` |
| POST | `/uploads/records` | 登记媒体记录并返回直传地址（`uploadUrl`），小程序直传前调用 |
| POST | `/uploads/:id/content` | 直传字节流（凭短期签名 `?token=`） |
| GET | `/uploads/:id/url` | 短期签名 URL（`?intent=upload` 返回直传地址，默认下载/预览地址） |
校验：MIME 与扩展名白名单、单文件大小上限（默认 10MB）、认证材料一律 `private` 且仅审核员可取。

## 11. 管理端 `/admin`

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/admin/stats` | `dashboard:view` |
| GET | `/admin/alumni`、GET `/admin/alumni/:id` | `alumni:view` |
| GET | `/admin/verifications`、GET `/admin/verifications/:id` | `verification:review` |
| POST | `/admin/verifications/:id/decision` | `verification:review` |
| GET | `/admin/verifications/:id/attachments/:mediaId/url` | `verification:review` |
| GET | `/admin/resources`、GET `/admin/resources/:id` | `resource:review` |
| POST | `/admin/resources/:id/decision` | `resource:review` |
| GET | `/admin/resources/:id/attachments/:mediaId/url` | `resource:review` |
| GET/POST/PATCH/DELETE | `/admin/events[/:id]` | `event:manage` |
| GET | `/admin/events/:id` | 活动详情（管理端） | `event:manage` |
| GET | `/admin/events/:id/registrations` | 活动报名名单（**分页**：`page` / `pageSize`，出参 `{items, meta}`） | `event:manage` |
| GET/POST/PATCH/DELETE | `/admin/articles[/:id]`、`/admin/notices[/:id]` | `content:manage`（列表返回**全文**正文：后台编辑弹窗直接回填列表行） |
| GET | `/admin/users`、POST `/admin/users`、PATCH `/admin/users/:id` | `admin:manage` |
| GET | `/admin/roles`、`/admin/permissions` | `admin:manage`（**分页**：`page` / `pageSize`，出参 `{items, meta}`） |
| GET | `/admin/action-logs` | `audit:view` |
| GET/PUT | `/admin/settings` | `settings:manage`（GET **分页**：`page` / `pageSize`，出参 `{items, meta}`） |
| GET | `/admin/ops/invalidation-bus` | `admin:manage`（**只读运维端点**：共享失效总线状态，见下） |

### 只读运维端点：`GET /admin/ops/invalidation-bus`（第七轮新增）

多实例部署时，运维要能**一眼确认「跨实例失效链路通不通」**，
而不是只能逐个实例翻日志。本端点只返回总线状态，**不提供任何写操作**。

出参（`data`）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `enabled` | boolean | 总线是否开启（`RBAC_INVALIDATION_ENABLED=false` 时为 `false`） |
| `channel` | string | **生效频道**（按环境隔离；所有实例必须一致） |
| `subscribed` | boolean | **本实例**是否订阅上了频道 |
| `published` | number | 本进程累计发布的失效事件数 |
| `received` | number | 本进程累计收到的失效事件数 |
| `lastError` | string \| null | 最近一次总线错误（`null` = 没有） |
| `degraded` | boolean | `true` = 总线开着但**没订阅上**（= 撤权延迟回落到 TTL 上界那一档） |

- ⚠️ **既有对外契约不变**：`/healthz` 与 `/system/health` 的响应形状**原样不动**
  （它们是公开端点，把频道名与错误信息挂上去等于对外暴露内部拓扑）；
  本端点另开，只对**管理员**（`admin:manage`）开放。
- 口径与读法见 `docs/SECURITY.md` 第 2.1.9 节与 `docs/SERVER-OPERATIONS.md`。

角色与权限点见 `docs/DATABASE-DESIGN.md` §8。

### 管理端写操作的错误语义（#112 / #113 / #116 / #190）

| 情形 | HTTP | 业务 `code` |
|---|---|---|
| `POST /admin/users` 登录名重复（唯一索引冲突） | **409** | `CONFLICT` |
| `POST /admin/articles/categories` 分类 slug 重复（唯一索引冲突） | **409** | `CONFLICT` |
| `PATCH /admin/articles/categories/:id` 改成别人已占用的 slug（唯一索引冲突） | **409** | `CONFLICT` |
| `PUT /admin/settings` 并发写同一个 key 且重试耗尽（唯一键冲突） | **409** | `CONFLICT` |
| `GET /admin/users/:id`、`PATCH /admin/users/:id`、`PATCH\|POST /admin/users/:id/status` 目标不存在 | **404** | `NOT_FOUND` |
| `PATCH\|DELETE /admin/articles/categories/:id` 目标不存在 | **404** | `NOT_FOUND` |
| 停用 / 降权会导致**系统里不再有 active 且拥有 `admin:manage` 的管理员** | **400** | `VALIDATION_ERROR` |

- **不存在一律 404**：不再返回 `200 + {error:'NOT_FOUND'}` ——
  那会被统一包装成 `code:'OK'` 的**假成功响应**，客户端按 `code` 判断成功，
  于是把「对象不存在」当成成功处理。
- **「最后一个能管管理员的人」是不可动的不变量**：
  服务端在事务内、提交前校验，不满足即拒绝并整体回滚。
- `admin_users.status` 的取值只有 `active` / `disabled`
  （**没有** `locked`，那是普通校友账号的状态）；列表筛选 `status` 同理。
- ⚠️ **唯一键冲突必须是 409，不能是 500**（缺陷 #190）：
  管理端按业务 `code` 分支处理失败 —— 500 会被当成「服务端故障」，
  运维去查服务健康度、管理员去刷新页面，而真实原因只是「你填的 slug 重复了」。
  处置方式是**捕获唯一键冲突并转成 409**；
  **不得**靠去掉唯一索引来「解决」它（那等于允许重名分类，是数据损坏）。
  对账口径与守护脚本见 `infra/scripts/check-error-semantics.mjs`，
  用例见 `apps/api/test/integration/admin-write-error-semantics.e2e-spec.ts`。

### 用户侧写操作的错误语义（第九轮）

用户侧（校友本人）的写端点此前**没有**逐条核过「撞唯一键时返回什么」——
这一轮把口径补齐，与管理端**同一套**：`400` 参数 / `404` 不存在 / `409` 冲突，
**数据库异常不得直接抛成 500**（那会被客户端当成「服务端故障」）。

| 情形 | HTTP | 业务 `code` |
|---|---|---|
| `POST /auth/mock/login`、`POST /auth/wechat/login` 同一 `openid` 并发首登（重试后仍冲突） | **409** | `CONFLICT` |
| `POST /auth/mock/login`、`POST /auth/wechat/login` 同一 `unionid` 已绑定另一个账号 | **409** | `CONFLICT` |
| `POST /auth/refresh` 会话令牌哈希撞键（重签后仍冲突） | **409** | `CONFLICT` |
| `PATCH /me/profile`、`PATCH /me/privacy` 并发建档 → **幂等**读回既有档案；读不回才算冲突 | **200 / 409** | 幂等 / `CONFLICT` |
| `PUT /me/contacts`、`PATCH /me/contacts` 并发建联系方式行 → **幂等**读回既有行；读不回才算冲突 | **200 / 409** | 幂等 / `CONFLICT` |
| `POST /connections/requests` 同一对用户的 pending 申请已存在 → **幂等**返回既有申请（`idempotent:true`） | **200** | 幂等 |
| `POST /connections/requests` 撞唯一键且读不到既有申请（真冲突） | **409** | `CONFLICT` |
| `POST /connections/requests/:id/accept` 并发接受同一份申请 | **200** | 幂等（读回既有连接关系） |
| `PUT /connections/:id/contact-grant` 并发授权同一对连接 → **幂等**更新既有授权行 | **200** | 幂等 |
| `PUT /connections/:id/contact-grant` 撞唯一键且读不到既有授权行（真冲突） | **409** | `CONFLICT` |
| `POST /events/:id/registrations` 同一活动重复报名（唯一索引冲突） | **409** | `CONFLICT` |
| `POST /resources`、`PATCH /resources/:id` 同一份附件挂两次（唯一索引冲突） | **409** | `CONFLICT` |
| `POST /alumni/verification`、`PUT /alumni/verification/:id/resubmit` 同一份证明材料挂两次（唯一索引冲突） | **409** | `CONFLICT` |
| `POST /connections/requests`、`POST /resources` 等带 `Idempotency-Key` 的写请求，同一个键被并发占用 | **409** | `IDEMPOTENCY_CONFLICT` |

- **幂等优先于报错**：同一个动作重复提交**不是错误** ——
  连接申请返回既有申请（`idempotent:true`）、接受申请读回既有连接关系、
  联系方式授权更新既有授权行。
  只有「连既有行都读不到」时才是**真冲突**，此时才给 409。
- ⚠️ **唯一键冲突必须是 409，不能是 500**（与缺陷 #190 同一口径）：
  用户侧此前把 `ER_DUP_ENTRY` 直接冒泡成 500，用户看到的是「服务器内部错误」，
  而真实原因只是「你已经报名过了」「这个微信账号已绑定另一个账号」。
- **登记与对账**：唯一键登记表（`infra/scripts/check-error-semantics.mjs` 里的
  `UNIQUE_KEY_REGISTRY`）是「已对账」的唯一事实来源 ——
  脚本会扫**全部实体文件**，把每个唯一键（单列唯一、复合唯一、主键自然键）
  都算出来，登记表里少一条就报错；每条还必须写清「撞键时返回什么、在哪处置」。
- 用例见 `apps/api/test/integration/user-write-error-semantics.e2e-spec.ts`。

## 12. 系统 `/system`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/system/regions` | 地区字典（带校友计数） |
| GET | `/system/industries` | 行业字典（带校友计数） |
| GET | `/system/settings` | 公开项系统设置 |
| GET | `/system/health` | 存活 + 依赖状态 |
