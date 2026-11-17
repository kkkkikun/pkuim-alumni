# 内蒙古北京大学校友会 · 微信小程序（原生 + TypeScript）

本目录是「内蒙古北京大学校友会数字化平台 V1」的**微信小程序客户端**，消费后端真实 REST API，
并在视觉与交互上复刻 `prototype/html-v1/index.html` 的红白「燕园」原型。

- 目录归属：`apps/miniprogram`
- 技术栈：原生微信小程序 + TypeScript + 自定义组件（`src/components`）
- 接口契约：`packages/contracts`（`ApiPaths` / DTO），本项目在 `src/types/index.ts` 与 `src/services/paths.ts` 中做**运行时副本**，
  因为小程序运行时无法直接引用工作区 TypeScript 包。

---

## 1. 在微信开发者工具中打开

1. 安装 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)（稳定版，基础库 ≥ 2.30）。
2. 选择「导入项目」，目录指向本目录 `apps/miniprogram`。
3. **AppID**：当前 `project.config.json` 中为占位符 `touristappid`（游客模式）。
   正式接入前替换为校友会注册的**小程序 AppID**（在 `project.config.json` 的 `appid` 字段修改，或在开发者工具中「详情 → 基本信息」里改）。
4. **后端地址**：修改 `src/config/index.ts` 中的 `API_BASE_URL`：

   ```ts
   export const API_BASE_URL = 'http://127.0.0.1:3000/api/v1';
   ```

   - 未改动时指向本机 3000 端口（便于开发者工具直连本地 API）。
   - 部署到私网服务器时，改为实际地址，例如 `http://<私网服务器地址>:3000/api/v1`（**不要猜测 IP，按实际部署填写**）。
   - 真实设备预览时，需在开发者工具「详情 → 本地设置」勾选 **不校验合法域名**，
     或在微信公众平台把域名加入「开发 → 开发管理 → 服务器域名 → request / uploadFile 合法域名」。
5. **后端必须可达**：`docker compose` 的 API 服务已启动，接口前缀为 `/api/v1`。

> 说明：本项目**不依赖** `tdesign-miniprogram` 的运行时构建产物，界面全部由仓库内自定义组件实现，
> 因此**无需**执行「工具 → 构建 npm」即可编译运行。`tdesign-miniprogram` 已在 `package.json` 中声明为依赖，
> 后续若要替换为 TDesign 组件，只需在页面 `index.json` 的 `usingComponents` 中指向
> `tdesign-miniprogram/<组件名>/<组件名>` 并执行一次「构建 npm」。

---

## 2. 登录方式（微信 / Mock 运行时切换）

`services/auth.ts` 暴露两个实现，接口一致，由 `src/config/index.ts` 的开关决定走哪条：

| 开关 | 实现 | 说明 |
| ---- | ---- | ---- |
| `USE_MOCK_LOGIN = true`（当前） | `loginWithMock()` → `POST /auth/mock/login` | 开发期使用固定 `mockOpenid`，小程序未注册也能联调 |
| `USE_MOCK_LOGIN = false` | `loginWithWechat()` → `wx.login` 取 `code` → `POST /auth/wechat/login` | 正式模式，只需把 AppID 配置到后端 |

两者都会把返回的 `accessToken / refreshToken / user / stage` 写入全局 Store 与本地缓存。

**安全约定**：`session_key`、`openid` 等敏感认证数据只在服务端处理；小程序端只拿到业务 token 与用户资料，
不会读取、也不会向页面暴露 `session_key`。

---

## 3. 目录结构

