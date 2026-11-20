# 安全说明

> 最近一次落实：2026-11-20（**第二轮**：复核上一轮的产出并补齐遗漏；实测记录见 `docs/TEST-REPORT.md` 第 8 节）。
>
> 本轮复核发现并修掉的问题（上一轮的防线对自家模板无效、生产部署路径被自己的校验挡住、
> 管理员默认口令是公开常量、认证失败的请求不受限流保护等）逐条记在 `docs/KNOWN-ISSUES.md` #173~#180。

## 1. 认证

- 密码：bcrypt（cost 10）单向哈希；管理员密码不落明文，不出现在任何接口响应。
- 令牌：JWT access token 2 小时；refresh token 30 天且**只存哈希**，登出与刷新轮换立即吊销。
- 微信凭据：`code` → `code2session` 全程在服务端；`session_key` 不下发、不落库、不进日志。
- Mock 登录仅在 `AUTH_MODE=mock|both` 时可用；正式上线置 `AUTH_MODE=wechat` 即关闭。
- **取值非法时按最严口径处理（fail-closed）**：`AUTH_MODE` 写错（如 `wechats`）不再退回 `both`
  （那等于把 Mock 后门重新打开），而是关闭 Mock 登录并打错误日志。
- **启动期校验**：生产环境缺 `JWT_SECRET` / 数据库口令 / MinIO 密钥，或 `CORS_ORIGINS=*`，
  或 `AUTH_MODE` 未显式设置 / 取值非法 / 为 `mock` —— **拒绝启动**（`src/config/config-validation.ts`）。
- **占位值识别不分隔符**：`change-me-xxx` 与 `CHANGE_ME_xxx` **同样**被判定为占位值 ——
  仓库自己的模板（`docker-compose.prod.yml`、`infra/env/env.prod.example`）用的就是下划线写法，
  上一轮的防线对自家模板完全无效（见 KNOWN-ISSUES #173）。
- **管理员口令没有默认值**：仓库里公开的 `Admin@2026` **不再是任何路径的兜底值** ——
  管理端建号必须提供初始口令（DTO 必填），Seed 在生产环境要求显式提供强口令、
  且不再重置已存在账号的口令（见 KNOWN-ISSUES #175）。

## 2. 授权

- 用户身份阶段（游客 / 已登录 / 待审核 / 已认证）由后端 `AlumniStageGuard` 强制，
  前端隐藏按钮不构成安全边界。
- 管理端权限点由 `PermissionsGuard` 校验；用户令牌不能调用管理接口，管理员令牌具备独立权限集合。
- 越权访问统一返回 403，不泄露资源是否存在（目录中未公开资料返回 404）。

## 3. 隐私与联系方式（最高优先级）

1. 联系方式存 `private_contacts`，AES-256-GCM 加密，密钥由 `JWT_SECRET` 派生（不同环境自动隔离）。
2. **列表接口永不 SELECT 联系方式列**；通讯录、连接列表、资源列表均无该字段。
3. 对方联系方式可见需同时满足四个条件：
   - 存在 `connection_pairs.status='active'`；
   - 我方 `alumni_profiles.allow_contact_share = 1`；
   - 对方 `alumni_profiles.allow_contact_share = 1`；
   - 存在 `contact_share_grants.allow = 1`（我方与对方各一条）。
4. 撤回授权立即生效（授权记录置 0）；解除连接关系时在同一事务内撤销双方授权。
5. 通讯录只返回 `users.stage='verified'` 且 `show_in_directory=1` 的校友，并按
   `show_college / show_industry / show_region` 做字段级裁剪。
6. **学号由服务端脱敏后落库**（`student_id_masked` 保留首尾各 2 位，中间为 `*`）：
   客户端提交完整学号也只会存成脱敏值；后台用完整学号搜索仍能命中（按同一规则脱敏后匹配）。
7. **证明材料只接受私有桶资产**：`visibility='public'` 的文件被当作证明材料引用时返回 400，
   且不会写进证明材料关联表（public 桶里的对象拿到地址即可下载，不能承载私密材料）。
