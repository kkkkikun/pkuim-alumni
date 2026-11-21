# 已知问题与处理记录（Known Issues）

> 本文件记录**真实发生**的问题、原因与处置，包含尚未验证的项。
> 阶段交付记录见 `docs/plan.md`；测试结果见 `docs/TEST-REPORT.md`。

## 已解决

### 1. 技术栈误判（Phase 0 → 1）
- **现象**：最初按既有项目习惯假设 FastAPI + PostgreSQL + uni-app，搭建了后端脚手架。
- **原因**：用户提供的 `docs/top.md` 当时尚未落盘（`docs/plan.md` 为 0 字节）。
- **处置**：收到 `docs/top.md` 后整体转向 NestJS + MySQL 8.4 + TypeORM + 原生小程序 + pnpm monorepo，
  删除不匹配的脚手架，`docs/plan.md` 重写为与 `top.md` 一致的执行跟踪表。

### 2. `pnpm install` 因未批准原生构建脚本而失败（ERR_PNPM_IGNORED_BUILDS）
- **现象**：pnpm 11 默认严格模式，安装结束报 `Ignored build scripts` 并以退出码 1 失败；
  `pnpm.onlyBuiltDependencies` 写在 `package.json` 中被忽略（pnpm 10+ 改读 `pnpm-workspace.yaml`）。
- **处置**：`pnpm-workspace.yaml` 声明 `onlyBuiltDependencies` + `strictDepBuilds: false`。

### 3. `bcrypt` 原生模块无法编译（Module not found: bcrypt_lib.node）
- **现象**：`bcrypt@5.1.1` 的 prebuilt 二进制未下载，容器内 `node-gyp` 亦不可用。
- **处置**：改用 **bcryptjs**（同一 bcrypt 算法，纯 JS，无原生依赖）。
  密码强度不受影响（cost 10），仅吞吐略低，对校友会量级无影响。
  涉及文件：`apps/api/src/auth/auth.service.ts`、`apps/api/src/database/seeds/seed.ts`、集成测试。

### 4. 容器内 `corepack prepare pnpm` 失败
- **现象**：corepack 固定从 `registry.npmjs.org` 拉取 pnpm，该域名在校园网不可达。
- **处置**：Dockerfile 改为 `npm install -g pnpm@${PNPM_VERSION} --registry=${NPM_REGISTRY}`（npmmirror 可达）。

### 5. Dockerfile `# syntax=docker/dockerfile:1.7` 无法拉取
- **现象**：BuildKit 从 Docker Hub 拉取 syntax 前端镜像失败。
- **处置**：syntax 指令改指华为云镜像前缀
  `# syntax=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/docker/dockerfile:1.7`。

### 6. Docker Hub 直连被墙
- **现象**：`docker pull` 全部 connection reset。
- **处置**：统一使用 `swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/*` 前缀，
  已在服务器预拉取 mysql:8.4 / redis:7-alpine / node:22-alpine / nginx:alpine / minio。

### 7. TypeORM `query()` 不接受对象参数
- **现象**：集成测试中 `dataSource.query(sql, { id })` 触发 TS2353。
- **处置**：TypeORM 原生 `query()` 只接受位置参数数组，测试统一改为 `query(sql, [value])`；
  业务代码使用 QueryBuilder 具名参数，不受影响。

### 8. `alumni_profiles.show_direction` 列缺失
- **现象**：契约 `PrivacySettings.showDirection` 与实体不一致，编译报错。
- **处置**：实体、迁移（`InitSchema1730000000000`）与 `docs/DATABASE-DESIGN.md` 同步补充该列。

### 9. MinIO 环境变量命名不一致
- **现象**：compose 注入 `MINIO_BUCKET_PUBLIC/MINIO_BUCKET_PRIVATE`，API 原先读 `MINIO_BUCKET/MINIO_PRIVATE_BUCKET`；
  且 compose 的 `MINIO_ENDPOINT` 带协议前缀，MinIO SDK 需要裸 host。
- **处置**：`configuration.ts` 兼容两种命名，并解析 endpoint 中的协议与端口。

### 10. 锁文件与 manifest 不同步导致镜像构建失败
- **现象**：`ERR_PNPM_OUTDATED_LOCKFILE`（依赖从 bcrypt 切换到 bcryptjs 后）。
- **处置**：依赖变更后必须「服务器安装 → 回拉 `pnpm-lock.yaml` → 再推送」，保证本地与服务器锁文件一致。


### 11. `UserSession` 实体未注册进 `entities` 数组（Phase 6 冒烟 0/10）
- **现象**：`EntityMetadataNotFoundError: No metadata for "UserSession" was found.`
  → Mock 登录 500 → 后续带 token 请求全 401，冒烟 10 项仅通过 6 项。
- **原因**：实体文件已写，但 barrel 的 `entities` 数组漏了 `UserSession`（且漏了 import，编译才报错）。
- **处置**：`apps/api/src/database/entities/index.ts` 补 `import { User, UserSession }` 与数组项。

### 12. JWT `expiresIn` 字符串被 jsonwebtoken 按**毫秒**解析
- **现象**：解码 access token 得到 `exp === iat`（令牌签发即过期），`/admin/stats` 持续 401。
- **原因**：`JWT_ACCESS_TTL=900`（秒）以字符串传给 `signAsync`；jsonwebtoken 对字符串走 `ms()` 语义，
  `ms('900') = 900 毫秒` → `exp = iat + 0.9s` 取整后等于 `iat`。
- **处置**：新增 `apps/api/src/common/utils/duration.ts`，统一把 TTL 解析为**秒数**再签发；
  签发参数一律传数字（`expiresIn: 900`），消除毫秒/秒歧义。校验：`exp - iat = 900s`。

### 13. 同一秒内刷新令牌完全相同 → `user_sessions` 唯一索引冲突（500）
- **现象**：刷新令牌报 `Duplicate entry '...' for key 'user_sessions.uk_user_sessions_token'`。
- **原因**：JWT 载荷只有 `{sub,kind,typ}`，同一密钥、同一秒签发的 refresh token **字节级相同**，
  哈希后撞唯一索引。
- **处置**：access/refresh 载荷加入随机 `jti`（`randomUUID()`），保证每个令牌唯一。

### 14. `@Query()` 使用交叉类型 → metatype 退化 → 列表接口 500
- **现象**：`GET /resources`、`GET /admin/*` 等列表接口报 `skip value is not a number`。
- **原因**：Nest 的 ValidationPipe 按**运行时 metatype** 决定是否校验/转换；
  写成 `PaginationQueryDto & { keyword?: string }` 时 metatype 退化为 `Object`，
  class-transformer 不生效 → `page` 为字符串/undefined → `skip(NaN)`。
- **处置**：新增 `common/dto/list-query.dto.ts`，所有「分页 + 筛选」查询改为**具名类继承**
  `PaginationQueryDto`；`ResourceQueryDto` 改为继承分页基类。
  同时把校验管道抽成 `common/pipes/validation.pipe.ts`，应用与集成测试共用，杜绝行为漂移。

### 15. BIGINT 主键以字符串返回 → 「不能给自己发申请」失效
- **现象**：`POST /connections/requests` 给自己发申请返回 **201**（应 400）；接口返回的 id 是 `"1"` 字符串。
- **原因**：API 的 TypeORM 连接缺少 `supportBigNumbers/bigNumberStrings` 配置，
  BIGINT 列被 mysql2 返回为字符串；而 DTO 经 class-transformer 转换成了数字，
  `dto.targetUserId === fromUserId` 严格比较失效。
- **处置**：`app.module.ts` 补 `extra: { supportBigNumbers: true, bigNumberStrings: false }`
  （与 `data-source.ts` 一致）；服务层对 id 统一 `Number()` 归一化后再比较；
  `normalizePair` 内部也做数值归一。校验：自申请返回 400，接口 id 变为数字。

### 16. `alumni_profiles.verified_by` 外键指错表 → 认证审核 500
- **现象**：`POST /admin/verifications/:id/decision` 报
  `foreign key constraint fails (alumni_profiles, fk_alumni_profiles_verified_by)`。
- **原因**：该列存的是**审核管理员 id**（在 `admin_users`），外键却指向 `users(id)`；
  管理员 id 与用户 id 恰好相同时看似正常，一旦不同即触发约束失败。
- **处置**：新增迁移 `1730000001000-FixVerifiedByForeignKey` 把外键改指 `admin_users(id)`，
  并清理历史脏数据；`InitSchema` 与 `docs/DATABASE-DESIGN.md` 同步修正。

### 17. 契约声明的 7 个端点未实现 → 前后端 404
- **现象**：`ApiPaths` 声明但服务端未注册：`meContacts`、`user`、`alumni`、`alumniVerificationHistory`、
  `notificationItem`、`systemSettings`、`adminAlumniItem`。
- **原因**：契约先行、后端补实现时遗漏；没有任何机制发现「契约有、实现无」。
- **处置**：补齐上述端点（`PUT/PATCH /me/contacts`、`GET /users/:id`、`GET /alumni`、
  `GET /alumni/verification/:id/history`、`GET /notifications/:id`、`GET /system/settings`、
  `GET /admin/alumni/:id`）；并新增**契约-路由一致性集成测试**
  （`contract-routes.e2e-spec.ts`），逐条比对 `ApiPaths` 与 Swagger 实际路由，以后再漂移立即失败。

### 18. 幂等拦截器从未注册 + 回写用裸 SQL 拼 JSON（500）
- **现象**：带 `Idempotency-Key` 的并发写请求，出现 1 次 201 + 4 次 409，但**胜出的那条 500**；
  且多轮压测中同一幂等键产生了数百条重复资源。
- **原因**：
  (a) `IdempotencyInterceptor` 写好了却**从未注册**到应用与测试；
  (b) `complete()` 用 `update(..., { responseBody: () => JSON.stringify(v) })`，
      TypeORM 把函数体当裸 SQL 拼进 UPDATE，JSON 文本无引号 → SQL 语法错误；
      改传普通对象同样被 TypeORM 对 JSON 列内联序列化，仍然缺引号。
- **处置**：在 `main.ts` 与测试基座注册该拦截器（注册顺序在 `TransformInterceptor` 之外层，
  以便记录已包装的响应体）；`complete()` 改为**参数绑定**的原生 SQL
  （`UPDATE ... SET response_body = ? WHERE scope = ? AND idem_key = ?`）。

### 19. 幂等回放返回 HTTP 201（应 200）
- **现象**：压测统计「创建成功 803 次」，实际只创建了 1 条资源。
- **原因**：命中幂等记录后拦截器直接回放已存响应体，但 POST 的默认状态码仍是 201，
  客户端无法区分「新建」与「回放」。
- **处置**：回放分支显式设置 `200 OK` 并加 `Idempotent-Replay: true` 响应头。

### 20. 集成测试误连业务库 → TRUNCATE 清空已 Seed 数据
- **现象**：第一次跑集成测试后，`nmg_alumni` 的 `users/alumni_profiles/resource_posts` 全部清空。
- **原因**：`app.module` 的数据库配置只读 `DB_*`，不认 `DATABASE_URL`，
  而迁移脚本走 `data-source.ts`（认 `DATABASE_URL`）→ 迁移与测试连到**不同库**；
  集成测试的 `resetDatabase` 直接 TRUNCATE 了业务库。
- **处置**：
  (a) `configuration.ts` 统一支持 `DATABASE_URL`（与 `data-source.ts` 同一套解析规则）；
  (b) 新增 `infra/scripts/test-integration.sh`：库名不含 `test` 直接拒绝执行，
      自动建库 / 迁移 / Seed / 跑测试 / 结束后校验业务库行数；
  (c) `test/setup.ts` 增加启动护栏：生效库名不含 `test` 直接抛错；
  (d) 业务库已重新 Seed 恢复（1000 校友 / 60 资源 / 40 连接对 / 5 活动 / 40 认证申请）。

### 21. k6 `setup()` 的模块级变量不跨 VU 共享
- **现象**：通讯录/互申/报名/资源四个场景全部 401，压测阈值全红。
- **原因**：k6 每个 VU 有独立 JS 运行时，`setup()` 里赋值的模块级变量在 VU 中是 `undefined`。
- **处置**：改为 `setup()` 返回值 → 通过函数参数传给各 VU（`export default function (data)`）。

### 22. k6 v0.50 `setResponseCallback` 不接受自定义函数
- **现象**：`unsupported argument, expected http.expectedStatuses`。
- **处置**：`expectStatuses()` 改用 `http.expectedStatuses({min:200,max:499})` 把业务冲突 4xx
  排除出 `http_req_failed`，具体状态合法性由各脚本内部的 `check()` 严格把关。


### 23. MinIO 存储桶从未被创建（上传必然 NoSuchBucket）
- **现象**：备份脚本提示桶不存在；`POST /uploads` 报错；对象存储里没有 `nmg-public` / `nmg-private`。
- **原因**：全项目没有任何建桶逻辑（`makeBucket` / `bucketExists` 均未出现），而桶名只在 `.env.prod` 里配置。
- **处置**：`UploadsService` 实现 `OnModuleInit`，启动时幂等检查并创建 public / private 两个桶；
  MinIO 不可用时只打告警、不阻断 API 启动。实测日志：`已创建存储桶：nmg-public / nmg-private`。

### 24. 上传端点未应用 `FileInterceptor` → 500
- **现象**：`POST /api/v1/uploads` 报 `Cannot read properties of undefined (reading 'originalname')`。
- **原因**：控制器 import 了 `FileInterceptor` 与 `UseInterceptors`，但两个上传方法上**没有装饰器**，
  `@UploadedFile()` 永远拿不到文件。
- **处置**：两个上传端点补 `@UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 MiB } }))`。
  注意 Nest 11 的签名是 `FileInterceptor(fieldName, options)`，options 在**第二个参数**。
  实测：`POST /uploads` 返回 201，文件写入 `nmg-private` 桶。

### 25. mc 的 `local` 是保留别名 / 别名大小写敏感（备份/恢复脚本）
- **现象**：MinIO 镜像失败，报 `Unable to stat source 'local/nmg-public'` 与 `Requested path '/nmg/nmg-public' not found`。
- **原因**：(a) mc 内置的 `local` 别名固定指向 `localhost:9000`，`MC_HOST_LOCAL` 无法覆盖；
  (b) `MC_HOST_NMG` 实际创建的别名名是**大写** `NMG`，mc 解析别名大小写敏感，小写 `nmg` 会被当成路径。
- **处置**：备份/恢复脚本改用 `MC_HOST_NMG` + `NMG/<bucket>`。

### 26. `gzip -c file.gz` 会把已压缩文件再压缩一次
- **现象**：恢复校验报「表数量不一致：期望 0 / 实际 33」，实际数据已正确导入。
- **原因**：`gzip -c` 不带 `-d` 时执行的是**压缩**，`file.gz` 被再压一次，管道里是 gzip 二进制流而非 SQL。
- **处置**：改用 `gzip -dc`（解压到标准输出）。

### 27. k6 脚本自身的多处缺陷（压测首轮全红）
- **现象**：首轮压测 5 个场景全部 401 / 阈值不通过。
- **原因与处置**：
  1. `setup()` 中赋值的**模块级变量在 VU 中不共享**（每个 VU 有独立 JS 运行时）
     → 改为 `setup()` 返回值经函数参数下发（`export default function (data)`）；
  2. `http.setResponseCallback` 只接受 `http.expectedStatuses(...)` 的结果，不能传自定义函数
     → 改为区间 `{min:200,max:499}`，状态合法性由脚本内 `check()` 把关；
  3. 响应回调在 `setup()` 里调用对 VU 无效 → 移到**模块级**；
  4. 幂等键在模块级用 `Date.now()` 生成 → 每个 VU 各生成一个（导致一轮压测创建多条资源）
     → 改由 `setup()` 生成并下发；
  5. 互申请��固定使用账号 1/2，第二轮起命中既有申请，测不到「新建」路径 → 每轮轮换账号对；
  6. 管理员令牌字段名写成 `access_token`，实际返回 `accessToken` → 兼容两种。

### 28. 客户端与服务端路径漂移（12 处，运行时才暴露为 404/405）
- **现象**：小程序「我的」页、认证进度页、隐私设置页的若干请求全部失败；
  管理后台「校友详情」「活动详情」「账号状态」三个动作同样失败。
- **原因**：契约 `ApiPaths` 只声明了**路径**，没有约束**方法**；
  小程序运行时镜像了一份路径表，两边各自演进，出现「路径对、方法错」的漂移：
  | 客户端 | 调用 | 服务端实际 | 后果 |
  |---|---|---|---|
  | 小程序 | `POST /auth/session` | `GET` | 405 |
  | 小程序 | `GET /connections/{id}` | 只有 `DELETE` | 404 |
  | 小程序 | `POST /connections/{id}/contact-grant` | `PUT` | 405 |
  | 小程序 | `GET /events/{id}/registrations` | 只有 `POST/DELETE` | 404（且属死代码） |
  | 小程序 | `GET /me/profile` | 只有 `PATCH` | 404 |
  | 小程序 | `PUT /me/profile` | 只有 `PATCH` | 404 |
  | 小程序 | `GET /me/privacy` | 只有 `PUT` | 404 |
  | 小程序 | `GET /alumni/verification` | 只有 `POST`（另有 `/mine`） | 400 |
  | 管理后台 | `GET /admin/events/{id}` | 只有 `PATCH/DELETE` | 404 |
  | 管理后台 | `POST /admin/users/{id}/status` | 未注册（契约路径是 `/users/{id}/status`） | 404 |
- **处置**：
  1. 新增 `infra/scripts/check-client-paths.mjs`：解析契约与小程序镜像表、扫描两端客户端的**真实调用点**，
     还原出 (方法, 路径) 后与服务端 Swagger 逐条比对，路径缺失或方法未注册即报错；
  2. 该校验已接入 `infra/scripts/test-integration.sh`，成为常规回归的一部分；
  3. 服务端按契约补齐缺失端点：`GET /me/profile`、`GET /me/privacy`、`GET /connections/:id`、`GET /admin/events/:id`；
  4. 客户端改为与服务端一致的方法；删除未在服务端实现且无页面使用的 `GET /events/:id/registrations`（含契约键）；
  5. 契约补登 `alumniVerificationMine`、`uploadRecords`、`uploadContent`、`articleCategoriesItem`；
  6. 下线两个无人调用的历史别名路由：`PUT /me/profile/contact`、`GET /admin/categories`。
- **回归**：`check-client-paths.mjs` 复跑 **0 错误**（小程序 51 个调用点、管理后台 51 个调用点、服务端 87 条路由）。

### 29. `GET /me/connection-requests` 返回 `[{}]`（数组里塞了未 await 的 Promise）
- **现象**：联系申请列表接口返回 200，但每一项都是空对象 `{}`，页面拿不到申请 id 与状态。
- **原因**：`ConnectionsService.listRequests()` 里 `toRequestView()` 是 **async** 方法，
  写成 `rows.map((row) => this.toRequestView(row))` —— 得到的是 **Promise 数组**；
  JSON 序列化 Promise 时没有任何自有属性，于是每项变成 `{}`。
- **处置**：改为 `await Promise.all(rows.map(...))`，并返回契约规定的分页结构。
- **注意**：同一文件的 `toConnectionView` 一直正确使用了 `Promise.all`，所以连接列表不受影响；
  全仓库已排查同类写法（`toView` / `toArticleView` / `toNoticeView` 均为同步函数，无此问题）。

### 30. 连接类列表接口未按契约返回分页结构
- **现象**：`GET /connections`、`GET /me/connections`、`GET /me/connection-requests` 返回裸数组，
  而契约 `ConnectionsResponse` / `ConnectionRequestsResponse` 规定为 `PageResult`（`{items, meta}`）。
  小程序「我的」首页的角标计数依赖 `meta.total`，实际恒为 0。
- **原因**：服务实现先于契约定型，且返回类型没有被契约一致性测试覆盖（此前只比对路径是否存在）。
- **影响**：小程序的 4 个列表页（我的-连接记录、我的-发出的申请、我的-收到的申请、搜索-申请结果）
  全部读 `result.items`，而服务端返回的是裸数组 → `items` 为 `undefined` → 页面恒为空列表；
  「我的」首页角标计数依赖 `meta.total`，实际恒为 0。
- **处置**：`listRequests` / `listConnections` 改为分页查询并返回 `paginate(...)`；
  `ListRequestsQueryDto` 继承 `PaginationQueryDto` 支持 `page/pageSize`；集成测试断言同步改为 `data.items`。

### 31. `/me` 系列接口的响应形状与契约不一致
- **现象**：`PATCH /me/profile`、`PUT /me/privacy`、`PUT /me/contacts` 返回的是整个 `getMe()` 结果
  （`{user, alumniProfile, privacy, contact, stage}`），而契约分别要求
  `MyAlumniProfile` / `PrivacySettings` / 联系方式对象；小程序据此赋值会把整个响应塞进 `alumniProfile`。
  另外 `privacy` 的开关是 MySQL tinyint（`0/1`）而非布尔值，且 `alumniProfile` 内没有内嵌
  `privacy` 与自己的联系方式（契约 `MyAlumniProfile` 要求有）。
- **处置**：
  - `MeService` 拆出 `toPrivacy()` / `toMyProfile()` / `toContact()` 三个整形函数，布尔开关统一转 `boolean`；
  - `updateProfile` → `MyAlumniProfile`，`updatePrivacy` → `PrivacySettings`，`updateContact` → 联系方式对象；
  - `GET /me` 的 `alumniProfile` 改为 `MyAlumniProfile`（内嵌 `privacy` 与自己的联系方式），顶层 `privacy/contact` 保留兼容。

### 32. 小程序 `tsc --noEmit` 存在 4 处类型错误（此前静态自检未覆盖）
- **现象**：`pnpm --filter @nmg/miniprogram typecheck` 报错 4 处：
  `WechatMiniprogram.IRequestOption` 在当前 typings 版本中不存在；
  `settleAll()` 只支持同构数组导致异构返回值推断失败；
  `DirectoryEntry | null | undefined` 不能赋给 `DirectoryEntry | null`。
- **处置**：`IRequestOption` → `RequestOption`；`settleAll` 改为按元组映射的泛型签名
  （`{ [K in keyof T]: Settled<T[K]> }`）；目录页对空值做显式收敛。
- **回归**：小程序 `tsc --noEmit` 通过；管理后台 `vue-tsc --noEmit` 通过；契约包 `tsc` 通过。

### 33. 契约声明了服务端并不存在的方法
- **现象**：契约 `ApiPaths.eventRegistrations`（`GET /events/{id}/registrations`）在服务端没有实现
  —— 服务端只有 `POST`（报名）与 `DELETE`（取消），`docs/API-SPEC.md` 也只登记了这两个方法。
  由于既有契约一致性测试只比对「路径是否存在」（该路径确实存在，只是方法不同），一直未被发现。
- **处置**：删除契约键与小程序里对应的死函数（无任何页面调用）；
  管理端名单走 `GET /admin/events/:id/registrations`（需 `event:manage` 权限），
  不向普通校友公开报名名单，避免个人信息外泄。

### 34. `events/articles/notices/resource_posts.created_by` 外键指向 `users`，实际存管理员 id
- **现象**：在测试库创建活动时 500：
  `Cannot add or update a child row: a foreign key constraint fails (events, CONSTRAINT fk_events_created_by FOREIGN KEY (created_by) REFERENCES users (id))`。
- **原因**：这四张表的 `created_by` 在 `InitSchema` 中外键指向 `users(id)`，
  但服务层写入的是**管理员 id**（`events.service.create()` / `content.service.adminCreateArticle()` /
  `adminCreateNotice()` 均传 `admin.id`，管理员在 `admin_users` 表）。
  业务库之所以没报错，是因为 `users.id` 与 `admin_users.id` 恰好撞上了 ——
  该列实际指向一个**无关用户**，属于静默的语义错误（用户被删除时还会被 `ON DELETE SET NULL` 抹掉）。
  这与 #12（`alumni_profiles.verified_by`）是同一类问题，当时只修了那一列。
- **处置**：
  - 新增迁移 `1730000002000-FixCreatedByForeignKey`：把四张表的 `created_by` 外键改指向
    `admin_users(id)`，并把指向不存在管理员的历史脏数据置 NULL（幂等）；
  - 实体关系改为 `@ManyToOne(() => AdminUser)`，`InitSchema` 同步（新建库直接正确）；
  - `docs/DATABASE-DESIGN.md` 标注 `created_by FK→admin_users`。
- **验证**：迁移已在业务库执行成功；`INFORMATION_SCHEMA` 复核四张表均指向 `admin_users`；
  管理端新建活动返回 201。

### 35. `GET /alumni/verification/mine` 被 `verification/:id` 抢先匹配 → 400
- **现象**：小程序「认证进度」页取认证状态返回 400。
- **原因**：Nest 按**注册顺序**匹配路由，`@Get('verification/:id')` 注册在 `@Get('verification/mine')` 之前，
  于是 `mine` 被当作 id 交给 `ParseIntPipe` → 400。
- **处置**：把 `verification/mine` 移到 `verification/:id` 之前注册，并在控制器里加了注释说明该约束。
  已复查其余控制器：内容（`articles/categories` 先于 `articles/:id`）、通知（`unread-count` / `read-all` 先于 `:id`）、
  连接（`requests` / `requests/:id` 先于 `:id`）均无同类问题。
- **验证**：集成测试新增 `GET /alumni/verification/mine` 用例通过。

### 36. 路径校验脚本用正则匹配调用参数，长行上触发灾难性回溯（进程空转）
- **现象**：校验脚本在服务器上 CPU 占用 100% 且数分钟无输出，只能强杀。
- **原因**：用 `method<...>(arg` 的正则抓取调用点时，`(?:<.*>)?` 在**没有 `>` 的长行**上会逐字符回溯；
  管理后台的 `.vue` 文件存在超长行，复杂度退化为 O(n²)。
- **处置**：改为**线性扫描**——先匹配方法名，再手工跳过泛型、定位 `(`、按括号/引号深度读到第一个顶层实参，
  整体复杂度 O(n)。同一脚本本地实测从「数分钟无输出」降到 **0.1 秒**。
- **验证**：反向用例验证（故意把小程序改成 `POST /connections/{id}/contact-grant` 与镜像值漂移），
  校验器准确报出 `METHOD_NOT_ALLOWED` / `MIRROR_VALUE_MISMATCH` / `ROUTE_NOT_FOUND` 并以退出码 1 结束。

### 37. `GET /auth/session` 未返回契约承诺的 `stage`
- **现象**：契约 `AuthSessionResponse = { user, stage }`，但服务端只返回 `{ user }`。
  管理后台刷新页面时 `session.stage` 恒为 `undefined`（靠本地默认值兜底）；
  小程序 `loadSession()` 同样拿不到服务端身份阶段。
- **原因**：会话接口只透出了 `user` 投影，漏了顶层 `stage`。
- **处置**：服务端补 `stage` —— 管理员会话为 `'admin'`，用户会话为用户当前身份阶段；
  契约新增 `SessionUser` 精确描述精简投影；小程序改为**只同步 stage**，
  不再用精简投影覆盖本地缓存的完整用户资料（`GET /me` 才是完整资料来源）。

### 38. 契约里的若干响应类型与实现不符（含 `API-SPEC` 对 `/alumni/:id` 的描述失真）
- **现象**：
  - 契约 `AlumniProfileResponse = AlumniProfileDto`，但 `GET /alumni/:id` 实际返回的是**公开名片投影**
    （与通讯录条目同构，不含 `realName/intro/联系方式`）；
  - `docs/API-SPEC.md` 把该接口写成「校友详情（管理端，含联系方式解密视图）」——**与实现相反**，
    实现返回的是不含私密字段的公开投影（更安全，但文档失真）；
  - 契约缺少 `/alumni/verification/mine`（数组）、`/connections/:id`（单项）、`/auth/session`（精简投影）的类型。
- **处置**：契约补 `VerificationsMineResponse` / `ConnectionPairResponse` / `SessionUser`，
  `AlumniProfileResponse` 改为 `DirectoryEntry` 并加注释说明是公开投影；
  `API-SPEC` 同步改正该行的描述与权限列（公开）；
  小程序 `getAlumniProfile()` 同步改为 `DirectoryEntry`，去掉 `as AlumniProfileDto` 的强制转换。
- **验证**：小程序 / 管理后台 / 契约包三处 `tsc` 全部通过。

### 39. 前端缺少「运行期静默失败」的静态防线（小程序尤其危险）
- **现象**：小程序无法在微信开发者工具中运行（需真实 AppID 与 GUI 环境），
  但它的典型故障——页面未注册、跳转地址写错、WXML 绑定的方法不存在、
  WXML 读取的 data 字段不存在——**在 tsc 里完全查不出来**，只会在真机上表现为白屏或「点了没反应」。
  上一轮把「小程序静态自检通过」当作交付结论，但那次自检实际只覆盖了 `tsc`，
  后续核查立刻发现 4 处类型错误（#32），说明该结论并不成立。
- **处置**：新增两个纯 node（无依赖）的静态交叉校验器：
  - `infra/scripts/check-miniprogram.mjs`：校验 41 个页面的注册完整性、**全部 `/pages/...` 跳转字面量**
    （含 `utils/navigate.ts` 的 URL 构造函数与页面内路由表）、`switchTab` 目标、
    152 处事件绑定与对应 TS 方法、260 处模板字段与 `data/setData`、`usingComponents` 组件存在性、
    `services` 导出存在性；
  - `infra/scripts/check-admin-web.mjs`：校验路由组件存在性、视图是否被路由引用、
    路由权限点是否在契约 `AdminPermission` 中、菜单路径、具名/路径跳转；
  - 封装为 `infra/scripts/check-frontend.sh`，并接入 `infra/scripts/test-integration.sh`（测试通过后自动执行）。
- **验证**：两个校验器均做过**反向验证**——分别注入 6 类与 3 类缺陷
  （未注册页面、事件绑定不存在、组件不存在、跳转地址不存在、页面路由表指向未注册页、
  服务导出不存在、权限点拼错、路径跳转不存在），全部被准确报出并以退出码 1 结束；
  真实仓库当前 0 错误 0 警告。

### 40. 小程序缺「通知中心」（需求基线明确要求，但此前未实现）
- **现象**：`docs/top.md` Phase 5 前端交付清单里写明「**完成通知中心**」，
  §8.2 也要求「站内通知 / 通知列表 / 通知详情 / 通知已读状态」；
  但服务端接口（`GET /me/notifications`、`GET /notifications/:id`、
  `GET /notifications/unread-count`、`POST /notifications/:id/read`、
  `POST /notifications/read-all`）与契约都齐备，**小程序里却一个通知页面都没有**，
  用户收不到任何站内提醒（契约里的 `meNotifications` 等键在小程序镜像表中根本不存在）。
- **原因**：Phase 5 交付时把「服务端有接口」当成了「功能已交付」，
  路径一致性校验的 `MIRROR_MISSING_KEY` 警告里也一直列着这些键，但没人把它当成缺口。
- **处置**（本轮补齐）：
  - 新增服务层 `services/notifications.ts`（列表 / 详情 / 标记已读 / 全部已读 / 未读数）；
  - 新增页面 `pages/me/notifications/index`（列表、未读标记、全部已读、隐私提示）
    与 `pages/me/notification-detail/index`（详情、打开即已读）；
  - 「我的」页新增「通知中心」入口与未读角标（`unreadCount`）；
  - 小程序镜像表补齐 `meNotifications` / `notificationItem` / `notificationRead` /
    `notificationReadAll` / `notificationUnreadCount` 五个键，与契约逐字一致；
  - 新增服务端集成测试 `notifications.e2e-spec.ts`（4 个用例）覆盖
    「业务动作 → 通知入库 + Outbox 登记 → 未读计数 → 已读状态 → 仅本人可见」。
- **实测**：线上走通「A 发联系申请 → B 未读数 +1 → 列表出现站内通知 →
  标记已读 → 未读数归零」，Worker 侧 `outbox_events` 状态 `done`、
  `notification_deliveries` 状态 `sent`。

### 41. 压测数据清理脚本漏掉通知三张表
- **现象**：压测跑完后，业务库里残留 **230 条站内通知 + 230 条投递记录**，
  而 `cleanup-loadtest-data.sh` 报告「清理完成」。
- **原因**：清理脚本只删了资源、活动、连接申请、幂等记录等表，
  没有处理 `notifications` / `notification_deliveries` / `outbox_events`；
  通知是压测期间「联系申请 / 资源提交 / 活动报名」三条链路顺带产生的。
  另外脚本里 `mock_k6_alumni-%` 的 LIKE 模式写错了分隔符（实际 openid 是
  `mock_k6_alumni_001`，下划线而非连字符），即使执行也匹配不到。
- **处置**：清理脚本补上通知三张表的删除，并按「聚合对象是否还存在」清理孤儿 Outbox 事件
  （`aggregate_type <> 'system'` 的 `notification/resource_post/event/connection_request`）；
  修正 LIKE 模式。执行后业务库回到：users=1202、notifications=0、deliveries=0、
  outbox 仅剩 15 条种子与业务相关事件。

### 42. 需求基线（`docs/top.md`）没有任何机器化校验
- **现象**：`top.md` §3.1 逐条列出了四个栏目的二级页面、§4.3 列出了 13 个必须实现的接口分组，
  但这些条目只存在于文档中 —— 没有任何机制保证它们真的被实现。
  后果就是 #40：服务端和契约都有通知接口、Phase 5 也写着「完成通知中心」，
  而小程序里一个通知页面都没有，**没有任何检查会报错**。
- **处置**：把需求基线落成可校验的矩阵并接入回归：
  - `docs/SPEC-COVERAGE.json`：50 条页面需求（含 Phase 5 的通知中心两条）、
    16 个管理后台视图、13 个 API 分组，逐条指向实现文件；
  - `infra/scripts/check-spec-coverage.mjs`：校验
    ① 矩阵里的页面真实存在（app.json 注册 + .ts + .wxml）、
    ② app.json 里没有矩阵未覆盖的孤儿页面（新增页面必须登记需求出处）、
    ③ 后台视图存在且被路由引用、
    ④ §4.3 的每个 API 分组在服务端至少注册了一条路由（路由表取自运行中 API 的 Swagger）；
  - 已接入 `infra/scripts/check-frontend.sh` → `test-integration.sh` 回归链。
- **反向验证**：在临时副本里删掉「通知中心」页面注册、并新增一个未登记的页面，
  校验器分别报出 `PAGE_NOT_REGISTERED` 与 `PAGE_NOT_IN_MATRIX`，退出码 1 ——
  与 #40 的实际缺口形态一致。

### 43. 备份恢复演练脚本「静默失败」，且结构指纹校验是恒过的
- **现象**：`backup-restore-drill.sh` 跑完备份与恢复后，打印到「✓ 表数量：33」就以退出码 1
  结束，没有任何错误提示；演练库 `nmg_restore_drill` 残留在服务器上没被清理。
- **原因（两层）**：
  1. 比对用的表名清单里写了 `resources`，而实际表名是 `resource_posts`；
     SQL 报错被 `2>/dev/null` 吞掉，`set -o pipefail` 让脚本在第一条失败查询处直接退出，
     **看起来像跑完了，其实后面的比对一步都没做**；
  2. 更严重：`check_same` 的 SQL 模板把库名写死成 `${DB_NAME}`（源库），
     于是「在演练库上执行」时读的仍然是**源库**的 `information_schema`——
     列结构指纹、外键指纹、索引指纹三项**恒等成立**，属于典型的假阳性校验。
- **处置**：
  - 重写脚本：SQL 改用 **stdin 管道**传给 mysql（表名反引号不再被多层 shell 吃掉）；
    SQL 失败**显式报错**而非静默退出；比对从「手工维护 13 张表清单」改为
    **遍历全部表逐表行数比对**（新增表自动纳入）；
  - 引入 `__DB__` 占位符，`check_same` 按当前被查询的库替换，
    结构指纹现在真的分别读两个库的元数据；
  - 加 `trap` 兜底：无论成功失败都清理演练库，`--keep` 时才保留；
  - 比对项扩充为：表数量 / 全表行数 / 列结构指纹 / 外键指纹 / 索引指纹 /
    迁移记录数与内容 / 默认字符集；
  - 新增 `infra/scripts/backup-restore-drill-selftest.sh`（反向验证）：
    ① 正常演练退出码 0；② 完好演练库跑 `--compare-only` 退出码 0（正向基线）；
    ③ 注入缺陷 A（删一条 `event_registrations`）→ 比对退出码 1 且命中「行数」；
    ④ 重新演练回到完好状态；⑤ 注入缺陷 B（把 `users.nickname` 改成 `VARCHAR(255)`）
    → 比对退出码 1 且命中「列结构指纹」。实测两轮缺陷均被抓出。
  - 演练本体接入 `test-integration.sh` 第 8 步（`--skip-drill` 可跳过，
    `--drill-selftest` 额外跑反向验证）。
- **实测**：修复后完整演练退出码 0 —— 33 张表行数一致、列结构指纹
  `b1befb26120bcbf220b5be0d1da58503`、外键指纹 `4ca42c672cf427a8ec853b084b8b8393`、
  索引指纹 `6e4522a6e31b0d13e28e8d2f502f31b1`、迁移记录 3 条、字符集 utf8mb4，
  演练库自动清理；服务器数据库仅剩 `nmg_alumni` 与 `nmg_alumni_test`。