```
src/
├── app.ts / app.json / app.wxss      # 入口、路由表、全局视觉变量与通用样式
├── bootstrap.ts                      # 启动引导：恢复会话、预热字典、刷新身份
├── config/index.ts                   # API 地址、登录方式开关、超时、分页
├── types/index.ts                    # 契约类型镜像（import type 用）
├── services/
│   ├── paths.ts                      # ApiPaths 运行时副本
│   ├── request.ts                    # 请求层：信封解包、鉴权、令牌刷新、幂等键
│   ├── auth.ts                       # 微信 / Mock 登录适配层
│   ├── content.ts events.ts directory.ts connections.ts resources.ts
│   ├── me.ts system.ts uploads.ts    # 业务服务
│   └── index.ts
├── store/index.ts                    # 轻量全局 Store（令牌 / 用户 / 字典 / 筛选 / 滚动位置）
├── utils/                            # 请求反馈、弹窗、身份守卫、滚动恢复、格式化
├── styles/blocks.wxss                # 页面共享样式块
├── components/                       # state-view / dialog / person-item / opportunity-card / event-card / article-card
├── custom-tab-bar/                   # 四个一级栏目的自定义底部导航
└── pages/
    ├── home/        # 首页栏目（10 页）
    ├── directory/   # 通讯录栏目（5 页）
    ├── connect/     # 连接栏目（10 页）
    └── me/          # 我的栏目（16 页）
```

页面路由见 `src/app.json`（41 个页面）。一级栏目通过 `custom-tab-bar` + `tabBar.custom = true` 实现。

---

## 4. 关键实现说明

### 4.1 请求层（`services/request.ts`）

- 统一拼接 `/api/v1` 前缀与 `API_BASE_URL`；解包 `{ code, message, data }` 信封，业务层只拿到 `data`。
- 自动附带 `Authorization: Bearer <accessToken>`、`X-Request-Id`；写操作 POST 自动附带 `Idempotency-Key`。
- **令牌刷新**：访问令牌失效（HTTP 401）时调用 `refreshAccessToken()`；该函数为 **single-flight**，
  并发请求会排队等待同一次刷新结果，刷新成功后原请求**重试一次**（最多一次），刷新失败则清理登录态。
- 失败统一弹出 Toast（`showError: false` 可关闭），并抛出 `ApiError`（含 `code / statusCode / requestId`）。

### 4.2 筛选与滚动位置保持（spec §3.2）

- 筛选条件存放在全局 Store：`directoryFilter`（关键词 / 地区 / 行业 / 毕业年份）与 `connectFilter`（类型 / 地区 / 行业）。
  筛选页（`pages/directory/filter`、`pages/connect/filter`）只负责编辑 Store，确定后 `navigateBack`，列表页 `onShow` 重新读取。
- 滚动位置：列表页 `onPageScroll: trackPageScroll('<key>')` 写入 Store，返回时 `onShow` 调用 `restorePageScroll('<key>')`
  通过 `wx.pageScrollTo` 恢复；筛选条件变化时 `resetPageScroll` 回到顶部。

### 4.3 身份与隐私（spec §1.3 / §3.3）

- Store 中的 `stage` 取值 `guest | logged_in | pending_review | verified`，与后端一致；前端只做展示与引导，
  **不依赖前端隐藏按钮来保证安全**，所有权限以后端校验为准。
- 联系方式只在「连接已建立」且「对方也已共享」时展示（`ConnectionPairDto.peerContact` 仅在双方授权后有值）；
  `pages/me/contact-share` 管理「我是否共享」，可随时撤回。

### 4.4 表单状态

发布资源 / 发布需求 / 联系申请 / 活动报名 / 认证资料等表单均具备：字段校验 → 提交中 → 成功 → 失败重试，
并在失败时展示具体错误文案（`submitError`）。

---

## 5. 本地校验命令

```bash
# 需要先在仓库根目录安装依赖（安装动作由 Lead 在服务器或本地执行）
pnpm --filter @nmg/miniprogram typecheck   # tsc --noEmit -p tsconfig.json
```

小程序本身需要用微信开发者工具编译运行（本环境无法执行）。

---

## 6. 待配置 / 待确认

1. 真实小程序 AppID（当前为 `touristappid` 占位符）。
2. 私网 API 真实地址（`src/config/index.ts` 的 `API_BASE_URL`）。
3. 微信合法域名白名单（request / uploadFile）。
4. `POST /uploads` 的请求体结构（契约只定义了路径）：当前客户端按 `{ fileName, mimeType, size }` 约定，
   若后端字段不同需同步 `src/types/index.ts` 的 `CreateUploadBody` 与 `services/uploads.ts`。
5. `GET /alumni/verification` 返回当前认证状态、`GET /me/connection-requests` 的 `direction` 参数为**客户端假设**，
   客户端已对连接申请做「按当前用户 id 二次分拣」，即使后端不按方向过滤也能正确显示。