8. 证明材料存私有桶，仅审核权限可取短期签名 URL。
9. **解除连接之后，连接详情不再返回对方资料**：非 `active` 的关系一律 404
   （此前详情接口不校验关系状态，与列表口径不一致 —— 见 KNOWN-ISSUES #177）。

## 4. 输入与注入

- 所有入参经 `class-validator` 校验（长度、范围、枚举、正则），`ValidationPipe` 白名单模式拒绝多余字段。
- 数据访问统一走 TypeORM 参数化查询，无字符串拼接 SQL。
- 文件上传校验 MIME、扩展名与大小；对象 key 由服务端生成，不使用用户提供的路径。

## 5. 传输与暴露面

- 服务器只监听私网地址，对外暴露经 Nginx；不开放 Docker TCP 2375，不修改服务器 SSH 配置。
- 数据库 / Redis / MinIO 端口仅绑定 `127.0.0.1`。
- **CORS 白名单精确匹配**（`src/config/cors.ts`）：
  - 生产环境 `CORS_ORIGINS` 不得为 `*`（启动期校验直接拒绝启动），也不接受任意 Origin；
  - 白名单外的 Origin **拿不到任何 CORS 响应头**，预检请求返回 403；
  - `*` 仅在非生产态可用，且此时**不带凭据**（不再「反射任意 Origin + credentials」）。
  - **只接受配置里逐条列出的具体域名**：子域通配（`https://*.example.com`）**不认**，
    启动期校验也把带 `*` 的 origin 判为非法（见 KNOWN-ISSUES #176）。
- **安全响应头应用层与 Nginx 层都覆盖**（`src/common/middleware/security-headers.ts` +
  `infra/nginx/nginx.conf`）：`X-Content-Type-Options`、`X-Frame-Options: DENY`、
  `Referrer-Policy`、`Permissions-Policy`、`X-Permitted-Cross-Domain-Policies`、
  `Cross-Origin-Opener-Policy`、`Content-Security-Policy`、`Strict-Transport-Security`（HTTPS/生产态）。
  API 端口可绕过 Nginx 直连，这层由应用自己保证。
  - 管理后台的静态资源（`infra/nginx/admin-web.conf` 的 `location /assets/`）也覆盖同一组头 ——
    nginx 的 `add_header` **不跨层继承**，该块自己出现 `add_header` 就会丢掉父层的全部安全头
    （见 KNOWN-ISSUES #178）。
- **反向代理信任**：`TRUST_PROXY_HOPS`（默认 1）让限流按**真实客户端 IP** 计数 ——
  此前 `req.ip` 恒为 Nginx 容器地址，所有匿名请求共用一个计数桶。

## 6. 频率与滥用

- 登录 / 刷新：20 次/分钟；写接口 30 次/分钟；读接口 240 次/分钟（按用户或 IP，固定窗口计数于 Redis）。
- **计数桶按「身份 + 接口类别」（auth / write / read）**，不是按路由处理器 ——
  逐路由分桶会让实际阈值放大到文档承诺的数倍。
- **认证失败的请求同样计额**：限流守卫排在 JWT 守卫之后，伪造 / 过期令牌的请求此前在到达限流前
  就被 401 拒掉，等于完全不受保护。现在认证失败先按 IP 计一次额度，超阈值直接 429
  （见 KNOWN-ISSUES #179）。
- **类别判定先看 handler 名再看 HTTP 方法**：登录 / 刷新端点全是 POST，
  若先按方法判成 write 档，「登录 20 次/分钟」这一档就形同虚设。
- 限流中间件在 Redis 不可用时**降级放行**（可用性优先），不阻断业务。

## 7. 审计

- 管理端关键操作（审核、发布、下架、账号状态）写入 `admin_action_logs`（只追加）。
- 审计日志记录**来源 IP**（`admin_action_logs.ip`；此前该列从未被写过，管理端该列恒为空）。
- **审计记录受数据库保护**：`admin_action_logs.admin_id` 的外键是 `ON DELETE RESTRICT`，
  删除管理员账号**不会**连带删掉他的审计痕迹（此前是 `CASCADE`，等于「删账号即删证据」）。