### 44. 已交付的校验器需要逐个做「反向验证」
- **现象**：本项目已产出 6 个校验器（契约路由、客户端路径、前端静态 ×2、需求覆盖、
  API-SPEC 文档）。其中 #43 暴露出：**一个「通过」的校验器可能根本没有校验任何东西**。
- **处置**：确立硬规矩——**每个校验器都必须做反向验证**（注入缺陷 → 确认报错且退出码 1），
  否则视为恒过、不可信。反向验证脚本随校验器一起交付：
  `infra/scripts/check-frontend.sh`（前端类）、`infra/scripts/backup-restore-drill-selftest.sh`（恢复类）。
- **状态**：6 个校验器均已完成反向验证；本条作为后续新增校验器的准入条件。

### 45. 反向验证本身也曾只是「人工做过一次」
- **现象**：#43/#44 落地时，5 个前端 / 契约校验器（小程序静态、管理后台静态、需求覆盖、
  API-SPEC 文档、客户端路径）的反向验证是**人工在临时副本里手改一次、看一眼报错**，
  没有留下可重复执行的脚本。回归链无法自动证明「这些校验器今天仍然有效」——
  校验器本身被改坏（如某个判定条件写错、某个目录改名）时，回归会静悄悄地「全绿」。
- **处置**：新增 `infra/scripts/check-frontend-selftest.sh` + `infra/scripts/selftest-inject.mjs`：
  - 先跑**正向基线**：在干净副本上跑 5 个校验器，必须全部退出码 0
    （否则副本环境本身有问题，后续用例结论不可信）；
  - 再逐个注入真实缺陷（每个用例一份**独立临时副本**，真实工作副本只读）：
    | 注入 case | 期望错误码 |
    |---|---|
    | 页面文件存在但未在 app.json 注册 | `PAGE_NOT_REGISTERED` |
    | WXML 绑定 TS 中不存在的方法 | `HANDLER_MISSING` |
    | usingComponents 指向不存在的组件 | `COMPONENT_MISSING` |
    | 后台路由指向不存在的视图 | `ROUTE_COMPONENT_MISSING` |
    | 路由声明契约外的权限点 | `PERMISSION_NOT_IN_CONTRACT` |
    | app.json 注册了矩阵未覆盖的页面 | `PAGE_NOT_IN_MATRIX` |
    | 矩阵登记了服务端没有实现的 API 分组 | `API_GROUP_NOT_IMPLEMENTED` |
    | API-SPEC 写了服务端不存在的端点 | `DOC_ENDPOINT_MISSING` |
    | 客户端调用点指向未注册路径 | `ROUTE_NOT_FOUND` |
  - 再加**元自检**：用一个永远返回 0 的假校验器跑 `expect_failure`，
    断言它必须被判为「恒过」——防止断言函数本身写坏导致自测假通过。
- **接入**：成为 `test-integration.sh` 第 8 步（`--skip-selftest` 可跳过），
  第 9 步为备份恢复演练，`--drill-selftest` 额外跑演练校验器的反向验证。
- **实测**：基线 5/5 退出码 0；9 类缺陷全部被抓出且退出码均为 1；元自检通过；
  整套反向验证在服务器上耗时约 3 秒，可承受每次回归都跑。

### 46. 契约与服务端路由的校验重复实现，且客户端路径校验长期有 32 条噪音警告
- **现象（两处）**：
  1. `check-client-paths.mjs` 每次运行都报 **32 条 `MIRROR_MISSING_KEY` 警告**
     （契约 84 键 / 小程序镜像 52 键）。这 32 个键全是管理后台 / 服务端专用路径，
     小程序本来就不需要镜像 —— 噪音会淹没真实警告。
  2. 新写 `check-contract-routes.mjs` 后发现，它与 `check-client-paths.mjs` 内部的
     「契约 → 服务端」「服务端 → 契约」两段逻辑**功能重叠**，
     两处各写一遍，日后必然各自漂移。
- **原因**：
  - 噪音来源：`MIRROR_MISSING_KEY` 的判定是「契约里有、镜像表里没有就告警」，
    但小程序镜像表**本就应该只是契约的子集**，该判定方向错了；
  - 重复来源：契约 ↔ 服务端集合比对此前散落在「契约测试」「客户端校验」两处，没有单一归属。
- **处置**：
  - **职责去重**：「契约 ApiPaths ↔ 服务端路由」的集合级双向比对统一由
    `check-contract-routes.mjs` 负责（**error 级**、排除 `/healthz` 等基础设施路径）；
    `check-client-paths.mjs` 删掉重复的两段逻辑，专注「镜像一致性 + 客户端调用点」，
    并在文件头注明职责边界，避免后人再写一遍；
  - **噪音换真检查**：把 32 条 `MIRROR_MISSING_KEY` 警告降级为一行 INFO 说明
    （「其余 32 个为管理后台 / 服务端专用，不参与镜像校验」），
    同时新增 `MIRROR_LITERAL_PATH` **error 级**检查：
    小程序若绕过镜像表直接写字面量路径，契约改路径时客户端不会跟着改 ——
    这才是镜像机制真正要防的风险。实测当前小程序**没有**这种写法。
- **实测**：客户端路径校验输出从「32 条警告」变为「0 条噪音 + 1 条 INFO + 1 条 `/healthz` 提示」；
  契约 84 键 ↔ 服务端 85 条路由（1 条基础设施）**集合完全一致**。
- **反向验证**：新增 2 个用例 —— ① 契约里加一个服务端没有的路径键 →
  `CONTRACT_ROUTE_MISSING`；② Swagger 里塞一条契约没声明的路由 →
  `SERVER_ROUTE_NOT_IN_CONTRACT`；③ 小程序改用字面量路径 → `MIRROR_LITERAL_PATH`。
  三个用例退出码均为 1 且命中预期错误码。
- **附带修正**：新增 `MIRROR_LITERAL_PATH` 后，原「客户端调用未注册路径」用例的注入方式
  失效（被字面量检查先拦下，命中不了 `ROUTE_NOT_FOUND`）——
  这是自测脚本自己暴露的问题，已把注入改为「契约与镜像表同步加键」，两条检查互不干扰。

### 47. 种子数据的认证状态与认证流程记录完全脱节
- **现象**：新建数据完整性校验器（`infra/scripts/check-data-integrity.sh`）后首次运行，
  报出 4 项非零违规：
  | 项 | 违规数 |
  |---|---|
  | `stage='verified'` 但无通过认证记录 | 801 |
  | `stage='pending_review'` 但无在途认证记录 | 242 |
  | 有通过认证记录但用户 `stage` 非 `verified` | 8 |
  | 有在途认证记录但用户 `stage` 非 `pending_review` | 16 |
- **原因**：业务不变量由服务层强制（`alumni.service.ts`）：
  提交申请 → `stage='pending_review'`；审核通过 → `stage='verified'` 且 `profile.verified=1`；
  退回/驳回 → `stage='logged_in'`。
  但 `seeds/fixtures.ts` 是**按 60% / 25% / 15% 随机分配** `users.stage`，
  `seedVerifications` 又另外随机生成 40 条**随机状态**的申请并随机分配给用户，
  两者互不关联 —— 认证状态与流程记录对不上号。
- **影响**：管理端「身份审核」列表与通讯录里的已认证人数对不上；
  任何基于认证记录的统计、审计、追溯都会与 `users.stage` 冲突。
- **处置（存量 + 新增双向）**：
  - **存量**：新增迁移 `1730000003000-BackfillVerificationHistory`（幂等）：
    ① 按既有申请记录修正用户 `stage`（含 `profile.verified` 同步）；
    ② 按既有 `stage` 补录缺失的申请与审核记录（带「【历史数据补录】」标记，`down()` 可按标记精确删除；
    `stage` 的修正**不可逆**，完全回退需从备份恢复）。
  - **新增**：改 `seeds/seed.ts` —— ① `seedVerifications` 改为「按申请状态分配对应 `stage` 的用户」，
    并修正驳回记录的审核动作为 `reject`；② 新增 `seedVerificationHistory`，
    为每个已认证 / 待审核校友补齐对应的申请与审核记录。
    **空库 + 新 seed 实测：30 项数据完整性检查全部归零**。
- **实测**：迁移在**测试库先验证**（30 项全 0）后才在业务库执行；业务库迁移后 30 项全部归零，
  `users=1202` 未减少，`notifications=0` 未受影响。

### 48. 数据完整性校验器自身的盲区：受外键保护的检查项无法注入
- **现象**：为数据校验器写反向验证时，「地区码不在字典表」这一项**注入不进违规数据** ——
  写入时直接被数据库外键 `fk_alumni_profiles_region` 拒绝
  （`ERROR 1452 Cannot add or update a child row: a foreign key constraint fails`）。
- **原因**：A1–A5 这类「字典外键」检查受**数据库外键约束**保护，
  存储层就写不进脏数据 —— 它们是「纵深防御」而非「数据现状检查」，
  无法用普通注入验证（曾误判为「校验器漏检」）。
- **处置**：
  - 新增 **F1–F3**：断言关键外键约束**确实存在**（从 `information_schema` 读取），
    这样「外键被误删」也会被抓住；
  - 反向验证用例相应调整：原「注入脏地区码」改为「注入档案认证标记与 stage 矛盾」（不受外键限制）；
    另加一例「删除外键约束 → 必须报 F1 → 恢复外键」，证明纵深防御项确实有效。
- **结论**：校验项分两类——**数据现状类**（可注入验证）与**结构保障类**（靠 F 项验证约束本身存在），
  两类都要有反向验证，否则容易把「被数据库挡住」误判成「校验器恒过」或「漏检」。

### 49. 集成测试基座的 `markVerified` 破坏业务不变量
- **现象**：把数据完整性校验接入回归链后，`--data-selftest` 一上来就报
  `C1 stage=verified 但无通过认证记录：2 条违规`，且注入用例找不到可用对象。
- **原因**：集成测试辅助函数 `markVerified()` 为了「跳过人工审核流程」，
  只执行了 `UPDATE users SET stage='verified'` 与 `UPDATE alumni_profiles SET verified=1`，
  **没有创建认证申请与审核记录** —— 与业务不变量
  （`stage='verified'` ⟺ `profile.verified=1` ⟺ 存在 approved 申请与审核记录）冲突。
  测试库本身就不是「符合生产约束的数据」。
- **处置**：`markVerified()` 改为在置为已认证的同时**补录一条 approved 认证申请与 approve 审核记录**
  （幂等：已有通过记录则跳过），并把注释里的不变量写清楚。
- **连带修正**：数据完整性自测脚本改为**自带数据准备**——先跑一次幂等 seed 把测试库补齐，
  不再依赖「外部刚好有完整数据」这一隐含前提（集成测试会清空测试库）。
- **实测**：修复后 6 类注入用例全部可执行并被抓出，撤销后数据恢复；回归链 `--data-selftest` 退出码 0。

### 50. 测试辅助函数的「补录审核记录」曾被整段跳过（测试库脏数据）
- **现象**：把越权探测套件接入回归链后，测试在 `beforeAll` 阶段整体失败：
  `QueryFailedError: Column 'admin_id' cannot be null`。
- **原因（两层）**：
  1. `verification_reviews.admin_id` 是 **NOT NULL**，而 `markVerified()` 补录审核记录时传了 `NULL`；
  2. 更隐蔽的是——**上一版代码根本没走到这一步**：`INSERT` 的返回结构在不同驱动下不一致
     （mysql2 给的是 `ResultSetHeader`，**没有 `id` 字段**，只有 `insertId`），
     旧代码读 `inserted[0].id` 得到 `undefined`，于是**整段审核记录插入被跳过**。
     表面上测试全绿，实际测试库里留下了「有通过认证申请、却没有审核记录」的脏数据
     （数据完整性检查的 E6 项）。
- **处置**：
  - 取主键改用 `SELECT LAST_INSERT_ID()`（跨驱动稳定），并保留 `insertId` 兜底；
  - `admin_id` 取真实管理员：优先查 `admin_users` 中 active 管理员，没有则 `ensureAdmin()` 建一个；
  - 由此也修正了 `LAST_INSERT_ID()` 与「审核记录必须存在」的联动 —— 现在
    「已认证用户」在测试库中同样满足完整不变量。
- **连带修正**：越权探测套件中，原本用 HTTP 提交认证申请来造数据，会把提交人的
  `stage` 改成 `pending_review`，导致该用户后续请求全被「校友身份认证」守卫拦下（**自伤**）。
  改为直接写库插入申请记录，不触碰任何用户的 stage。
- **实测**：越权探测 20 条用例全部通过；集成测试 84 → **86 用例**全绿。

### 51. 幂等键跨用户串号：响应回放会泄露他人的联系方式明文（P0 隐私缺陷）
- **现象**：验证幂等接口时发现——用户乙使用与用户甲**相同的 `Idempotency-Key`**、
  **相同的请求体**调用同一写接口时，乙拿到的是**甲的响应回放**
  （HTTP 200 + `Idempotent-Replay: true`），而不是自己的执行结果。
- **原因**：`IdempotencyInterceptor` 的 scope 定义为 `METHOD:route.path`，
  幂等记录表的唯一索引是 `(scope, idem_key)` —— **两者都不含用户维度**。
  于是「甲用 key=k 提交过」这件事，会让「乙用同一个 key」直接命中甲的记录。
- **影响（最坏路径）**：
  1. `PUT /me/contacts` 的响应体含**解密后的联系方式明文** ——
     乙会直接拿到甲的手机号 / 邮箱 / 微信号，**直接违反「联系方式仅本人可见」的隐私硬规则**；
  2. `POST /auth/mock/login` 这类**匿名**接口会回放**他人的访问令牌**（凭据泄露）。
- **处置**：
  1. scope 纳入用户维度 → `METHOD:route.path:u{userId}`，
     唯一索引不变、**无需迁移**（幂等记录本就有 `user_id` 列可查）；
  2. **匿名请求不启用幂等**：匿名写接口无法按用户隔离幂等键，
     不同用户共用 scope 必然互相回放（登录接口回放令牌风险最高），
     宁可对匿名请求直接放行。
- **反向验证**：修复前「不同用户使用同一幂等键」用例失败
  （`expected 201 "Created", got 200 "OK"`，且响应带回放头）；
  修复后 6 条幂等用例全绿，其中包含
  「跨用户的联系方式请求必须真正执行」「匿名登录接口不得回放他人令牌」两条针对性用例。
- **连带影响**：scope 变化后，旧的幂等记录（scope 无用户后缀）不再命中，
  24 小时内未过期的记录会失效一次 —— 影响可忽略（幂等窗口本就用于防重复提交）。
- **新增测试**：`apps/api/test/integration/idempotency.e2e-spec.ts`（6 条），
  覆盖回放、409 冲突、不同键、跨用户隔离、跨用户联系方式、匿名登录。

### 52. 管理端路由前缀缺失：一批管理接口落在公开路径空间

- **现象**：`apps/api/src/modules/admin/admin-users.controller.ts` 上写的是
  `@Controller()`（**空前缀**），而同一模块的 `admin.controller.ts` 写的是
  `@Controller('admin')`。同一个管理后台，两套路由命名空间并存。
- **受影响的 5 条路由**（原本的实际路径 → 期望路径）：

  | 方法 | 修复前实际路径 | 修复后 |
  |---|---|---|
  | POST | `/articles/categories` | `/admin/articles/categories` |
  | PATCH | `/articles/categories/:id` | `/admin/articles/categories/:id` |
  | DELETE | `/articles/categories/:id` | `/admin/articles/categories/:id` |
  | PATCH | `/users/:id/status` | `/admin/users/:id/status` |
  | POST | `/users/:id/status` | `/admin/users/:id/status` |
  | GET | `/users/:id` | `/admin/users/:id` |

- **为什么是缺陷（不只是风格问题）**：
  1. **与公开只读接口同路径段**：`GET /articles/categories` 是 `@Public()` 的公开接口
     （小程序未登录即可读取分类字典），而 `POST /articles/categories` 是管理端写接口。
     两者落在同一个路径前缀下，仅靠 HTTP method 区分 ——
     任何按「路径前缀」而非「method + 路径」做白名单/网关策略的地方都会漏掉写接口。
  2. **契约把管理端路径写进了公共区**：`ApiPaths.user` / `ApiPaths.userStatus` /
     `ApiPaths.articleCategoriesItem` 三个键原本位于 `api.ts` 的「Users / Alumni」「Content」
     公共区段，而它们实际只被管理后台消费。契约是唯一事实来源，
     **契约错了，调用方就会照着错的路径写代码，运行时 404**。
  3. **三方「一致」掩盖了错误**：`check-contract-routes.mjs` 做契约 ↔ 服务端双向比对，
     此前报「84 键 ↔ 85 路由，0 差异」—— 因为**契约与服务端同错**。
     一致性校验只能保证「没有漂移」，不能保证「路径语义正确」。
  4. **已实际产生故障**：新写的 `admin-content.e2e-spec.ts` 按契约的直觉
     用 `/admin/articles/categories` 调管理端接口，修复前必然 404。
- **处置**：
  1. 服务端：`@Controller()` → `@Controller('admin')`，
     方法上的冗余 `admin/` 前缀去掉，其余路由自动落到 `/admin` 命名空间；
  2. 契约：删除公共区的 `user` / `userStatus` / `articleCategoriesItem`，
     在 Admin 区新增 `adminUserStatus` / `adminArticleCategories` /
     `adminArticleCategoryItem`（**84 键总数不变**）；
  3. 管理后台：`admin.ts` 的分类增删改与账号状态变更改调 `/admin` 前缀；
     分类**读取**仍走公开 `GET /articles/categories`（读字典无需管理权限）；
  4. 小程序：镜像表 `paths.ts` 只含公开路径（本来就不含这三个管理键），无需改动；
  5. 文档：`API-SPEC.md` 的路径与权限点同步更新。
- **回归防线**：`admin-content.e2e-spec.ts` 新增用例
  「管理端写接口不在公开路径空间暴露」，锁死两条不变量 ——
  公开路径下的 6 个管理路由必须 404；迁到 `/admin` 之后未认证访问必须是 401（鉴权在前）
  而不是 404（路由不存在）。
- **验证（已实测）**：服务器上 `POST /admin/articles/categories` → **201**、
  `POST /articles/categories` → **404**；其余 5 条新路径全部 200/201，
  3 条旧路径全部 404；契约 ↔ 服务端 **84 键 ↔ 85 路由 0 差异**；
  API-SPEC 105 条声明一致；集成测试 15 套件 / 115 用例全绿。

### 53. 限流测试在模块顶层改 `process.env`，污染同一进程内的后续测试文件

- **现象**：新增 `apps/api/test/integration/rate-limit.e2e-spec.ts` 时，
  在**模块顶层**写了 `process.env.RATE_LIMIT_ENABLED = 'true'` 等 6 个环境变量。
- **为什么必须在顶层**：限流阈值由 `ConfigService` 的配置工厂在 **`AppModule` 导入时**求值一次，
  而 `test/helpers.ts` 顶层就 `import { AppModule } from '../src/app.module'` ——
  也就是说配置在**测试文件被加载时**就已经固化了。
  把赋值挪到 `beforeAll` 会来不及（阈值退回默认值，测试必然失败）。
- **为什么这是个缺陷**：`jest --runInBand` 会在**同一进程**内顺序执行多个测试文件，
  顶层改 `process.env` 会泄漏到后续文件：
  1. `RATE_LIMIT_WRITE=2` 这种极低阈值会让后续文件里的普通写请求**随机 429** ——
     回归链变成「看运气」，偶尔红一次还很难定位；
  2. `REDIS_DB=3` 会让后续文件连到限流测试专用的 Redis 库，
     而限流测试在 `afterAll` 里 `flushdb()` —— 可能把别的套件的数据一起清掉。
- **处置**：
  1. 顶层**先快照**原值，再设置限流相关环境变量（保证配置在导入时正确）；
  2. `afterAll` 里**原样恢复**（不存在则 `delete`），杜绝泄漏；
  3. 保留 `REDIS_DB=3` 的隔离设计 —— 限流计数与业务数据分库，互不干扰。
- **补充**：`test/setup.ts` 每个文件都会把 `RATE_LIMIT_ENABLED` 重置为 `'false'`，
  所以该变量原本不会泄漏；但 `REDIS_DB` 等**未被 setup 重置**的变量会 ——
  这也是必须显式恢复的原因。
- **验证（已实测）**：回归链 `--runInBand` 顺序执行下，限流套件之后的
  `pagination`、`contract-routes` 等套件**全绿**，未出现随机 429；
  `REDIS_DB` 未泄漏到后续套件。

### 54. 测试的 `afterAll` 会掩盖 `beforeAll` 的真实失败

- **现象**：18 个集成测试文件的 `afterAll` 都写死了 `await app.close()`。
  一旦 `beforeAll` 失败（连不上库、环境变量不对等），`app` 仍是 `undefined`，
  `afterAll` 就会抛 `TypeError: Cannot read properties of undefined (reading 'close')`，
  **把真正的错误信息顶掉**。
- **实际踩到的例子**：本轮第一次跑新套件时，真实错误是
  `Access denied for user 'nmg'@'172.18.0.7' (using password: YES)`，
  但测试输出里最显眼的是那条 `Cannot read properties of undefined` ——
  **排查方向被带偏**，差点以为是应用代码的问题。
- **处置**：全部改为可选调用 —— `await app?.close()`（限流套件的 `redis?.flushdb()` / `redis?.quit()` 同理），
  保证 `beforeAll` 失败时原始错误能直接暴露。
- **顺带修掉的另一个真实错误**：`rate-limit.e2e-spec.ts` 里把
  `PATCH /me/privacy` 写成了 PATCH，而服务端**只有 `PUT /me/privacy`**
  （`/me/contacts` 才是 PUT/PATCH 双别名）→ 请求 404。
  这是**写测试时凭印象臆测方法名**的典型错误，
  印证了「未覆盖的端点一旦补测，最先暴露的就是调用方对契约的记忆偏差」。
- **验证（已实测）**：修复后首次失败时，输出里**直接就是**
  `Access denied for user 'nmg'@'172.18.0.7' (using password: YES)`，
  不再被 `Cannot read properties of undefined` 顶掉；
  15 套件 / 115 用例全绿。

### 55. 测试基座 `resetDatabase` 漏表 → 「单独跑是绿的，整条回归链跑就红」

- **现象**：新增的 `admin-content.e2e-spec.ts` 单独跑全绿，
  放进完整回归链却报
  `Duplicate entry 'selftest-cat' for key 'article_categories.uk_article_categories_slug'`（500）。
  错误发生在**创建分类**这一步 —— 上一轮运行残留的同名分类还在库里。
- **根因**：`apps/api/test/helpers.ts` 的 `resetDatabase` 用的是**手工维护的表清单**，
  只列了 19 张表，而测试库实际有 **34 张**：
  - 漏掉的业务数据表：`article_categories`、`articles`、`notices`、
    `media_assets`、**`idempotency_records`**（幂等记录跨次残留，
    会让「同键回放」类断言在下一次运行时行为不同）；
  - 另有 10 张是**必须保留**的基座表（字典、权限、角色、管理员账号、迁移记录），
    原本因为没被列进清单而「侥幸」没被清掉。
- **为什么必须根治而不是补一张表**：手工清单**必然还会漏** ——
  每加一张新表都要记得同步清单，漏了就复现同样的偶发失败。
- **处置（两层）**：
  1. **`resetDatabase` 动态化**：表清单改为从 `information_schema` 实时获取，
     并把每张表显式归入 `CLEANED_TABLES`（测试数据）或 `PRESERVED_TABLES`（基座）；
     **出现任何未归类的表直接抛错**，逼人明确表态（fail fast，不静默残留）；
  2. **回归链整库重建**：`test-integration.sh` 的第 1 步从
     「`CREATE DATABASE IF NOT EXISTS` + 跑 seed」改为
     「`DROP DATABASE` + `CREATE` + 迁移 + seed」——
     每次回归都从**确定的基线**开始，而不是在上一轮的残渣上继续。
     护栏不变：库名必须包含 `test`、且不得等于业务库。
- **附带收益**：这类「单跑绿 / 连跑红」的问题是最难查的偶发失败，
  它会让整个回归链的可信度下降 —— 修好之后回归链才真正具备
  **可重复执行**的性质。
- **验证（已实测）**：整库重建后回归链 **10 步 EXIT=0**；
  单独重跑 `admin-content` 套件与整链重跑结果一致（均为 PASS）。

### 56. 私有文件的下载地址可被任意登录用户取走（横向越权，P1 隐私缺陷）

- **现象**：补测上传链路时发现，`GET /uploads/:id/url`
  **只校验登录、不校验文件归属** —— 用户乙可以拿到用户甲的**私有**附件的
  MinIO 预签名下载地址。实测：甲登记私有文件 → 乙请求同一 id → **200**（预期 404）。
- **影响**：
  1. `intent=download` 返回预签名下载地址 → **他人可下载私有附件**；
  2. `intent=upload` 返回**带写入能力的直传地址**（含 HMAC 签名令牌）→
     拿到就等于可以**覆盖**他人私有文件的内容。
- **根因**：`UploadsService.getUploadTarget(assetId, intent)` 拿到 asset 后
  直接返回地址，全流程没有比对 `asset.uploaderId` 与当前用户；
  控制器方法甚至没有注入 `@CurrentUser()`。
- **处置**：
  1. `getUploadTarget` 增加 `requesterId` 参数，
     私有资产要求 `uploaderId === requesterId`，否则抛 **404**
     （与「通讯录未公开资料返回 404」的既有取舍一致，避免用状态码泄露文件是否存在）；
  2. **公开资产**（如资讯封面）不受限制 —— 任何人可取其地址；
  3. 控制器 `url()` 注入 `@CurrentUser()` 并传 `user.id`；
     `createRecord` 内部取直传地址时同样传 `user.id`；
  4. 死代码 `urlFor()` 改为委托给 `getUploadTarget`，避免留下行为不一致的旁路。
- **新增测试**：`uploads.e2e-spec.ts` 覆盖
  「本人取自己的资产 200 / 匿名 401 / **他人取同一资产 404**」。
- **同类自查**：`POST /uploads/:id/content` 是 `@Public()`，
  靠 HMAC 令牌授权 —— 令牌只由资产所有者通过 `uploads/records` 取得，
  修归属校验后这条链路也一并闭合。
- **验证（已实测）**：修复前**他人取私有资产地址返回 200**；修复后 404，用例通过。

### 57. 压测结果产物里残留明文访问令牌

- **现象**：k6 的 `--summary-export` 会把 `setup` 阶段拿到的**访问令牌明文**写进
  结果 JSON 的 `setup_data` 里（`.log` 里也可能出现请求头）。
  这些结果文件位于工作副本的 `tests/concurrency/results/`，
  是**会被归档 / 同步 / 贴进报告**的产物 —— 等于把可用凭据散落在产物中。
  实测在 54 个结果文件里都能读到 `eyJ...` 形态的 JWT。
- **影响**：令牌泄露即可冒用对应账号（压测账号权限较高，directory 场景用的是管理员令牌）。
  产物目录若被同步进代码仓库，凭据会跟着进版本历史。
- **处置**：
  1. 新增 `infra/scripts/redact-loadtest-results.mjs`：递归替换 JSON 里所有
     JWT 形态字符串（含嵌套对象与数组），文本文件走正则替换；
     自带 `--selftest`（造含令牌的样本，断言令牌被替换、无关内容与指标保留）；
  2. `loadtest.sh` 在每个场景跑完后**立即**对该场景的 summary 与 log 脱敏
     —— 不等到整轮结束，避免中间态暴露；
  3. 服务器上已有的 54 个历史结果文件已一次性脱敏，复查无明文令牌残留。
- **补充约定**：**压测 / 测试产物不得留明文凭据**。凡是会被归档或同步的文件，
  都要先过脱敏。
- **验证（已实测）**：自检通过；服务器上 54 个文件脱敏后
  `grep -l "eyJ..."` 无命中。


### 58. 管理端「管理员账号」页真实浏览器里直接崩：返回裸数组且缺 `roles`

- **现象**：管理后台 `/system/admins` 页面在**真实浏览器**里抛
  `TypeError: Cannot read properties of undefined (reading 'length')`，页面白屏。
  该问题在 API 集成测试、静态前端校验、路径一致性校验里**全部是绿的**。
- **根因（两层）**：
  1. `GET /admin/users` 服务端返回**裸数组**，而契约 `AdminUserDto` 与前端
     `fetchAdminUsers` 都声明为 `PageResult`（`{ items, meta }`）——
     前端 `usePagedList` 取 `.items` 得到 `undefined`；
  2. 列表项**没有 `roles` 字段**，前端「角色」列渲染时 `.map` 又会抛 undefined。
- **影响**：整个管理员账号管理页不可用（无法查看、无法新建管理员）。
- **处置**：
  1. `listAdminUsers` 改为返回 `paginate(items, total, page, pageSize)`；
  2. 新增 `rolesOf()`：用 `In` **批量**取角色代码，避免 N+1，输出 `roles: string[]`；
  3. 新增 `AdminUserListQueryDto`（keyword / status），服务端**真正支持**筛选
     ——此前前端在传的 keyword/status 被静默丢弃，筛选框是摆设；
  4. 非法 `status` 返回 400，而不是被忽略。
- **新增测试**：`admin-content.e2e-spec.ts` 断言分页结构、roles 数组、
  keyword/status 筛选生效、非法 status → 400。
- **验证（已实测）**：修复前新路径 201/200/200、旧路径全 404；
  修复后契约 ↔ 服务端 **84 键 ↔ 85 路由 0 差异**，后台 13 个路由真实浏览器冒烟
  **console error 0 / 未捕获异常 0 / 失败请求 0**。

### 59. 管理端校友列表 / 详情：响应字段与筛选参数双双漂移（列是空的、筛选框是摆设）

- **现象**：管理后台「校友管理」页面能正常渲染，但：
  1. **「账号状态」列恒为空** —— 页面读的是 `item.userStatus`，服务端返回的却是 `status`；
  2. 详情抽屉的「认证时间」「资料更新时间」为空，**「账号状态」单选框永远预选「正常」**
     —— 详情接口同样返回 `status` 而不是 `userStatus`；
  3. 详情抽屉的**「身份审核历史」时间线恒为空** —— 契约 `AdminAlumniDetail.verifications`
     是必填字段，服务端**根本没返回**；
  4. 契约 `AlumniProfileDto` 声明为必填的 `intro` / `verifiedAt` / `contactVisible` /
     `updatedAt` 在列表与详情里**全部缺失**；
  5. 页面提供了 6 个筛选条件（关键字 / 学院 / 认证状态 / 账号状态 / 行业 / 毕业年份），
     服务端**只支持 2 个**（关键字、地区），其余 **4 个被静默忽略** ——
     请求照发、状态码 200、结果不受影响。
- **影响**：后台在**核对账号状态、批量清理失效账号**时会被误导：
  看到「状态正常」的用户其实已被停用；按「已认证」筛选得到的仍是全量结果。
- **根因**：服务端响应是**手写对象字面量**，没有与契约 DTO 绑定；
  契约（`AlumniProfileDto` + 后台本地 `AdminAlumniListItem`）与前端页面都按
  `userStatus` 与补齐字段消费，双方从未对过账。
- **处置**：
  1. `directory.service.ts` 的 `adminList` 补齐 `intro` / `verifiedAt` /
     `contactVisible` / `updatedAt`，并把 `status` 改名为契约字段 **`userStatus`**；
  2. `adminDetail` 同样补齐上述字段（含 `userStatus`）；
  3. `AdminAlumniListQueryDto` 增加 `college` / `verified` / `status` /
     `industryCode` / `graduationYear`，`adminList` 逐条落实过滤条件；
  4. `alumniDetail` 合并该用户的认证申请历史，填上 `verifications`；
  5. 前端 mock 数据同步补齐 `userStatus` / `stage` / `verificationStatus`。
- **新增测试**：`response-shape.e2e-spec.ts` 断言「列表项字段齐全」
  与「5 个筛选条件逐个生效」，并断言非法 `status` 返回 400。
- **验证（已实测）**：修复前 4 项字段缺失、5 个筛选条件无效；修复后
  响应结构校验 49 个端点全绿，新增用例 6/6 通过。

### 60. 审计日志缺 `adminName`：后台「操作人」列恒为空

- **现象**：`GET /admin/action-logs` 返回的记录里**没有操作人姓名**，
  而契约 `AdminActionLogDto.adminName` 是必填，后台「操作人」列直接渲染它 → 恒空。
- **影响**：审计日志失去「谁做的」这一关键信息，事后追溯时无法定位责任人。
- **根因**：`admin.controller.ts` 的 `logs()` 只映射了 `adminId`，没有关联管理员表取名称。
- **处置**：`leftJoinAndSelect('log.admin', 'admin')`，输出 `adminName`
  （优先 `displayName`，回退 `username`，再回退「未知管理员」）。
- **新增测试**：`response-shape.e2e-spec.ts` 断言每条审计记录的 `adminName` 是非空字符串。
- **验证（已实测）**：修复前字段缺失；修复后校验通过。

### 61. 资源 / 认证的审核记录缺 `adminName`：审核人姓名恒为空

- **现象**：`ResourcePostDto.reviews[]` 与 `VerificationApplicationDto.reviews[]`
  里的审核记录**没有 `adminName`**，而契约声明为必填。
  后台资源审核页与认证审核页都直接渲染 `review.adminName` → 恒空。
- **影响**：审核轨迹里看不出是谁审的，审核责任链断裂。
- **根因**：`resources.service.ts` / `alumni.service.ts` 的 `toView()` 只映射 `adminId`。
- **处置**：
  1. 两个模块的 `TypeOrmModule.forFeature` 注册 `AdminUser` 实体；
  2. 新增 `adminNames()` 私有方法，**一次 `In` 查询**批量取名称（避免 N+1）；
  3. `toView()` 与认证历史 `history()` 的输出补上 `adminName`。
- **新增测试**：`response-shape.e2e-spec.ts` 断言公开内容列表与管理端认证列表
  的审核记录 `adminName` 非空。
- **验证（已实测）**：修复前字段缺失；修复后校验通过。

### 62. 小程序「编辑资料」保存的联系方式**根本没存进去**（P1 用户可见的数据丢失）

- **现象**：小程序「编辑资料」页把联系方式（手机号 / 微信号 / 邮箱）与档案字段
  **一起提交**，页面提示「资料已更新」——但联系方式**没有保存**，
  重新进入资料页又是空值。
- **影响**：用户以为自己填了联系方式，实际数据丢失；且没有任何报错提示，
  用户会反复填写、反复丢失。
- **根因**：`UpdateProfileDto` **少声明了** `contactPhone` / `contactWechat` /
  `contactEmail` 三个字段，而契约 `UpdateProfileBody` 里是有的。
  全局 ValidationPipe 开了 `whitelist: true`，**未声明的字段被直接剥掉**，
  接口照样返回 200。
- **处置**：
  1. `UpdateProfileDto` 补齐三个字段（沿用 `UpdateContactDto` 的校验规则：
     手机号 ≤ 32 位、微信号 ≤ 64 位、邮箱走 `@IsEmail()`）；
  2. `me.service.updateProfile` 检测到联系方式字段时，**复用 `updateContact`
     的加密写入路径**落库 —— 联系方式仍然只以密文存储（`private_contacts`），
     不引入第二套存储方式。
- **新增测试**：`request-contract.e2e-spec.ts` 断言「保存后能读回」+
  「落库是密文（不含明文）」+「不带联系方式时不清空」+「邮箱非法 → 400」。
- **验证（已实测）**：修复前响应里联系方式为 null 且库中无记录；
  修复后读回一致、库中为密文。

### 63. 管理端 6 个列表页的筛选框全是摆设（14 个参数被静默丢弃）

- **现象**：管理后台的「认证审核 / 资源审核 / 活动管理 / 资讯管理 / 公告管理 /
  审计日志」页面都有搜索框或筛选下拉，**填了没反应**：
  请求照发、状态码 200、返回的还是全量数据。
- **影响**：管理员在几百条记录里定位目标只能靠肉眼翻页；
  误以为「筛选后没有」而做出错误判断（例如以为某条记录不存在）。
- **根因**：服务端 DTO **没有声明**这些查询参数，
  Nest 的 ValidationPipe 把它们从 query 里剥掉，控制器根本收不到。
  客户端（前端页面）确实一直在发这些参数 —— 只是没人对过账。
- **逐条明细**：

  | 端点 | 客户端发送 | 服务端原先支持 |
  |---|---|---|
  | `GET /admin/verifications` | keyword | status |
  | `GET /admin/resources` | keyword | status、type |
  | `GET /admin/events` | keyword、status | 无 |
  | `GET /admin/articles` | keyword、categoryId | status |
  | `GET /admin/notices` | keyword | status |
  | `GET /admin/action-logs` | adminId、action、startDate、endDate | 无 |

- **处置**：
  1. 新增 / 扩展查询 DTO：`AdminEventListQueryDto`、`AdminActionLogQueryDto`，
     并给认证 / 资源 / 资讯 / 公告列表 DTO 补 `keyword`（资讯再补 `categoryId`）；
  2. 各服务的列表查询落实过滤条件
     （认证：申请人姓名 / 学院 / 学号 / 学历；资源：标题 / 正文 / 发布人；
     活动：标题 / 描述 / 类型 + 状态；资讯：标题 / 摘要 + 分类；
     公告：标题 / 正文；审计日志：操作人 / 操作类型 / 起止时间）；
  3. 控制器把新参数透传给服务。
