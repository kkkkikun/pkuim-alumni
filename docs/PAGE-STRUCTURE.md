# 页面结构

> 依据 `docs/top.md` §3.1 与 HTML V1 原型的四个一级栏目。
> 小程序原生工程路径：`apps/miniprogram/src/pages/**`；管理后台：`apps/admin-web/src/views/**`。

## 一级栏目（底部 TabBar，原生）

| Tab | 页面目录 | 接口 |
|---|---|---|
| 首页 | `pages/home/index` | `GET /home/feed`、`GET /articles`、`GET /notices`、`GET /events` |
| 通讯录 | `pages/directory/index` | `GET /directory`、`GET /system/regions`、`GET /system/industries` |
| 连接 | `pages/connect/index` | `GET /resources`、`POST /resources`、`GET /system/industries` |
| 我的 | `pages/me/index` | `GET /me`、`GET /me/connections`、`GET /me/connection-requests`、`GET /me/resources`、`GET /me/events`、`GET /me/verifications`、`GET /notifications/unread-count` |

## 二级页面

### 首页
| 页面 | 路径 | 说明 |
|---|---|---|
| 资讯列表 | `pages/home/news-list` | 分页加载 |
| 资讯详情 | `pages/home/news-detail` | 正文 + 分类 + 发布时间 |
| 活动列表 | `pages/home/event-list` | 支持按地区筛选 |
| 活动详情 | `pages/home/event-detail` | 报名按钮、名额进度 |
| 活动报名 | `pages/home/event-register` | 表单（备注），提交态/成功态/失败态 |
| 我的报名状态 | `pages/home/my-registrations` | 可取消报名 |
| 公告列表 | `pages/home/notice-list` | |
| 公告详情 | `pages/home/notice-detail` | |
| 校友会介绍 | `pages/home/about` | 静态介绍 + 联系方式说明 |

### 通讯录
| 页面 | 路径 | 说明 |
|---|---|---|
| 校友列表 | `pages/directory/index` | 搜索 + 地区/行业筛选（独立筛选页） |
| 综合筛选 | `pages/directory/filter` | 地区 + 行业多选 |
| 校友主页 | `pages/directory/profile` | 名片 + 关系状态 + 「申请建立联系」 |
| 联系申请 | `pages/directory/request` | 交流说明表单（6–300 字） |
| 申请结果 | `pages/directory/request-result` | 成功/失败/待对方确认 |

### 连接
| 页面 | 路径 | 说明 |
|---|---|---|
| 资源与需求广场 | `pages/connect/index` | 类型切换 + 行业分类 + 地区筛选 |
| 资源详情 | `pages/connect/detail` | 类型、标题、描述、发布者 |
| 需求详情 | `pages/connect/demand-detail` | 同上，类型不同 |
| 发布资源 | `pages/connect/publish-offer` | 表单 |
| 发布需求 | `pages/connect/publish-demand` | 表单 |
| 我的发布 | `pages/connect/my-posts` | 含审核状态标签 |
| 表达合作意向 | `pages/connect/intent` | 说明表单 |
| 连接申请详情 | `pages/connect/request-detail` | 接受/拒绝（接收方） |

### 我的
| 页面 | 路径 | 说明 |
|---|---|---|
| 个人主页 | `pages/me/profile` | 名片与隐私开关概览 |
| 个人资料编辑 | `pages/me/profile-edit` | 资料表单 |
| 校友认证介绍 | `pages/me/verify-intro` | 认证流程说明 |
| 认证资料填写 | `pages/me/verify-form` | 姓名/院系/年份/学号脱敏/备注 |
| 证明材料上传 | `pages/me/verify-upload` | 选图 + 上传（私有桶） |
| 认证进度 | `pages/me/verify-status` | 当前状态与审核意见 |
| 认证历史 | `pages/me/verify-history` | 时间线 |
| 收到的联系申请 | `pages/me/incoming-requests` | 接受/拒绝 |
| 发出的联系申请 | `pages/me/outgoing-requests` | 状态与撤回 |
| 已建立联系 | `pages/me/connections` | 联系方式授权开关 |
| 联系方式授权 | `pages/me/contact-grant` | 单个连接的授权开关 |
| 我的活动 | `pages/me/my-events` | 报名记录 |
| 我的资源与需求 | `pages/me/my-resources` | |
| 隐私设置 | `pages/me/privacy` | 目录可见、字段可见、接受申请、共享联系方式 |
| 账号设置 | `pages/me/account` | 登录态、退出、隐私政策 |
| 通知中心 | `pages/me/notifications` | 站内通知列表 |

## 管理后台页面

| 模块 | 路径 | 主要接口 |
|---|---|---|
| 登录 | `/login` | `POST /auth/admin/login` |
| 数据总览 | `/dashboard` | `GET /admin/stats` |
| 校友管理 | `/alumni` | `GET /admin/alumni`、`GET /admin/alumni/:id`、`POST /users/:id/status` |
| 身份审核 | `/verification` | `GET /admin/verifications`、`POST /admin/verifications/:id/decision` |
| 资源审核 | `/resources` | `GET /admin/resources`、`POST /admin/resources/:id/decision` |
| 活动管理 | `/events` | `GET/POST/PATCH/DELETE /admin/events`、`GET /admin/events/:id/registrations` |
| 内容管理 | `/articles`、`/notices` | `/admin/articles`、`/admin/notices`、`/articles/categories` |
| 系统管理 | `/system` | `/admin/users`、`/admin/roles`、`/admin/permissions`、`/admin/action-logs`、`/admin/settings` |

## 状态与权限适配

- 游客：可浏览首页、资讯、公告、活动与公开资源；其余页面引导登录。
- 已登录未认证：可编辑资料、提交认证；通讯录/连接/发布入口显示认证引导。
- 待审核：展示认证进度；受限接口后端返回 403，前端统一提示。
- 已认证校友：全部业务可用。
- 管理员：使用独立登录与权限点，菜单与路由按权限过滤。