- 资源审核历史 `resource_post_reviews` 与认证审核历史 `verification_reviews` 只追加，不覆盖。
- 连接申请历史只追加，接受/拒绝/撤回都留痕。

## 8. 待办（上线前必须完成）

> 本节区分两类：**仓库侧已落实**（代码 + 用例已落地）与**仍需人工动作**。
> 仍需人工动作的项已在 `docs/KNOWN-ISSUES.md` 的「待办」小节逐条写明「谁做什么」。

### 8.1 仓库侧已落实（2026-11-20）

- [x] **配置读取与启动期校验**：`JWT_SECRET`（≥32 字节、非占位值）、数据库口令、MinIO 密钥
  缺失或仍是仓库里的占位值时，生产环境**拒绝启动**；`.env.example` 给出占位与生成说明
  （`openssl rand -hex 32`）；仓库内**不含任何真实密钥**。
- [x] **Mock 登录收敛**：`AUTH_MODE` 在配置、启动校验与登录路径三处都收敛；
  非 `wechat` 之外的取值按 fail-closed 处理；`AUTH_MODE=mock` 在生产环境拒绝启动。
- [x] **CORS 收敛到白名单**：只接受配置里列出的具体域名，不接受通配符、不接受任意 Origin；
  正向与负向用例齐备（`test/integration/security-hardening.e2e-spec.ts`）。
- [x] **安全响应头**：应用层与 Nginx 层都覆盖（见第 5 节）。
- [x] **审计只追加的数据库保护**（见第 7 节）。
- [x] **占位值识别不分隔符**（第二轮）：`CHANGE_ME_xxx` 与 `change-me-xxx` 同样被拒，
  仓库自己的模板不再能绕过启动期校验；`.env.example` 与模板都写明了生成方式
  （`openssl rand -hex 32`）。
- [x] **部署模板与启动期校验对齐**（第二轮）：生产模板与 compose 的默认 `AUTH_MODE`
  不再是 `mock`（否则按仓库文档部署会起不来），但生产用 `mock` 依然被拒绝启动。
- [x] **管理员口令无默认值**（第二轮）：`Admin@2026` 不再是任何路径的兜底值；
  Seed 在生产环境要求显式提供强口令，且不再重置已存在账号的口令。
- [x] **CORS 只认具体域名**（第二轮）：子域通配一律不认（启动期也判为非法）。
- [x] **认证失败的请求也计额**（第二轮）：伪造 / 过期令牌不再绕过限流。

### 8.2 仍需人工动作（仓库侧无法完成）

- [ ] **正式环境更换 `JWT_SECRET`、数据库口令、MinIO 密钥，并改用密钥管理服务注入**
  （仓库侧只能保证「没配就别启动」；接入密钥管理服务、正式轮转属人工安排）。
- [ ] **关闭 Mock 登录（`AUTH_MODE=wechat`）并配置正式 AppID/AppSecret**
  （服务端开关与校验已就绪；正式凭据与切换时机属人工安排）。
- [ ] **CORS 收敛到正式域名 + 启用 HTTPS 证书**
  （白名单机制已就绪；正式域名、证书签发与续期属人工安排）。
- [ ] **接入微信订阅消息模板**
  （Outbox 通道、重试、幂等与失败可见性已具备；模板 ID、用户订阅授权与真实推送属人工安排）。
- [ ] **WAF 规则与定期备份/恢复演练**
  （备份与恢复演练脚本已存在；WAF 规则、cron/systemd 定时任务的安装属人工安排）。
- [ ] **正式环境的管理员口令**（`ADMIN_BOOTSTRAP_PASSWORD`）
  （服务端已无默认口令兜底：生产环境 Seed 缺口令就拒绝建号；正式口令由运维决定并写入环境变量）。