- **新增测试**：`request-contract.e2e-spec.ts` 对 6 个端点逐个断言
  「筛选后结果全部命中条件」。
- **验证（已实测）**：修复前 14 处不一致；修复后请求契约对账 97 个调用点 0 不一致。

### 64. 契约 `UserProfile.role` 与实现不符：普通校友的 role 是 `'alumni'`

- **现象**：契约写的是 `role: AdminRole | null`（5 个管理端角色代码之一），
  但服务端对普通校友返回的是 **`'alumni'`** —— 并不在 `AdminRole` 联合里。
  服务端内部类型一直写的是 `string | null`。
- **影响**：契约比实现**更窄**，任何按契约写代码的人都会以为
  「普通校友的 role 要么是 null、要么是管理端角色」；
  小程序的本地类型副本被迫写成 `string | null`（更宽），**两处事实来源分叉**。
- **处置**：契约改为 `role: string | null`，与实现一致；小程序副本本来就对，不用改。

### 65. 契约 `SessionUser.permissions` 比实现更窄

- **现象**：契约写 `permissions: AdminPermission[]`，
  但会话既可能是管理端（管理员权限点），也可能是普通校友（恒为空数组）；
  服务端内部类型一直是 `string[]`。
- **影响**：契约比实现更窄 → 小程序镜像只能写成更宽的 `string[]` → 事实来源分叉。
- **处置**：契约改为 `permissions: string[]`。
  （管理端自己的 `AdminLoginResult.permissions` 仍保留 `AdminPermission[]`，那是登录响应。）

### 66. 契约 `MeResponse.stage` 比实现更宽

- **现象**：契约写 `stage: string`，服务端实际返回的 stage 就是
  `AlumniStage` 的四个取值之一（guest / logged_in / pending_review / verified），
  小程序镜像已经写成了 `AlumniStage`。
- **影响**：契约更宽 → 镜像更窄 → 事实来源分叉；
  用契约类型写代码时拿不到穷尽性检查。
- **处置**：契约改为 `stage: AlumniStage`。

### 67. 分类「文章数」列恒为空；小程序类型镜像与契约静默分叉

- **现象**：管理后台「资讯管理 → 分类管理」弹窗里的 **「文章数」列永远是空的**；
  同时契约 `ArticleCategoryDto.articleCount` 是**可选字段**，服务端从来没给过。
- **影响**：管理员看不出每个分类下有多少篇资讯，分不清「冷门分类」与「分类没生效」。
- **根因**：`content.service.listCategories()` 只映射了 id/name/slug/sortOrder，
  契约里的 `articleCount` 没有任何地方计算。
- **处置**：
  1. `listCategories()` 增加一次 `GROUP BY` 统计每个分类下的文章数；
  2. 只统计**已发布**文章 —— 草稿数量属于内部信息，公开列表（该端点是公开只读）
     不应泄露；
  3. `createCategory` / `updateCategory` 的返回也补上 `articleCount`，保持形状一致。
- **顺带清理**：前端 `AdminAlumniListItem` 里声明了服务端**从不会返回**的可选字段
  `verificationStatus`（且页面并不使用它）→ 从类型与 mock 中删除，
  避免「客户端以为有这个字段、运行时恒为 undefined」。
- **新增诊断**：响应结构校验器现在会额外报告
  「**所有样本里都没出现过的可选字段**」—— 这类字段即服务端从不给，
  客户端读到的就是恒定的 undefined。
- **新增测试**：`request-contract.e2e-spec.ts` 断言分类列表带 `articleCount`
  且数值 ≥ 已发布文章数。

### 68. 小程序类型镜像与契约分叉（73 个同名类型靠人工同步）

- **现象**：小程序无法在运行时引用工作区包 `@nmg/contracts`，
  在 `apps/miniprogram/src/types/index.ts` **手工镜像**了一份类型
  —— 74 个类型里有 73 个与契约同名。
  镜像一旦滞后，两边就静默分叉：小程序 TypeScript 照样编译通过
  （它用的是自己那份），但运行时按着「以为存在」的字段取值，得到 undefined。
  「契约是唯一事实来源」在这条链路上被悄悄架空。
- **首跑即发现 3 处漂移（都是契约写错了）**：
  | 类型 | 契约 | 镜像 | 真相 |
  |---|---|---|---|
  | `UserProfile.role` | `AdminRole \| null` | `string \| null` | 普通校友的 role 是 `'alumni'`，不在 AdminRole 里 → 契约更窄（#64） |
  | `SessionUser.permissions` | `AdminPermission[]` | `string[]` | 会话可能是普通校友（空数组）→ 契约更窄（#65） |
  | `MeResponse.stage` | `string` | `AlumniStage` | 服务端 stage 就是四个枚举值之一 → 契约更宽（#66） |
- **处置**：
  1. 以**实现为准**修正契约三处（小程序镜像本就正确）；
  2. 新增 `infra/scripts/check-contract-mirror.mjs`：逐类型对比
     interface 的字段集合与可选性、type alias 的类型表达式，漂移即失败；
  3. 反向验证并入前端 / 契约自测（`mirror-type-drift`：给镜像加一个契约没有的字段
     → 必须报 `INTERFACE_DRIFT`）。
- **终态**：73 个同名类型，**漂移 0**。

### 69. 小程序「我的活动」恒空、「我的」页计数恒 0：`/me/events` 返回的不是活动列表

- **现象**：小程序「我的活动」页与「我的报名」页**永远是空的**；
  「我的」页上的「我的活动」计数恒为 0。
- **影响**：用户看不到自己报过的任何活动，也无法确认报名是否成功 ——
  这是报名闭环的最后一环断了。
- **根因**：`GET /me/events` 服务端返回的是**「报名记录数组」**
  （每条含 event 子对象），而契约 `EventDto.myRegistration` 表示的是
  「我在这场活动里的报名状态」，小程序按 `PageResult<EventDto>` 消费
  → `result.items` 是 undefined → 页面恒空；
  `result.meta` 也是 undefined → 「我的」页计数恒 0。
- **处置**：
  1. `eventsService.myRegistrations(userId, page, pageSize)` 改为返回
     **分页的活动列表**（每条 `EventDto.myRegistration` 填上报名状态），
     与契约、其余 `/me/*` 列表端点的形状一致；
  2. 顺带把原来的 **N+1 查询**（每条报名再查一次活动）改成一次 `In` 批量查询；
  3. 活动被删除后残留的报名记录会被过滤掉（不再返回 null 项）。
- **新增测试**：`read-coverage.e2e-spec.ts` 断言「分页结构 + `items[0].myRegistration`
  = registered」。

### 70. 小程序「认证历史」恒空：`/me/verifications` 返回裸数组

- **现象**：小程序「认证历史」「认证进度」页的列表恒为空。
- **根因**：`GET /me/verifications` 返回 `alumniService.mine()` 的**裸数组**，
  而契约与小程序都按 `PageResult<VerificationApplicationDto>` 消费
  → `result.items` 是 undefined → 列表恒空。
- **处置**：
  1. 新增 `alumniService.minePaged(userId, page, pageSize)` 返回分页结构；
  2. `/me/verifications` 改用分页方法并接收 `page` / `pageSize`；
  3. `mine()` 保持数组形态 —— 管理端校友详情里的 `verifications` 字段
     契约上就是数组（`AdminAlumniDetail.verifications`）。
- **新增测试**：`read-coverage.e2e-spec.ts` 断言分页结构自洽。

### 71. 两个权限点被授予角色却无任何端点引用（悬空权限）

- **现象**：`resource:manage` 与 `notification:broadcast` 出现在契约的
  `AdminPermission` 联合、种子的角色授权、以及后台「角色 × 权限矩阵」页面里，
  但服务端**没有任何端点**要求这两个权限 —— 矩阵上写着的能力其实不存在。
- **影响**：管理员会以为「内容管理员」能广播通知（需求基线 §8.2 只要求
  站内通知与事件驱动，**没有**要求管理端广播），实际做不到。
- **处置**：本轮**不删**这两个权限点 —— `notification:broadcast` 是为
  后续接通微信订阅消息预留的；改为让新校验器把「有权限点但无端点引用」
  作为**提示**输出，避免这类悬空能力长期无人察觉。
  需求基线未要求广播功能，因此不新增该端点。

### 72. 管理端校友列表的第三个副本 `GET /alumni`：落在公开路径空间，且 5 个筛选参数是摆设

- **现象**：`GET /alumni` 在 Swagger 里公布了 9 个查询参数
  （`page / pageSize / keyword / stage / regionCode / college / verified / status /
  industryCode / graduationYear`），但 handler 只透传了其中 4 个
  （`keyword / stage / regionCode / page / pageSize`）——
  `college / verified / status / industryCode / graduationYear` **被静默丢弃**：
  传了不报错、状态码 200、结果不受筛选影响。
- **根因（两层）**：
  1. **端点重复**：它是 `GET /admin/alumni`（#59 修复后的完整版）的**第二个副本**，
     两端客户端都没有调用它 —— 唯一的历史调用是集成测试里的一条无用例。
  2. **路径空间错位**：`/alumni` 是**公开路径空间**（`GET /alumni/:id` 是公开名片，
     小程序匿名可读），而 `GET /alumni` 要求 `alumni:view` 权限并返回
     `realName / openid / stage / userStatus` 等管理端字段。
     这与需求基线 `docs/top.md` §4.3 的收敛原则直接冲突 ——
     基线当年正是因为同样的理由把 `/users` 收敛成了 `/admin/users`：
     「会让管理端接口落在公开路径空间，与小程序可匿名读取的公开接口混同」。
- **处置**：
  1. **删除** `AlumniController.list`（`GET /alumni`），
     管理端校友列表统一走 `GET /admin/alumni`（9 个筛选项全部真正生效）；
  2. 契约 `ApiPaths.alumni` 与小程序本地路径镜像同步移除
     （`alumniItem` = `GET /alumni/:id` 公开名片**保留**）；
  3. `docs/API-SPEC.md` §3 端点表删除该行并补注收敛说明；
  4. 集成测试中对应的无用例一并移除（端点覆盖校验要求端点 ↔ 用例一一对应）。
- **新增校验层**：本轮新增 `infra/scripts/check-swagger-param-usage.mjs`
  ——「服务端自己承诺的参数，到底有没有被真正用上」。
  这类缺陷不抛异常，响应结构校验（看返回了什么）与请求契约对账
  （看客户端发了什么）**都查不出来**，必须单独一层：

  | 层级 | 判定 |
  |---|---|
  | 一级 | handler 里出现 `query.<prop>`，或从 query 解构出该字段 |
  | 二级 | handler 把 query **整体透传**给 service → 到 service 方法体继续追踪 |
  | 三级 | service 再整体透传给另一个 service → 再追一层 |
  | 兜底 | 仍追不到 → 记为「无法静态判定」的提示，**不判失败**（避免误报） |

  实测：22 个带查询 DTO 的 handler、84 个声明参数 → 0 不一致；
  删除前是 23 / 94，其中 `GET /alumni` 的 5 个参数被抓出。
- **反向验证**：`infra/scripts/check-swagger-param-usage-selftest.sh`
  注入两类真实缺陷，必须都被抓出且退出码非 0：
  1. `swagger-param-declared-unused` —— DTO 声明一个 handler 从不引用的字段；
  2. `swagger-param-service-drop` —— handler 整体透传，但 service 里那个筛选条件被删掉。
  两个用例分别覆盖一级与二级判定路径，自测脚本自带元自检。

### 73. `PATCH /resources/:id` 静默丢弃 `attachmentMediaIds`：改资源换附件「保存成功」但没换

- **现象**：作者修改自己发布的资源并提交新的附件列表 → 接口返回 200，
  资源标题改了、**附件一个没变**；`resource_post_attachments` 表也没有新记录。
- **根因**：`resourcesService.update()` 只处理 `title / body / industryCode /
  regionCode` 四个字段，**完全没有处理 `attachmentMediaIds`** ——
  而契约 `UpdateResourceBody` 声明了它、Swagger 公布了它、`create()` 也会落库。
  这就是典型的「声明了、公布了、但就是不生效」。
- **发现方式**：Phase 21 新增的**声明参数消费对账**
  （`infra/scripts/check-swagger-param-usage.mjs`）把查询参数与请求体字段
  一并纳入追踪，一跑就报 `DECLARED_PARAM_NOT_USED`。
- **处置**：
  1. `update()` 实现**整体替换**语义：传了列表就用它替换全部附件，
     没传（`undefined`）则保持原样（与同方法里其它字段的 PATCH 语义一致）；
  2. 附件 id 去重（唯一索引是 `(post_id, media_id)`，重复 id 会直接 500）；
  3. 落库前校验附件归属（见 #78）。

### 74. 资源附件字段没有元素级校验：畸形输入直接 500

- **现象**：`POST /resources` 传 `attachmentMediaIds: "abc"` → **500**（不是 400）。
- **根因**：`CreateResourceDto` / `UpdateResourceDto` 的 `attachmentMediaIds`
  只有 `@IsOptional()`，没有 `@IsArray()` / `@IsInt({ each: true })`
  （同一批的认证 DTO `SubmitVerificationDto` 是有完整校验的）。
  畸形值一路穿到 service 里执行 `.map()` → TypeError → 500。
- **⚠️ 更隐蔽的一层**：`ValidationPipe` 开了 `enableImplicitConversion`，
  属性上的 `design:type = Array` 会让 class-transformer 把**任意非数组值**
  静默强转成数组 —— `{ nope: true }` 会被转成**空数组**。
  也就是说：少写 `@Type(() => Number)` 的话，畸形对象会被当成
  「清空全部附件」→ **静默丢数据**，比 500 更糟。
- **处置**：
  1. 三个数组字段（资源的 create/update、认证的 submit/resubmit）统一补齐
     `@IsArray()` / `@ArrayMaxSize(9)` / `@IsInt({ each: true })`；
  2. 补 `@Type(() => Number)`：对象 / 字符串 → `null` → `@IsArray` 失败 → **400**；
     合法数组不受影响（`["3"]` 仍按隐式转换变成 `[3]`，与本仓库其它数字参数的
     既有约定一致）。

### 75. 附件列表的响应结构与契约不符：后台审核页与资源详情页附件区恒空

- **现象**：后台「认证审核」详情抽屉的「证明材料」区、
  「资源审核」详情抽屉的「附件」区，文件名 / 类型 / 大小**全是空白**。
- **根因**：契约声明 `VerificationAttachmentDto[]`（6 个字段）与
  `MediaAssetDto[]`（9 个字段），服务端两处都只返回 `{ id, mediaId }`。
  后台模板渲染的是 `attachment.mimeType` / `attachment.fileName` /
  `formatBytes(attachment.size)` → 全部 undefined。
- **实测证据**：`GET /admin/verifications/1` 返回
  `attachments: [{"id":1,"mediaId":1}]`，而契约要求 `fileName / mimeType /
  size / uploadedAt` 也在里面。
- **为什么一直没被发现**：响应结构校验只看「字段在不在」，而**数组为空时
  元素结构根本不会被校验**；而业务库里 10 条认证附件挂在第 1~10 号申请上，
  列表接口返回的是**最新 50 条**（都没附件）→ 采样永远碰不到有附件的条目。
- **处置**：
  1. 服务端两处都返回完整媒体信息（join `media_assets`）；
  2. 契约新增 `ResourceAttachmentDto`（与 `VerificationAttachmentDto` 同构，
     **不含** `bucket / objectKey / visibility` 等内部存储细节），
     `ResourcePostDto.attachments` 改用它 —— 原先复用 `MediaAssetDto`
     会把对象存储路径暴露给公开读取资源列表的人；
  3. 小程序本地类型镜像同步。

### 76. 响应结构校验器的盲点：空数组 → 元素结构从未被校验（校验器自身的缺陷）

- **现象**：校验器对 `GET /resources`、`GET /admin/verifications` 都判 `[OK]`，
  但契约与实现的形状明显不一致（见 #75）。
- **根因（两层）**：
  1. **数组为空时，元素的类型结构根本没有被校验** —— 遍历空数组自然什么都不查；
  2. **列表只采样前 5 条** —— 而有附件的是排在后面的老记录，
     前 5 条恰好都没附件 → 两层叠加，缺陷被完整掩盖。
- **处置**（校验器自身加固，不掩盖、不误报）：
  1. 采样改为**优先挑「内部含非空数组 / 对象」的条目**，
     让嵌套结构真正被校验到；
  2. 数组为空且元素是**具名类型**时，把该类型记进
     「**元素结构从未被校验**」清单并在输出里点名 ——
     盲点必须被显式报出来，而不是静默通过；
  3. 反向验证：新增合成夹具 `GET_admin_verifications.json` 与两个用例 ——
     `shape-nested-missing-field`（嵌套元素缺字段必须 **FAIL**）、
     `shape-nested-empty-array`（数组全空必须**报出盲点**）；
     响应结构自测由 4 类缺陷增至 **5 类缺陷 + 1 类盲点**。

### 77. 管理员预览用户上传的证明材料 → 404「文件不存在」：审核流程根本走不通

- **现象**：后台「认证审核」详情里点「预览」→ 提示「文件不存在」。
  实测：管理员令牌调 `GET /api/v1/uploads/1/url` → **404**。
- **根因**：私有资产的地址只允许**上传者本人**取
  （`UploadsService.assertOwnership`，这本身是对的），
  而审核员不是上传者 → 永远取不到。
  但「证明材料」存在的意义就是给审核员看 —— 这是**归属语义与审核流程的冲突**。
- **处置**：不放松归属规则，而是**按业务对象鉴权**：
  - 新增 `GET /admin/verifications/:id/attachments/:mediaId/url`
    （需 `verification:review`）与
    `GET /admin/resources/:id/attachments/:mediaId/url`（需 `resource:review`）；
  - 鉴权依据是「该附件**确实挂在**被审核的那个对象上」，而不是资产归属；
    附件不存在或不属于该对象一律 **404**（不泄露存在性）；
  - 后台两个页面改用这两个端点预览。

### 78. 认证 / 资源提交可引用**他人的媒体 id**：跨用户文件泄露的口子

- **现象**：用户 A 可以把用户 B 的 media id 填进自己的资源 / 认证申请。
- **影响**：结合 #77 的管理端预览端点，审核员就能取到 B 的**私有文件** ——
  即「把别人的私有文件挂到自己的申请上，等人来取」。
  另外，引用**不存在**的 media id 会被外键约束打成 **500**。
- **处置**：`resourcesService` / `alumniService` 在落库前校验附件归属：
  媒体必须存在，且 `uploader_id` 必须是当前用户；
  否则 **400**（`附件不存在或不属于当前用户`）。
  同时补上认证重交时的重复 id 去重（唯一索引 `(application_id, media_id)`）。

### 79. 管理端 12 个写接口的请求体**没有任何 DTO 校验**

- **现象**：`POST /admin/events`、`POST /admin/articles`、`POST /admin/notices`、
  `POST|PATCH /admin/users`、`PATCH /admin/users/:id/status`、`PUT /admin/settings`、
  分类的新增/修改 —— 这些端点的请求体写的是 `Record<string, unknown>` 或普通 TS
  `interface`，**运行时 metatype 是 `Object`，ValidationPipe 会完全跳过校验**
  （`toValidate()` 对 Object 返回 false）：
  - `title: {}` 会被 service 里的 `String()` 变成 `"[object Object]"` **直接存进库**；
  - `status: 'bogus'` 一路走到数据库 ENUM 约束 → **500**（而不是 400）；
  - 客户端传了契约之外的字段也不会被剥掉（whitelist 对 Object 无效）。
- **需求基线**：§4.3 明确要求「DTO 校验」「统一错误码」「参数过滤」。
- **处置**：
  1. 新增 12 个请求体 DTO（按领域模块归属，避免循环依赖）：
     `events/dto/event.dto.ts`、`content/dto/content.dto.ts`、
     `admin/dto/admin-body.dto.ts`；
  2. 控制器改用 DTO，service 签名同步为 DTO 类型，并**去掉 `String()` / `Number()` 强转**
     —— 强转只会把畸形输入悄悄变成合法值；
  3. 字段与契约 `packages/contracts/src/api.ts` **一一对应**（不多不少）：
     多一个字段 = 客户端能传服务端不认的东西；少一个 = 客户端传了却被静默剥掉。

### 80. 草稿也带着「发布时间」：`publishNow` 是死参数

- **现象**：新建**草稿**资讯 / 公告后，`publishedAt` 仍然是当前时间 —— 草稿列表里的
  「发布时间」是假的。
- **根因**：`publishedAt: payload.publishNow === false ? null : new Date()`，
  而 `publishNow` **契约里没有、客户端也从没发过**（全仓只有服务端两处引用）
  → 条件恒为 false → 草稿也写入发布时间。
- **处置**：`publishedAt` 只在 `status === 'published'` 时写；
  内容从已发布退回草稿时把 `publishedAt` 清空。

### 81. 角色同步时「不存在的角色编码」被静默忽略，响应却回显请求里的完整列表

- **现象**：`POST /admin/users` 传 `roles: ['alumni_reviewer', 'typo_role']`
  → 库里只挂上 `alumni_reviewer`，但响应返回 `["alumni_reviewer","typo_role"]`
  → 接口「声称」给了一个其实没生效的角色（后台据此显示会误导管理员）。
- **根因**：`syncRoles()` 按编码查角色，查不到就跳过；但响应直接回显了请求列表。
- **处置**：`syncRoles()` 返回**实际生效**的角色编码，响应只回显它；
  更新接口在未提交 `roles` 时回读当前实际角色，而不是返回空数组。

### 82. 布尔查询参数 `'false'` 被当成 `true`：后台「未认证」筛选返回的是已认证名单

- **现象**（线上实测复现）：
  ```
  GET /api/v1/admin/alumni?verified=true    → total=809，全部 verified=true
  GET /api/v1/admin/alumni?verified=false   → total=809，全部 verified=true  ← 同样的结果！
  ```
  后台「认证状态 = 未认证」筛选返回的**全是已认证校友**。
- **根因**：`ValidationPipe` 开着 `enableImplicitConversion`，
  class-transformer 按属性的 `design:type = Boolean` 做隐式强转，
  而它的布尔转换是 **`!!value` 语义** —— 字符串 `'false'` / `'0'` 都会被转成 **true**
  （容器内实测确认：`'false' → true`、`'0' → true`）。
  `@Type(() => Boolean)` 有同样问题，**不可用**；
  自定义 `@Transform` 也来不及 —— 转换发生在自定义 transform **之前**。
- **处置**：
  1. 全局关闭 `enableImplicitConversion`
     （`common/pipes/validation.pipe.ts`），需要转换的地方一律**显式**声明；
  2. 新增 `common/dto/transforms.ts` 的 `@ToBoolean()`：
     `'true'/'1' → true`、`'false'/'0' → false`（在关闭隐式转换后，
     原始字符串能到达 transform，实测正确）；
  3. `AdminAlumniListQueryDto.verified` 与隐私设置的 6 个布尔字段改用 `@ToBoolean()`。
- **连带修好的**（同一个根因）：
  - 字符串字段不再被强转：对象 `{}` 不再变成 `"[object Object]"`（脏数据入库）；
  - 数组字段不再被强转：对象 `{nope:true}` 不再变成**空数组**
    （原本会被当成「清空附件」→ 静默丢数据，见 #74）。

### 83. 后台停用账号时填写的「原因」被静默丢弃

- **现象**：后台「校友管理 → 启用/停用」弹窗里让管理员填写原因，
  点确认后**原因没有留下任何痕迹** —— 审计日志里查不到。
- **根因**：契约 `UpdateUserStatusBody` 声明了 `reason?: string`，
  后台也确实在发（`AlumniView.vue` 的停用弹窗），但服务端
  `setUserStatus()` **根本没读这个字段** —— 请求体里的 `reason` 被直接丢掉。
  （这个死字段是本轮**声明参数消费对账**抓出来的：
  `UpdateUserStatusBodyDto.reason 在 UpdateUserStatusBodyDto 里声明，
  但服务端从未真正使用它`。）
- **处置**：账号状态变更写审计日志 `user.status.change`，
  detail 里带 `from / to / reason`。

### 84. 管理端账号类操作完全没有审计日志

- **现象**：后台「审计日志」页能看到内容审核、活动、资源的操作记录，
  但**管理员账号的变更（新建管理员、改角色、改状态）和普通账号的启停**
  一条记录都没有 —— 最该留痕的一类操作恰好是空白。
- **根因**：`AdminUsersController` 里**没有注入** `admin_action_logs` 仓储，
  也没有写日志的辅助方法（`AdminController` 里有 `log()`，但那是另一个控制器）。
- **处置**：`AdminUsersController` 注入 `AdminActionLog` 并补 `log()` 辅助方法，
  新建 / 更新管理员写 `admin.user.create` / `admin.user.update`，
  账号状态变更写 `user.status.change`。

### 85. 声明参数消费校验器追不到控制器自己的私有方法（校验器自身盲点）

- **现象**：修完 #83 之后，回归链里 `check-swagger-param-usage.mjs` **仍然**报
  `UpdateUserStatusBodyDto.reason 未被消费` —— 可服务端明明用了
  （`setUserStatus()` 里写着 `reason: body.reason ?? null`）。
  校验器把一个**正常实现**判成了缺陷。
- **根因**：校验器只认 `this.<service>.<method>(...)` 这一种调用形态。
  `AdminUsersController` 把 body 整体交给**自己类内的私有方法**
  `this.setUserStatus(actor, id, body)`，追踪链断在私有方法上 → 误判成「声明了但没用」。
- **连带解析坑**：方法返回类型是多行泛型对象字面量
  （`Promise<{ accessToken: string; ... }>`）时，扫描到 `;` 就判定「方法体结束」→
  **整个方法被丢弃**（`AuthService.adminLogin` 正是这样丢的），
  于是 `POST /auth/admin/login` 的 `username` / `password` 一度被误报成未消费。
- **处置**：
  1. 校验器新增「控制器私有方法」追踪（`findOwnMethodCalls`），与 service 调用同权重；
  2. 解析器只在泛型闭合（`angle <= 0`）时才认 `;`；
  3. 判定结果改为聚合：**used > unknown > unused** ——
     只要还有一条路径「判不了」，就不能断言「没用」（避免误报成缺陷）；
  4. 新增反向验证用例 `swagger-param-own-helper-drop`
     （私有方法里删掉字段 → 必须被抓出），自测用例由 2 类增至 **3 类**。
- **影响面**：仅校验器自身，不影响线上功能；但若不修，
  #83 这种「字段确实被用了」的实现会被回归链永久拦下。

### 86. 契约声明了服务端从不接受的请求体字段 `publishedAt`

- **现象**：请求契约对账（客户端发送 ↔ 服务端声明）报出两处不一致：
  ```
  POST /admin/articles  客户端发送了请求体字段 publishedAt，服务端 schema 里没有
  POST /admin/notices   客户端发送了请求体字段 publishedAt，服务端 schema 里没有
  ```
  任何客户端若真按契约填了发布时间，字段会被 `ValidationPipe` 的
  **whitelist 直接剥掉** —— 接口照样 200，但「发布时间」从未生效。
- **根因**：契约 `CreateArticleBody` / `CreateNoticeBody` 里留着 `publishedAt?: string`，
  而服务端**从来就不接**这个字段：发布时间由服务端按 `status` 推导
  （只有 `status === 'published'` 才写，草稿一律 null，见 #80）。
  契约是早期设计的残留，与实现早已分叉。
- **处置**：**以实现为准修正契约** —— 从 `CreateArticleBody` / `CreateNoticeBody`
  移除 `publishedAt`，并在契约注释里写清「发布时间由服务端按 `status` 推导」。
  管理后台从来只**展示**发布时间、从不**发送**它，因此无需改前端代码。

### 87. 响应结构校验器的「元素结构从未被校验」判定条件写反（校验器自身盲点）

- **现象**：#76 给响应结构校验器加了一条提示 —— 数组全空时显式报出
  「元素结构从未被校验」。但实跑下来，报出来的清单**全是假的**：
  ```
  · AdminRole（出现在 GET /admin/roles，所有样本里该数组都是空的）
  · AdminPermission（出现在 GET /admin/permissions，所有样本里该数组都是空的）
  · RegionDto（出现在 GET /system/regions，所有样本里该数组都是空的）
  ```
  现场一查：`GET /admin/roles` 返回 5 条、`/admin/permissions` 返回 12 条、
  `/system/regions` 返回 13 条 —— **数组根本不空**。
- **根因**：`noteEmptyArray()` 的守卫写反了 ——
  `if (!value.length) return;`（数组**空**时直接返回），
  于是登记盲点的恰好是**非空**数组，而真正全空的情况**永远不会被报出来**：
  ```
  // 修之前
  function noteEmptyArray(value, inner, ctx, where) {
    if (!value.length) return;   // ← 空数组反而被跳过
    ...
  }
  ```
  也就是说：**#76 的盲点提示能力从上线起就是失效的**，
  而反向验证用例因为断言太宽（只 grep 提示文案）没能发现。
- **连带**：判定口径还漏了一层 —— 盲点说的是「**元素类型**从未被校验」，
  但原实现按「路径」判定，列表里第 1 条为空、第 2 条有内容时仍会被误报。
- **处置**：
  1. 判定条件改正，并按**元素类型**聚合：
     只有该类型出现过的**每一个**样本都是空数组，才算盲点；
  2. 提示文案改成如实描述（并列出所有出现位置）；
  3. **反向验证补强**：新增「不得报盲点」的断言 `expect_no_note`
     （基线夹具 + `shape-nested-sparse-array`：只有部分条目为空 → 不得报盲点），
     盲点用例改为清空**所有**夹具里的该元素类型 ——
     自测从 5 类缺陷 + 1 类盲点，变为 **5 类缺陷 + 1 类真盲点 + 1 类假盲点拦截**；
  4. 线上盲点清单改为**真实**的 5 个类型（附件 / 审核历史 / 报名列表等），
     并用两件事把它们钉住：
     - 新增集成测试 `nested-element-shape.e2e-spec.ts`（6 例，
       真实数据 + 真实接口，逐字段断言元素结构）；
     - 新增**合成夹具**（`infra/fixtures/response-shape/`），
       让这些嵌套数组**每轮回归都被校验**（线上业务库天然没有这类数据）。
- **影响面**：仅校验器自身，不影响线上功能；
  但不修的话，「元素结构从未被校验」这层保护实际一直是空的。

### 88. 媒体登记接口的请求体没有 DTO 校验

- **现象**（线上实测）：`POST /uploads/records` 收到畸形请求体时返回 **500**，
  而不是 400：
  ```
  { fileName: 123,  mimeType: 'image/png', size: 10 }   → 500
  { fileName: 'a.png', mimeType: 'image/png', size: 'abc' } → 500
  { fileName: 'b.png', mimeType: 'image/png', size: -999 } → 500
  ```
- **根因**：请求体类型是**普通 interface**（`CreateUploadBody`，
  定义在 `uploads.service.ts` 里）→ 运行时 metatype 是 `Object`，
  **ValidationPipe 完全跳过校验**。
  service 里只有手工的 `assertFile()`（非空 + MIME 白名单 + 扩展名白名单 + 上限），
  它**不校验类型**：
  - `fileName: 123` → `filename.lastIndexOf()` → TypeError → 500；
  - `size: 'abc'` → `'abc' > 上限` 为 false → **放行** → 落库时类型转换失败 → 500；
  - `size: -999` → 同样是负数，直接放行；
  - 契约之外的字段（`bucket` / `objectKey`）不被剥掉
    （虽然 service 只读白名单字段、实际风险有限，但「契约外字段被接受」本身就是错的）。
- **处置**：新增 `uploads/dto/upload.dto.ts` 的 `CreateUploadBodyDto`
  （`@IsString/@MaxLength`、`@IsIn(白名单)`、`@Type(() => Number) + @IsInt/@Min(1)/@Max(10MB)`、
  `@IsOptional/@IsIn(['public','private'])`），
  MIME / 扩展名 / 大小上限常量上移到 DTO 文件，service 与 DTO 共用（避免白名单两处漂移）；
  契约补 `CreateUploadBody`（此前契约里**根本没有**这个请求体的定义），
  小程序类型镜像同步。

### 89. 活动报名的请求体没有 DTO 校验

- **现象**（测试库实测）：`POST /events/:id/registrations` 传
  `{ note: { evil: true } }` → **201 Created**，对象被直接塞进 `note` 列。
  契约 `RegisterEventBody` 里 `note` 明明是 `string`。
- **根因**：请求体类型写成**内联对象字面量** `@Body() body: { note?: string }`
  → 运行时 metatype 是 `Object` → ValidationPipe 跳过校验。
- **处置**：新增 `events/dto/event.dto.ts` 的 `RegisterEventBodyDto`
  （`@IsOptional/@IsString/@MaxLength(200)`），控制器与契约字段一一对应。

### 90. 这类问题此前没有自动检查（流程缺口）

- **现象**：#79 只修了**管理端 12 个**写端点，
  媒体登记（#88）与活动报名（#89）两个端点一直漏在网外 ——
  它们不属于管理端，靠人工审查很容易漏掉。
- **处置**：新增第 8 层校验 `infra/scripts/check-request-dto.mjs`：
  扫描**所有**控制器的 `@Body()` 与 `@Query()` 参数，判定其类型在运行时
  是否真的会被校验（内联字面量 / `Record<...>` / `any` / 原始类型 /
  解析不到类定义 / 类里没有任何 class-validator 装饰器 —— 六种情况全部报出），
  并接入回归链第 15 步（自带反向验证，**4 类**注入缺陷必须被抓出：
  `any` / 内联字面量 / 无装饰器 / **查询 DTO 写成交叉类型**）。
  `@Query()` 同样受这条规则约束：交叉类型
  （`PaginationQueryDto & { keyword?: string }`）会让 metatype 退化成 `Object`
  → 参数不校验也不转换（`page` 变 NaN → 列表接口 500）。
  当前基线：**54 个整体请求体 / 查询对象，0 个会被跳过校验**。

### 91. 认证审核的「审核动作」没有枚举校验，非法值返回 409

- **现象**：`POST /admin/verifications/:id/decision` 传
  `{ "action": "bogus-action" }` → 返回 **409 Conflict**；
  而资源审核的同类非法输入 `POST /admin/resources/:id/decision` 返回 **400**。
  同一类「非法参数」，两种错误码。
- **根因**：`VerificationDecisionDto.action` 只有 **TS 联合类型**
  （`'approve' | 'reject' | 'request_changes'`）+ `@IsString()/@Length(4,32)`，
  **没有 `@IsIn`** → 运行时不做枚举校验 → 非法值一路走到 service，
  被 `statusMap[dto.action]` 判空后抛 `ConflictException`。
  TS 的类型标注在运行时**毫无约束力**。
- **影响**：409 的语义是「与当前状态冲突」，用它表达「参数非法」本身就是错的 ——
  客户端按错误码分类处理时会把「参数写错」当成「状态冲突」而重试。
- **处置**：补 `@IsIn(['approve', 'reject', 'request_changes'])` → 非法值直接 400。

### 92. 7 个状态筛选参数没有枚举校验，传错值静默返回空列表

- **现象**：管理端 5 个列表（认证 / 资源 / 资讯 / 公告 / 活动）的 `status` 筛选，
  加上校友列表的 `stage`、联系申请列表的 `status`，
  都写的是 `status?: string`（或只有 TS 联合类型）→ **没有 `@IsIn`**。
  传 `status=bogus` 不报错，直接拿去查库 → 返回**空列表** →
  用户看到「筛选后没有数据」，极易误判成「数据丢了 / 功能坏了」。
  同一批字段里 `userStatus` 却有 `@IsIn` —— 不一致本身就是信号。
- **处置**：7 处全部改为 `@IsIn([...])` + 与契约一致的 TS 联合类型，
  枚举值逐字对齐数据库 ENUM（认证 5 值、资源 6 值、资讯/公告 3 值、活动 4 值、
  stage 3 值、联系申请 5 值）。

### 93. 枚举漂移此前没有自动检查（流程缺口）

- **现象**：#91 / #92 都是「枚举值在四个地方对不上」造成的，
  而四个地方分别住在：数据库迁移、DTO、契约、客户端下拉框。
  人工审查必然漏 —— #92 的 7 处分散在 3 个文件里。
- **处置**：新增**第 9 层校验** `infra/scripts/check-enum-consistency.mjs`：
  - **R1** DTO 的每个 `@IsIn([...])` 列表，必须被**某个**数据库 ENUM 完全包含
    （否则存在「DTO 放行、数据库拒绝」→ 500 的值）；
  - **R2** DTO 里名为 status / action / type / stage / visibility / source /
    level / channel / kind 的字段，**必须**有 `@IsIn`
    （TS 类型标注在运行时无约束力，不能作为「已经校验过」的依据）；
  - **R3** 契约里的枚举联合类型与数据库 ENUM 的关系（提示级，
    部分重叠时提示「多出的值通常表示不落库的状态」）。
  接入回归链**第 16 步**（15 步 → **16 步**），自带反向验证
  （2 类注入缺陷必须被抓出）。当前基线：**22 个数据库 ENUM / 765 个 DTO 字段 /
  13 个契约枚举，0 处漂移**。
  - 自由文本列（`admin_action_logs.action` VARCHAR(64)、`events.kind` VARCHAR(32)）
    走**显式豁免清单**，每条都写明理由，并在每次运行里打印出来。

