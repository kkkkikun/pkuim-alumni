# 安全说明

## 1. 认证

- 密码：bcrypt（cost 10）单向哈希；管理员密码不落明文，不出现在任何接口响应。
- 令牌：JWT access token 2 小时；refresh token 30 天且**只存哈希**，登出与刷新轮换立即吊销。
- 微信凭据：`code` → `code2session` 全程在服务端；`session_key` 不下发、不落库、不进日志。
- Mock 登录仅在 `AUTH_MODE=mock|both` 时可用；正式上线置 `AUTH_MODE=wechat` 即关闭。

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
6. 学号脱敏存储（`student_id_masked`）；证明材料存私有桶，仅审核权限可取短期签名 URL。

## 4. 输入与注入

- 所有入参经 `class-validator` 校验（长度、范围、枚举、正则），`ValidationPipe` 白名单模式拒绝多余字段。
- 数据访问统一走 TypeORM 参数化查询，无字符串拼接 SQL。
- 文件上传校验 MIME、扩展名与大小；对象 key 由服务端生成，不使用用户提供的路径。

## 5. 传输与暴露面

- 服务器只监听私网地址，对外暴露经 Nginx；不开放 Docker TCP 2375，不修改服务器 SSH 配置。
- 数据库 / Redis / MinIO 端口仅绑定 `127.0.0.1`。
- CORS 默认 `*` 仅用于私网联调，正式部署应收敛到具体域名。

## 6. 频率与滥用

- 登录 / 刷新：20 次/分钟；写接口 30 次/分钟；读接口 240 次/分钟（按用户或 IP，固定窗口计数于 Redis）。
- 限流中间件在 Redis 不可用时**降级放行**（可用性优先），不阻断业务。

## 7. 审计

- 管理端关键操作（审核、发布、下架、账号状态）写入 `admin_action_logs`（只追加）。
- 资源审核历史 `resource_post_reviews` 与认证审核历史 `verification_reviews` 只追加，不覆盖。
- 连接申请历史只追加，接受/拒绝/撤回都留痕。

## 8. 待办（上线前必须完成）

- [ ] 正式环境更换 `JWT_SECRET`、数据库口令、MinIO 密钥，改用密钥管理服务注入；
- [ ] 关闭 Mock 登录（`AUTH_MODE=wechat`），配置正式 AppID/AppSecret；
- [ ] CORS 收敛到正式域名，启用 HTTPS 证书；
- [ ] 接入微信订阅消息模板（当前仅站内通知，接口已预留 Outbox 通道）；
- [ ] 补充安全响应头与 WAF 规则、按 top.md §11 建立定期备份与恢复演练。
