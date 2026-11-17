# @nmg/admin-web · 校友会管理后台

内蒙古北京大学校友会数字化平台 V1 的管理后台（Vue 3 + TypeScript + Vite + Pinia + TDesign Vue Next + axios）。

所有页面均调用真实 REST API（`@nmg/contracts` 中的 `ApiPaths`），本地不保存任何业务假数据。

## 快速开始

```bash
pnpm install            # 在仓库根目录执行（由 Lead 统一安装）
pnpm --filter @nmg/admin-web dev
pnpm --filter @nmg/admin-web build
```

复制 `.env.example` 为 `.env.local` 可覆盖默认配置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `/api/v1` | API 根地址（生产环境由 Nginx 反向代理同源） |
| `VITE_API_PROXY_TARGET` | `http://localhost:3000` | 仅 dev server 使用的 /api 代理目标 |
| `VITE_DEV_PORT` | `5174` | 开发服务器端口 |
| `VITE_API_TIMEOUT` | `20000` | 请求超时（毫秒） |
| `VITE_USE_MOCK` | `false` | 演示数据开关，**仅本地开发使用**，开启后顶栏会显示「演示数据模式」 |

## 目录结构

```
src/
├── api/            # HTTP 客户端（http.ts）与按域拆分的接口模块
│   ├── http.ts     # axios 实例、信封解包、单飞刷新、请求 ID / 幂等键
│   ├── session.ts  # 会话状态（localStorage 持久化）与 401 回调
│   ├── mock.ts     # VITE_USE_MOCK 演示数据适配层
│   ├── auth.ts     # 登录 / 刷新 / 登出 / 会话
│   ├── admin.ts    # 管理后台全部业务接口
│   └── system.ts   # 字典与文件上传
├── components/     # PageHeader / StateBox / PagerBar / CoverUploader / AppIcon
├── composables/    # usePagedList：统一的分页、加载、错误状态
├── layouts/        # AdminLayout：侧边栏 + 顶栏 + 内容区
├── router/         # 路由与权限守卫（meta.requiredPermission）
├── stores/         # auth（令牌 / 管理员 / 权限点）、dictionary（地区 / 行业）
├── styles/         # 品牌色板（与小程序 HTML 原型一致）
├── utils/          # 格式化、标签字典、防抖、菜单定义
└── views/          # 各业务页面
```

## 权限模型

- 登录返回 `AdminLoginResult.permissions`（`AdminPermission[]`），保存在 Pinia + localStorage。
- 侧边栏菜单按权限点过滤，路由通过 `meta.requiredPermission` 二次校验，缺权跳转到 `/403`。
- 权限点仅用于界面展示，**真实鉴权始终由服务端执行**。

## 令牌刷新

`src/api/http.ts` 在响应拦截器中捕获 401：同一时刻只发起一次 `POST /auth/refresh`，
其余并发请求复用同一个 Promise；刷新成功后自动重放原请求，刷新失败则清空会话并跳转登录页。

## 路由

使用 hash 模式（`createWebHashHistory`），避免依赖 Nginx 的 SPA 回退配置。
`/` 会自动跳转到当前账号有权限的第一个菜单页。