### 94. 声明参数消费校验器把多行装饰器里的 `enum:` 当成了字段（校验器自身误报）

- **现象**：给 7 个状态筛选补上枚举校验（#92）后，回归链第 7 步直接失败，
  报出 7 处「**查询参数 enum** 在 XxxQueryDto 里声明，但服务端从未真正使用它」——
  而服务端根本没有任何名为 `enum` 的参数。
- **根因**：DTO 字段正则的 `[^;]*` **会跨行匹配**，
  于是多行装饰器里的
  ```ts
  @ApiPropertyOptional({
    enum: ['pending', 'needs_more_material', ...],
    description: '认证状态',
  })
  ```
  里的 `enum:` 被当成了**字段声明**（一路匹配到后面 `status` 的分号），
  把 `enum` 当成属性名。
- **处置**：校验器在解析字段前**先剥掉装饰器**（新增 `stripDecorators()`，
  支持跨行与嵌套括号）；并补一条**防误报**的反向验证用例
  `swagger-param-multiline-decorator`（把装饰器改成多行后，校验器必须仍然 0 误报）。
- **影响面**：仅校验器自身；不修的话，任何按多行写法写 `@ApiPropertyOptional`
  的 DTO 都会让回归链**永久失败**。

### 95. BullMQ 对相同 jobId 的 `add` 直接忽略 → 失败后重投被吞掉，通知永远投不出去

- **现象**：Worker 消费 Outbox 事件失败后，`failed` 处理器把事件状态改回 `pending`，
  dispatcher 随后**再次**把同一个事件投进队列 —— 但队列里什么也没发生：
  `failed` 计数不变、没有任何新任务、**控制台也不报任何错**。
- **根因**：BullMQ 的 `jobId` 是**去重键**。修复前的实现里
  ```ts
  await queue.add('outbox', { outboxId: row.id, notificationId },
    { jobId: `outbox-${row.id}`, ... });   // ← jobId 只含 outboxId
  ```
  同一个 `outboxId` 永远得到同一个 `jobId`，而 `failed` 处理器回退状态时
  **没有递增 `attempts`** → `jobId` 不变 → 第二次 `add` 被 BullMQ **静默忽略**。
  结果：该通知**永远**不会再被投递，而系统看起来一切正常。
- **实测**：worker 容器内（bullmq 5.81.5、Redis db=1、临时队列 `nmg-outbox-selftest`）——
  首次 `add` + 失败后 `failed:1`；第二次用**相同 jobId** 再 `add` → `failed` **仍为 1**，
  任务根本没进队列。
- **处置**：
  1. `jobId` 改为携带 `attempts`：`outbox-${outboxId}-a${attempts}`
     （新增 `buildJobId()`）—— 同一 `attempts` 的重复投递仍被去重（防重复消费），
     失败后 `attempts` 递增 → `jobId` 变化 → 重投能真正进队列；
  2. 回退路径 `markRetry()` 必须 `attempts = attempts + 1`，否则 `jobId` 不会变；
  3. 回退时**只处理 `status = 'pending'`** 的行：已是 `done`/`failed` 的终态事件
     不得被改回 `pending`（否则已送达的通知会被重复投递）；
  4. 超过重试上限（`MAX_DELIVERY_ATTEMPTS = 10`）的事件标记为 `failed`，不再无限重试。
- **涉及文件**：`apps/worker/src/outbox.ts`（新增）、`apps/worker/src/index.ts`（改用）。

### 96. Worker 更新 `notification_deliveries` 不检查 affectedRows → 消息静默丢失

- **现象**：投递记录不存在（或已被改过）时，Worker 仍然把 Outbox 事件标记为 `done`。
  事件状态是「已处理」，但用户**永远收不到这条通知**，且没有任何报错或告警。
- **根因**：修复前的消费逻辑里
  ```ts
  await conn.execute(
    "UPDATE notification_deliveries SET status = 'sent', sent_at = NOW(3) WHERE notification_id = ? AND channel = 'inapp'",
    [notificationId]);
  // ← 没有检查 affectedRows
  await conn.execute("UPDATE outbox_events SET status = 'done' ...", [outboxId]);
  ```
  `UPDATE` 影响 0 行时不会抛错，代码继续把事件标记为 `done`。
- **处置**：`processOutboxJob()` 强制校验 `affectedRows === 1`，
  否则**抛错回滚整个事务**（事件保持未投递状态，进入重试而不是假装成功）；
  同时对 `outbox_events` 的认领也加了 `AND status = 'pending'` 的守卫，
  防止同一事件被并发重复投递。
- **涉及文件**：`apps/worker/src/outbox.ts`。

### 97. dispatcher 对缺 `notificationId` 的事件 `continue` 跳过 → 永远卡在 `pending`

- **现象**：payload 里没有 `notificationId` 的 Outbox 事件**永远停在 `pending`**，
  被 dispatcher 每 2 秒重新扫描一次 —— 既不会被投递，也不会失败，
  数据库里看不到任何「这条事件坏了」的迹象。
- **根因**：修复前的派发逻辑是
  ```ts
  const notificationId = row.payload?.notificationId;
  if (!notificationId) continue;   // ← 直接跳过，状态原封不动
  ```
- **处置**：`dispatchPending()` 对这类**无效事件**显式标记为 `failed`
  （`status='failed'` + `processed_at`），让它可见、可查、可人工处理，
  同时计入 `skipped` 指标，不再被反复扫描。
- **涉及文件**：`apps/worker/src/outbox.ts`。

### 98. Worker 投递链路此前**完全没有**自动检查（流程缺口）

- **现象**：上面三个缺陷能同时存在，是因为**没有任何一层测试经过 Worker**：
  回归链第 1~16 步全部走 HTTP 接口（NestJS + ValidationPipe + TypeORM），
  而 Outbox → 队列 → 投递这段链路是**独立进程 + 独立中间件（BullMQ/Redis）**，
  一个接口测试都覆盖不到。三处静默失败（不抛异常、不影响响应码）因此完全不可见。
- **处置**：新增**回归链第 17 步**「Worker 投递链路自检」——
  在 worker 容器内用**测试库 + 测试 Redis（db=1）+ 独立队列名**真实跑一遍
  「派发 → 消费 → 投递 → 重试 → 终态」全链路（`apps/worker/src/selfcheck.ts`），
  25 项断言，并内含**反向验证**：复刻修复前的实现跑同一场景，
  断言「旧实现确实会静默失败、新实现确实会拦住」。
- **覆盖的断言**：正常路径（sent + done）/ 投递记录缺失必须抛错且不得标 done /
  失败后重投真的再次进队列并被消费 / 重投的 `jobId` 与首次不同 /
  无效 payload 被标记 `failed` / 超过重试上限不再重试 /
  终态事件不被回退成 `pending` / 元自检（BullMQ 同 `jobId` 的第二次 `add` 确实被忽略）。
- **涉及文件**：`apps/worker/src/selfcheck.ts`（新建）、
  `infra/scripts/test-integration.sh`（第 17 步）、`apps/worker/Dockerfile` 无需改动
  （`src/**/*.ts` 已由 `tsc` 编译进 `dist/`）。

### 99. 通知写入不在业务事务内 ——「业务成功但通知丢失」这条保证在实现里并不存在

- **现象**：通知写入失败时，**业务数据已经提交**。
  用户看到 500，但系统里留下了一条「业务已完成、却永远收不到通知」的记录；
  活动报名更严重 —— 名额计数已经被占用，**名额被白白吃掉**。
- **根因**：三份权威文档都要求通知与业务同事务：
  - `docs/top.md` §597：「重要通知采用数据库 Outbox 模式，**先在业务事务中**写入待发送事件」
  - `docs/CONCURRENCY-DESIGN.md` §67：「通知等副作用先写 `outbox_events`（**与业务同事务**）……避免「业务成功但通知丢失」」
  - `docs/ARCHITECTURE.md` §58：「副作用（通知）走 Outbox：**业务事务内**写 `outbox_events`」

  而实现里**8 个通知调用点没有一个在业务事务内**：
  `NotificationService.push()` 的三次写入（notifications / notification_deliveries / outbox_events）
  各自独立提交，且它的注释还写着「与业务同事务，保证「业务成功但通知丢失」不会发生」——
  **注释与事实相反**。最典型的例子是 `events.register()`：
  报名事务先提交，之后才在事务外调 `notifications.push()`。
- **处置**：
  1. `NotificationService.push()` 增加可选的 `EntityManager` 参数：
     传入时三次写入**全部走该事务**；不传时退化为独立提交（并在注释里写明这一后果）；
  2. 6 个业务方法改为「业务写入 + 通知写入」同事务：
     `alumni.submit` / `alumni.decide` / `connections.createRequest` /
     `connections.accept` / `connections.reject` / `events.register` /
     `resources.create` / `resources.review`（共 8 个通知写入点）；
  3. 事务内的仓储访问统一走 `manager.getRepository(...)` ——
     ⚠️ 用默认仓储（`this.xxx`）会走**另一条连接**，写出去就不在事务里了。
- **验证**：新增 `apps/api/test/integration/notification-atomicity.e2e-spec.ts`（6 例），
  用**故障注入**（`jest.spyOn(notifications, 'push').mockRejectedValue(...)`）断言业务写入被整体回滚：
  联系申请 / 活动报名（含名额归还）/ 认证提交 / 资源提交审核。
  **反向验证**：把 `events.register` 临时还原成「通知在事务外」后重跑，
  「活动报名」用例**真的变红**（`registered_count` 停在 1 而不是回到 0）→ 断言有鉴别力，不是恒过。

### 100. 投递失败在数据库里完全不可见（`notification_deliveries` 三个字段从未被写过）

- **现象**：投递失败后，`notification_deliveries` 这一行**一个字段都没变过**：
  `status` 永远是 `'pending'`、`attempts` 永远是 `0`、`last_error` 永远是 `NULL`。
  运维看到的是一条「还在排队中」的投递记录，
  完全看不出它已经失败过多少次、为什么失败 —— 失败被彻底吞掉。
  连 ENUM 里预留的 `'failed'` 值在整个代码里**从未被使用过**。
- **根因**：Worker 只在**成功**时 UPDATE 投递记录一次；
  `failed` 处理器只把 outbox 事件改回 `pending`，对投递记录**一个字都没写**。
- **处置**：
  1. 新增 `recordDeliveryFailure()`：每次失败递增 `attempts` 并写下 `last_error`；
  2. 新增 `markDeliveryFailed()`：超过重试上限时把投递记录标记为 `'failed'`（此前从未使用过的枚举值）；
  3. 成功路径补 `attempts = attempts + 1`、`last_error = NULL`；
  4. 只更新**尚未送达**（`status <> 'sent'`）的记录 ——
     已经送达的投递不能因为后续的重复投递失败而被改成失败状态。
- **残余局限（未消除，如实记录）**：若投递记录本身**不存在**
  （例如通知被删除导致 `notification_deliveries` 级联删除，而 outbox 事件还在），
  失败原因只能落在 `outbox_events.status='failed'` 与 `outbox_events.attempts` 上，
  具体原因留在 Worker 日志（`docker logs nmg-worker`）——
  因为没有行可以写。彻底解决需要给 `outbox_events` 加一列 `last_error`，
  属于**业务库 schema 变更**，本轮未做（见下条）。
- **验证**：回归链第 17 步的 Worker 自检新增 6 项断言
  （失败后 `attempts` 递增、`last_error` 非空、未送达不得被标成 sent、
  超过上限后 `status='failed'` 且留下原因、终态事件不被回退）。

### 101. 写接口失败后幂等键永远卡在 `in_progress`，同一个键再也无法重试

- **现象**：某个写接口返回 4xx/5xx 之后，客户端用**同一个幂等键**重试，
  拿到的不是原本的错误，而是 **409「幂等键正在处理中，请稍后重试」** ——
  重试永远失败，最长持续 24 小时。
  幂等键的本职恰恰是「让重试安全」，失败后反而把重试堵死。
- **根因**：`IdempotencyInterceptor` 的流程是
  「先插一条 `in_progress` 记录 → 执行 handler → 成功后把记录改成 `completed`」。
  `complete()` 只在 **handler 成功返回**时才会执行；
  handler 抛错时（参数校验失败、乐观锁冲突、名额已满……）
  记录**永远停在 `in_progress`**。
  而 `claim()` 的判定只有三种：`completed` → 回放、哈希不同 → 冲突、其余 → 「处理中」。
  `in_progress` 落进第三种 → 409。
  ⚠️ Nest 的执行顺序是「守卫 → 拦截器 → 管道 → handler」，
  所以 **ValidationPipe 的 400 也发生在幂等键被占用之后** —— 一次参数写错就废掉一个键。
- **处置**：handler 抛错时**释放**幂等键（删除该条 `in_progress` 记录），
  让客户端可以用同一个键安全重试；
  同时严格区分「业务失败」与「业务成功但响应存档失败」：
  后者**不释放**记录（否则会重复执行），但仍把成功响应返回给客户端
  （否则客户端以为失败而重试 → 又撞上 409 → 彻底卡住）。
- **涉及文件**：`apps/api/src/common/interceptors/idempotency.interceptor.ts`

### 102. `idempotency_records.expires_at` 只写不读 ——「24 小时有效期」形同虚设

- **现象**：一个已经**过期**的幂等键仍然回放当初的响应，
  而不是重新执行；而且这张表里的记录**永不过期、也不清理**。
- **根因**：`claim()` 写入 `expires_at = now + 24h`，
  但**全代码库没有任何一处读取它**（`grep expires_at` 只命中实体与写入点）。
  于是 `docs/API-SPEC.md` §13 承诺的「同一 (scope, key) **在有效期内**只执行一次」
  里的「有效期」三个字没有落到实现上 —— 实际语义是「**永远**只执行一次」。
  后果不只是回放旧数据：客户端若复用了旧的键，会拿到一份**早已过时的响应**
  （比如指向一个已经被删除或已改动的资源 id）。
- **处置**：`claim()` 发现已有记录**已过期**时，删除旧记录并重新占用 ——
  本次**真正执行**，而不是回放过期响应。
- **残余（未做，如实记录）**：过期记录目前是被**下次用到时**惰性清理的，
  没有任何后台任务定期清理 `idempotency_records` → 长期不被复用的键会一直留在表里。
  要彻底解决需要一个定时清理任务（本轮未做）。

### 103. 幂等冲突返回通用 `CONFLICT`，契约里的 `IDEMPOTENCY_CONFLICT` 是死码

- **现象**：幂等键冲突（409）时，响应里的 `code` 是通用的 `CONFLICT`。
  客户端若按契约判断 `code === 'IDEMPOTENCY_CONFLICT'`，**永远匹配不上**。
- **根因**：拦截器抛的是普通 `ConflictException`，
  被统一异常过滤器按状态码映射成 `ResponseCode.CONFLICT`。
  而 `packages/contracts/src/common.ts` 的 `ErrorCode` 里
  （以及 `apps/api/src/common/constants.ts` 的 `ResponseCode` 里）
  都单独定义了 `IDEMPOTENCY_CONFLICT` ——
  **它在整个代码里从未被任何一处返回过**，是一个死码。
  `docs/CONCURRENCY-DESIGN.md` §66 也写明「请求体哈希不一致返回 `IDEMPOTENCY_CONFLICT`」。
- **处置**：改抛 `new HttpException({ code: ResponseCode.IDEMPOTENCY_CONFLICT, message }, 409)`，
  过滤器会采用 `payload.code`（与限流守卫 `RATE_LIMITED` 的写法一致）；
  并同步把这条语义补进 `docs/API-SPEC.md` 的幂等约定。
- **验证**：新增 `apps/api/test/integration/idempotency-lifecycle.e2e-spec.ts`（4 例），
  覆盖「失败后同键可重试」「过期后真正执行」「冲突错误码」「未过期仍回放（正向对照）」。

### 104. 任何登录用户都能拿到**他人 public 资产**的写入直传地址 → 可覆盖别人的文件

- **现象**：甲登记了一个 public 媒体资源（如资讯封面）。
  乙只要调用 `GET /uploads/{甲的资产id}/url?intent=upload`，
  就能拿到一个**带写入能力**的签名直传地址，
  随后 `POST /uploads/{id}/content?token=...` 即可**把甲的文件覆盖掉**。
  实测：修复前该请求返回 **200**（应为 404），并直接吐出了可用的
  `...?token=<签名>` 写入地址。
- **根因**：`assertOwnership()` 的判定是
  ```ts
  if (asset.visibility === 'public') return;   // ← 公开资产直接放行
  if (requesterId === undefined) return;
  if (asset.uploaderId !== requesterId) throw new NotFoundException('文件不存在');
  ```
  这对**下载**是对的（公开资产任何登录用户都能看），
  但 `intent=upload` 返回的不是下载地址，而是
  `POST /uploads/:id/content?token=...` —— 一个**能覆盖对象**的签名地址。
  **「可读」被当成了「可写」**，于是形成一条横向越权写入。
  ⚠️ 既有测试只覆盖了「他人**私有**资产取**下载**地址 → 404」，
  「他人 **public** 资产取 **upload** 地址」这条路径**从未被验证过**。
- **处置**：`assertOwnership()` 增加 `intent` 维度 ——
  - `intent=download`：公开资产放行，私有资产只允许上传者本人；
  - `intent=upload`：**无论公开还是私有，都只允许上传者本人**
    （直传地址是写入能力，不因「公开可见」而外泄）。
  失败一律 **404**（与既有取舍一致，不通过状态码泄露文件是否存在）。
- **验证**：新增 `apps/api/test/integration/upload-authorization.e2e-spec.ts`（5 例）：
  - 他人对我的 public 资产索取 upload 地址 → **404**（修复前实测 **200**，并返回了可用写入地址）；
  - 用自己资产的令牌改路径去写别人的资产 → **被拒**（令牌与 assetId 绑定）；
  - 对照：甲对自己的 public 资产取 upload 地址 → 200；
  - 对照：乙对甲的 public 资产取**下载**地址 → 200（公开可下载是设计意图，不该被误伤）；
  - 对照：乙对甲的 private 资产取 upload 地址 → 404（原本就正确）。
- **涉及文件**：`apps/api/src/modules/uploads/uploads.service.ts`

### 105. 字段可见开关在通讯录的**检索路径**上完全失效 → 被隐藏的字段仍可被搜出来反推

- **现象**：用户明明把「公开毕业院系 / 所在行业 / 所在地区 / 我的方向」关掉了，
  别人照样能在通讯录里**搜到他** —— 返回的那一行里字段是 `null`，
  但「搜得到」本身就已经把值泄露了。
- **根因**：字段可见开关在**响应**里被尊重，却在**检索**里被无视：
  ```ts
  // 关键字搜索：直接 LIKE 匹配被开关控制的列
  .orWhere('p.college LIKE :keyword', { keyword })
  .orWhere('p.direction LIKE :keyword', { keyword })
  .orWhere('p.intro LIKE :keyword', { keyword })
  .orWhere('region.name LIKE :keyword', { keyword })
  .orWhere('industry.name LIKE :keyword', { keyword });
  // 地区 / 行业筛选：直接按列等值匹配
  qb.andWhere('p.regionCode = :regionCode', { regionCode: query.regionCode });
  ```
  而同一段代码在组装响应时又按开关裁剪：
  ```ts
  college: profile.showCollege ? profile.college : null,
  regionName: profile.showRegion ? (profile.region?.name ?? null) : null,
  ```
  → 开关在**写入侧**生效、在**读取侧**也生效，唯独在**检索侧**失效。
  地区 / 行业筛选更糟：那是**等值匹配**，码表空间很小 → 可以**逐个枚举**。
- **处置**：
  1. 关键字搜索改为**按开关条件化匹配**：
     `p.showCollege = 1 AND p.college LIKE …`（方向 / 地区 / 行业同理）；
  2. `regionCode` / `industryCode` 筛选同样加上对应的开关条件；
  3. `p.intro` **从公开检索中移除** ——
     契约的 `DirectoryEntry` 里**根本没有 `intro`**，
     它对他人从来不可见，拿它当检索键等于提供一个
     「简介内容存在性」的预言机（管理端检索不受影响，管理员本来就看得到）。
  > 原则：**能被搜到的字段，必须是看得到的字段。**
- **反向验证（真实执行）**：修复前跑新增用例，5 条缺陷用例全红
  （隐藏学院 / 方向 / 地区 / 行业 / 简介均被搜出），3 条对照用例全绿
  → 断言有鉴别力，且**没有把发现能力一起关掉**
  （未隐藏学院的人仍可被按学院搜出；姓名与毕业年份的检索始终可用）。
- **涉及文件**：`apps/api/src/modules/directory/directory.service.ts`

### 106. `showDirection` 被用来隐藏「方向」，但用户**没有任何入口能改它**

- **现象**：服务端按 `showDirection` 把 `direction` 从通讯录里裁掉，
  但这个开关**只存在于数据库**（seed 里随机赋值）——
  不在 `UpdatePrivacyDto` 里、不在契约的 `UpdatePrivacyBody` 里、
  小程序隐私页也没有对应开关。
  于是被 seed 随机关掉的用户，方向就**永远**对别人不可见，且**无从恢复**。
  与另外 6 个开关（`showInDirectory` / `showCollege` / `showIndustry` /
  `showRegion` / `acceptContactRequests` / `allowContactShare`）行为不一致。
- **处置**：`showDirection` 补齐为**完整可读写**的一等开关：
  - `UpdatePrivacyDto` 增加 `@ToBoolean() @IsBoolean() showDirection?: boolean`；
  - `MeService.updatePrivacy()` 处理该字段；`toPrivacy()` 返回该字段；
  - 契约 `PrivacySettings` / `UpdatePrivacyBody` 增加 `showDirection`；
  - 小程序类型镜像同步，隐私页增加「公开我的方向」开关。
- **验证**：新增端到端用例 —— 读得到开关 → 改成 `true` → 落库 →
  **别人在通讯录里真的能搜到他**（这条断言把「开关存进去了」和「开关真的起作用」串成一条链）。

### 107. 缺少 `.dockerignore` → 密钥与整仓进入 Docker 构建上下文

- **现象**：服务器仓库里放着 `.env.prod`（MySQL 口令 / `JWT_SECRET` / MinIO 凭据），
  但仓库根目录**没有 `.dockerignore`** ——
  于是 `docker build` 会把**整个仓库**当作构建上下文发送给 Docker 守护进程。
  实测：服务器上 `.env.prod` 确实存在、`.dockerignore` 确实不存在。
- **影响面**：
  - 本部署的守护进程与仓库**同机**，实际泄露面有限（密钥没有离开这台机器）；
  - 但只要换用**远程构建器 / CI**（`DOCKER_HOST` 指向别处、或用 buildx 远程构建），
    这些文件就会被**上传到网络另一端** ——
    「不要把密钥交给构建上下文」不能只靠部署者的自觉；
  - 附带：本机若存在 `node_modules`，pnpm 的**符号链接**会被一起拷进镜像，
    得到指向宿主机的**悬空软链** → 镜像里的依赖是坏的（本地构建必踩）；
  - 附带：`.git`（完整历史）与 `tests/concurrency/results`（压测产物）同样进上下文。
- **处置**：新增 `.dockerignore`，排除：
  `.env` / `.env.*`（保留 `.env.example`）、`.git`、`node_modules`、
  `dist`、`coverage`、`*.tsbuildinfo`、`logs`、`*.log`、
  `tests/concurrency/results`、`.idea` / `.vscode` / `.DS_Store`。
  ⚠️ **刻意不排除** `apps/*/test/` —— 回归链第 4 步要**在 api 容器内**跑 jest，
  测试代码必须留在镜像里（由此产生的另一个问题见 #108）。
- **验证**：三个镜像用新 `.dockerignore` 重建成功；
  镜像内无 `.env` / `.git` 残留；测试代码仍完整在镜像内（29 个集成测试文件）；
  全量回归链 17 步 EXIT=0（证明构建所需文件没有被误排除）。

### 108. 生产镜像携带整套测试代码与开发依赖（**未修**，如实记录）

- **现象**：生产 api / worker 镜像里带着 `apps/api/test/**`（29 个集成测试文件）
  以及 `jest` / `ts-jest` / `ts-node` / `typescript` 等**开发依赖**。
  实测：容器内 `ls /app/apps/api/test/integration` 有 29 个文件，
  `node_modules/.bin` 里存在 `jest` / `ts-jest` / `ts-node`。
- **影响面**：镜像体积与攻击面偏大（含测试夹具与内部实现细节）；
  但**没有把密钥打进镜像**（`.env.prod` 从未被 `COPY` 进任何层）。
- **为什么本轮没修**：当前回归链第 4 步是
  `docker compose exec api … jest …` —— **在 api 容器内**跑测试。
  要剥离测试代码与开发依赖，就必须
  ① 给 api.Dockerfile 拆出一个专供测试的 stage（带 devDependencies 与测试代码），
  ② 在 compose 里加一个指向该 stage 的 `api-test` 服务，
  ③ 把回归链第 4 步改成 `docker compose run --rm api-test jest …`，
  ④ 生产 runtime stage 执行 `pnpm prune --prod` 并删掉 `apps/*/test`。
  这是一次**部署链路的结构性改造**，收益是镜像卫生，
  风险是回归链本身跑不起来 —— 本轮先把 #107 这个零风险的缺口补上，
  这一项留作独立的改造项，不在缺陷修复里顺手改基础设施。

### 109. `VERIFICATION_REQUIRED` 是死码 → 客户端无法区分「没认证」与「没权限」

- **现象**：未完成校友身份认证的用户调用需要认证的接口（如发布资源），
  服务端返回 **403 + `FORBIDDEN`** —— 与「你没有权限」**完全同一个错误码**。
  客户端因此**无法区分**「你还没认证 → 去认证页」和「你无权做这件事」，
  而这是**两种完全不同的用户引导**：
  前者只要去认证就能继续，后者再点多少次都没用。
  小程序里明明有 `pages/me/verify-intro/index` 等认证页面，
  却**没有任何信号**告诉它「该把用户送去认证」。
- **根因**：`AlumniStageGuard` 抛的是普通 `ForbiddenException`，
  被统一异常过滤器按状态码映射成通用的 `FORBIDDEN`。
  契约（`packages/contracts/src/common.ts`）里专门为这个语义定义了
  `VERIFICATION_REQUIRED`，但服务端**从未返回过它**（死码）。
- **处置**：守卫改为抛
  `new HttpException({ code: ResponseCode.VERIFICATION_REQUIRED, message }, 403)` ——
  **HTTP 状态码保持 403 不变**（用户已登录，只是身份阶段不够），
  只把业务错误码换成专用的那一个；
  同时小程序请求层新增 `ApiError.isVerificationRequired`，
  命中时**引导到认证页**（带 5 秒冷却，避免失败风暴时反复跳转）。
- **验证**：新增 `apps/api/test/integration/error-codes.e2e-spec.ts`，
  其中一条**对照用例**保证普通越权（改别人的资源）**仍然是 `FORBIDDEN`** ——
  把所有 403 都改成 `VERIFICATION_REQUIRED` 同样是错的。

### 110. `AUTH_FAILED` 是死码 → 「没带令牌」与「凭据无效」被混为一谈

- **现象**：管理员密码错误、刷新令牌失效、账号被停用，
  一律返回 **401 + `AUTH_REQUIRED`** ——
  和「你压根没带令牌」**完全同一个错误码**。
  客户端看到的是「登录状态已失效，请重新登录」，
  而真实情况是「你的密码错了」—— 用户被引导去做一件没用的事。
- **根因**：认证服务里的凭据类失败全部抛普通 `UnauthorizedException`，
  被过滤器按状态码 401 映射成 `AUTH_REQUIRED`。
  契约里的 `AUTH_FAILED` **从未被返回过**（死码）。
- **处置**：新增 `authFailed()` 工厂，凭据类失败（用户名或密码错误、
  账号被停用、刷新令牌失效、账号不可用）统一抛
  `new HttpException({ code: ResponseCode.AUTH_FAILED, message }, 401)`；
  「没带令牌」仍由 JWT 守卫返回 `AUTH_REQUIRED` —— 两者被明确区分开。

### 111. 契约里的错误码可以从服务端「悄悄消失」（流程缺口）

- **现象**：上面三个死码（`IDEMPOTENCY_CONFLICT` / `VERIFICATION_REQUIRED` /
  `AUTH_FAILED`）能同时长期存在，是因为**没有任何一层检查过**
  「契约声明的错误码，服务端到底会不会返回」。
  响应结构校验看的是**字段**、请求契约对账看的是**参数**、
  端点覆盖看的是**路由** —— 都没有人看**错误码**。
- **处置**：新增**第 10 层校验** `infra/scripts/check-dead-error-code.mjs`：
  - **R1 死错误码**：契约 `ErrorCode` 的每一项，服务端源码里必须能找到引用
    （`ResponseCode.X` 或该字面量）→ 没有就报 `DEAD_ERROR_CODE`（失败）；
  - **R2 契约缺码**：服务端会返回、但契约里没有的码 → 报 `CONTRACT_MISSING_CODE`（失败）；
  - **R3 客户端未消费**：契约里有、客户端代码里从未出现 → **提示**（不判失败）。
  - 非错误码豁免清单（当前只有成功信封业务码 `OK`）**每次运行都打印**，
    避免「悄悄放过」。
- **验证**：自带反向验证 `check-dead-error-code-selftest.sh`，
  注入两类缺陷（`dead-error-code` / `contract-missing-code`），
  断言校验器**退出码非 0 且命中对应判定码**，并有**元自检**
  （「永远返回 0 的假校验器」必须被判失败）。
- **接入**：回归链**第 18 步**。

### 112. 管理员登录名重复 → 500（唯一索引冲突没被当成「输入问题」）

- **现象**：在管理后台新建管理员时，若登录名已存在，
  接口返回 **500 `INTERNAL_ERROR`**。
  登录名重复是**客户端可自行修正**的输入问题（换个名字就行），
  却以「服务端内部错误」的形式抛给前端 ——
  前端只能弹一个「系统错误」，用户完全不知道是哪里重了。
- **根因**：`adminUsers.save(...)` 命中 `uk_admin_users_username` 唯一索引时
  抛出 `QueryFailedError`，而管理端控制器**没有捕获它**，
  于是被统一异常过滤器当成未处理异常 → 500。
- **处置**：捕获 `ER_DUP_ENTRY` 并转成
  `ConflictException('登录名已存在')` → **409 + `CONFLICT`**。
  其它数据库错误仍按原样抛出（不当成 409 吞掉）。

### 113. 管理端「对象不存在」返回 200 + `{error:'NOT_FOUND'}` → 假成功响应

- **现象**：`GET /admin/users/:id`、`PATCH /admin/users/:id`、
  `PATCH|POST /admin/users/:id/status` 在目标不存在时，
  返回 **HTTP 200**，响应体是 `{code:'OK', message:'success', data:{error:'NOT_FOUND'}}`。
  客户端按 `code === 'OK'` 判定成功 → **把「对象不存在」当成了成功处理**：
  管理后台的账号详情页会拿着一个空对象继续渲染，而不是提示「该账号不存在」。
- **根因**：这三个分支是全仓库**唯一**用
  `return { error: 'NOT_FOUND' }` 表达「不存在」的地方；
  其它模块（资源、认证、联系申请、附件）一律 `NotFoundException` → 404。
  这三处属于历史遗留写法，与仓库既有约定不一致。
- **处置**：统一改为 `NotFoundException('…不存在')` → **404 + `NOT_FOUND`**，
  与仓库其余部分一致。

### 114. 管理员账号的「已锁定」是个不存在的值（筛选摆设 + 契约漂移）

- **现象**：管理后台「管理员账号」页的「账号状态」筛选里有一项**已锁定**，
  选中后永远返回**空列表**；契约 `AdminUserDto.status` 也借用了 `UserStatus`
  （含 `'locked'`），等于承诺了一个**服务端永远给不出的值**。
- **根因**：`admin_users.status` 的 ENUM 只有 `('active','disabled')`
  （见 `docs/DATABASE-DESIGN.md` §8），管理员账号**根本没有**「锁定」这个状态
  （只有普通校友账号 `users.status` 才有 `'locked'`）。
  两处都复用了普通账号的状态集合。
  ⚠️ 现有枚举校验器没能抓到它：R1 只要求「DTO 的取值被**某个**数据库 ENUM 包含」，
  而 `['active','disabled','locked']` 恰好被 `users.status` 那个 ENUM 包含 → 判过。
- **处置**：
  - `AdminUserListQueryDto.status` 收紧为 `@IsIn(['active','disabled'])`；
  - 契约 `AdminUserDto.status` 改为 `'active' | 'disabled'`（不再复用 `UserStatus`）；
  - 管理后台「管理员账号」页移除「已锁定」筛选项。
  - 校验器的表绑定盲点另有专项处置（见 #117）。

### 115. 管理端账号/角色/审计日志的多步写没有事务（可留下半成品）

- **现象**：修改管理员时，服务端依次做「改资料 → 同步角色 → 写审计日志」三步写，
  **三步不在同一个事务里**。其中「同步角色」是先 `DELETE` 旧关联、再 `INSERT` 新关联。
  只要中途失败（唯一索引冲突、连接中断、外部异常），
  就会留下**角色已被清空**的半成品账号，而接口已经返回 500，
  管理员无从得知发生了什么 —— 只能进数据库手工救。
  这是缺陷 #99（通知写入不在业务事务内）在**管理端**的同一形态。
- **根因**：控制器直接用注入的默认仓储写数据，
  而默认仓储走的是**另一条连接** —— 即便外面包了 `transaction()`，
  里面的 `save/delete` 也**不在事务内**。
- **处置**：`createAdmin` / `updateAdmin` / `setUserStatus` 全部改为
  `dataSource.transaction(...)`，事务内**一律用 `manager.getRepository(...)`**；
  「资料 + 角色 + 审计日志」同生共死。

### 116. 没有任何保护，管理员可以把自己锁在后台外面

- **现象**：一个管理员可以：
  - 把**自己**停用（`PATCH /admin/users/:id` 传 `status:'disabled'`）；
  - 或把**最后一个**持有 `admin:manage` 的管理员降权（把角色换掉）。
  结果是**再没有任何人能登录后台**（只能进数据库手工救），
  且全程没有任何提示 —— 接口返回 200，一切看起来都很成功。
- **根因**：管理端写路径上**没有任何「最后一个管理员」保护**；
  `check-data-integrity.sh` 的 30 条硬约束里也没有针对管理员的条目，
  即「系统里必须始终留有能管管理员的人」这条不变量**根本没被表达过**。
- **处置**：在 `updateAdmin` 的**事务内、提交前**校验不变量 ——
  「系统里至少存在一个 `status='active'` 且拥有 `admin:manage` 权限的管理员」，
  不满足即 **400 + `VALIDATION_ERROR`** 并整体回滚。
  只在「本次操作真的动了状态或角色」时才校验，
  单纯改显示名不受影响（防止这条规则变成误伤源）。

### 117. 枚举校验器的盲点：DTO 的状态字段没有绑定到具体的表（流程缺口）

- **现象**：#114 里 `AdminUserListQueryDto.status` 放行了 `'locked'`，
  而 `admin_users.status` 的 ENUM 里没有这个值 ——
  枚举一致性校验器却判「一致」。
- **根因**：R1 的判定是「DTO 的取值集合必须被**某个**数据库 ENUM 包含」，
  **不关心这个 DTO 字段对应的是哪张表**。
  只要系统里存在任何一个内容相同的 ENUM（本例是 `users.status`），
  错误绑定就能蒙混过关。同样的盲点对契约侧也成立：
  契约里的**具名类型别名**（如 `UserStatus`）没有被解析，
  也没有绑定到具体表。
- **处置**：见 `docs/TEST-REPORT.md` §2.38 的校验器增强说明 ——
  枚举校验器新增**表绑定**规则（R4）与**契约类型别名解析 + 反向覆盖**规则（R5），
  并配套注入式反向验证。

### 118. 认证「补交材料」是三步写，没有事务（状态机会自相矛盾）

- **现象**：用户补交证明材料时，服务端依次做三件事：
  ① 改申请状态为「已补交」→ ② 挂证明材料 → ③ 把用户阶段改回「待审核」。
  三步**各自提交**，任何一步失败都会留下半成品：
  - 第 ② 步失败 → 申请已经是「已补交」，但**材料没挂上** ——
    审核员看到的是一份**没有材料**的申请，用户以为补交成功（接口却报错）；
  - 第 ③ 步失败 → 申请是「已补交」，但用户阶段还停在旧值 ——
    **用户依然用不了认证功能**，状态机自相矛盾。
  另外，材料归属校验原先放在「改状态」**之后** ——
  材料不合法时接口报错，申请却已经变成「已补交」。
- **根因**：`AlumniVerificationService.resubmit()` 直接用注入的默认仓储写数据，
  没有包事务。同一个服务的 `submit()` 与 `decide()` 都用了事务 ——
  `resubmit` 是**遗漏**，不是有意为之。
- **处置**：
  - 三步写全部进 `dataSource.transaction(...)`，事务内**一律 `manager.getRepository(...)`**；
  - 事务内**重新取一次**申请，以最新状态判定「是否仍需补交」（并发补交时不会互相覆盖）；
  - 材料归属校验**前移到任何写入之前**。

