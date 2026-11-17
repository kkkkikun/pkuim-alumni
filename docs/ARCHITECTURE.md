# 架构说明

## 1. 总体结构

```
                 微信小程序 (apps/miniprogram)        管理后台 (apps/admin-web)
                        │  HTTPS / JSON                      │  HTTPS / JSON
                        └──────────────┬─────────────────────┘
                                       │  /api/v1（契约：packages/contracts）
                                 Nginx (infra/nginx)
                                       │
                            ┌──────────┴──────────┐
                            │  NestJS API (api)  │  ← Worker (apps/worker) 消费同一队列
                            └──────────┬──────────┘
                     ┌─────────────────┼─────────────────┐
                 MySQL 8.4          Redis 7          MinIO
              （业务唯一事实源）   （队列/限流/缓存）  （私有桶+公开桶）
```

- **模块化单体**，不是微服务。API 与 Worker 同仓库、不同进程，避免早期服务治理复杂度。
- **多实例友好**：API 无状态，会话落 MySQL、限流与队列落 Redis，可水平扩容。
- **契约唯一来源**：`packages/contracts`；OpenAPI 由 NestJS Swagger 自动生成，字段与契约保持一致。

## 2. 后端分层（apps/api/src）

```
common/        守卫（JWT / 权限 / 身份阶段 / 限流）、异常过滤器、响应与幂等拦截器、DTO 与工具
config/        分环境配置（app / database / redis / minio）
auth/          AuthProvider 抽象（Mock / WeChat）、令牌签发与会话轮换、管理员登录
database/      实体、迁移、DataSource、Seed（与业务代码同仓库但独立目录）
modules/       业务模块：me / alumni / directory / connections / resources /
               events / content / notifications / uploads / admin / system
```

依赖方向：`modules → common / database / auth`，反向依赖禁止；跨模块调用通过导出的 Service，
不直接跨模块操作 Repository。

## 3. 认证与授权

| 主体 | 凭据 | 令牌 | 权限 |
|---|---|---|---|
| 小程序用户 | 微信 code / Mock openid | access 2h + refresh 30d（轮换即吊销） | 身份阶段：`logged_in` / `pending_review` / `verified` |
| 管理员 | 用户名 + bcrypt 口令 | 同上，独立 `admin_users` 表 | RBAC：5 角色 / 12 权限点 |

- refresh token 只以 SHA-256 哈希落库（`user_sessions`），登出/轮换立即失效。
- openid / session_key 只在服务端处理；`WechatAuthProvider` 之外不接触微信凭据。
- 管理端接口用 `@RequirePermissions()` 声明权限点，由 `PermissionsGuard` 强制；前端隐藏按钮只是体验优化。

## 4. 数据一致性

见 `docs/CONCURRENCY-DESIGN.md`。要点：

- 关键写操作在事务内完成（申请→建关系→回填；占名额→写报名）。
- 唯一索引承担最终防重：`uk_event_registration`、`uk_connection_request_pending`、`uk_connection_pairs`、
  `uk_resource...`、`uk_idempotency`。
- 状态流转一律用带前置状态的条件 UPDATE，重复操作幂等。
- 内容类对象使用 `version` 乐观锁（资源、认证申请）。
- 副作用（通知）走 Outbox：业务事务内写 `outbox_events`，Worker 消费投递。

## 5. 文件与对象存储

- 公开内容图片 → `nmg-public` 桶；认证证明材料 → `nmg-private` 桶（默认私有）。
- 上传校验 MIME、扩展名与大小（10MB 上限）。
- 私有文件通过 5 分钟有效期的预签名 URL 下发，且接口本身需要登录态。
- `media_assets` 保存元数据，删除文件不影响业务记录。

## 6. 部署拓扑（私网服务器）

| 服务 | 说明 | 端口 |
|---|---|---|
| nginx | 反向代理 `/api` → api，`/` → admin-web | 127.0.0.1:18080 |
| api | NestJS，2 实例起步 | 容器内 8000 |
| worker | BullMQ 消费者 | — |
| admin-web | nginx 静态托管 | 容器内 80 |
| mysql / redis / minio | 数据与中间件 | 仅 127.0.0.1:15432 / 16379 / 19000 |

Compose 项目名 `nmg-pku-alumni`，数据卷前缀 `nmg-`，与既有 `swload-*` 栈完全隔离。

## 7. 前端

- **小程序**：原生微信小程序 + TypeScript + TDesign Miniprogram。一套请求层（令牌刷新、错误提示、幂等键），
  四个一级栏目 + 二级页面；`wx.login` 与 Mock 登录双通道。
- **管理后台**：Vue 3 + TS + Vite + Pinia + TDesign Vue Next；菜单与路由按权限点控制；
  所有列表接真实分页接口，无本地假数据兜底。

## 8. 可观测性

- 每个请求带 `X-Request-Id`，响应回传，便于串联日志。
- 健康检查：`GET /healthz`（存活）、`GET /api/v1/system/health`（依赖连通性）。
- 关键管理操作写 `admin_action_logs`（只追加）。