### 119. 个人资料保存是「资料 + 联系方式」两步写，没有事务

- **现象**：小程序「个人资料」页一次提交姓名和手机号：
  服务端先提交资料、再写联系方式（加密落库）。
  第二步失败（加密异常、DB 错误）时，**名字已经改了、手机号没存**，
  而接口返回 500 —— 用户以为什么都没存，实际资料已经改了；
  重试时 `version` 又会 +1，两次提交互相覆盖。
- **根因**：`MeService.updateProfile()` 里 `profiles.save()` 与 `updateContact()`
  是两次独立的提交；`updateContact()` 用的是注入的默认仓储（另一条连接），
  即便外面包了 `transaction()` 也**写不进事务**。
- **处置**：`updateProfile()` 改为 `dataSource.transaction(...)`；
  `updateContact()` 增加可选的 `manager` 参数，事务内用 `manager.getRepository(...)`；
  `requireProfile()` 同样支持传入仓储。

### 120. 资讯/公告详情用「整行 save」实现浏览计数（静默丢失更新）

- **现象**：`GET /articles/:id` 与 `GET /notices/:id` 的浏览计数实现是
  「读出整行 → `view_count += 1` → **整行 `save`** 」。
  于是每次浏览都会把**读到的旧值整行写回**：
  - 并发中的管理端修改（标题 / 正文 / 状态）会被这次浏览**静默覆盖回旧值**
    —— 管理端明明改成功了，一刷新就没了；
  - `updated_at` 被刷新（内容其实**没人改过**），
    `updated_at` 列在迁移里带 `ON UPDATE CURRENT_TIMESTAMP`，任何写都会触发；
  - 每次浏览都写整行（含 `body` 这个 MEDIUMTEXT）。
- **根因**：典型的「读-改-写」竞态 + 写放大；计数这种**与业务数据无关**的字段
  本就不该跟着整行回写。
- **处置**：改成**只动计数列**的原子更新：
  `UPDATE articles SET view_count = view_count + 1, updated_at = updated_at WHERE id = ?`。
  显式写 `updated_at = updated_at` 是关键 ——
  MySQL 在**显式赋值**时不会应用 `ON UPDATE CURRENT_TIMESTAMP`，
  于是「浏览」彻底不产生副作用（计数 +1，其余一列不动）。

### 121. 「多步写没有事务」这一类缺陷，缺乏自动防线（流程缺口）

- **现象**：#99（通知写入不在业务事务内）、#115（管理端账号与角色的多步写）、
  #118（补交材料）、#119（个人资料）—— 四个缺陷**形态完全相同**，
  却是在四个不同模块里被**分四次**挖出来的。
  也就是说：现有 18 步回归链里**没有任何一层**能发现「多步写没进事务」。
- **根因**：多步写的正确性**无法靠静态检查判定**
  （「这次 save 和那次 save 是不是应该同生共死」取决于业务语义），
  但**可以靠故障注入判定**：在中间某一步制造失败，
  断言前面的写入**必须被回滚**。
  仓库里已有这种手法（#99 的通知原子性用例、#115 的账号写入用例），
  但当时是**逐个模块手写**，没有形成统一的做法。
- **处置**：本轮把这套手法收敛成**一个套件**
  （`multi-step-write-atomicity.e2e-spec.ts`）：
  - 注入点统一为「把仓储/服务方法替换成抛错的桩」，
    事务内新建的仓储实例也拦得住（打在**仓储原型**上）；
  - 每条缺陷用例都必须配一条**对照用例**，证明正常路径没被误伤；
  - 每轮都做**容器内回退**：把修复回退成旧行为，确认用例**真的会红**。
- **自动化防线（新增第 11 层校验）**：
  `infra/scripts/check-transaction-escape.mjs` 专治「**包了事务却没写进那个事务**」：
  - **R1（失败）事务逃逸**：事务回调内出现
    `this.<repo>.save/update/delete/insert(...)`、
    `this.<repo>.createQueryBuilder().update/insert/delete(...)`、
    或 `this.dataSource.query('UPDATE …')`
    —— 它们走的是注入仓储的**另一条连接**，会**跳出事务**
    （立刻提交，事务回滚也回滚不掉它），报 `TRANSACTION_ESCAPE`；
  - **R2（提示）多步写候选**：同一个方法里有 2 次以上写入、且方法体内**没有**
    `transaction(` —— 「该不该同生共死」取决于业务语义，静态判不了，
    所以只提示、人工复核；**豁免清单每次运行都打印**，避免悄悄放过
    （当前 2 条豁免都是 if/else 二选一，运行时只会发生一次写）。
  - 接入回归链**第 19 步**，自带反向验证（注入 `tx-escape-in-transaction` /
    `multi-step-no-transaction`）+ 元自检。

### 122. 取消报名时重复回收名额（名额凭空多出来）

- **现象**：活动的真实名额只有一个真相：
  `events.registered_count` 必须等于「当前 `status='registered'` 的报名记录条数」。
  两者一旦不等，容量判定（`registered_count < capacity`）就失真 ——
  表现为**看起来还有名额、实际已经超卖**。
  触发路径：用户**并发**点两次「取消报名」（或取消与别的状态变更竞争）：
  - 第一次取消：`UPDATE event_registrations SET status='cancelled' WHERE status='registered'`
    影响 1 行 → 回收 1 个名额 ✓；
  - 第二次取消（它在外层读取时看到的还是「已报名」）：
    条件更新**影响 0 行**，但代码**没有检查影响行数**，仍然继续执行
    `registered_count = registered_count - 1` → **名额被多回收一个** ✗。
- **根因**：`EventsService.cancel()` 里两个条件更新都**没有校验 affectedRows**。
  外层那次 `findOne` 发生在**事务之外**，到事务里执行时状态可能已经变了。
  设计文档（`docs/CONCURRENCY-DESIGN.md` §1.3）承诺「取消报名与其他报名请求竞争」
  要用条件更新解决 —— 条件更新做了，但**影响行数没看**。
- **处置**：条件更新影响 0 行 → 说明**这次取消没有真正生效**
  → **不再回收名额**，并如实返回幂等（读一下当前状态决定 `cancelled` 的取值）。
- **验证**：新增 `apps/api/test/integration/event-capacity-accounting.e2e-spec.ts`，
  注入「并发取消」后断言 `registered_count` 仍等于有效报名条数；
  另有两条**对照用例**（正常取消回收一次、连续取消两次只回收一次）。

### 123. 管理端可把活动人数上限改到小于已报名人数

- **现象**：管理后台把活动人数上限改成小于当前已报名人数时，接口返回 **200**，
  活动进入「报名人数 > 上限」的不可能状态：
  已报名的人超出了上限，而后续报名又被 `registered_count < capacity` 拦住 ——
  活动永远卡在这个自相矛盾的状态里，**而且没有任何地方会报这个错**。
  管理端表单只校验「不小于 0 的整数」（0 表示不限），不感知已报名人数。
- **根因**：`EventsService.update()` 直接 `event.capacity = payload.capacity`，
  没有对照当前 `registered_count`；数据完整性校验器里也**没有**这条不变量。
- **处置**：容量改为正数且小于当前已报名人数时 → **400 + `VALIDATION_ERROR`**；
  `capacity = 0`（不限）不参与比较。
- **防线**：数据完整性校验器新增两条**永久约束**（业务库只读，每日可跑）：
  - **C8 活动已报名计数与实际报名记录数不一致** → 必须为 0；
  - **C9 活动人数上限小于当前已报名人数** → 必须为 0。

### 124. 标记通知已读：不存在也返回「已读」（假成功）

- **现象**：同一个模块里，两个端点对**同一个对象**给出**相反的语义**：
  - `GET /notifications/:id` → 通知不存在 → **404 NOT_FOUND** ✓
  - `POST /notifications/:id/read` → 通知不存在 → **200 `{id, read:true}`** ✗
  客户端（小程序「消息」页）按 2xx 判定成功，于是**把「操作失败」当成「已读」**；
  而如果 id 填的是**别人的**通知，接口同样返回「已读」——
  用户以为标记成功，实际什么都没发生（对方的通知也**不会被**改动，条件里带了 userId ✓）。
- **根因**：标记已读用的是条件更新 `WHERE id = :id AND userId = :userId`，
  但**没有看影响行数** —— 影响 0 行（不存在 / 不是你的）也照样返回成功。
  这是 #122 同一形态的另一个实例：**条件更新必须检查 affectedRows**。
- **处置**：逻辑收敛到 `NotificationService.markRead()`，
  由它判断影响行数：影响 0 行时再查一次存在性，
  确实不存在 → **404 + `NOT_FOUND`**（与 GET 端点一致，且不泄露他人通知是否存在）；
  已读通知重复标记仍返回 **200**（幂等）。

### 125. 「标记已读」被实现了两遍，其中一份是死代码

- **现象**：`NotificationsController.markRead()` 里**自己实现**了一遍条件更新，
  而 `NotificationService.markRead()` 里还有一份**从未被调用**的同名实现。
  两份实现迟早漂移 —— 事实上 #124 就是只在**控制器那份**里发生的：
  服务端那份同样不检查影响行数，却因为没人调用而一直「看起来没问题」。
- **根因**：业务逻辑写在控制器里，而 service 里又留了一份。
  本仓库反复出现的形态（#81 / #113 / #124 同源）：**两份实现 = 两套语义**。
- **处置**：删除控制器里的重复实现，统一调用 service；
  service 负责判定影响行数并抛出 404。

### 126. 「不创建资源」的 POST 端点一律返回 201 Created（7 处）

- **现象**：HTTP 规范里 **201 Created** 的含义是「本次请求**创建了**新资源」，
  且**应当**带 `Location` 头指向它。而仓库里有一批 POST 端点**根本不创建任何资源**，
  只是「改一个状态」，却都返回了 **201**（Nest 对 POST 的默认值，从没人改过）：

  | 端点 | 实际做的事 | 修复前 |
  |---|---|---|
  | `POST /notifications/:id/read` | 标记已读 | 201 |
  | `POST /notifications/read-all` | 全部已读 | 201 |
  | `POST /connections/requests/:id/reject` | 拒绝申请 | 201 |
  | `POST /connections/requests/:id/cancel` | 撤回申请 | 201 |
  | `POST /resources/:id/submit` | 提交审核 | 201 |
  | `POST /resources/:id/withdraw` | 撤回发布 | 201 |
  | `POST /admin/users/:id/status` | 启用/停用账号 | 201 |

  最刺眼的一处是最后一条：它是 `PATCH /admin/users/:id/status` 的**兼容别名**
  （API-SPEC 明写「建议改用 PATCH」），却和 PATCH 版本返回**不同的状态码**
  （POST 201 / PATCH 200）—— 同一个操作、两条路径、两种答案。
- **根因**：Nest 的 POST 默认状态码是 201，而「默认」不等于「正确」。
  仓库**自己已有正确做法**：活动报名**第一次** 201、**幂等命中** 200，是显式设置的
  —— 说明「只有真的创建了资源才 201」是本仓库的既定约定，这批端点只是没跟上。
- **处置**：这 7 个端点全部加 `@HttpCode(HttpStatus.OK)` → **200**；
  真正创建资源的 POST 端点（认证申请、联系申请、活动报名、管理端创建…）**保持 201**。
- **验证**：新增 `apps/api/test/integration/http-status-semantics.e2e-spec.ts`，
  既钉住这 7 个端点必须是 200，也**钉住创建型端点必须仍然是 201**（防误伤）。

### 127. 测试夹具的「关外键检查」是会话级的，却用在了会换连接的调用上

- **现象**：`resetDatabase()` 重置测试库时用 `dataSource.query('SET FOREIGN_KEY_CHECKS = 0')`
  关掉外键检查，再逐张 `TRUNCATE`。
  但 `SET FOREIGN_KEY_CHECKS` 是**会话级变量**，而 `dataSource.query()` 每次调用
  都可能从连接池里**换一条连接** —— 于是 `TRUNCATE` 可能落到一条
  `FOREIGN_KEY_CHECKS=1` 的连接上，报
  `Cannot truncate a table referenced in a foreign key constraint`。
- **根因**：把「会话状态」当成了「全局状态」。
  池化连接下，「设变量」与「用变量」必须落在**同一条连接**上才成立。
- **处置**：整段重置改用**一条专用连接**（`dataSource.createQueryRunner()`），
  `SET FOREIGN_KEY_CHECKS` 与全部 `TRUNCATE` 在同一会话内完成；
  并在重置前先 `ROLLBACK`，清掉这条连接上可能残留的事务。
- **影响面**：只影响集成测试夹具，**不影响生产代码**（生产代码没有「先关外键检查再批量清表」的写法）。

### 128. 跨用例残留事务：间歇性的「表定义已变」与死锁

- **现象**：回归链第 4 步偶发失败，报两类错：
  - `Table definition has changed, please retry transaction`
  - `Deadlock found when trying to get lock`（发生在 `INSERT INTO users` 上），
    随后伴随 `verification_applications` 的外键约束失败。
  单独跑那个套件是**绿的**，只有整条链跑才红 —— 本仓库最难查的一类失败形态。
- **机制**：这两条错是**同一件事**的两面。一个连接若带着**未提交事务**回到池里：
  1) 它的读视图早于 `TRUNCATE` → 之后读该表报「表定义已变」；
  2) 它持有的**间隙锁**会让并发 `INSERT` 与它互等 → 死锁。
  被它插进来的外键行随即失败（父行随事务回滚消失）→ 外键约束失败。
- **处置**：
  - 夹具侧：重置前先 `ROLLBACK` 本连接；重置前**点名**测试库里仍开着的事务
    （`information_schema.innodb_trx`；无 PROCESS 权限时静默跳过）；
  - 夹具侧：每个套件 `app.close()` 前再做一次同样的点名，**当场**指出是哪个套件泄漏；
  - 回归链侧：第 4 步结束后用 root 检查测试库残留事务数，**不为 0 直接失败**，
    不让它悄悄污染下一轮。
- **诚实说明**：间隙锁 + 残留事务这条**机制链已被探针实测复现**
  （子表外键失败的 errno 1452 与约束名与 chain44 **完全一致**；
  并发插入按定时序报 1213 死锁或 1205 锁等待超时，同属一族），
  但**泄漏事务的具体来源用例尚未定位到**（连续两轮全量回归未再复现）。
  因此当前的处置是「**让污染无处藏身 + 让它一出现就叫名**」，
  而不是「已修好泄漏点」。
- **Phase 41 的进展（仍不宣称「已定位」）**：
  - 夹具改用 **DELETE 重置**（见 #138）后，「读视图早于 DDL」这个**触发条件本身没了**
    → 这条机制链的第一环被拆掉；
  - 回归链第 4 步的「残留事务数 = 0」断言已**连续五轮**（chain50 ~ chain54）通过，
    且套件级的「点名」诊断（`reportLeftoverTransactions`）**一次都没有报出**泄漏事务；
  - 但**「泄漏事务来自哪个用例」仍然没有定位到** —— 没有症状就没有线索，
    只能等它再次出现。若再次出现，套件名会随诊断一起打印（夹具已带当前用例文件名）。
  - 临时给测试库账号授予的 `PROCESS` 权限（调查所需）**已撤销**；
    没有该权限时诊断**静默跳过**（不影响测试），权威检查仍由回归链用 root 承担。

### 129. 改了 HTTP 语义，却漏改既有测试的状态码断言

- **现象**：#126 把 7 个「不创建资源」的 POST 端点从 **201** 改成 **200**，
  但既有的 `notifications.e2e-spec.ts` 仍在断言 **201** ——
  那批用例在服务端改完的那一刻就失效了，却直到下一次全量回归才暴露，
  而且报错的套件（notifications）**离改动点很远**（改的是 notifications 控制器本身，
  但红的是另一个文件里的同一批端点）。
- **根因**：改服务端语义时，**测试文件通常不在改动清单里** ——
  没人会想到去翻测试；而这类漂移在「没人跑那批测试」时会静静烂在那里。
- **处置**：同步更新 `notifications.e2e-spec.ts` 的三处断言
  （标记已读 201→200、标记他人通知 201→**404**（#124 语义）、全部已读 201→200），
  并**新增第 12 层校验**把这类漂移变成可自动发现的问题（见 #130）。

### 130. 流程缺口：没有「服务端状态码 ⟷ 测试断言」的对账层

- **现象**：#129 这类漂移靠人眼是**必然漏掉**的 ——
  改服务端的 `@HttpCode` 时，没有任何工具会提示「有三个测试文件在断言旧的状态码」。
- **处置**：新增**第 12 层校验** `infra/scripts/check-status-code-assertions.mjs`：
  - 解析**控制器**声明的成功状态码（`@HttpCode` 优先，POST 默认 201，其余默认 200）；
  - 解析**集成测试**里的 `.expect(NNN)` 断言（按请求链归属，路径参数名统一规范化）；
  - 对账：服务端声明 200 而测试断言 201 → **失败**（语义变了、测试没跟上）；
    服务端声明 201 而测试断言 200 → **提示**（常见于「幂等回放返回 200」，不判失败）；
    4xx / 5xx 断言 → 不在本层范围（错误语义由响应结构校验器负责）。
- **反向验证**：`check-status-code-assertions-selftest.sh`，
  注入 `status-code-assertion-stale`（把通知断言改回 201）→ 必须命中
  `STATUS_ASSERTION_MISMATCH` 且退出码非 0；基线必须无漂移（防误报）；
  另含元自检（恒过的校验器被判失败）。
- **现状**：服务端端点 107 个、测试状态码断言 485 条，**0 处漂移**，
  3 条提示全部是仓库既有的幂等回放约定（联系申请 / 活动报名 / 资源发布）。
- **接入**：回归链**第 20 步**。

### 131. 资源「修改」：附件归属校验排在内容写入**之后** → 400 却已经把内容改了

- **现象**：`PATCH /resources/:id` 带着**别人的** mediaId 时，服务端返回
  **400「附件不存在或不属于当前用户」**；但**资源其实已经被改了**
  （标题、正文、`version`、状态全部变化）。
- **根因**：`ResourcesService.update()` 的顺序是
  「写内容 → 校验附件归属 → 换附件」。
  校验排在写入之后，失败时**前面的写已经提交**。
  这与 #118（材料归属校验排在写入之后）是同源问题，
  但发生在**另一个模块**（资源）—— 说明「校验必须先于写入」这条规矩没被普遍执行。
- **后果**：客户端拿到 400 会以为「什么都没发生」，
  而服务端已经把内容改了（还可能把已发布内容打回 `pending`、`version+1`）——
  **请求被拒却留下副作用**，是极难排查的一类问题。
- **处置**：附件归属校验**前移到任何写入之前**；
  校验通过后才进事务做「内容写入 + 附件整体替换」。

### 132. 资源「修改」：内容写入与附件整体替换**没有事务** → 留下半成品

- **现象**：附件那一步写库失败时（注入故障实测），
  **内容写入已经提交** —— 留下一份「内容是新的、附件是旧的（甚至被删空了）」的半成品，
  接口返回 500。
- **根因**：`update()` 的两个写各自提交：
  `this.posts.save(post)` 与 `replaceAttachments()`（先 `delete` 全部旧附件，再 `save` 新附件）。
  而**同一个模块**的 `create()` 早就用事务把「内容 + 附件 + 通知」包起来了 ——
  同一个模块，两种写法。
- **处置**：整段修改进 `dataSource.transaction(...)`，
  事务内用 `manager.getRepository(...)` 重取并写；
  附件替换也走同一个 manager（`replaceAttachments(postId, mediaIds, manager)`）。
- **配套**：新增 `apps/api/test/integration/resource-update-atomicity.e2e-spec.ts`（4 例，含 2 条对照）。

### 133. 流程缺口：事务校验器的 R2 看不见「跨方法的多步写」

- **现象**：第 11 层校验器（`check-transaction-escape.mjs`）的 R2 规则
  「同一方法里有 2 次以上写入且没有事务」**抓不到 #132** ——
  因为那两次写**分散在不同方法**里：
  `update()` 自己写一次内容，再调 `replaceAttachments()` 写一次附件。
- **根因**：R2 的写操作识别只认 `this.<repo>.save(...)` 这种**直接写法**，
  而 `replaceAttachments()` 里的两次写用的是**局部别名**
  （`const attachments = manager.getRepository(X)` 后的 `attachments.save(...)`）；
  方法识别也只认「缩进 2 空格 + 名字 + 单行签名」，
  于是 `private async replaceAttachments(`（**跨行签名**）压根没被当成方法。
- **处置**：新增 **R3（提示级）「跨方法的多步写」**：
  - 写操作识别扩展到**局部别名**；
  - 方法识别扩展到 `private` 修饰与**跨行签名**；
  - 命中条件：方法自己有写、又调用同类里**会写库**的其它方法、且方法内没有事务。
- **反向验证**：`check-transaction-escape-selftest.sh` 新增第 4 个用例
  （注入 `multi-step-across-methods`，把 `update()` 回退成修复前形态）
  → 必须命中 `MULTI_STEP_WRITE_ACROSS_METHODS`；基线必须无该提示（防误报）。
- **效果**：修复前点名 `resources.service.ts · update`；修复后该提示**自动消失**。

### 134. 管理端 11 处写操作：「业务写 + 审计日志」没有同事务

- **现象**：管理端所有写接口都是「先改业务数据，再写 `admin_action_logs` 审计日志」两步，
  **没有事务**。审计日志写失败时：
  - 业务改动**已经提交**，接口却返回 **500**（管理端以为失败 → 重试 → 业务被改两次）；
  - 而且**这条操作没有审计记录**，事后无法追溯。
- **范围**（`admin.controller.ts` 共 11 处）：
  `verification.decision`、`resource.decision`、`event.create/update/delete`、
  `article.create/update/delete`、`notice.create/update/delete`。
- **实测（修复前，注入「审计日志写失败」）**：
  - `POST /admin/events` → 500，但 `events` 表里**活动已经建出来了**；
  - `DELETE /admin/notices/:id` → 500，但公告**已经被删掉了**。
- **处置**：
  - 相关 service 方法（活动 3 个、内容 6 个、两个 `decide`）都接受**可选的 `manager`**；
    两个 `decide` 原来自带事务，改成「有外部 manager 就加入外部事务，否则自己开事务」；
  - 控制器里 11 个写端点统一包进 `this.dataSource.transaction(...)`，
    业务写与 `log()` 用**同一个 manager**；
  - `log()` 增加可选 `manager` 参数。
- **配套**：新增 `apps/api/test/integration/admin-audit-atomicity.e2e-spec.ts`（4 例，含 2 条对照），
  容器内回退 → **2 条真红、2 条对照组真绿**。
- **效果**：第 11 层校验器的 R3 提示（`admin.controller.ts · updateEvent`）**自动消失**。

### 135. 校验器 R1 把「把 manager 传下去的服务调用」误判为事务逃逸

- **现象**：#134 修复后，控制器里出现了
  `this.eventsService.update(id, body, manager)` —— 服务方法**接受并使用了**事务的 manager，
  根本不逃逸；但 R1 规则只看「事务回调里出现了 `this.xxx.<写方法>()`」，
  于是把它**误报**成事务逃逸（退出码非 0，会直接卡住回归链）。
- **根因**：R1 把「`this.<something>.<write>()`」一律当成「注入仓储写入」，
  分不清**仓储**（`this.posts.save`）与**服务**（`this.eventsService.update`），
  也看不出服务方法**接不接受**事务的 manager。
- **处置**：R1 增加一条判据 —— 若这次调用的**实参里带了事务的 manager**，
  则被调方可以加入同一个事务，**不算逃逸**（实参解析做了括号配对，跳过字符串）。
- **双向断言**：
  - 真逃逸仍被抓到（`tx-escape-in-transaction`：事务里 `this.applications.save(...)`，
    **不**传 manager → 退出码 1）；
  - 传 manager 的调用**不得**被抓到（基线里控制器就有 11 处这种调用 →
    基线退出码必须为 0，否则就是误报）。

### 136. 校验器自身的三个盲点（都被这次的实战撞出来了）

- **现象**：Phase 40 的重构把回归链第 19 步的**反向验证**打挂了 ——
  注入用例找不到目标模式（实现一变写法，注入就失配）；
  修好之后又冒出**两类误报**（事务感知的方法被判「无事务多步写」）。
- **三个盲点与处置**：
  1. **R2 不认局部别名的写**（`const articles = …` 后的 `articles.save(...)`）
     → R2/R3 统一改用同一套写操作识别（认 `this.x.write` **和**局部别名）；
  2. **事务感知的方法被误判**（`syncRoles(manager, …)`、`replaceAttachments(…, manager?)`
     这类方法由**调用方**开事务，自己不需要再开）
     → 新增「事务感知」判定（签名收 EntityManager 且写走那个 manager）→ 不再当候选；
  3. **注入点依赖现有代码的形状** → 注入用例改为**新增一个文件**，
     不再改现有代码（实现怎么演进都能注入）。
- **顺带新增 R4（提示级）**：事务感知的方法里出现 `this.<repo>.<write>(`
  → 那次写**不在调用方的事务里**，事务回滚回滚不掉它 → 必须点名。
  这正是 #134 修复过程中最容易引入的形态。
- **反向验证**：自测从 4 例扩到 **5 例**
  （新增注入 `transaction-aware-bypass`），基线仍必须无逃逸、无误报。

### 137. 「先查后插」在并发下撞唯一键（两处）

- **形态**：
  ```ts
  const existing = await this.repo.findOne({ where: { ... } });
  if (existing) { /* 改并保存 */ } else { await this.repo.save(this.repo.create({ ... })); }
  ```
  单线程下「只发生一次写」没问题；**并发**下两个请求都读不到既有行，
  于是都去 INSERT → 后到的那一个撞唯一键 → 500。
- **两处命中**：
  - `ConnectionsService.setContactGrant()` → `contact_share_grants` 的唯一索引
    `uk_contact_grant (pair_id, user_id)`；
  - `ContentService.upsertSetting()` → `system_settings.key` 是**主键**。
- **现实场景**：同一用户在两台设备同时打开「联系方式授权」开关；
  两个管理员同时保存同一条系统设置。
- **处置**：两处都改成「捕获 `ER_DUP_ENTRY`（errno 1062）→ 重新读出既有行 → **改为更新**」，
  而不是甩 500 给用户（与仓库既有的 `isDuplicateKey()` 模式一致）。
- **配套**：新增 `apps/api/test/integration/concurrent-upsert.e2e-spec.ts`（3 例，含 1 条对照）。
  用例用**两段式屏障**（都到达 → 都读完 → 才放行去写）把并发窗口放大到**必现**：
  - 单纯加固定延时会让两个请求**错开** → 先到的请求 INSERT 并提交 → 后到的读到行 → 走更新分支 →
    **撞不出冲突**，表现为两个 200 的**假通过**；
  - 只做「同时开始读」的屏障也不够 → 先读到的那次可能一路冲到 INSERT 并提交，
    后一次 SELECT 就读到了行 → 同样撞不出冲突。
- **反向验证**：未修代码上稳定复现 **500**
  （`Duplicate entry '9-21' for key 'contact_share_grants.uk_contact_grant'` /
  `Duplicate entry 'concurrency_probe_setting' for key 'system_settings.PRIMARY'`）；
  修复版 **3/3 全绿**。

### 138. 测试夹具用 TRUNCATE 重置的三个脆弱点

- **现象与根因**：
  1. **DDL 慢**：这台服务器上 DDL 延迟在 **2~30 秒/条**之间剧烈波动
     （实测 `TRUNCATE` 30s、`ALTER COMMENT` 9.4s、`RENAME TABLE` 15s），
     一次重置 25 张表可能要好几分钟，整条回归链被拖成小时级；
  2. **让其它事务的读视图失效**：`TRUNCATE` 是 DDL → 其它连接上的事务之后再读该表会报
     `Table definition has changed`（缺陷 #128 的症状来源）；
  3. **复位了自增计数器** → 掩盖了真实缺陷（见 #139）。
- **处置**：夹具 `resetDatabase()` 改用**单事务 DELETE（DML）**：
  一条专用 QueryRunner → 先 `ROLLBACK` 清掉这条连接上的残留事务 →
  `FOREIGN_KEY_CHECKS=0`（**会话级变量，必须与 DELETE 同连接**）→ 一个事务里逐表 DELETE → 提交。
- **副作用（已知且已确认）**：`AUTO_INCREMENT` 不再复位，各表 id 在整轮测试中持续增长。
  唯一一处测试硬编码 id 的地方已修（`admin-audit-atomicity` 删公告用例改用创建返回的 id）。
- **附带收获**：不再复位自增计数器，反而把 #139 这类「**靠巧合通过**」的断言给炸了出来。

### 139. `notification.push()` 丢弃 `options.aggregateId`，Outbox 的 aggregate_id 指向错对象

- **现象**：库里出现自相矛盾的 Outbox 行：
  ```
  event_type     = 'connection.request.created'
  aggregate_type = 'connection_request'
  aggregate_id   = <通知自己的 id>      ← 指向了一条通知，不是联系申请
  ```
- **根因**：`apps/api/src/modules/notifications/notification.service.ts` 的 `push()` 签名里
  有 `options.aggregateId`（调用方给的是「这个事件所指向的聚合根 id」），
  但写库时写死成 `String(notification.id)` → 调用方传的 `aggregateId` 被**静默丢弃**。
  受影响的调用点共 8 处：联系申请（创建 / 接受 / 拒绝）、认证（提交 / 决定）、
  资源（投稿 / 审核）、活动报名。
- **为什么长期没被发现**：`notifications.e2e-spec.ts` 里有一条断言
  `expect(outbox.aggregate_id).toBe(String(created.body.data.id))`，
  它一直是**靠巧合通过**的 —— 老夹具用 TRUNCATE 重置，**每张表的自增计数器都从 1 重新开始**，
  于是「通知 id」恰好等于「联系申请 id」（都是 1、2、3…）。缺陷 #138 改用 DELETE 重置后，
  两个计数器不再同步，这条断言**立刻变红**，才把真缺陷挖出来。
- **处置**：`aggregateId: options.aggregateId ?? String(notification.id)`
  —— 调用方给了就用调用方给的，没给才退回通知 id（默认语义不变）。
- **配套**：新增 `apps/api/test/integration/outbox-aggregate-id.e2e-spec.ts`（4 例，含 1 条对照），
  覆盖联系申请 / 资源投稿 / 活动报名三类事件。
  用例先往 `notifications` 插一条 **id=900000 的占位通知**，把通知的自增计数器顶到远处，
  这样「通知 id」与「聚合根 id」**不可能相等** —— 断言不依赖自增计数器的巧合，
  换回 TRUNCATE 重置也不会变成假通过。
- **反向验证**：未修代码上 **3 红 1 绿**
  （`aggregate_id` 实际是 `900001` / `900002` / `900003`，即通知 id）；修复版 **4/4 全绿**。

### 140. 幂等 scope 用的是**路由模板** → 同一把钥匙开两个不同资源会互相串扰

- **形态**：幂等拦截器把 scope 写成 `METHOD:${request.route.path}:u{userId}`，
  而 `request.route.path` 是**路由模板**（如 `/connections/:id/contact-grant`），
  不是实际路径（`/api/v1/connections/17/contact-grant`）。
- **后果**：「同一把钥匙开两个不同的资源」落进**同一个 scope**：
  - 请求体相同 → 第二个请求被当成**回放**，返回**第一个**资源的响应；
  - 而第二个资源**根本没有被写入** —— 客户端却收到 200，像是成功了
    （**静默的数据丢失**）。
- **实测**（未修代码，容器内）：`PUT /connections/58/contact-grant` 与
  `PUT /connections/59/contact-grant` 用同一把钥匙、同一份 body
  → 第二个响应里的 `data.id` 是 **58**（第一个资源），数据库里只有 **1 条**授权记录。
- **处置**：
  - scope 改用**实际路径**（`request.originalUrl` 去查询串）：
    `METHOD:/api/v1/connections/17/contact-grant:u3`；
  - 请求指纹从「只有 body」扩到「方法 + 实际路径（含查询串）+ body」
    → 同一路径但查询串/请求体不同，仍按契约返回 **409 `IDEMPOTENCY_CONFLICT`**；
  - `idempotency_records.scope` 由 `VARCHAR(64)` 放宽到 `VARCHAR(255)`
    （新迁移 `1730000004000-WidenIdempotencyScope`，**幂等**：先查列的实际类型）。
    实际路径比模板长，长路由（如 `/api/v1/admin/verification/applications/:id/decision`）
    加上 BIGINT id 后**会超过 64 字符** → 不放宽就直接 `Data too long` → 500。
- **配套**：新增 `apps/api/test/integration/idempotency-scope.e2e-spec.ts`
  （3 例：1 条 #140 + 2 条对照 —— 同一资源仍回放、同一资源不同 body 仍 409）。
- **反向验证**：未修代码上 #140 用例**真红**（`data.id` 是 58 而非 59），
  两条对照**真绿**；修复后 **13/13 全绿**（含既有幂等套件）。
- **契约同步**：`docs/API-SPEC.md` 与 `docs/CONCURRENCY-DESIGN.md` §幂等键
  明确「路径取**实际路径**（含资源 id），不是路由模板」。

### 141. 客户端**每次请求都换一把新的幂等键** → 幂等能力在真实链路上形同虚设

- **现象**：管理后台与小程序的请求层都在**每次发请求时现生成**一把随机幂等键：
  - `apps/admin-web/src/api/http.ts`：请求拦截器里 `config.headers.set('Idempotency-Key', config.idempotencyKey || randomId())`
    —— 拦截器**每次**都跑，axios 的重试（401 刷新令牌后重发同一个 config）也会被换成新钥匙；
  - `apps/miniprogram/src/services/request.ts`：`header['Idempotency-Key'] = generateId()`。
- **后果**：幂等键的用途是「**首次其实写成功了、只是响应丢了**，重试不要写第二遍」。
  每次换新钥匙 → 重试被服务端当成**新请求** → **重复创建**，
  服务端那套「同键同体回放」的能力**一次都没被真正用到**。
- **处置（已做）**：
  - 管理后台：拦截器**已经有钥匙就不再覆盖** → 自动重试沿用同一把；
  - 小程序：幂等键改到 `request()` 这一层生成一次（401 重试走 `{ ...opts }` → 天然沿用），
    并新增 `RequestOptions.idempotencyKey` 让调用方能显式指定。
- **仍存在的缺口（不宣称已解决）**：
  - **用户手动重试**（超时后用户再点一次提交）属于**两次独立动作**，
    要去重必须由 UI 层「一个动作一把钥匙」——
    目前各页面**没有**持有这个键，因此手动重试仍可能重复创建；
  - 小程序与管理后台**都没有**针对该行为的自动化测试
    （两端都没有测试运行器；给 admin-web 引入 vitest 会新增 workspace 依赖，
    与「playwright 不得进 workspace 依赖」的既有约束同类，故本轮未做）。
  - 所以这条记为**设计缺口**：服务端已就绪，客户端还需要在 UI 层补「动作级钥匙」。

### 142. 部署流程**不执行迁移** → 代码与业务库表结构悄悄漂移

- **形态**：deploy 的流程是「同步 → 构建 → `up -d` → 健康检查」，
  中间**没有迁移这一步**。于是代码改了表结构、业务库却还是旧结构 →
  **运行时才报错**。
- **这轮就被它咬到了**：#140 把 `idempotency_records.scope` 放宽到 `VARCHAR(255)`，
  如果迁移没手工补上，库里还是 64 →
  长路径的幂等请求会 `Data too long for column 'scope'` → **500**。
- **为什么本地与测试库测不出来**：回归链第 1 步**重建**测试库、第 2 步**跑迁移**，
  所以测试环境永远是「结构与代码一致」的；
  而业务库是**唯一**会漂移的地方 —— 也就是说这类缺陷**天然只在生产暴露**。
- **处置**：
  - `deploy.sh` 在 **`up -d` 之前**用新镜像跑一次迁移
    （`compose run --rm --no-deps api ... migration:run`）：
    - 放在切流量**之前**：此时旧容器还在服务旧代码，迁移是**加法式**的
      （只加列/加表），旧代码对新结构完全兼容 → 不会出现「切了流量才发现结构不对」；
    - 放在**之前**的另一层好处：新代码上线时结构**已经就位**，
      没有「新代码跑在旧结构上」的窗口；
  - 迁移失败 → **中止部署**（不带着不一致的结构上线）；
  - 部署后再跑一次**迁移一致性对账**（见 #144 的新校验层）→「跑过」不等于「跑全了」；
  - `--build-only`（只构建不启动）**不动数据库**。
- **新增校验层**：第 **14** 层 `check-pending-migrations.sh`（详见 #144）。

### 143. 迁移清单有**两份**，真正应用迁移的那份容易漏加

- **形态**：`migrations/index.ts`（应用运行时用）与
  `data-source.ts` 里的 `migrations: [...]` 数组
  （**`typeorm migration:run` CLI 用的就是这一份**）曾**各抄一份**类名。
- **后果**：两份手工维护的清单迟早不同步，而**真正去应用迁移的正是后一份** ——
  新增迁移时若只改 `index.ts`，那条迁移就**永远不会被应用**，
  且**没有任何报错**：CLI 会说「没有新迁移」，一切看起来正常。
- **处置**：`data-source.ts` 改为直接 `import { migrations } from './migrations'`，
  清单**只有一份**（`migrations/index.ts`）→ 两边不可能再不一致。
- **防回退**：第 14 层校验器的 R1 规则会核对
  「`migrations/` 目录里的每个迁移文件 ↔ 清单里的每一项」，
  漏登记立即被抓出（详见 #144）。

### 144. 流程缺口：没有「代码里的迁移 ⟷ 库里已应用」的对账层

- **动机**：#142 与 #143 都是**没有任何报错**的静默失败，
  而且**只在业务库暴露**（测试库每次重建并跑迁移）。
  所以必须有一层**当面对账**：代码要的迁移，库里到底应用了没有。
- **新增第 14 层校验** `infra/scripts/check-pending-migrations.sh`：
  | 规则 | 判定 | 挡住的坑 |
  |---|---|---|
  | R1 清单 ↔ 文件一致（**失败**） | `migrations/` 目录里的每个迁移文件都必须登记进 `migrations/index.ts`；清单里也不能有**不存在的**文件 | #143（漏登记 = 迁移永远不会被应用） |
  | R2 业务库无未应用迁移（**失败**） | 代码清单里的每个迁移都必须在库的 `migrations` 表里有对应记录 | #142（代码已按新结构工作、库里还是旧结构） |
  | R3 库里有清单之外的迁移（**提示**） | 代码分支不一致 / 回滚过的痕迹 → 只提示不判失败 | 避免误伤 |
- **只读**：脚本只执行 `SELECT`，不写库、不跑迁移。
  可用 `--db <库名>` 指定目标库，`--static-only` 只做静态核对（不需要 `.env.prod`）。
- **反向验证**（`check-pending-migrations-selftest.sh`）：
  | 步骤 | 期望 | 实测 |
  |---|---|---|
  | 正向基线 | 退出码 0 且无 `PENDING_*` | ✅ 0 |
  | 注入「迁移文件未登记进清单」 | 退出码非 0 且命中 `PENDING_MIGRATION_UNREGISTERED` | ✅ 退出码 1 |
  | 注入「已登记但数据库里没有」 | 退出码非 0 且命中 `PENDING_MIGRATION` | ✅ 退出码 1 |
  | 元自检（恒过的假校验器） | 必须被判失败 | ✅ |
- **接入回归链第 22 步**（对账 + 反向验证）。

### 145. 微信编译器把 11 个**必需**模块剪掉 → 交付出去的小程序包一打开就崩

- **动机**：为了把「临时预览版」交给客户，我先把小程序**离线编译**了一遍
  （见 #146），产物清单一对账就发现少了 11 个模块。
- **现象**：`project.config.json` 里 `setting.ignoreUploadUnusedFiles: true`
  （微信开发者工具的默认选项），微信编译器会做「未被引用的文件不上传」的剪枝，
  但它**剪错了** —— 被剪掉的是**必需**模块：
  | 被剪掉的模块 | 谁在用它 |
  |---|---|
  | `services/index.js` | **所有页面**都 `require("../../../services")`（它是 barrel 文件） |
  | `config/index.js` | `services/request.js` 里 `require("config")` |
  | `store/index.js` | 全局状态 |
  | `types/index.js` | 类型（运行时已被擦除，但 import 还在） |
  | `services/{connections,content,directory,events,notifications,resources,uploads}.js` | 被 `services/index.ts` 再导出 |
- **为什么危险**：编译**成功**、上传**成功**、后台**显示已上传** ——
  但包一打开就是 `module not found`（小程序要求模块路径相对**包根**，
  `require("config")` 找的是 `<root>/config/index.js`）。
  也就是说：**照原样发布，客户拿到的是一个必崩的包**。
- **修复**：`apps/miniprogram/project.config.json` → `ignoreUploadUnusedFiles: false`。
  代价只是包大 ~44 KB（251 → 263 个文件，287.6 → 331.9 KB）。
- **顺带暴露的第二个事实**：微信编译器是**只转译、不做类型检查**的 ——
  注入一个类型错误，编译照样「成功」。
  → 类型问题只能靠 `tsc --noEmit` 抓，两道检查都得跑（见 #146）。
- **实测证据**：
  | 场景 | 修复前 | 修复后 |
  |---|---|---|
  | 产物 .js 文件数 | 70（缺 11 个必需模块） | **81（与源文件 1:1）** |
  | 产物文件总数 / 体积 | 251 / 287.6 KB | 263 / 331.9 KB |
  | 注入语法错误 | **编译仍「成功」**（坏文件被剪掉，根本没编译） | **编译失败**（BABEL_PARSE_ERROR） |

### 146. 流程缺口：没有「编译产物 ⟷ 源文件」的对账层

- **动机**：#145 的根因是**没人看过编译产物**。
  原因有二：
  1. `ci.preview` / `ci.upload` 会先联网「取项目属性」，
     没有真实 AppID + 上传密钥时**在编译完成前就失败** ——
     所以「上传前的编译」从来没能被观察到；
  2. 微信编译器的输出**不落盘**（临时目录用完即删），
     没有任何现成手段能看产物。
- **新增第 16 层校验** `infra/scripts/miniprogram-compile-check.mjs`：
  | 规则 | 判定 | 挡住的坑 |
  |---|---|---|
  | R1 产物能编译出来（**失败**） | 离线编译不抛错 | 语法错误级的坏包 |
  | R2 产物里无残留 TS 语法（**失败**） | 扫 `interface` / `export type` / `as unknown as` / `implements` | TS 没被转译 → 运行时必崩 |
  | R3 源模块 1:1 入包（**失败**） | 每个源 `.ts` 都要有对应 `.js` | **#145**（被误剪 → module not found） |
  | R4 演示兜底模块入包（**失败**） | `demo/router.js`、`demo/dataset.data.js` 必须在包里 | 断网兜底失效 → 白屏 |
- **怎么做到离线编译**：`getCompiledResult` 走的是本地编译，
  但它内部会调 `getProjectAttr`（要联网）。
  → 在脚本里把 `utils/sign` 与 `utils/request` **本地打桩**，
  返回默认项目属性，从而不联网也能编译。
  （打桩只用于**本地自检**，真正的上传仍然走真实凭据。）
- **反向验证**（`check-miniprogram-compile-selftest.sh`）：
  | 步骤 | 期望 | 实测 |
  |---|---|---|
  | 正向基线 | 退出码 0，产物 263 文件 / 331.9 KB | ✅ 0 |
  | 注入语法错误 | 编译必须失败 | ✅ 退出码 1（BABEL_PARSE_ERROR） |
  | 注入类型错误 | 编译仍过（只转译不检查），`tsc --noEmit` 必须红 | ✅ tsc 退出码 2（TS2322） |
- **接入发布流程**：`release-miniprogram-preview.sh` 的第 1.5 步
  —— **离线编译自检不过就不上传**，杜绝把坏包发给客户。

### 147. 小程序数据以 `.json` 形式进包 → 运行时能否 `require('*.json')` 不确定

- **动机**：离线演示数据集原本是 `src/demo/dataset.json`，
  在 TS 里 `import rawDataset from './dataset.json'`。
  但微信小程序运行时的模块系统**是否支持 require JSON 模块**，
  我无法在真机上先试一次再决定（连开发者工具都没有）。
  拿不准的东西不能进交付物。
- **处理**：改成**编译期内联** —— 导出脚本直接生成
  `src/demo/dataset.data.ts`（内容是 TS 对象字面量，JSON 是它的子集），
  运行时零风险。
- **新增第 15 层校验** `infra/scripts/check-miniprogram-demo.sh` 的 R7：
  源码里**不得**出现 `from '*.json'` / `require('*.json')`。
  实现要点：**先剥注释再判定** ——
  第一版把注释里写的「`require('*.json')`」当成了真引用，误报了一次。

### 148. 微信登录失败一律返回 **500 服务器内部错误** → 用户明明是「code 不对」，却看到「服务器故障」

- **动机**：小程序接入真实微信登录后，第一次打真实链路就撞上了：
  ```bash
  curl -X POST http://8.160.116.34:18080/api/v1/auth/wechat/login \
       -d '{"code":"invalid_code_for_test"}'
  # → HTTP 500 {"code":"INTERNAL_ERROR","message":"服务器内部错误"}
  ```
  `auth.service.ts` 里其实**已经有** `authFailed()` 助手（缺陷 #110 修「死码」时加的），
  但 `loginWithWechat` **没有用它**；
  `WechatAuthProvider` 抛的是**普通 `Error`**，
  被 `AllExceptionsFilter` 按「非 HttpException」一律映射成 500。
  → 契约里的 `AUTH_FAILED`（401）**在微信登录路径上从未出现过**。
- **更糟的是「两种失败被混为一谈」**：
  | 真实情况 | 应当返回 | 修复前返回 |
  |---|---|---|
  | 微信拒绝凭据（code 过期 / 被用掉 / 不是真 code） | 401 `AUTH_FAILED` | 500 `INTERNAL_ERROR` |
  | 微信接口不可达（超时 / 被拒 / 微信挂了） | 502（服务端故障，让用户稍后再试） | 500 `INTERNAL_ERROR` |
  | Mock 登录入参非法（`mock:` 去掉前缀为空） | 400 `VALIDATION_ERROR` | 500 `INTERNAL_ERROR` |
- **处理**：
  1. provider 引入**可分类**的 `WechatAuthError`（`invalid_code` / `unavailable`），
     网络层异常（axios 抛错）也归入 `unavailable`；
  2. `AuthService.toWechatAuthException()` 把三类失败分别映射到
     **401 AUTH_FAILED / 502 INTERNAL_ERROR / 400 VALIDATION_ERROR**；
  3. 微信返回的 `errmsg`（含 `hints` / `req_id`）**只进服务端日志**，不返回给客户端；
  4. Mock 登录的入参错误也一并从 500 改成 400。
- **对照用例**（新增 2 个套件 / 10 个用例，真实 MySQL + Redis 容器内跑）：
  `apps/api/test/integration/wechat-login.e2e-spec.ts` 用
  **本地假微信服务器**（`WECHAT_API_BASE` 是现成的测试缝）精确制造四类情形：
  成功 / `errcode` 拒绝 / 200 但无 openid / 连接被掐断。
  `apps/api/test/integration/auth-mode.e2e-spec.ts` 锁定 `AUTH_MODE` 三种取值的语义。
  - **防误报断言**：每个用例都断言假服务器**确实收到了请求** ——
    否则「环境变量没生效、请求打到真实微信（同样返回 40029）」会让 401 变成假阳性。
  - **反向验证**（把 provider 退回「抛普通 Error」= 修复前行为，重建镜像后重跑）：
    | 用例组 | 修复后 | 退回旧行为 |
    |---|---|---|
    | `wechat-login`（6 例） | 6 通过 | **4 失败**（401/502 全变 500）✅ 用例确实抓得住 |
    | `auth-mode`（4 例） | 4 通过 | 4 通过（该组不依赖 provider 错误类型） |
  - 公网入口实测（`http://8.160.116.34:18080`）：
    无效 code → **HTTP 401 `AUTH_FAILED`** ✅；code 过短 → HTTP 400 `VALIDATION_ERROR` ✅。

### 149. `AUTH_MODE` 是**死配置** → 生产环境里 Mock 登录是个**公开后门**

- **动机**：`.env.prod` 里一直写着 `AUTH_MODE=both`，
  但**全仓库没有任何代码读它** → Mock 登录与微信登录**永远同时可用**。
  后果有两个：
  1. 生产环境里 `POST /api/v1/auth/mock/login` 是**公开可用的后门** ——
     任何人都能凭空造出一个用户（写进 `users` 表）；
  2. 运营想「只留微信登录」时**无计可施**，配置改了也没人读。
- **处理**：`AuthService` 真正实现这个开关，取值 `mock` / `wechat` / `both`：
  | 取值 | Mock 登录 | 微信登录 |
  |---|---|---|
  | `mock` | ✅ | 403 `FORBIDDEN` |
  | `wechat` | 403 `FORBIDDEN` | ✅ |
  | `both` | ✅ | ✅ |
  - 非法取值一律按 `both` 处理 —— 配置写错不该让登录整个瘫掉。
  - 被拒的请求**不会造出用户**（用例里有断言：403 之后 `users` 仍为空）。
- **当前取值**：校园机 `.env.prod` 保持 `AUTH_MODE=both` ——
  预览期要留 Mock 通道（小程序端走真实登录，但后端仍需可自测）。
  **正式对外前建议改为 `wechat`**，把 Mock 后门彻底关掉。

### 150. 流程缺口：上传「成功」不等于**包里的配置是对的**

- **动机**：`ci.upload` 返回成功只说明「代码传到微信服务器了」。
  以下三种事故它**一个都拦不住**：
  | 事故 | 客户看到的表现 |
  |---|---|
  | API 基址没注入（还是 `127.0.0.1:3000`） | 真机上**一个接口都调不通**，页面全空 |
  | `USE_MOCK_LOGIN` 还是 `true` | 客户用的是「演示账号」，不是自己的微信身份 |
  | `DATA_MODE` 落在 `demo` | 全是假数据，演示效果与真实效果不一致 |
  更隐蔽的是：以前要靠**手改源码**来切这三项，改漏了没有任何机制会发现。
- **处理**：
  1. 上传脚本支持**构建期注入** `--api-base-url` / `--mock-login` / `--data-mode`
     （改完由 `trap` 自动还原源码，异常路径也还原）；
  2. 注入点统一为一个 `inject_const` 函数 ——
     **保留类型注解**（`DATA_MODE: DataMode` 少了注解会变成 `string`，
     赋给 `DataMode` 类型的参数直接编译报错）；
  3. **上传前在产物里对账**（新增于 `miniprogram-ci-upload.sh` 第 4.5 步）：
     注入之后、上传之前离编译一次，直接在**编译产物**里找这三个值，
     找不到就**中止上传**；
  4. 产物里的写法必须容错 minify：实测产物为
     `exports.USE_MOCK_LOGIN=!1` / `exports.DATA_MODE="auto"` ——
     断言同时认 `false`/`!1` 与 `true`/`!0`。
- **反向验证**（阿里云实测）：
  | 对象 | 期望 | 实测 |
  |---|---|---|
  | 注入后的工程副本 | 退出码 0，三项配置全部符合预期 | ✅ `A_RC=0` |
  | 未注入的工程副本（基址仍是 `127.0.0.1`、mock 仍 `true`） | 必须**失败**并点名哪几项不符 | ✅ `B_RC=1` |

### 151. 我在文档里写了「后台可勾选『不校验合法域名』」——**公众平台根本没有这个开关**

- **现象**：用户去微信公众平台「开发管理 → 开发设置 → 服务器域名」找这个开关，
  页面只有「使用微信云开发 / 微信云托管」的引导和「开始配置」，
  **没有任何「不校验合法域名」勾选项**。
- **事实**（微信官方文档《网络 · 跳过域名校验》原文）：
  > 在**微信开发者工具**中，可以临时开启「开发环境不校验请求域名、TLS 版本及 HTTPS 证书」选项，
  > 跳过服务器域名的校验。此时，在**微信开发者工具中**及**手机开启调试模式**时，
  > 不会进行服务器域名的校验。

  即：**这个开关只存在于微信开发者工具**，公众平台**没有**；
  手机端的等价手段是**开启调试模式**
  （小程序右上角「…」→「开发调试」→「打开调试」→ 重新进入小程序，
  左上角出现 vConsole 绿色浮标即已生效）。
- **同时确认的硬性规则**（官方文档「服务器域名配置」）：
  | 规则 | 内容 |
  |---|---|
  | 协议 | 只支持 `https`（`wx.request` / `uploadFile` / `downloadFile`）与 `wss` |
  | 不能用 IP | 「域名不能使用 IP 地址（小程序的局域网 IP 除外）和 localhost」 |
  | 必须备案 | 域名需通过 **ICP 备案** |
  | 端口 | 默认 443；非标准端口需在配置里带端口 |
  | 修改频率 | 一个月最多修改 5 次 |
- **对本项目的直接后果**：公网入口是 `http://8.160.116.34:18080`（**IP + HTTP**），
  → **无法**配置为 `request 合法域名` → 体验版在**正常模式**下必然请求失败。
  服务器上现有的 `*.dpdns.org` 是免费动态域名（他人域名的子域），**无法 ICP 备案**，
  也不能用作合法域名。
- **三条可走的路**：
  | 路径 | 前提 | 何时可用 | 看到的数据 |
  |---|---|---|---|
  | ① 手机开调试模式 | 客户微信号在「体验成员」名单里 | **现在** | 真实后端数据 |
  | ② 离线演示包（`--data-mode demo`） | 无（完全不联网） | **现在** | 本地演示数据 |
  | ③ 买域名 → ICP 备案 → Caddy 签证书 → 配置合法域名 | 域名 + 备案（通常 1~3 周） | 正式发布前 | 真实后端数据 |
- **处置**：已修正本仓库 4 处错误表述
  （`release-miniprogram-preview.sh` / `deploy-public-edge.sh` /
  `docs/DEPLOY-PUBLIC-EDGE.md` / `apps/miniprogram/README.md`），
  并把「小程序 request 合法域名」列入「待验证 / 未完成」清单。

### 152. 真机「打开一片空白、图标全无、只剩底栏文字」→ **微信运行时不支持「目录导入」**

- **现象**：客户扫码打开体验版，**页面全白**，只有底部 tabBar 的文字出来，
  **图标一个都没有**（tabBar 的图标是纯 CSS 画的，不是图片）。
  极具迷惑性：底栏文字在（tabBar 组件**没有 import**，能正常加载），
  页面内容全空（页面**有 import**，加载失败）。
- **真凶**（客户提供的 vConsole 报错，直接指向答案）：
  ```
  MiniProgramError
  module 'services.js' is not defined, require args is '../../../services'
  Error: module 'services.js' is not defined, require args is '../../../services'
      at require (pages/home/index/index.ts:1:1)
      at <require(pages/home/index/index.js)>

  MiniProgramError
  module 'store.js' is not defined, require args is '../store'
  ```
  → **微信小程序的运行时不做「目录 → index.js」的回退**：
  源码里 `import { ... } from '../../../services'`，
  编译产物里就是 `require("../../../services")`，
  运行时把它解析成模块 `services.js` —— **找不到**（包里明明有 `services/index.js`）。
  → 页面 JS 加载失败 → **页面全白**。
- **规模**：全工程 **130 处**目录导入（`services` 39 / `types` 58 / `store` 28 / `config` 5），
  涉及 65 个文件。全部改成显式指向 index（`'../../../services/index'`）。
- **为什么层层校验全都没拦住**（这才是重点）：
  | 校验 | 结果 | 为什么漏 |
  |---|---|---|
  | 编译成功 | ✅ | 编译器照抄 import，**它自己也不做 index 回退** |
  | 无残留 TS 语法 | ✅ | 产物是合法 JS |
  | 源模块 1:1 入包 | ✅ | `services/index.js` **确实在包里** |
  | 产物里每条 require 可解析（R5） | ✅ | R5 按 **Node 规则**判定 → 能解析 |
  | `tsc --noEmit` | ✅ | TS 的模块解析**有** index 回退，所以类型检查也通过 |
  → **每一层都用了各自的规则判定「合法」，唯独没人用「微信运行时的规则」判定过。**
  产物层的检查**在原理上就查不出它**（文件在包里、Node 规则能解析），
  必须**在源码层**按「微信运行时规则」查。
- **修复与新增校验**：
  1. 130 处目录导入全部改为 `'xxx/index'`；
  2. **新增第 18 层校验** `infra/scripts/check-miniprogram-imports.mjs`：
     源码里凡有指向目录的相对 import，一律判失败并给出正确写法；
     已接入上传流程（`miniprogram-ci-upload.sh` 第 4.6 步），
     **白屏这类问题从此不会漏到真机**；
  3. 配套反向验证 `infra/scripts/check-miniprogram-imports-selftest.sh`
     （注入一处目录导入 → 必须被判失败 + 点名 + 给出正确写法 + 元自检），
     **实测 5/5 通过**。
- ⚠️ **一次被推翻的判断（留档，避免后人重走）**：
  我曾判定「编译产物引用了包外的 `@babel/runtime` → 真机 module not found → 白屏」。
  逐字节核对后**不成立**：编译器会把这 26 个 helper **自动打进包里**，
  `require('@babel/runtime/helpers/regeneratorRuntime')` 能正常解析。
  —— 这个误判是被**反向验证**当场抓出来的
  （注入缺陷后校验器本该失败却通过了 → 说明前提就是错的，回头一查前提确实错了）。
  **教训**：拿到「符合现象的解释」不等于「找到根因」，
  必须有一份**来自现场的证据**（这里是客户的 vConsole 报错）才能定案。
- **顺带**：第 17 层校验（R5：产物里每条 require 都必须能在包内解析）
  虽然**没能抓住这次的缺陷**（它按 Node 规则判定），
  但它能抓住「包外 npm 依赖真的缺失」这类问题，保留。

### 154. 首页 32 个类**一个都没有样式** → 真机页面上半部分全是裸文字

- **现象**：客户真机截图（`debug/qan/`）：白屏修好之后页面能显示了，
  但**上半部分全是裸文字**（"心系燕园 · 情连北疆" / "校友资讯" / "以校友情谊为起点"…），
  **下半部分的文章卡片却是有样式的**（白底圆角卡片、标签、日期、阅读数）。
  客户反馈：「显示出来了，但细节没有 HTML 精致」。
- **真凶**：首页 WXML 用了 **32 个类**（`.home` / `.hero*` / `.home-tabs` /
  `.shortcut*` / `.notice-row` / `.section-heading` / `.state-wrap` /
  `.loading-line` / `.error-tip` / `.notice-list` / `.empty-mini`），
  而这些类**在所有 WXSS 里都没有定义**。
  首页的 `index.wxss` 此前**只有 6 行**，且**没有 import 共享的 `styles/blocks.wxss`**。
  → 真机上就是「文字按默认样式从上往下排」。
- **为什么没被发现**：
  - 页面能打开、数据能加载 → 数据层没问题；
  - 底部文章卡片、tabBar **有样式**（它们是自定义组件，各带自己的 wxss）
    → 一眼看过去「好像是有样式的」，只是上半截裸了；
  - 没有任何校验在问「**这个类名有人管吗**」。
- **修复**：
  1. 重写 `apps/miniprogram/src/pages/home/index/index.wxss`（照 `prototype/html-v1/index.html` 移植，
     px→rpx）：hero 渐变 + 装饰、页签下划线、焦点推荐条、快捷入口四色、公告条、
     骨架屏、错误提示、空态；
  2. `styles/blocks.wxss` 追加共享的 `.notice-list` / `.notice-item*` / `.empty-mini` / `.menu-title`；
  3. `components/article-card` 补 `.article-views`、`components/opportunity-card` 补 `.op-author`；
  4. `pages/me/notification-detail/index.wxss` 补整页 8 个 `.notify-detail*` 类
     （该页此前只有一行 `@import`）。
- **新增第 19 层校验** `infra/scripts/check-miniprogram-styles.mjs`：
  WXML 里用到的每个类，必须在 `app.wxss` + 本页 wxss + `@import` 链里有定义；
  动态类名（如 `icon-{{item.icon}}`）按前缀匹配。
  配套反向验证 `check-miniprogram-styles-selftest.sh`（**实测 5/5 通过**）。

### 155. 全项目**一张图片资源都没有** → 图标是 CSS 手绘和汉字占位，跟原型完全不像

- **现象**：客户反馈「底部 tab栏 的『首页/通讯录/连接/我的』图标不太对，
  顶部图片里面的塔楼简笔画也没有」。真机截图证实：
  - tabBar 的 4 个图标是**用 CSS 伪元素手绘**的（`.icon-home::before` 是个三角形屋顶、
    `.icon-users::after` 是个半圆）—— 原型是 Feather 风格**描边 SVG**，完全对不上；
  - 首页快捷入口是**汉字占位**：`人` / `连` / `历` / `燕`；
  - 「我的」页菜单是**汉字占位**：`名` / `历` / `连` / `知` / `发` / `隐` / `燕` / `设`；
  - 通知类型图标是**汉字占位**：`认` / `连` / `审` / `活` / `通`；
  - 隐私提示是**汉字占位**：`盾`；搜索框是 `搜`；
  - 活动卡标记是**活动类型的首字**（`{{event.kind || '燕'}}`）；
  - 原型的**塔楼线描插画**（首页 banner / 我的页 banner / 连接页网络图 / 焦点卡装饰）
    在小程序里**完全缺失**，只有我自己用 CSS 渐变画的「同心圆 + 波纹」凑数。
- **根因**：**WXSS 不支持 SVG data URI**（`background-image` 只认 png/jpg/gif/webp 的 base64），
  而项目**从未引入任何图片资源**，也没有任何工具把原型的 SVG 变成小程序能用的 PNG。
  → 结果就是：手绘 CSS 或直接拿汉字凑。
- **修复**：
  1. **新增资产生成器** `infra/scripts/generate-miniprogram-assets.py`：
     **从 `prototype/html-v1/index.html` 现读现提取** `iconPaths`（31 个图标）
     与 4 幅插画（`bannerArt` 塔楼群 / `meArt` 校园建筑 / `netArt` 校友网络 /
     `miniArt` 焦点卡装饰），用 `cairosvg` 栅格化成 PNG。
     **原型是唯一事实来源**（不在脚本里另抄一份 —— 抄一份就会漂移，而漂移是静默的）；
     按原型 CSS 里的 `currentColor` 还原**每个位置各自的色调**
     （快捷入口四色 / 菜单 `#c38f73` / 活动卡红与橄榄两色），共 **102 个 PNG、约 130 KB**；
  2. tabBar 改为 `<image>`（选中/未选中两套色），删除 8 条 CSS 手绘规则；
  3. 首页 / 我的页 / 连接页 / 通讯录 / 通知 / 账号页 / 活动卡的占位图标全部换成 SVG 栅格图；
  4. 4 幅插画按原型的定位与透明度接回（`opacity: .45` / `.55` 等）。
- **新增第 21 层校验** `infra/scripts/check-miniprogram-assets.mjs`：
  1) WXML / WXSS / TS 里引用的每一个本地图片路径，**磁盘上必须真的存在**
     （不存在 → 真机上是「图标位置一片空白」，不报任何错）；
  2) **不允许再有「用单个汉字冒充图标」**的写法。
  配套反向验证 `check-miniprogram-assets-selftest.sh`（**实测 7/7 通过**）。
- **成本**：主包从 353 KB 涨到 **515 KB**（小程序主包上限 2 MB，余量充足）。

### 156. 全项目 **20+ 处直接渲染原始 ISO 时间戳** → 页面显示 `2026-01-08T08:00:00.000Z`

- **现象**：客户截图里文章卡片的日期是 `2026-01-08T08:00:00.000Z`，
  底栏标签页、文章列表、公告列表、活动详情、连接申请、个人页……**到处都是**。
- **根因**：**不是后端返回错了** —— DTO 里的时间字段本来就该是 ISO 串。
  是**展示层没做格式化**：WXML 数据绑定只取值、**不能调用 JS 函数**，
  于是直接把 DTO 丢给 WXML 就等于把原始串显示给用户。
  而 `utils/format.ts` 里的 `formatDate` / `formatDateTime` **早就存在**，只是一直没人调用；
  更糟的是有三个页面里**挂着从未被 WXML 调用的 `formatDate` / `formatDateTime` /
  `formatNoticeDate` 方法**（死代码），让人以为「已经处理过了」。
- **规模**：20 处渲染点，分布在 20 个页面 / 组件。
- **修复**：
  1. **新增展示模型层** `apps/miniprogram/src/utils/view.ts`：
     `toArticleView` / `toNoticeView` / `toEventView` / `toOpportunityView` / `toRequestView`，
     统一产出**已经格式化好的**展示字段（`dateText` / `timeText` / `updateText`）；
  2. `utils/format.ts` 新增 `formatRelativeTime`（`刚刚` / `12分钟前` / `3小时前` /
     `昨天 19:30` / `5天前` / 绝对日期）；
  3. 全部 20 处改为绑定展示字段，并清掉三个死方法；
  4. `me/notification-detail` 的 `createdAt` 字段改名 `createdText`（页面私有 data）。
- **新增第 20 层校验** `infra/scripts/check-miniprogram-dates.mjs`：
  WXML 里凡出现 `xxxAt` 这类**原始时间字段**的插值，一律判失败
  （`dateText` / `timeText` 这类展示字段天然不误报）。
  配套反向验证 `check-miniprogram-dates-selftest.sh`（**实测 5/5 通过**）。

### 157. `formatRelativeTime` 的「昨天」按**时长**判定而非**日历日** → 跨零点会误标

- **发现途径**：写 #156 的单元测试时，**测试先红了**（暴露的是我自己的预期写错，
  但顺着查下去发现了实现里真有一个语义缺陷）。
- **现象**：昨天 23:50 的事，在今天 03:00 打开时，
  距今只有 **3 小时 10 分** —— 按「距今不足 48 小时就是昨天」的写法会显示
  `昨天 23:50`（还算对），但昨天 23:50 → 今天 12:00 距今 36 小时，
  同样会被标成「昨天」，而**按日历那已经是前天**。
  跨零点的这段时间永远显示不对。
- **修复**：改为**按本地日历日之差**分级：
  今天之内 → `N小时前`；昨天 → `昨天 HH:mm`；2~6 天 → `N天前`；≥7 天 → 绝对日期。
- **回归用例**（写在 `apps/miniprogram/test/format.spec.ts`）：
  跨零点的昨天仍是「昨天」、前天显示「2天前」——
  这两条在旧的时长判定下**会红**。

### 158. `admin_user_roles` 是**保留表** → 集成测试的绿不绿**取决于 jest 的执行顺序**

- **发现经过**：本轮跑完整回归链时，`http-status-semantics.e2e-spec.ts` 红了
  （`PATCH /admin/users/:id/status` 期望 200，实得 **403**）。
  而**上一轮同一套代码**（`git HEAD` 完全一致、api 镜像与仓库逐字节一致）
  是 **42 套件 / 295 用例全绿** —— 同一份代码，一轮绿一轮红。
- **真凶**：
  - `resetDatabase()` 把 `admin_users` / `admin_user_roles` / `roles` /
    `role_permissions` 列为**保留表**（只清「测试数据表」）；
  - 而 `admin-test` 这个管理员账号被**十几个套件共用**，
    每个套件都往它身上 `ensureAdmin()` 授不同的角色 →
    **它的角色会跨套件、跨运行累积**；
  - `http-status-semantics` 用的是 `admin-test` + 固定角色 `event_admin`，
    而 `event_admin` 在 seed 里只有 `event:manage` + `audit:view` ——
    **没有** `alumni:manage`；
  - `PATCH /admin/users/:id/status` 的守卫是 `@RequirePermissions('alumni:manage')`
    → 单独跑必然 403。
  - 上一轮之所以绿，是因为**碰巧**有别的套件（`admin-account-management`）
    先跑并把 `alumni_reviewer` 角色留给了 `admin-test`；
    下一轮容器重建 → jest 的执行顺序缓存没了 → 顺序变了 → 就红了。
- **为什么这么隐蔽**：
  - 「整链绿」只证明**某种执行顺序下**没问题；
  - jest 按**上一次运行的耗时缓存**排序，容器一重建缓存就清空 → 顺序不可复现；
  - 失败信息只有一句 403，**没有任何提示**说「你的权限是别人留下的」。
- **修复**：
  `http-status-semantics.e2e-spec.ts` 改为**自带权限**：
  照 `admin-account-management.e2e-spec.ts` 已有的正确范式 ——
  **唯一账号 + 唯一角色 + 显式授予本套件需要的权限**（`event:manage` + `alumni:manage`），
  并在 `afterAll` 清理自己创建的账号与角色
  （`admin_users` / `roles` 是保留表，不清理会挤进别的套件的分页 ——
  `admin-content` 的「第一页含 admin-test」假设就因此破过）。
- **新增「集成测试隔离性自检」** `infra/scripts/check-test-isolation.sh`：
  **每个套件单独跑都必须绿** —— 这才是「不依赖执行顺序」的可验证口径。
  配套反向验证 `check-test-isolation-selftest.sh`
  （在容器内把 `alumni:manage` 授权换成 `event:manage`，精确复现本缺陷原貌 →
  必须被判红 → 还原后必须判绿）。
- **教训**：
  **「整链绿」不等于「测试是对的」。**
  只要测试之间共享可变状态，绿不绿就取决于执行顺序 —— 而顺序是**环境产物**，不是代码属性。
  真正该问的不是「整链绿了吗」，而是「**每个套件自己跑绿吗**」。

### 159. CORS 反射**任意** Origin 且允许携带凭据（`origin: true` + `credentials: true`）

- **现象**：`main.ts` 里是 `origin: cors === '*' ? true : ...` 且 `credentials: true`，
  而 `CORS_ORIGINS` 的默认值就是 `'*'`。`origin: true` 的语义是「**回显请求里的任意 Origin**」，
  叠加 `credentials: true` 之后，**任何第三方站点**都能带着用户凭据调用本接口并读到响应。
  全仓**没有任何一条 CORS 用例**。
- **影响面**：正式部署只要没显式配 `CORS_ORIGINS`，就处于「任意站点可带凭据读接口」的状态。
- **处置**：新增 `src/config/cors.ts`（白名单精确匹配 + 子域通配 `*.example.com`），
  以中间件形式挂载（`app.use`），**白名单外的 Origin 一个 CORS 头都不给**，预检返回 403；
  `*` 只在非生产态可用且**不带凭据**；生产态 `*` 由启动期校验直接拒绝启动。
- **验证**：`test/integration/security-hardening.e2e-spec.ts`（正向 + **负向**：白名单外无响应头、
  生产态 `*` 不放行）。

### 160. 没有启动期配置校验：占位密钥可以直接上线

- **现象**：`JWT_SECRET` 的兜底值是仓库里的公开常量 `'change-me-to-a-long-random-string'`，
  数据库口令兜底 `''`，MinIO 密钥兜底 `''` —— 照抄 `.env.example` 就能带着**公开可猜的密钥**启动，
  任何人据此都能伪造任意用户（含管理员）的令牌。
- **处置**：新增 `src/config/config-validation.ts`，由 `ConfigModule.forRoot({ validate })` 调用：
  生产环境下 JWT_SECRET（≥32 字节、非占位值）、数据库口令、MinIO 密钥缺失或仍是占位值，
  或 `CORS_ORIGINS` 为 `*`、`AUTH_MODE` 未设 / 非法 / 为 `mock` —— **拒绝启动**；
  非生产态只打印提醒。仓库内**不含任何真实密钥**。
- **验证**：`test/integration/config-validation.e2e-spec.ts`（9 例负向断言）。

### 161. `AUTH_MODE` 非法取值 fail-open：拼错一个字母就重新打开 Mock 后门

- **现象**：`authMode` getter 把任何无法识别的取值都当成 `both` ——
  生产环境里把 `wechat` 写成 `wechats`，Mock 登录后门就**自动重新打开**，且没有任何报错。
- **处置**：改为 **fail-closed**：非法取值一律按 `wechat` 处理（关闭 Mock 登录）并打错误日志；
  生产环境未显式设置 `AUTH_MODE` 也拒绝启动。
- **验证**：`test/integration/auth-mode.e2e-spec.ts` 新增「非法取值」一组（Mock 登录 403 且不建用户）。

### 162. 限流按「路由处理器」分桶 + 没有 `trust proxy`：实际阈值被放大、且分不清攻击者

- **现象**：
  1. 计数 key 是 `ratelimit:{身份}:{路由处理器}:{窗口}`，而文档承诺的是「写接口 30 次/分钟」
     —— 逐路由分桶意味着**每个**写端点各有 30 次/分钟，攻击者把请求摊到多个端点即可放大数倍；
  2. 没有设置 `trust proxy`，Express 取到的 `req.ip` 是**Nginx 容器地址** ——
     所有走 Nginx 的匿名请求（浏览、登录、直传登记）共用**同一个 IP 计数桶**，
     限流实际变成「全站共享配额」，且无法区分攻击者。
- **处置**：计数桶改为「身份 + 接口类别（auth / write / read）」，与 `docs/SECURITY.md` 第 6 节一致；
  `main.ts` 按 `TRUST_PROXY_HOPS`（默认 1，API 端口只绑 127.0.0.1，仅 Nginx 可达）信任 1 跳代理。
- **验证**：`test/integration/rate-limit.e2e-spec.ts`（写端点之间共享额度）。

### 163. 学号「脱敏存储」只靠客户端自觉

- **现象**：`student_id_masked` 字段名写着 masked，DTO 也只校验「4~32 字符的字符串」，
  客户端提交**完整学号**时服务端原样落库 —— 明文学号进了数据库。
- **处置**：新增 `src/common/utils/mask.ts`，由**服务端**统一脱敏（保留首尾各 2 位）；
  后台按学号搜索时按同一规则脱敏后匹配，搜索能力不受影响。
- **验证**：`test/integration/privacy-hardening.e2e-spec.ts`（负向：库里检索不到完整学号）。

### 164. 证明材料可以被放进 **public 桶**

- **现象**：上传登记的 `visibility` 完全由客户端决定，
  `POST /uploads/records` 传 `visibility:'public'` 就能把身份证 / 学位证放进 public 桶 ——
  那个桶里的对象**拿到地址就能下载**。
- **处置**：认证申请引用证明材料时，服务端强制只接受**私有桶**资产，否则 400 且不写关联表。
- **验证**：`test/integration/privacy-hardening.e2e-spec.ts`（负向）。

### 165. 审计日志的外键是 `ON DELETE CASCADE`：删账号等于删证据

- **现象**：`admin_action_logs.admin_id` 的外键级联删除，
  `docs/SECURITY.md` 第 7 节承诺的「只追加」在**数据库层面**并不成立。
- **处置**：迁移 `1730000005000` 把外键改成 `ON DELETE RESTRICT`；
  两个会清理测试管理员的用例同步改成「先删审计记录再删账号」。
- **验证**：迁移在测试库上 `migration:revert` → `migration:run` 往返通过。

### 166. 安全响应头只在 Nginx，API 直连时一个都没有

- **现象**：应用层**没有任何**安全响应头（无 helmet、无手写中间件），
  而 API 端口（18081）在私网里可直接访问 —— 绕过 Nginx 时响应头全部缺失。
- **处置**：新增 `src/common/middleware/security-headers.ts`（与 Nginx 层同一份清单），
  应用与 Nginx 都覆盖；同时用 `proxy_hide_header` 消除**重复响应头**
  （同名头出现两次时浏览器可能整体忽略，反而更弱）。
- **验证**：`test/integration/security-hardening.e2e-spec.ts`（逐头断言）。

### 167. 列表接口的 N+1 查询：一页 20 条要打 66~103 条 SQL

- **现象**：`alumni` / `resources` / `connections` 三个模块的视图装配是
  `Promise.all(rows.map(row => toView(row)))`，而 `toView()` 每行 3~5 条 SQL。
  实测每页 20 条：管理端资源列表 **66 条**、认证审核列表 **65 条**、连接列表 **103 条** SQL。
- **处置**：改为「一次 `In(...)` 批量查 + 内存分桶」，查询数与页大小无关（9 / 8 / 6 条）。
- **验证**：新增 `test/integration/query-efficiency.e2e-spec.ts` —— 它同时是**回归守卫**
  （`queries <= 20`），逐行查询一旦回来就会被抓住。

### 168. 小程序首屏把每个请求打了两遍

- **现象**：9 个页面在 `onLoad` 与 `onShow` 里都调了同一个 loader，
  而微信的生命周期是 `onLoad → onShow → onReady` —— 首屏请求数直接翻倍
  （「我的」页 9 个请求，其中 4 个是完全重复的）。
- **处置**：新增 `apps/miniprogram/src/utils/first-show.ts`（按页面实例记录的 WeakMap 守卫），
  首次进入只加载一次，返回页面时仍然刷新。
- **验证**：小程序单测（新增 `test/first-show.spec.ts`）+ 五个静态校验脚本全绿。

### 169. 管理后台主 chunk 1.38 MB（UI 库被打包进应用 chunk）

- **现象**：`tdesign-vue-next` 不在 `manualChunks` 里，整个组件库被打进主 chunk
  （1,379,729 B），而 `chunkSizeWarningLimit: 2048` 恰好把这个问题静音了。
- **处置**：把 TDesign 拆成独立 chunk，并把告警阈值降回 500 KB（诚实地暴露体积问题）。
  主 chunk 1,379,729 B → **23,724 B**；`dist` 总量基本不变（+842 B）。
- **⚠️ 诚实说明**：**首屏下载量没有减少**（2,011,181 B → 2,011,270 B）——
  `main.ts` 里 `app.use(TDesign)` 是全局注册，产物仍被首屏预加载。
  真正的减负需要改成按需引入（会改动管理后台的组件注册方式，且需要真实浏览器验证），
  本轮**未做**，见「待验证 / 未完成」。

### 170. 审计日志的 `ip` 列从未被写过：管理端「来源 IP」恒为空

- **现象**：`admin_action_logs.ip` 这一列建表至今**一行都没写过** ——
  两处写审计日志的地方都没有设置它，而审计列表接口却把 `ip` 返回给管理端，
  于是后台「来源 IP」列**恒为空**，事后追溯拿不到任何来源信息。
- **处置**：新增 `src/common/services/request-context.service.ts`（`AsyncLocalStorage` 承载当前请求的
  来源 IP）与全局拦截器 `RequestContextInterceptor`，写审计日志时随取随用；
  服务由新的全局模块 `CommonModule` 提供（各模块共用同一个实例）。
- **验证**：`test/integration/admin-audit-atomicity.e2e-spec.ts` 新增一例：
  管理端写操作后，审计行的 `ip` 必须有值。

### 171. `pnpm-lock.yaml` 与 `package.json` 不同步（构建靠 `--no-frozen-lockfile` 绕过）

- **现象**：本轮执行 `pnpm install` 时 pnpm 重新生成了锁文件，差异 294 行 ——
  锁文件里 `apps/api` 的依赖还写着 `bcrypt@^5.1.1`，而 `package.json` 早已换成
  `bcryptjs@^2.4.3`（缺陷 #3 的处置：bcrypt 原生模块编不出来，改用 bcryptjs）。
  也就是说**仓库里的锁文件自那次替换之后就没再更新过**。
- **影响面**：`pnpm install --frozen-lockfile` 会因为「锁文件与 package.json 不同步」而失败；
  当前部署是靠 `INSTALL_FLAGS=--no-frozen-lockfile`（见 `infra/env/env.prod.example`）绕过的 ——
  也就是说**镜像构建实际上没有用锁文件锁住依赖版本**。
- **影响 CI**：主干新增的 CI 门禁（`.github/workflows/ci.yml`）用
  `pnpm install --frozen-lockfile` 安装依赖 —— 在**干净检出**里它会直接失败：
  `ERR_PNPM_OUTDATED_LOCKFILE`（先报 `apps/worker/package.json`，再报 `apps/api`）。
  也就是说**任何 PR 的 CI 都会卡在安装步骤**，与 PR 内容无关。
- **本轮的处置**：把锁文件**按 package.json 重新生成**并随本 PR 一起提交 ——
  这不是「升级依赖」，而是让锁文件**记录 package.json 里早已选定的依赖**
  （`bcryptjs@2.4.3` 是缺陷 #3 的既定处置，`apps/worker` 的 5 个依赖此前根本不在锁文件里）。
  重新生成后**没有任何依赖版本被改动**（与当前 `node_modules` 里的版本逐一相同），
  而 `pnpm install --frozen-lockfile` 在干净检出里恢复可用 ——
  依赖版本重新被锁住，构建不再靠 `--no-frozen-lockfile` 绕过。
- **验证**：干净副本里 `pnpm install --frozen-lockfile --lockfile-only` 退出码 0
  （修复前是 `ERR_PNPM_OUTDATED_LOCKFILE`）。

### 172. `pnpm lint` 从来无法执行：仓库既没有 `eslint` 依赖，也没有 ESLint 配置文件

- **现象**：`apps/api/package.json` 里的 `lint` 脚本是 `eslint "src/**/*.ts"`，
  `admin-web` 的脚本则写着「lint 由根仓库 ESLint 统一配置」——
  但仓库**根目录既没有 eslint 依赖，也没有任何 ESLint 配置文件**
  （`git log --all -- '.eslintrc*' 'eslint.config.*'` 为空）。
  于是 `pnpm lint` 一律报 `eslint: not found` 并以退出码 1 结束。
- **影响面**：主干新增的 CI 门禁里有一步就是 `pnpm lint` ——
  即使账号的 Actions 额度恢复，这一步也会让 CI 变红。
  （本 PR 的 CI 另有**更早**的阻塞：GitHub 侧报
  “The job was not started because recent account payments have failed or your spending limit needs to be increased”。）
- **处置（主干已完成，本 PR 沿用）**：主干在并行的一轮里把 ESLint 真正装上了
  （`eslint.config.mjs` + 根依赖 `eslint` / `@typescript-eslint/*`，
  并清掉 27 处真实的 lint 违规），本 PR 与主干同步后**直接沿用主干的配置与清理**，
  不再自带一份重复的工具链改动（避免两边配置漂移）。
  现在 `pnpm lint` 退出码 0，CI 的 Lint 步骤可以通过。
- **仍未覆盖**：管理后台的 `.vue` 单文件组件还没纳入 lint
  （需要 `vue-eslint-parser` + `eslint-plugin-vue`），小程序侧也没有 lint 脚本
  （它在微信运行时里跑，`Page` / `wx` 等是运行时注入的全局对象）。
  两者的把关方式目前分别是 `vue-tsc --noEmit` + `check-admin-web.mjs`、小程序静态校验脚本。

### 173. 仓库自己的 `CHANGE_ME_*` 占位值绕过了启动期校验（上一轮的防线对自家模板无效）

- **现象**：上一轮（opt-001）加了「生产环境缺密钥 / 用占位值 → 拒绝启动」的启动期校验，
  但占位值黑名单只认 `-` 分隔的写法（`change-me-xxx`）。
  而**仓库自己的模板用的全是下划线**：
  `docker-compose.prod.yml` 的 `JWT_SECRET: ${JWT_SECRET:-CHANGE_ME_jwt_secret_min_32_chars}`、
  `infra/env/env.prod.example` 的 `MYSQL_PASSWORD=CHANGE_ME_app_password`。
  这些值长度都 ≥ 32、格式又逃过黑名单 → **用默认 compose 参数起生产环境，校验全绿、照常启动**，
  而 JWT 密钥是**公开在仓库里的常量** —— 任何人都能伪造管理员令牌。
  也就是说：上一轮修掉的那个洞，在自家模板上原样还在。
- **处置**：占位值识别统一把 `_` 与 `-` 当同一个分隔符（`canonicalize`），
  并补上常见弱默认口令（`password123` / `secret123` / `admin123` / `123456`）。
- **验证**：`apps/api/test/integration/config-validation.e2e-spec.ts`
  「仓库自己的 CHANGE_ME_xxx 写法必须被识别成占位值」+
  「模板与 compose 里的占位密钥必须能被占位值识别命中」（直接读仓库里的两个文件做对账）。

### 174. 上一轮的启动期校验把**仓库自己的生产部署路径**挡在了门外

- **现象**：上一轮把「生产环境 `AUTH_MODE=mock`」改成拒绝启动，
  但 `infra/env/env.prod.example` 里仍然是 `AUTH_MODE=mock`，
  而 `infra/scripts/init-env.sh` 正是**照着这个模板**生成 `.env.prod` 的。
  于是：按仓库文档走一遍「生成 .env.prod → 起服务」，生产 API **起不来**（容器反复重启）。
  `docker-compose.prod.yml` 的默认值同样是 `mock`，不准备 `.env.prod` 直接 `compose up` 也起不来。
- **处置**：模板与 compose 的默认值改为 `both`（与**现网实际部署**一致：`AUTH_MODE=both`），
  并在模板里写明「正式上线改 wechat（人工安排）」；
  `AUTH_MODE=mock` 在生产环境依然会被启动期校验拒绝（这一条不放宽）。
- **验证**：新增用例「生产环境模板不得把 AUTH_MODE 设成 mock」「compose 的默认 AUTH_MODE 不得是 mock」
  —— 直接读仓库里的模板与 compose 文件做对账，防止再次漂移。

### 175. 管理员的默认口令是**公开在仓库里的常量**（`Admin@2026`）

- **现象**：两处：
  1. `apps/api/src/database/seeds/seed.ts` 硬编码 `admin / Admin@2026`，
     而且**每次跑 Seed 都会把口令重置**成它 —— 运维手工改过的强口令活不过下一次 Seed；
  2. `apps/api/src/modules/admin/admin-users.controller.ts` 建号时是
     `body.password ?? 'Admin@2026'` —— 管理端「创建管理员」不填初始口令，
     新账号的口令就是这个公开常量。
- **影响面**：`Admin@2026` 出现在 README、docs、seed 脚本里 —— 等同于「谁都能登进管理后台」。
- **处置**：
  - Seed 的账号名与口令改为从环境变量取（`ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_PASSWORD`）；
    生产环境**要求显式提供强口令**（缺失 / 仍是默认值 / 是占位值 / 短于 12 位 → 拒绝建号），
    且**不再重置**已存在账号的口令（开发/测试环境保留原来的可重复行为）。
  - 管理端建号的初始口令**改为必填**（DTO 层校验，缺失或短于 8 位直接 400），
    仓库里不再有任何「默认管理员口令」的回退路径；
    管理后台的表单校验同步从 6 位改成 8 位。
- **验证**：`admin-account-management.e2e-spec.ts` 新增两例：
  「创建管理员不传初始口令 → 400（且账号根本没被建出来）」、
  「传了初始口令 → 只能用这个口令登录，仓库里的公开默认口令登不进去」。

### 176. CORS 白名单接受子域通配，与文档口径不一致

- **现象**：`docs/SECURITY.md` 第 8 节写的是「只接受配置里列出的**具体域名**，不接受通配符」，
  但 `config/cors.ts` 与 `config/config-validation.ts` 都支持 `https://*.example.com` 这种子域通配。
  文档与实现不一致 —— 按「以更严格的一侧为准」处理。
- **处置**：白名单**只做精确匹配**，通配写法一律不认；
  启动期校验也把带 `*` 的 origin 判为非法（生产环境直接拒绝启动）。
- **验证**：`security-hardening.e2e-spec.ts` 的用例从「子域通配匹配子域」改成
  「子域通配**不被接受**」；`config-validation.e2e-spec.ts` 同步。

### 177. 解除连接之后，连接详情仍返回对方的资料

- **现象**：`connections.service.ts` 的 `getConnection()` **不校验关系状态**：
  列表接口只给 `status='active'` 的关系，详情接口却连已解除（`revoked`）的关系也照给 ——
  对方的学院 / 地区 / 行业仍然拿得到（联系方式虽已随解除被撤销，资料字段还在）。
  两边口径不一致，等于「解除连接」之后仍能查到对方资料。
- **处置**：详情与列表口径统一 —— 非 `active` 的关系一律 404（不泄露关系是否存在）。
- **验证**：`connections.e2e-spec.ts` 新增一例「解除连接后：列表里没有、详情也 404」。

### 178. 管理后台的静态资源**一个安全响应头都没有**（nginx 的 add_header 不跨层继承）

- **现象**：`infra/nginx/admin-web.conf` 的 `location /assets/` 里只有一条
  `add_header Cache-Control ...`；而 nginx 的规则是「**当前层级只要出现任何 add_header，
  就不再继承父层的全部 add_header**」——
  于是直连管理后台静态资源（compose 把 18082 映射到宿主机）时，
  `X-Frame-Options` / CSP / HSTS 等**全部缺失**。
- **处置**：`location /assets/` 内补齐与 server 块同一份安全头清单（nginx 没有变量化的 add_header，只能重复）。
- **验证**：`infra/scripts/check-admin-web.mjs` 之外，本条以配置对账 + 人工复核为准
  （本机没有直连 admin-web 容器的 nginx 实例，未做端到端抓包 —— 记为待验证）。

### 179. 认证失败的请求**完全不受限流保护**

- **现象**：全局守卫的执行顺序是 `JwtAuthGuard → PermissionsGuard → AlumniStageGuard → RateLimitGuard`，
  而限流守卫排在**最后**。于是「不带头 / 带头但无效」的请求在到达限流之前就被 401 拒掉，
  **一分钱额度都不消耗** —— 攻击者只要在请求头塞一个垃圾 `Bearer` 值，
  就能对受保护端点无限打。文档第 6 节承诺的「按用户或 IP 计数」对这些请求并不成立。
- **处置**：把计数逻辑抽成 `RateLimiterService`（`common/services/rate-limiter.service.ts`），
  `JwtAuthGuard` 的失败路径也调用它（按 IP 计额）；超阈值直接 429，没超才回原来的 401。
  顺带修正了类别判定顺序：**先看 handler 名再看方法** —— 否则登录 / 刷新（全都是 POST）
  会被判成 write 档，「登录 20 次/分钟」这一档形同虚设。
- **验证**：`rate-limit.e2e-spec.ts` 新增一例「带伪造令牌的请求同样消耗额度，超过阈值后返回 429」。

### 180. 上一轮迁移的注释**承诺了两个从未落地的索引**

- **现象**：迁移 `1730000005000` 的注释里明确写着要补
  `articles.category_id` 与 `admin_action_logs.created_at` 两个索引，
  但文件里的 `INDEXES` 常量**只有 3 条**，这两个**从未被创建** ——
  「注释承诺了、库里其实没有」。
- **处置（本轮实测后决定取舍）**：
  - `articles(category_id, published_at)` **落地**（迁移 `1730000006000`）：
    实测「按分类筛选 + 按发布时间倒序」的 COUNT **23.78 ms → 2.53 ms（9.4×）**，
    执行计划从 `idx_articles_published`（扫 10000 行）换成 `idx_articles_category`（扫 2000 行）。
  - `admin_action_logs(created_at)` **不落地**：实测宽时间区间（30 天）COUNT 前后一致
    （20.94 ms → 21.47 ms，优化器仍选 `idx_admin_action_logs_admin` 的 skip scan），
    窄区间（1 天）只有 0.94 ms → 0.80 ms —— 收益微弱，
    按上一轮定下的规矩「**没有实测数字的索引不写进生产库**」不加。
    迁移 5000 的注释已改成不再声称自己建了它；本轮的新迁移也不含它。
- **另加一个实测有收益的索引**：`event_registrations(user_id, id)`
  （实测 SELECT 5.45 ms → 0.23 ms、COUNT 2.07 ms → 0.14 ms，
  执行计划从「主键倒序扫 + 逐行过滤」换成「按 user_id 直接定位」）。
- `connection_pairs(user_b_id, id)` **不落地**：实测（2 万条连接对）SELECT 0.266 ms → 0.313 ms、
  COUNT 4.676 ms → 4.747 ms —— OR 两侧优化器仍走主键倒序扫 / 全表扫，**没有改选**新索引，
  按同一条规矩不加。
  实测数字与命令见 `docs/TEST-REPORT.md` 第 8 节。

### 181. 响应结构校验器的「字面量联合取值校验」**恒过**，第三轮改的四个端点**结构从未被校验**

- **现象**（第四轮复核发现）：
  - `infra/scripts/check-response-shape.mjs` 的 `splitUnion()` 按顶层 `|` 切分联合类型时
    **不丢弃空片段**。而契约里的联合类型几乎都写成多行、**首行就是一个 `|`**：
    ```ts
    export type AdminRole =
      | 'super_admin'
      | 'alumni_reviewer'
      ...
    ```
    此时第一个片段是**空字符串** → 后续逻辑把空片段当成
    「这个值符合空类型」→ **任何取值都判定为通过**。
    于是**所有字面量联合（枚举）的取值校验整体恒过**：
    服务端返回 `status: 'totally_bogus_status'`、`roles: ['totally_bogus_role']`
    也不会报错（已实测注入验证）。
  - 同一脚本的**调用点扫描**只认 `apiGet` 的泛型。而管理后台这四个第三轮端点的
    真实返回类型写在**包装器** `readPageResult<T>(raw, path)` 的泛型上
    （`apiGet` 的泛型是 `unknown`）→ 这四个端点被记成 `unknown` → **结构从未被校验**。
    第三轮改的恰恰就是这四个端点（`GET /admin/roles|permissions|settings`、
    `GET /admin/events/:id/registrations`）。
- **影响**：响应结构这一层**形同虚设** —— 它守的是「服务端返回的字段与契约声明对不上」
  这一类缺陷，而这类缺陷**不抛异常**：页面照常渲染，只是列是空的、筛选项是摆设。
- **处置（本轮）**：
  1. `splitUnion()` 丢弃空片段 → 字面量联合的取值校验真正生效；
  2. 调用点扫描**补扫包装器**：`readPageResult<T>` 的泛型是**条目**类型，
     返回类型是 `PageResult<条目>`，路径在第 2 个实参上；
  3. 同一个端点上「`unknown` + 真实类型」并存时**保留真实类型**
     （`unknown` 不校验任何东西，留在报告里只会让人误以为该端点的声明类型就是 `unknown`）；
  4. **反向验证**补两个用例（见 `infra/scripts/check-response-shape-selftest.sh`）：
     注入越界的枚举取值、注入缺失字段的 `/admin/roles` 条目 → **都必须被抓出来**。
- **顺带修正**：`infra/fixtures/response-shape/GET_admin_events_1_registrations.json`
  这份夹具是**第三轮之前**录的（`data` 是裸数组），与第三轮改成 `{items, meta}` 后的
  真实响应已经对不上 —— 之前校验器把它记成 `unknown` 才没暴露。
  本轮按第三轮的真实结构重录。

### 182. 角色代码是**开放集合**，但契约写成了封闭联合 `AdminRole`

- **现象**：第四轮把上面的联合取值校验修好之后，响应结构校验器立刻在
  `GET /admin/users` 上报出真实差异：
  `items[1].roles[3]` 取值 `attachment_reviewer` 不在契约声明的 5 个角色代码里。
- **真相**（已逐条核实）：
  - `roles` 表的 `code` 是 **`VARCHAR(32)`**（不是 ENUM）—— **自由文本列**，
    角色目录本就是可扩展的目录表（`DATABASE-DESIGN.md` 第 8 节把它列为目录表，
    只有「初始角色」由 Seed 写入，见 `docs/top.md` 第 4.2 节）；
  - 服务端**自己的入参 DTO** 就是 `roles?: string[]`
    （`apps/api/src/modules/admin/dto/`），比契约的 `AdminRole[]` **更宽**；
  - 服务端**出参**也是按库里实际存的代码返回的
    （`admin-users.controller.ts` 的 `roleCodesOf()` 返回 `string[]`）；
  - 前端早就**按开放集合**消费：`ROLE_LABELS[role] || role`、`ROLE_PERMISSIONS[role] || []`
    —— 拿不到内置标签时**回退到代码本身**，这正是开放集合的写法；
  - 内置的 5 个角色由 `check-rbac-matrix.mjs` 守着（契约联合 ≡ 种子角色 ≡ 前端矩阵），
    那是**另一层**保证（内置角色不能漂移），与「管理员持有的角色代码是否封闭」无关。
- **处置**（本轮）：契约按实现放宽（与本文件 #64 / #65 同一类漂移的既有处置方式一致）：
  `AdminUserDto.roles` 与 `AdminRoleDto.code` 由封闭联合改为 `string` / `string[]`；
  `AdminRole` / `AdminPermission` 两个联合**保留**（它们守的是内置角色与权限点的目录一致性）。
  管理后台前端与契约同步（角色标签/权限矩阵对未知代码的既有回退逻辑保持不变）。
- **同步到哪**：`packages/contracts/src/domain.ts`、`packages/contracts/src/api.ts`、
  `apps/admin-web/src/**`（`AdminUserDto.roles` 与 `UpdateAdminUserBody.roles` 的类型）。

### 183. 系统设置页**没有分页控件**：第三轮把端点改成分页后，客户端仍硬编码 `page=1&pageSize=100`

- **现象**（第四轮浏览器冒烟发现）：`GET /admin/settings` 第三轮已改成分页结构，
  但 `apps/admin-web/src/views/system/SettingsView.vue` 仍硬编码
  `fetchSettings({ page: 1, pageSize: 100 })`（且**不渲染 `PagerBar`）
  → **配置项超过 100 条时，后面的行永远看不到**（服务端 `pageSize` 上限就是 100）。
  这是「契约改了、客户端没跟上」的典型漏项：端点分页了，页面却当全表用。
- **处置**：按仓库统一约定（`usePagedList` + `PagerBar`，与「管理员账号」页一致）改写该页：
  走 `usePagedList` 消费分页结构、渲染 `PagerBar`、换页时重建草稿
  （否则上一页的草稿会串到下一页）。
- **不动**「角色权限」页：那一页要把**整份目录**（角色 × 权限矩阵）一次取全才能渲染矩阵，
  分页反而会渲染出残缺的矩阵 —— 它取整目录是有意的，不是漏项。

### 184. 冒烟脚本把「空表」误报成「服务端少给了字段」

- **现象**：`/resource`（资源审核）与 `/system/logs`（审计日志）两页冒烟报
  「表格里找不到列『发布人』/『操作人』」。真相是：**这两张表在测试库里是空的**
  （seed 不造资源与审计记录），TDesign 在空表时渲染的是**空状态、根本没有 `<table>`**，
  列自然找不到 —— 与「服务端少给了字段」是两回事。
- **此前的处置是绕过去的**：第三轮「补了几行测试数据后两页均通过」（见本文件第 3239 行）。
  测试数据一撤，问题原样复现 —— **绕过去的不是修好的**。
- **处置**：列内容断言**先看这一页有没有渲染出表格**：
  没有表格 → 记为「空表 / 空状态，跳过列内容断言」（不算缺陷）；
  有表格但找不到该列 → 仍然是缺陷（服务端确实少给了字段）。
  这样「空表」与「字段缺失」不再混为一谈，且**不依赖**测试库里有没有数据。

### 185. 同一个管理员先后挂不同角色 → 令牌带着**旧角色的权限点**（干净库必红、脏库必绿）

> 这一条是第四轮**修 CI 时挖出来的既有缺陷**（不是本轮引入的）：
> 在**未改动**的基线修订上，用**干净种子库**跑集成测试同样复现（1 例失败）。

- **现象**：`attachments.e2e-spec.ts` 的 `#77` 用例
  （管理员凭 `resource:review` 取资源附件地址）拿到 **403**。
  而同一个套件在**跑脏的库**上却是绿的。
- **机制**（两条独立的因素叠在一起）：
  1. **RBAC 身份是按管理员 id 缓存的**（`CacheKeys.adminRbac`，TTL ≤30 秒，
     见 `docs/SECURITY.md` 第 2.1 节）。`ensureAdmin()` 是**直接写库**、
     **绕过了 API** → 写完角色**不会**让缓存失效
     （只有走 API 的改角色写端点才会调 `invalidateAdminCache`）。
  2. 该套件的 `adminToken()` 默认**同一个管理员账号**（`admin-test`）配**同一个角色**
     （`attachment_reviewer`），却先后要它带**不同的权限点**
     （先 `verification:review`、后 `resource:review`）。
     角色与权限点是**多对多**（`role_permissions`）→ 同一个角色先后拿到哪个权限，
     **取决于哪个用例先跑**。
  于是**第一次登录时缓存下来的角色集会被后续沿用** → 令牌带着旧权限点 → 403。
- **为什么「干净库红、脏库绿」**：脏库里那个角色**早已攒下**另一个权限点
  （上一轮跑完残留的），所以看起来是好的。
  **CI 每次都是干净库** → 必然踩到 → 这就是 CI 上 Integration tests 失败的原因。
- **处置**：**一个角色一个管理员账号**（`adminToken()` 按角色派生账号名），
  各自的缓存条目互不干扰；并把这些账号纳入套件清理。
  另外补记：角色与权限点是多对多，**一个角色不该被用来表达两种权限**。

### 186. RBAC 缓存与「撤权延迟为 0」这两条承诺**此前没有任何用例守着**

- **现象**：`docs/SECURITY.md` 第 2.1 节承诺了两件事 ——
  ① 管理端请求不再每请求重算 RBAC（缓存「这个管理员有哪些权限点」）；
  ② 停用 / 降权时**主动失效**，本进程内「降权后仍能操作」的窗口是 **0**。
  但集成测试里**没有一条用例**覆盖这两点：
  - 既有用例要么用刚建好的账号（第一次请求本来就是冷的）；
  - 要么在降权之后**重新登录**（换了新令牌，缓存里压根没有旧条目）。
  于是把缓存改成「永不失效」、或把 `invalidateAdminCache` 那行注释掉，
  **整个集成测试套件（46 套件 / 359 例）照样全绿**。
- **为什么危险**：这正是「安全语义一旦回退，既有测试不会变红」的土壤 ——
  与缺陷 #185（干净库必红、脏库必绿）属于同一类。
- **处置**：新增 `apps/api/test/integration/rbac-cache.e2e-spec.ts`（4 条用例，本轮实测全绿）：
  1. **缓存确实生效**：同一个令牌连续两次请求 `GET /admin/alumni` → 第二次少打 **3 条 SQL**
     （RBAC 解析那三条：`admin_users` + `admin_user_roles` + `role_permissions`）；
     实测**冷启动 4 条 → 命中缓存 1 条**。
  2. **降权后立刻 403**：管理员被改角色后，**不重新登录**、用**同一张令牌**再请求 →
     **403 `FORBIDDEN`**（若主动失效失效，这里会放行 200）。
  3. **停用后立刻 401**：账号被停用后，**同一张令牌**再请求 → **401 `AUTH_REQUIRED`**。
  4. **未读通知数不缓存**：`/me/summary` 的 `unreadCount` 当场反映新插入的通知（0 → 1）。
- **顺带记一条**：`roles.code` 列是 **VARCHAR(32)**（见 `InitSchema` 迁移）——
  角色编码超过 32 字符会被数据库**直接拒绝**（`Data too long for column 'code'`）；
  写测试角色编码时要注意长度（本轮第一次写这个套件就踩到了）。

### 187. 多实例部署时「撤权跨实例即刻生效」此前**没有实现**（第五轮补上）

- **现象**：第三轮引入的 RBAC 缓存是**进程内**的，「停用 / 降权」的主动失效
  **只清发起写操作的那一个实例**的缓存 ——
  多实例部署时，其余实例最多要等 **TTL（≤60 秒）** 才生效
  （口径写在 `docs/SECURITY.md` 第 2.1.4 节，此前只有「TTL 兜底」这一档）。
- **为什么重要**：这是仓库自己记录的**最后一个可自行实现的安全缺口**
  （`docs/SECURITY.md` 第 2.1.4 节曾写「若将来要求撤权跨实例即刻生效，
  正确的做法是共享失效总线（Redis pub/sub）」；Redis 已在依赖里，不引入新基础设施）。
- **处置（第五轮）**：新增共享失效总线（Redis pub/sub）：
  - 口径**先写进文档**（`docs/SECURITY.md` 第 2.1.4 / 2.1.5 节）：
    撤权延迟分三档 —— 单实例 **0**；多实例 + 总线可用 **0**；
    多实例 + 总线不可用 **≤ TTL（≤60 秒）**；
    总线**只传失效事件、不传权限内容**；**未读通知数依旧不缓存**；
  - 实现：`apps/api/src/common/services/invalidation-bus.service.ts`
    （发布端在**管理端写操作事务提交后**发布；订阅端在**实例启动时**订阅并清掉本地条目），
    频道名**走配置**（`RBAC_INVALIDATION_CHANNEL`，默认基准名 `nmg:rbac:invalidate`），
    **按环境隔离**（生效频道 `nmg:prod:` / `nmg:dev:` / `nmg:test:`），
    可用 `RBAC_INVALIDATION_ENABLED=false` 关闭；
  - **降级路径是硬要求**：Redis 不可用 / 订阅断开时，
    管理端写操作**照常成功**（不抛错、不回滚业务写），撤权延迟回落到 TTL 上界；
  - 用例：`apps/api/test/integration/rbac-invalidation-bus.e2e-spec.ts`（4 例）
    —— 同进程**两个应用实例 + 一个 Redis**：实例 A 降权 → 实例 B 的缓存
    **26~93 ms 内**失效（**不等 TTL**）；总线不可用时写操作仍 200、
    且 TTL 窗口过后由 200 变 403（**不是永久放行**）；
    另有一条用例直接监听频道，断言总线上流动的消息**只有**
    `{"kind":"admin","adminId":N}`，**不含任何权限内容**。
- **仍未做的（有意为之）**：~~字典 / 分类 / 系统设置的**跨实例**失效没有上总线~~ ——
  **第六轮已补上**（见下方 #188）：它们的跨实例陈旧上界从「各自的 TTL」变成
  「总线可用 = 0 / 总线不可用 = ≤ TTL」，走的是**同一条总线、同一套降级路径**。

### 188. 字典 / 分类 / 系统设置的**跨实例**失效此前**没有**上总线（第六轮补上）

- **现象**：第五轮的总线**只承载 RBAC 失效事件**（`kind` 只有 `admin` / `rbac-all`）。
  分类 / 字典 / 系统设置在**其它实例**上仍要等各自的 TTL（默认 ≤60 秒、硬上限 ≤300 秒）才变 ——
  管理员在 A 实例改完分类，B 实例上的公开页面**半分钟内还是旧的**。
- **为什么值得修**：这不是安全语义（越权与否与字典无关），但它是一个
  **「改完不生效」的观感缺陷**，而且**没有明确上界**就容易被当成故障。
  仓库里已有的基础设施（Redis pub/sub）正好能复用，**不引入新东西**。
- **处置（第六轮）**：
  - **口径先写进文档**（`docs/SECURITY.md` 第 2.1.6 节）：
    字典 / 分类 / 设置的跨实例陈旧上界 = 单实例 **0**；多实例 + 总线可用 **0**；
    多实例 + 总线不可用 **≤ TTL**（默认 ≤60 秒、硬上限 ≤300 秒）；
  - **复用**第五轮的总线（`apps/api/src/common/services/invalidation-bus.service.ts`），
    只**多一种 `kind`**：`{"kind":"dict","dict":"categories" | "settings" | "all"}` ——
    **不新起总线、不新起频道、不引入新基础设施**；
  - 发布端：分类增删改（`POST/PATCH/DELETE /admin/articles/categories`）与
    系统设置写入（`PUT /admin/settings`）在**事务提交之后**发布；
    订阅端清掉本地对应的 `dict:*` 条目（分类变更只清 `dict:categories`，
    设置写入只清 `dict:settings`；地区 / 行业字典没有写端点，不在事件取值里）；
  - **降级路径与第五轮完全一致**：Redis 不可用时写操作**照常成功**（不抛错、不回滚），
    陈旧延迟回落到 **TTL 上界**，**不是永久陈旧**；
  - **总线仍然只传失效事件、不传内容**：字典类事件里**没有分类名、没有设置项的
    key / value**（设置里可能有敏感配置 —— 审计表都不记 value，总线更不能记）；
  - 用例：`apps/api/test/integration/dict-invalidation-bus.e2e-spec.ts`（6 例，本轮实测全绿）。
- **仍然要靠人工**：多实例部署时所有 API 实例必须连**同一个 Redis**
  （否则总线不生效，陈旧回落到 TTL 上界）；频道名同环境各实例要一致。

### 189. 通知深分页的**真正解法**是游标分页（keyset pagination）—— 但它会**改对外契约**

- **现象**：`docs/TEST-REPORT.md` 第 12.5 节用 `EXPLAIN ANALYZE` 实测过：
  深分页的耗时**由 `OFFSET` 决定**（`OFFSET 1980` → **54 ms**；`OFFSET 0` → **0.03 ms**），
  而 `(user_id, id)` 索引在优化器眼里**没有任何收益**（加与不加，计划与耗时都相同：
  54.8 / 53.9 / 53.5 ms，差异在噪声内；`FORCE INDEX` 反而更慢：2.87 ms vs 自选 1.32 ms）。
- **结论**：**加索引解决不了深分页**，只有换成 keyset pagination
  （`WHERE (user_id, id) < (:cursorId) ORDER BY id DESC LIMIT 20`）才能让第 N 页与第 1 页一样快。
- **为什么本轮不改**：keyset pagination 会**改对外契约** ——
  `page` / `pageSize` 语义要变成「游标 + 是否还有下一页」，
  两端客户端（管理后台、小程序）与 `packages/contracts` 都要跟着改，
  属于**契约变更轮**（第三轮那类），不在本轮授权范围内。
- **本轮只写决策记录**（不改契约、不改行为）：
  - 目标：把 `GET /me/notifications` / `GET /notifications` 这类**深翻页**列表端点
    改为「游标 + `hasMore`」，保留 `page` / `pageSize` 一段过渡期
    （旧参数还能用，但深页会提示改用游标）；
  - 兼容面：契约（`packages/contracts`）、管理后台列表、小程序「通知」页；
  - 风险：`OFFSET` 跳页能力会消失（「跳到第 50 页」要靠游标连翻），
    若产品要保留跳页，就只能保留 `OFFSET` 路径并接受它的耗时；
  - 验收口径：同一数据集下，第 50 页的耗时应与第 1 页**同量级**。
- **需要谁拍板**：**产品 / 客户**（对外契约变更 + 跳页能力的取舍），
  仓库侧在收到确认前维持现状（数字见 `docs/TEST-REPORT.md` 第 12.5 节）。

### 190. 资讯分类 **slug 重复**返回 500（Internal Server Error），而不是 409 CONFLICT（第七轮发现，第八轮已修）

- **现象**：`POST /admin/articles/categories` 用**已存在**的 `slug` 再建一个分类时，
  服务端返回 **500 Internal Server Error**（唯一索引 `uk_article_categories_slug` 冲突
  被直接抛成未处理异常），而不是管理端账号端点那套「**409 CONFLICT**」的错误语义
  （`docs/API-SPEC.md` 第 11 节「管理端写操作的错误语义」）。
- **为什么它值得记**：错误码**不可预期**会直接伤到管理端 ——
  管理端按 `code` 分支处理，500 会被当成「服务端故障」而不是「你填的 slug 重复了」，
  运维与用户都会拿错信息去排查。
- **处置（第八轮）**：
  - **修复**：`ContentService.createCategory` / `updateCategory`
    捕获唯一键冲突（`ER_DUP_ENTRY` / 1062）并转成 **409 `CONFLICT`**；
    ⚠️ 处置方式是**捕获冲突并转 409**，**不是**去掉唯一索引
    （那等于允许重名分类，是数据损坏）。
  - **顺带扫了同类唯一键冲突端点**：管理端写端点能触发的唯一键共 3 处 ——
    `admin_users.username`（原本已是 409，第八轮把判定换成仓库共用的
    `isDuplicateKeyError`，此前只认 `ER_DUP_ENTRY`、漏判 `errno=1062` 那种形态）、
    `article_categories.slug`（本条，已修）、`system_settings.key`
    （并发 upsert 重试耗尽后原先抛成 500，第八轮改为 **409**）。
    其余管理端写端点所涉的表**没有唯一列**（文章 / 公告 / 活动 / 资源 / 审核）。
  - **口径写进文档**：`docs/API-SPEC.md` 第 11 节「管理端写操作的错误语义」
    （原「管理端账号端点的错误语义」）补上分类与设置两行，并写明
    「唯一键冲突必须是 409，不能是 500」。
  - **用例**：`apps/api/test/integration/admin-write-error-semantics.e2e-spec.ts`
    （8 例）：注入冲突数据必须得到 409 / `CONFLICT`；
    冲突时**事务整体回滚**（不多出分类、不留下审计痕迹）；
    不存在的对象 → 404；缺参数 → 400。
  - **守护脚本**：新增 `infra/scripts/check-error-semantics.mjs`
    （唯一键登记表 ↔ 实现 ↔ 文档三方对账），并按仓库规矩做了**反向验证**
    （`infra/scripts/check-error-semantics-selftest.sh`：
    冲突处置被改回 500 / 新增唯一列没登记 / 口径改了但文档没改，三类缺陷都被抓出）。
- **验收口径**：注入冲突数据必须得到 **409 / `CONFLICT`**（而不是 5xx）；
  且**不得**靠放宽校验（去掉唯一索引）来「解决」它 —— ✅ 已达成。

### 191. 八个校验器的**反向验证**只在一个合并脚本里、而且**从来没进过 CI**（第八轮发现）

- **现象**：`infra/scripts/` 下这 8 个校验器
  （`check-miniprogram.mjs` / `check-admin-web.mjs` / `check-contract-mirror.mjs` /
  `check-rbac-matrix.mjs` / `check-contract-routes.mjs` / `check-api-spec-doc.mjs` /
  `check-client-paths.mjs` / `check-spec-coverage.mjs`）
  此前**没有**各自的 `-selftest.sh`；它们的反向验证全在**一个**合并脚本
  `check-frontend-selftest.sh` 里，而那个脚本**没有接进 CI**
  （只在 README / `docs/TEST-REPORT.md` / `infra/scripts/test-integration.sh` 里被提到）。
  后果是：这些校验器「有没有恒过」在 CI 里**从来没被验证过** ——
  与缺陷 #44 / #45 记的是同一片土壤。
- **为什么它值得记**：仓库的硬规矩是「**每个校验器都必须做反向验证**」，
  但这条规矩此前只对 6 个校验器（各自有 `-selftest.sh` 且进了 CI）成立。
- **处置（第八轮）**：
  - 给这 8 个校验器**各补一份** `-selftest.sh`（沿用仓库既有模板：
    正向基线 + 逐个用例注入缺陷 + 元自检 + 清理临时副本）；
    注入用例**全部复用** `infra/scripts/selftest-inject.mjs` 里**已有**的用例，
    没有新增注入点（新增注入点会依赖现有代码的写法，实现一演进就失配）。
  - **接入 CI**：纯静态的四个（miniprogram / admin-web / contract-mirror / rbac-matrix）
    与本轮新增的错误语义自测放进「Checker reverse verification (selftests)」那一步；
    依赖**跑着的 API** 的四个（contract-routes / api-spec-doc / client-paths /
    spec-coverage）另起一步，放在 API 起来**之后**并显式传 `--swagger`
    （默认地址上可能是**旧构建**的 API，基线会如实报出不一致并失败，不会假绿）。
  - 顺带修正一处**归属错误**：`MIRROR_LITERAL_PATH` 由 `check-client-paths.mjs`
    产出（不是 `check-contract-mirror.mjs`）—— 该用例挪到
    `check-client-paths-selftest.sh` 里断言。
- **仍需人工**：以上门禁只在 **CI** 里自动跑；本地要手动执行对应的 `-selftest.sh`。
- **补不了的（写明原因）**：`infra/scripts/` 下剩余的三个脚本**不做**反向验证，
  原因是它们**不是「判定型」校验器**，或**造不出可注入的仓库内对象**：
  | 脚本 | 为什么补不了 |
  |---|---|
  | `check-miniprogram-demo-content-inject.mjs` | 它是**注入器**（给 `check-miniprogram-demo-content.mjs` 造缺陷用的辅助脚本），本身不判定任何东西 —— 它的反向验证由调用它的 `check-miniprogram-demo-content-selftest.sh` 承担 |
  | `check-public-edge-e2e.sh` | 验的是**已部署的公网边缘链路**（边缘 nginx → SSH 反向隧道 → 后端），判定对象在**部署环境**里、不在仓库里 —— 仓库侧无法「注入缺陷」；它的脚本内已自带一条反向验证（端口冲突必须被发现） |
  | `admin-ui-smoke.mjs` | 浏览器冒烟，需要**真实浏览器**（Playwright + Chromium）；它的失败即非 0，不存在「判定码恒过」这一层，但它同样跑不出「注入缺陷」的自证场景 |

### 192. 多实例部署的「总线自证」此前**要人记得单独 curl**（第八轮接进运维巡检）

- **现象**：第七轮给了只读运维端点 `GET /api/v1/admin/ops/invalidation-bus`
  （逐实例查 `subscribed` / `channel` / `degraded`），但**没有任何脚本**会去看它 ——
  多实例部署时「某个实例压根没订阅上频道」这件事，
  只有人**记得**逐个实例 curl 才会暴露；
  而那一档的撤权 / 字典失效延迟会**回落到 TTL 上界**（≤60 秒 / ≤300 秒），
  表现成「偶尔不生效」，极难定位。
- **处置（第八轮）**：把该端点接进既有运维巡检脚本 `infra/scripts/healthcheck.sh`：
  - **逐实例**查询（在**容器内部**查本实例，不经 nginx ——
    经 nginx 只会打到负载均衡后的某一个实例，那样就看不出「是哪一台没订阅上」）；
  - 判定：`enabled=1` 且 `subscribed=0` → **FAIL**（并点名频道名）；
    `enabled=0` → 总线被整条关闭，**不是故障**；
    各实例 `channel` **不一致** → FAIL（事件互相打不到）；
    有 `lastError` → WARN 并打印；
  - 认证：该端点只对管理员开放，所以巡检要一个管理员凭据
    （`ADMIN_HEALTHCHECK_TOKEN` > `ADMIN_HEALTHCHECK_USERNAME/PASSWORD`
    > `.env.prod` 的 `ADMIN_BOOTSTRAP_USERNAME/PASSWORD`）；
    **都取不到时跳过这一项**（不是失败），但跳过这件事会**打印出来**，不静默。
- **仍需人工**：本轮**只在仓库侧**把手段做齐（脚本 + 判定口径 + 文档），
  **上线环境是否真的跑过一次巡检**（多实例部署下逐实例 `subscribed=1`、频道一致）
  仍属部署侧动作，见「共享失效总线的**部署侧**要求」那一行。
  口径与读法见 `docs/SERVER-OPERATIONS.md` 第 2.1 节。


### 193. 用户侧写端点的**唯一键冲突**此前一律抛成 500（第九轮发现并修复）

- **现象**：第八轮把「写操作的错误语义」核到了**管理端**，
  用户侧（校友本人）的写端点**逐条都没核过** ——
  连接申请（`uk_connection_request_pending`）、联系方式授权（`uk_contact_grant`）、
  活动报名（`uk_event_registration`）、资源附件（`uk_resource_post_attachment`）、
  认证附件（`uk_verification_attachment`）、用户 openid / unionid
  （`uk_users_openid` / `uk_users_unionid`）、会话 refreshToken
  （`uk_user_sessions_token`）、校友档案与联系方式行（主键 `user_id`）。
  核出来的结果是：**这些键撞上时，数据库异常大多直接冒泡成 500**，
  用户看到的是「服务器内部错误」，而真实原因只是
  「你已经报名过了」「这个微信账号已绑定另一个账号」「另一个请求刚好把账号建好了」。
- **为什么它值得记**：错误码不可预期会直接伤到用户端 ——
  客户端按 `code` 分支，500 会被当成「服务端故障」，
  于是用户刷新页面、运维查服务健康度，而真实原因是一次**并发**。
- **处置（第九轮）**：
  - **修复**（不改业务语义，只把「不可预期的 500」换成**可预期的错误码**）：
    并发首登 → **重跑整个事务**（重跑时是新的快照，能看到对方刚提交的行）；
    同一 unionid 绑了两个账号 → **409**（业务冲突，先查清楚再报）；
    会话令牌撞键 → 重新签发一次，仍撞才 **409**；
    重复报名 / 重复附件 / 重复材料 → **409**；
    并发建档 / 并发建联系方式行 → **读回既有行**（幂等），读不到才 **409**；
    连接申请的 pending 唯一键 → 幂等返回既有申请，读不到才 **409**；
    联系方式授权 → 并发时**更新既有授权行**（幂等），读不到才 **409**；
    幂等键（`uk_idempotency`）占用 → **409 `IDEMPOTENCY_CONFLICT`**（不再抛 500）。
  - **登记表扩到用户侧**：`infra/scripts/check-error-semantics.mjs` 的唯一键登记表
    现在**扫全部实体文件**（单列唯一、复合唯一、主键自然键共 21 条），
    少登记一条就报错；每条还必须写清「撞键时返回什么、在哪处置」。
    判定也从「方法体里有没有 `ConflictException`」收紧到
    **「捕获重复键的那一段里有没有给出可预期结果」** ——
    否则同一个方法里别的冲突分支会让校验器变成恒过的。
  - **口径写进文档**：`docs/API-SPEC.md` 第 11 节新增
    「用户侧写操作的错误语义」小节（幂等优先于报错；唯一键冲突必须是 409）。
  - **用例**：`apps/api/test/integration/user-write-error-semantics.e2e-spec.ts`
    （15 例）：幂等路径（重复申请 / 重复授权 / 重复报名 / 并发首登）
    与冲突路径（八种唯一键，分别断言 **409 / `CONFLICT`**、不得 5xx）
    以及 404 路径。
    ⚠️ 冲突用例用**故障注入**（让持久层抛出真实的 `ER_DUP_ENTRY`）
    而不是「碰运气」制造并发 —— 靠运气的用例跑十次可能只红一次，那不叫回归防线。
  - **反向验证**：错误语义校验器的自测从 3 个用例扩到 **7 个**
    （新增用户侧四个：用户侧处置被删掉 / 用户侧新增唯一列没登记 /
    新增**复合**唯一索引没登记 / 用户侧口径改了但文档没改），全部被抓出、退出码非 0。
- **验收口径**：撞唯一键必须落到 409（或幂等命中），
  **不得**出现 5xx；✅ 已达成（见 `docs/TEST-REPORT.md` 第 14 节）。

### 194. 认证申请**并发提交**会产生两条 pending 申请（第九轮发现，**未改**）

- **现象**：`POST /alumni/verification` 是「先查有没有 pending → 没有就插入」。
  两个并发请求都会读到「没有 pending」→ 都插入 →
  `verification_applications` 上**没有**「同一用户仅一条进行中申请」的唯一约束，
  于是库里留下**两条** pending 申请（审核端要处理两次）。
- **为什么本轮没改**：修它要么加**唯一索引**（要写迁移、且线上库要应用），
  要么改状态机（**业务语义**变更）—— 两者都超出「不改业务语义、对外契约变更先确认」的授权范围。
- **处置（第九轮）**：只**记录**，不改代码。
- **需人工**：是否加「同一用户仅一条 pending 申请」的唯一约束
  （MySQL 没有「条件唯一索引」，通常做法是加一个 `pending_guard` 生成列 +
  唯一索引，或在事务里用 `SELECT ... FOR UPDATE` 锁住该用户的行）？
  这属于**数据模型变更**，需产品 / 架构确认后另开一轮。

### 195. 连接关系**解除后无法重建**（`uk_connection_pairs` 命中历史行）（第九轮发现，**未改**）

- **现象**：`connection_pairs` 上的唯一索引是 `(user_a_id, user_b_id)`，
  **不区分关系状态**。一对校友解除连接后，这一行还在（`status='revoked'`）。
  之后两人重新建立联系、再次「接受申请」时，
  `ConnectionsService.accept` 用的是 `INSERT IGNORE`（`orIgnore`），
  于是**新插入被数据库挡掉**，随后按 `(user_a_id, user_b_id)` 读回的
  仍然是那条 `status='revoked'` 的旧行 ——
  申请被标记为「已接受」，但连接关系**并没有恢复**。
- **为什么本轮没改**：修它要动**业务语义**（解除后能否重建？重建是复用旧行还是新开一行？），
  并且可能要改唯一索引（加状态列进唯一键）—— 都超出本轮授权。
- **处置（第九轮）**：只**记录**，不改代码。
  ⚠️ 本轮在登记表里把 `uk_connection_pairs` 的处置登记为
  「`INSERT IGNORE` 吸收冲突 → 读回既有关系行（幂等）」，
  并在 `docs/API-SPEC.md` 写明该端点**幂等**——
  但「幂等」读到的是哪一行（已解除的那一行），属于上面这条待确认的业务语义。
- **需人工**：产品确认「解除后重新建立连接」的口径；
  确认后再定「复用旧行并改状态」还是「唯一键加状态列」。


## 待验证 / 未完成（不得声称已通过）> 以下均为**缺少外部资质或环境**导致的未验证项，与实现质量无关。
> 已实测完成的项（冒烟 10/10、集成测试 39/39、k6 分级压测、备份恢复演练、管理后台构建）见 `docs/TEST-REPORT.md`。

| 项 | 说明 | 计划 |
|---|---|---|
| 微信真实登录 | 小程序已注册（AppID `wx6761deb1125d858f`），凭据已接后端并经 `jscode2session` 验证被微信接受（返回 40029 = 凭据有效）；**但尚未在真机上跑过一次完整登录** | 客户扫码真机实测；建议体验期结束后切 `AUTH_MODE=wechat` |
| 微信订阅消息 | 仅站内通知；Outbox 通道与 Worker 派发已就绪，模板适配未接 | 配置消息模板后接通 Worker 的 `wechat` 渠道 |
| 小程序真机 / 开发者工具验证 | **已上传体验版**（版本 `0.5.0` 真后端 / `0.6.0` 离线演示，阿里云执行，出口 IP 已进代码上传白名单），预览二维码已出；客户**已在真机上打开过** —— 白屏已确认修复（#152），但**新版样式与图标（#154/#155/#156）尚未在真机复验** | 客户扫码复验新版界面；设体验版后客户直接打开 |
| 小程序 request 合法域名 | 当前后端入口是 `http://8.160.116.34:18080`（**IP + HTTP**），微信**强制**要求合法域名为 **HTTPS + 已备案域名**，且**不能用 IP** → 正常模式打开体验版会请求失败 | ① 体验期：手机开「调试模式」；② 正式发布：买域名 → ICP 备案 → Caddy 自动签证书 → 配置 request 合法域名 |
| 正式域名与 HTTPS 证书 | 私网环境用 nginx 明文回环；服务器上的 `*.dpdns.org` 是免费动态域名（他人域名的子域），**无法 ICP 备案**，不能用作小程序合法域名 | 买自有域名并备案后接入 Caddy |
| 对象存储托管服务（OSS/COS） | 当前用自建 MinIO | 切换 `MINIO_*` 环境变量即可，接口不变 |
| 对象存储异地容灾 | 备份只落服务器本地磁盘 | 接入异地存储后由 `backup.sh` 定时推送 |
| 生产密钥轮转与密钥管理服务接入 | 仓库侧已补齐**启动期校验**（缺配置/占位值 → 生产环境拒绝启动），但「正式更换密钥」与「接入密钥管理服务（Vault / 云 KMS）」属人工安排，仓库无法代做 | 运维：按 `docs/SECURITY.md` 第 8.2 节执行轮转；密钥经环境变量或密钥管理服务注入，**不写入仓库** |
| 正式 AppID / AppSecret 与 `AUTH_MODE=wechat` 切换 | 服务端开关、fail-closed 与启动校验均已就绪；**正式凭据填写**与切换时机属人工安排（当前体验版仍依赖 Mock 登录演示） | 运营/技术：微信公众平台申请正式凭据 → 填入环境变量 → 切 `AUTH_MODE=wechat` → 真机验证 |
| 正式域名与 HTTPS 证书 | CORS 白名单机制与 HSTS 响应头已就绪；**域名注册、备案、证书签发**属人工安排 | 客户 + 技术：见 `docs/DOMAIN-AND-ICP-FILING.md` |
| 微信订阅消息模板 | Outbox 通道、重试与幂等机制在 Worker 侧已具备；**模板 ID、用户订阅授权、真实推送**属人工安排 | 运营：配置模板后接通 Worker 的 `wechat` 渠道 |
| WAF 规则与备份定时任务 | 备份 / 恢复 / 演练脚本齐全；**WAF 规则集**与 **cron / systemd 定时任务的安装**属人工安排 | 运维：按 `docs/top.md` §11 与 `docs/BACKUP-RESTORE.md` 安装定时任务；在边缘层配置 WAF |
| ~~管理后台 UI 库按需引入（首屏减负）~~ | ✅ **第三轮已解决**：`main.ts` 从 `app.use(TDesign)`（全量注册）改为 `installTDesign(app)`（`apps/admin-web/src/plugins/tdesign.ts`），只注册**模板里真正用到的 19 个组件**，且每个组件从**深路径**（`tdesign-vue-next/es/<组件>`）引入；`vite.config.ts` 里对根入口的 `manualChunks` 也一并去掉（根入口会把整个库拉进来）。**首屏实际下载量 2,011,294 B → 1,208,675 B（gzip 466,698 B → 307,167 B，-39.9%）**，`dist` 总量 2,120,742 B → 1,318,074 B（-37.8%）。真实数字与测量方法见 `docs/TEST-REPORT.md` 第 9 节 | 已完成（第三轮） |
| ~~三个无上限列表端点~~ | ✅ **第三轮已解决**（契约变更轮）：三个端点全部改为 `{items, meta}` + `page`/`pageSize`：`GET /admin/events/:id/registrations`、`GET /alumni/verification/mine`、`GET /admin/roles|permissions|settings`。契约同步改了 `packages/contracts/src/api.ts`（并补上 `AdminRoleDto` / `AdminPermissionDto` 两个此前写窄了的目录条目类型）与 `docs/API-SPEC.md`（新增「第三轮的契约变更」迁移说明表）；两端客户端（管理后台 `EventListView.vue` 报名抽屉接 `PagerBar`、`RolesView.vue` / `AdminUsersView.vue` / `SettingsView.vue`；小程序 `services/me.ts`）与集成测试同步更新 | 已完成（第三轮） |
| ~~列表接口把 MEDIUMTEXT 正文整列返回~~ | ✅ **第三轮已解决**（契约变更轮）：三个**公开**列表端点（`GET /articles`、`GET /notices`、`GET /resources`）的 `body` 只返回**前 200 字摘要**（`apps/api/src/common/utils/excerpt.ts`），完整正文走详情接口。**管理端列表保持全文** —— 后台编辑弹窗直接回填列表行里的正文，截断会让管理员保存时**静默截断正文**（数据损坏，不是性能优化）；这一点在契约与 API-SPEC 里都写明了 | 已完成（第三轮） |
| ~~管理员每请求重算 RBAC（4 条 SQL）~~ | ✅ **第三轮已解决**：先在 `docs/SECURITY.md` 第 2.1 节**写明口径**（TTL ≤ 60 秒**硬上限**、降权 / 停用时**主动失效**、多实例部署下未被失效的实例最多等 TTL、缓存只存「有哪些权限点」而**不**缓存「这个请求是否被允许」），再实现 `TtlCacheService`（`apps/api/src/common/services/ttl-cache.service.ts`）+ `AuthService.resolveAdminIdentity`。管理端写端点（停用 / 改角色）在事务提交后**主动失效**该管理员的缓存条目 —— 本进程内撤权延迟为 **0**，TTL 只是多实例部署的兜底 | ✅ **第五轮补齐跨实例那一档**：共享失效总线（Redis pub/sub）已实现（`apps/api/src/common/services/invalidation-bus.service.ts`），多实例部署时撤权延迟也是 **0**；总线不可用时回落到 TTL 上界（≤60 秒），**写操作照常成功**。口径见 `docs/SECURITY.md` 第 2.1.4 / 2.1.5 节，用例见 `apps/api/test/integration/rbac-invalidation-bus.e2e-spec.ts` |
| ~~字典 / 聚合接口无缓存~~ | ✅ **第三轮已解决**：`GET /system/regions`、`/system/industries`、`/system/settings` 与 `GET /articles/categories` 走进程内 TTL 缓存（字典 / 分类 / 系统设置），写操作（分类增删改、设置写入）**主动失效**对应条目。**未读通知数绝不缓存**（`GET /me/summary` 每次实时 COUNT）—— 缓存它会让红点长期不消。口径见 `docs/SECURITY.md` 第 2.1 节 | 已完成（第三轮） |
| ~~`view_count` 每次浏览都写一次库~~ | ✅ **第三轮已解决**：浏览改为在 **Redis** 里 `HINCRBY` 计数（`ViewCounterService`），累计 20 次或到 60 秒周期才把增量**一次性**写回数据库（仍只动 `view_count` 一列，`updated_at = updated_at`）。`viewCount` 的一致性口径由「即时一致」改为**最终一致**（详情接口返回「库里的基线值 + 未落库增量」，用户看到的数字当场就是对的，但库里的行可能滞后一个刷回周期）—— 口径写在 `docs/SECURITY.md` 第 2.2 节与 `docs/API-SPEC.md`。Redis 不可用时**降级为直接写库**（与改动前一致，计数不丢） | 已完成（第三轮） |
| `/admin/stats` 的 `connectionTotal` 口径 | 管理端把它标成「连接总数」，服务端统计的却是**联系申请**条数（`connection_request_history`）。改查询会改变页面上显示的数字（对外可见语义），本轮只去掉了完全重复的那条 COUNT | ⚠️ **需产品/客户确认口径后再改**（第三轮**未改**：这是对外可见的业务语义，不是性能问题。已按本轮约定「只记录、不擅改」处理） |
| 连接列表未按对方的字段可见开关裁剪 | `/me/connections` 无条件返回对方的学院 / 地区 / 行业；而 `showCollege` 等开关在小程序里的说明是「**在通讯录中**显示你的毕业院系」—— 开关的语义只覆盖通讯录 | ⚠️ **需产品确认**「解除连接 / 连接列表」是否也应受开关约束；第三轮**未改**（改了就是改业务语义）。已按本轮约定「只记录、不擅改」处理 |
| nginx 静态资源安全头的端到端验证 | #178 已在 `infra/nginx/admin-web.conf` 补齐 `location /assets/` 的安全头。**本轮（复核轮）已做「配置侧」端到端验证**：用仓库里的这份 conf + 本轮（复核轮）的构建产物在真实 `nginx:alpine` 里起服务，`curl -I /assets/index-*.js` → **9 个安全响应头全部到位**（`X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy` / `Permissions-Policy` / `X-Permitted-Cross-Domain-Policies` / `Cross-Origin-Opener-Policy` / `Content-Security-Policy` / `X-XSS-Protection` / `Strict-Transport-Security`）+ `Cache-Control`。**但演示环境现场仍看不到这组头** —— 那边跑的是 4 天前的旧镜像（**部署未更新**，不是配置缺失） | ⚠️ **仍需人工**：部署到服务器后 `curl -I http://127.0.0.1:18082/assets/xxx.js` 再核对一次现场。证据见 `docs/TEST-REPORT.md` 第 11.7 节 |
| ~~管理端「分类 CRUD / 系统设置写入」没有审计记录~~ | ✅ **第三轮已解决**：`ContentService` 的这 4 个方法（`createCategory` / `updateCategory` / `deleteCategory` / `upsertSetting`）现在支持传入事务 `EntityManager`，控制器（`admin-users.controller.ts`）用 `dataSource.transaction` 把「业务写 + 审计写入」放进**同一事务**（沿用缺陷 #134 的做法：审计写失败时业务写一起回滚）。审计动作名：`category.create` / `category.update` / `category.delete` / `setting.update`；`setting.update` **不记 `value`**（设置里可能放敏感配置，审计表不该成为泄密面，只记 `key` 与 `description`） | 已完成（第三轮） |
| 通知深分页索引收益 | `(user_id, id)` 索引已建，但优化器在本次数据集上未自动改选；真实收益取决于数据分布 | ✅ **第五轮已用 `EXPLAIN ANALYZE` 复测**（测试库造 20 万 + 10 万条通知、两次 `ANALYZE TABLE`）：**加索引 / 删索引 / 加回索引，计划与耗时都相同**（54.8 / 53.9 / 53.5 ms，差异在噪声内），且 `FORCE INDEX (user_id, id)` 反而**更慢**（2.87 ms vs 优化器自选 1.32 ms）→ **按「没有实测数字的索引不写进生产库」的既定口径，本轮不加索引、不走 TypeORM migration**。**真正的解法是游标分页（keyset pagination）** —— 深分页耗时由 `OFFSET` 决定（OFFSET 1980 → 54 ms；OFFSET 0 → 0.03 ms），但那会**改对外契约**（`page`/`pageSize` 语义），本轮**不改** | ⚠️ **需产品/客户确认**是否接受契约层面的分页改造；**第六轮已把决策记录写进 #189**（目标、兼容面、风险、验收口径），**第八轮复核：仍无结论**（对外契约变更仍需产品 / 客户拍板，本轮按约定只记录、不擅改），在此之前维持现状（数字见 `docs/TEST-REPORT.md` 第 12.5 节） |
| 共享失效总线的**部署侧**要求（第五轮新增） | 总线靠 Redis pub/sub 广播「谁的缓存该作废」——**若多实例各连不同的 Redis，总线就不生效**（各自只订阅自己的），撤权延迟回落到 TTL 上界（≤60 秒）。频道名按环境隔离（`nmg:prod:` / `nmg:dev:` / `nmg:test:`），同一环境各实例必须一致 | ⚠️ **需人工在部署时确认**：所有 API 实例连**同一个** Redis（`docker-compose.prod.yml` 里已是共享的 `redis` 服务）；频道名用默认值即可（`RBAC_INVALIDATION_CHANNEL=nmg:rbac:invalidate`，服务端按 `NODE_ENV` 插入环境段）。**第七轮已给出「自证」手段**：部署后逐个实例查只读运维端点 `GET /api/v1/admin/ops/invalidation-bus`（管理员令牌），确认每个实例的 `subscribed` 都是 `true`、各实例 `channel` **一致**；读法见 `docs/SERVER-OPERATIONS.md` 第 2.1 节。**第八轮已把这一步接进运维巡检**：跑 `bash infra/scripts/healthcheck.sh` 即可逐实例判定（`enabled=1` 且 `subscribed=0` → FAIL；各实例频道不一致 → FAIL），不再需要人记得单独 curl（见 #192）。**但上线环境是否真的跑过一次巡检，仍属部署侧动作**（仓库侧只能把手段做齐） |
| ~~字典 / 分类 / 系统设置的**跨实例**失效没有上总线~~ | ✅ **第六轮已解决**：失效事件按 `kind` 扩展到字典类（`{"kind":"dict","dict":"categories"｜"settings"}`），**复用第五轮的同一条总线、同一个频道、同一套降级路径**（不新起总线、不引入新基础设施）。分类增删改与 `PUT /admin/settings` 在**事务提交后**发布，订阅端清掉本地对应的 `dict:*` 条目。跨实例陈旧上界从「各自的 TTL」变成「总线可用 = **0**；总线不可用 = **≤ TTL**（默认 ≤60 秒、硬上限 ≤300 秒）」。总线**仍然只传失效事件、不传字典内容**（没有分类名、没有设置项的 key / value）。口径见 `docs/SECURITY.md` 第 2.1.6 节，用例见 `apps/api/test/integration/dict-invalidation-bus.e2e-spec.ts` | 已完成（第六轮） |
| 第三轮新增端点 / 契约变更的**部署顺序** | 第三轮改了对外响应结构（`GET /admin/events/:id/registrations`、`GET /alumni/verification/mine`、`GET /admin/roles|permissions|settings` 改为 `{items, meta}`；新增 `GET /me/summary`；公开列表的 `body` 变为摘要）。**服务端与两端客户端必须一起发布** —— 只升级服务端会让旧客户端取 `.items` 得到 `undefined`，只升级客户端会让新客户端解析旧响应失败 | ⚠️ **需人工安排发布顺序**：建议「先发服务端（响应结构变更）+ 紧接着发两端客户端」的**同一次发布窗口**完成，不要跨版本长时间并存。**第四轮已产出逐端点的核对清单与两个方向的破坏形态：`docs/RELEASE-ORDER.md`**（含发布前 9 项勾选清单、发布后验证命令、回滚说明；其中 `GET /alumni/verification/mine` **两个方向都坏**，唯一可行顺序是「服务端先」，切换后到小程序新版铺开前该状态会一直错，需人工告知）。迁移说明见 `docs/API-SPEC.md` 的「第三轮的契约变更」小节。**本轮（复核轮）实测确认**：演示环境（`127.0.0.1:18080`，对外 `http://8.160.116.34:18080`）的 API **仍是第三轮之前的构建** —— `GET /me/summary` 返回 **404**、`GET /articles` 仍返回**全文 body**、管理后台静态资源缺 CSP / HSTS（跑的是 4 天前的旧镜像）。这与本行的约束**一致**（小程序新版本未过审前不能先切服务端），属**预期状态**而非漏发布；但也意味着**第三轮的契约变更目前确实尚未上线** |
| 第三轮的两条索引迁移尚未在**业务库**应用 | `AddQueryIndexesAndProtectAuditLogs1730000005000` 与 `AddRemainingQueryIndexes1730000006000` 在本机测试库已应用，但**线上业务库 `nmg_alumni` 尚未应用**（`infra/scripts/check-pending-migrations.sh` 的 R2 检查会报出来） | ⚠️ **需人工在部署窗口执行** `pnpm --filter @nmg/api db:migrate`（或走既有的迁移发布流程）。**第四轮已核对**（见 `docs/TEST-REPORT.md` 第 10.3 节）：两条迁移都已登记进 `migrations/index.ts` 且**排在最后**；`check-pending-migrations.sh` 的 **R1**（清单 ↔ 文件，不连库）已通过；**R2**（清单 ↔ 库）在本机两个库上都如实报出这两条**未应用** —— 与「线上待应用」一致。CI 跑的是 `--static-only`（CI 用的是普通 MySQL **service**、不是 compose 栈，R2 在 CI 里连不上库），**线上库的实际应用仍属人工动作** |
| ~~管理后台真实浏览器冒烟未在本机跑通~~ | ✅ **第三轮已跑通**：本机补装了 Playwright（**不写进仓库**，不引入新依赖），用已有的 Chromium 跑了 `infra/scripts/admin-ui-smoke.mjs`：**13 个路由全绿，0 条 console error，0 个未捕获异常，0 个失败请求**；定点截图见 `docs/screenshots/opt-003/` 与 `docs/TEST-REPORT.md` 第 9.7 节 | 已完成（第三轮） |
| 冒烟脚本的两个「找不到列」是**空表**而非缺陷 | `/resource`（资源审核）与 `/system/logs`（审计日志）此前冒烟报「表格里找不到列」：原因是**这两张表在测试库里是空的**（seed 不造资源与审计记录），空表时 TDesign 渲染的是空状态、**根本没有 `<table>`**，列自然找不到 | ✅ **第四轮已修好**（不再靠补测试数据绕过）：列内容断言**先看这一页有没有渲染出表格** —— 没有表格 → 记为「空表 / 空状态，跳过列内容断言」（不算缺陷）；有表格但找不到该列 → 仍是缺陷。见缺陷 #184 |
| 首屏下载量的**同机同负载**延迟对照 | 第 9.2 节只把 **SQL 条数**当作本轮的有效结论；延迟（p50/p95）本机两轮测量时机器负载不同，**不可直接比较**（公开端点一行没改，延迟却也变高了，说明是负载波动）。**本轮（复核轮）已量化这个「波动」有多大**：同机、同数据集、背靠背跑了 **A（缓存开）→ B（缓存关）→ A2（缓存开）** 三组 —— A 与 A2 **配置完全相同**，但 p50 已经相差最多 **2 倍**（`管理端·数据总览` 36.3 → 72.6 ms；`首页聚合` 62.7 → 84.0 ms），且**根本没有缓存**的 `首页聚合`、`通讯录检索` 同样在波动 → **波动幅度盖过了缓存本身可能带来的差异**，本机给不出延迟结论。（确定性指标不受影响：A 与 A2 的 SQL 条数逐个相同；A 与 B 的差**恰好是 3 条**/管理端请求，即 RBAC 解析那三条） | ⚠️ **仍需人工**：在专门的压测窗口（无其它任务）重跑 `perf:baseline` 两次，才能给出可比的延迟结论。本轮（复核轮）的实测与结论见 `docs/TEST-REPORT.md` 第 11.2 / 11.8 节。**第八轮复核：专用压测窗口仍未排期，本轮未跑新的延迟对照**（第七轮的 A/B/A 三组已给出「总线开关对读延迟无可测影响」的结论，剩余问题仍是缓存本身的延迟对照） |
| RBAC / 字典缓存的 TTL **旋钮此前没有暴露** | `RBAC_CACHE_TTL_SECONDS`（默认 30、上限 60）与 `DICT_CACHE_TTL_SECONDS`（默认 60、上限 300）在代码里一直生效，但 `infra/env/env.prod.example` 与 `docker-compose.prod.yml` 的 api `environment:` 里**都没有这两个变量** → 运维**无法在不重新打镜像的前提下**调整它们，只能改代码重发 | ✅ **第四轮已补齐**：`infra/env/env.prod.example` 与 `docker-compose.prod.yml` 已写入这两个变量（含中文注释），`docs/SECURITY.md` 第 2.1 节同步写明「默认 30 秒 / 上限 60 秒」的口径与旋钮位置。已用 `docker compose config` 验证渲染结果为 30 / 60，且改环境变量能被覆盖 |
| 多实例部署的**跨进程撤权演练**（第九轮新增仓库侧自证手段） | 此前「实例 A 撤权 → 实例 B 缓存立刻失效」只能靠**部署环境**人工核对（第七轮记在「只能靠人工核对」那一栏）。第九轮新增 `infra/scripts/invalidation-bus-drill.mjs`：起**两个 API 进程 + 一个 Redis**，在实例 B 上把靶子账号的 RBAC 缓存热起来，在实例 A 上降权，然后立刻在实例 B 上访问受保护端点 —— 必须**立刻 403**（不等 TTL）；同时脚本会起**第三个实例**把总线整条关掉（`RBAC_INVALIDATION_ENABLED=false`）作**退化形态对照** —— 那个实例在同一段时间里**仍然 200**，以此证明那次 403 确实是**总线**带来的、不是巧合。**本机实测**：实例 B 在 **7~8 ms** 内已 403，对照实例仍 200，演练通过 | ⚠️ **仍需人工**：在**上线环境**（多实例 + 共享 Redis）跑一次 `node infra/scripts/invalidation-bus-drill.mjs`，并把 `bash infra/scripts/healthcheck.sh` 跑一遍（逐实例 `subscribed=1`、频道一致）。两者都通过，才算「多实例撤权即时生效」在部署侧成立 |
| 认证申请的**并发提交**与**连接解除后重建** | 第 194 条（并发提交产生两条 pending 申请）与第 195 条（解除后无法重建连接）都是**数据模型 / 业务语义**层面的问题，本轮只记录未改 | ⚠️ **需产品 / 架构确认**：是否给「同一用户仅一条 pending 申请」加唯一约束；「解除后重新建立连接」是复用旧行还是新开一行 |
| 小程序「我的」页四个计数与红点的**真机**复验 | 第四轮已用**单元测试**（`apps/miniprogram/test/summary.spec.ts` 等，48 例全绿）覆盖 `toSummaryView()` 的四个计数与红点判定，并核对了 `apps/miniprogram/src/pages/me/index/index.wxml` 的绑定与 `post.body` 摘要排版（`-webkit-line-clamp: 2`）。但**小程序没有浏览器冒烟脚本**（不是网页，跑不了 Playwright），真实渲染效果仍需在微信开发者工具 / 真机上看过 | ⚠️ **需人工复验**：在微信开发者工具或真机上打开「我的」页，确认四个计数与红点符合预期、资讯/公告卡片摘要排版无截断异常（体验版已上传，见下方「小程序真机 / 开发者工具验证」行） |

## 已知设计取舍

1. **限流降级放行**：Redis 不可用时限流器直接放行（可用性优先），不阻断业务；Redis 恢复后自动生效。
2. **通讯录未公开资料返回 404 而非 403**：避免通过状态码泄露「该校友是否存在」。
3. **资源修改后需重新审核**：已发布内容被作者修改后回到 `pending` 并 `version+1`，宁可延迟公开也不放过未审内容。
4. **管理端独立账号体系**：管理员在 `admin_users` 表，与小程序用户分离，便于权限与审计独立管理。
