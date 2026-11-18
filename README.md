# 内蒙古北京大学校友会数字化平台 V1（NMG-PKU-Alumni）

微信小程序 + 管理后台 + NestJS API + MySQL 的一体化校友会数字化平台 V1。
本仓库是私网测试环境的完整可运行系统，不是原型。

- **权威需求文档**：[`docs/top.md`](docs/top.md)
- **执行跟踪表**：[`docs/plan.md`](docs/plan.md)
- **接口契约**：[`docs/API-SPEC.md`](docs/API-SPEC.md) · 机器可读：`packages/contracts`
- **数据模型**：[`docs/DATABASE-DESIGN.md`](docs/DATABASE-DESIGN.md)
- **并发设计**：[`docs/CONCURRENCY-DESIGN.md`](docs/CONCURRENCY-DESIGN.md)
- **部署运维**：[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) · [`docs/SERVER-OPERATIONS.md`](docs/SERVER-OPERATIONS.md)
- **原 HTML V1 备份**：[`prototype/html-v1/`](prototype/html-v1)（只读，未改动）

## 目录结构

```
apps/
  api/          NestJS API（认证、校友认证、通讯录、双向连接、资源审核、活动、内容、通知、上传、管理端 API）
  admin-web/    Vue 3 + TDesign Vue Next 管理控制台
  miniprogram/  原生微信小程序（TypeScript + TDesign Miniprogram）
  worker/       BullMQ Worker（Outbox 事件消费与通知投递）
packages/
  contracts/    前后端共享的 API 契约（DTO、路径、枚举）
infra/          Dockerfile、nginx、构建/部署/备份脚本、监控
database/       （位于 apps/api/src/database）实体、迁移、Seed
tests/
  concurrency/  k6 并发与业务一致性脚本
docs/           需求、架构、数据库、接口、安全、测试与运维文档
```

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | NestJS 11 + TypeORM 0.3 + MySQL 8.4 + Redis 7 + BullMQ + MinIO |
| 小程序 | 原生微信小程序 + TypeScript + TDesign Miniprogram |
| 管理后台 | Vue 3 + TypeScript + Vite + Pinia + TDesign Vue Next |
| 测试 | Jest + supertest（集成测试，真实 MySQL/Redis）+ k6（并发） |
| 工程 | pnpm workspace + Docker Compose + Nginx |

## 快速开始（私网服务器）

```bash
# 1. 同步代码（本地执行）
rsync -az --exclude node_modules --exclude .git --exclude dist \
  . sqserver:MyProject/pkuim-alumni/

# 2. 生成环境变量（随机密钥写入 .env.prod，权限 600）
ssh sqserver 'cd ~/MyProject/pkuim-alumni && bash infra/scripts/init-env.sh'

# 3. 构建并启动全套服务
ssh sqserver 'cd ~/MyProject/pkuim-alumni && bash infra/scripts/deploy.sh'

# 4. 迁移 + Seed（1000+ 虚构校友、5 个角色、示例内容）
ssh sqserver 'cd ~/MyProject/pkuim-alumni && bash infra/scripts/seed.sh --migrate'

# 5. 健康检查
ssh sqserver 'cd ~/MyProject/pkuim-alumni && bash infra/scripts/healthcheck.sh'
```

服务地址（私网）：

| 服务 | 地址 |
|---|---|
| 管理后台 | http://127.0.0.1:18080/ |
| API | http://127.0.0.1:18081/api/v1 |
| 健康检查 | http://127.0.0.1:18080/healthz |

默认管理员：`admin` / `Admin@2026`（Seed 创建，正式环境必须修改）。

## 本地开发

```bash
pnpm install
pnpm --filter @nmg/api start:dev     # API（需本地 MySQL/Redis，或用 docker-compose.yml 起依赖）
pnpm --filter @nmg/admin-web dev     # 管理后台
pnpm --filter @nmg/api test          # 集成测试（需真实 MySQL/Redis）
```

小程序：`apps/miniprogram` 用微信开发者工具打开，设置真实 AppID 与 API 地址即可。

## 测试与压测（已在私网服务器实测）

实测结果见 [`docs/TEST-REPORT.md`](docs/TEST-REPORT.md)：冒烟 10/10、集成测试 **285/285**（40 个套件，含 20 条越权探测 + 6 条幂等行为 + **4 条幂等生命周期** + **3 条幂等作用域** + **5 条上传写入授权** + **9 条隐私开关有效性** + **5 条错误码语义** + **12 条管理端账号写入完整性** + **6 条多步写原子性** + **6 条活动名额守恒** + **5 条通知已读语义** + **5 条 HTTP 状态码语义** + **4 条资源修改原子性** + **4 条管理端审计原子性** + **3 条并发撞唯一键** + **4 条 Outbox 聚合根** + 38 条端点覆盖补测 + 6 条响应结构防线 + 6 条嵌套元素结构 + 6 条请求体校验 + 5 条查询筛选枚举 + **6 条通知原子性**）、
前端静态校验 0 错误（含 `docs/top.md` §10.4 的 18 步端到端验收）、客户端路径一致性 0 错误、
**端点覆盖 100/100（服务端 100 条端点 / 433 处调用点，未覆盖 0）**、
**运行时响应结构校验 51 个端点 0 失败（契约声明的类型 ↔ 服务端真实响应逐字段对账）+ 11 个端点合成夹具 0 失败且无盲点**、
**请求契约对账 99 个调用点 0 不一致（客户端实际发送的查询参数与请求字段 ↔ 服务端声明）**、
**声明参数消费对账 54 个 handler / 197 个参数 0 不一致**、
**请求参数 DTO 校验 54 个整体请求体 / 查询对象：会被 ValidationPipe 跳过 0**、
**枚举一致性对账 22 个 DB ENUM / 786 个 DTO 字段 / 13 个契约枚举：漂移 0（含表绑定规则 R4/R5）**、
**契约 ↔ 小程序类型镜像 75 个同名类型 0 漂移**、
**RBAC 三方对账 0 不一致（12 权限点 / 5 角色 / 107 条端点）**、
**Worker 投递链路自检 33/33（Outbox → 队列 → 投递 → 重试，含 5 项反向验证 + 8 项失败留痕）**、
**幂等生命周期 4/4（失败后可重试 / 过期后真正执行 / 专用错误码 / 未过期仍回放）**、
**上传写入授权 5/5（他人 public 资产取 upload 地址 → 404；公开下载不受影响）**、
**隐私开关有效性 9/9（隐藏字段不得被搜出 / 开关真的可改可生效）**、
**错误码语义 5/5（未认证 / 凭据无效 / 需先实名 三种情形必须给不同错误码）**、
**错误码对账 0 死码（契约 ErrorCode ⟷ 服务端真实会返回的错误码，含 2 类注入反向验证）**、
**管理端账号写入完整性 12/12（重复登录名 409 / 不存在 404 / 无死枚举 / 多步写整体回滚 / 后台不可锁死）**、
**多步写原子性 6/6（补交材料 / 个人资料 / 浏览计数：失败必须整体回滚 + 3 条对照用例防误伤）**、
**活动名额守恒 6/6（并发取消不得多回收名额 / 容量不得改到低于已报名人数 + 4 条对照用例防误伤）**、
**事务逃逸对账 0 处（事务内不得用注入仓储写入）+ 2 条已确认豁免（if/else 二选一）+ 5 类注入反向验证**、
**HTTP 状态码对账 0 处漂移（服务端声明的成功码 ⟷ 既有测试断言的成功码，485 条断言）+ 3 条幂等回放提示**、
管理后台真实浏览器只读冒烟 13/13 路由 **0 错误**、
需求覆盖矩阵与 API-SPEC 文档一致性均通过、k6 分级压测 20 组全通过（改造后重跑）、
一键恢复演练通过（33 表行数 + 结构/外键/索引/迁移指纹全部一致）。
回归链 **22 步 EXIT=0**，业务库 `users` 行数 **1202**（全程未被污染）。

```bash
# 业务冒烟（10 项）
ssh sqserver 'cd ~/MyProject/pkuim-alumni && bash infra/scripts/smoke.sh \
  --base http://127.0.0.1:18081/api/v1'

# 集成测试（自动建测试库 → 迁移 → Seed → 跑测试 → 校验业务库未被污染
#           → 客户端路径一致性 → 前端静态校验 → 端点覆盖 100/100 → 校验器反向验证
#           → 数据完整性 + 反向验证 → 恢复演练 → 运行时响应结构校验 + 反向验证
#           → 请求契约对账 + 反向验证 → 声明参数消费对账 + 反向验证
#           → 请求参数 DTO 校验 + 反向验证 → 枚举一致性对账 + 反向验证
#           → Worker 投递链路自检 → 错误码对账 + 反向验证
#           → 事务逃逸对账 + 反向验证 → HTTP 状态码对账 + 反向验证
#           → 并发撞唯一键对账 + 反向验证 → 迁移一致性对账 + 反向验证，共 22 步）
ssh sqserver 'cd ~/MyProject/pkuim-alumni && bash infra/scripts/test-integration.sh'

# 只想跑机器化校验（不建库、不跑测试）
ssh sqserver 'cd ~/MyProject/pkuim-alumni && bash infra/scripts/check-frontend.sh'

# 校验器反向验证：注入真实缺陷，断言校验器确实会报错（约 3 秒）
ssh sqserver 'cd ~/MyProject/pkuim-alumni && bash infra/scripts/check-frontend-selftest.sh'

# 声明参数消费对账：服务端承诺的查询参数，实现里到底用没用上（可单独运行）
ssh sqserver 'cd ~/MyProject/pkuim-alumni && node infra/scripts/check-swagger-param-usage.mjs \
  --root . --swagger http://127.0.0.1:18081/docs-json'

# 数据完整性校验（业务库只读；32 项硬约束）
ssh sqserver 'cd ~/MyProject/pkuim-alumni && bash infra/scripts/check-data-integrity.sh'

# 客户端 ↔ 服务端 路径一致性校验（可单独运行）
ssh sqserver 'cd ~/MyProject/pkuim-alumni && node infra/scripts/check-client-paths.mjs \
  --root . --swagger http://127.0.0.1:18081/docs-json'

# 并发压测：5 场景 × 20/50/100/200 VU
ssh sqserver 'cd ~/MyProject/pkuim-alumni && export PATH=$HOME/bin:$PATH && \
  bash infra/scripts/loadtest.sh --vus="20 50 100 200" --duration=30s'

# 清理压测临时数据
ssh sqserver 'cd ~/MyProject/pkuim-alumni && bash infra/scripts/cleanup-loadtest-data.sh'

# 一键恢复演练：备份 → 恢复到演练库 → 逐项比对 → 自动清理（线上库全程只读）
ssh sqserver 'cd ~/MyProject/pkuim-alumni && bash infra/scripts/backup-restore-drill.sh'

# 恢复演练校验器的反向验证（注入缺陷必须被抓出，退出码非 0）
ssh sqserver 'cd ~/MyProject/pkuim-alumni && bash infra/scripts/backup-restore-drill-selftest.sh'

# 手工恢复（恢复只写入新库，线上库只读）
ssh sqserver 'cd ~/MyProject/pkuim-alumni && bash infra/scripts/backup.sh'
ssh sqserver 'cd ~/MyProject/pkuim-alumni && bash infra/scripts/restore.sh \
  --backup /home/kikun/backups/nmg-pku-alumni/<时间戳> --target-db nmg_restore_drill'

# 运行时响应结构校验（只读 GET；拿客户端声明的泛型返回类型逐字段核对服务端响应）
ssh sqserver 'cd ~/MyProject/pkuim-alumni && node infra/scripts/check-response-shape.mjs \
  --root . --base http://127.0.0.1:18081/api/v1'

# 响应结构校验器的反向验证（注入 4 类结构缺陷，断言校验器确实会报错）
ssh sqserver 'cd ~/MyProject/pkuim-alumni && bash infra/scripts/check-response-shape-selftest.sh'

# 请求契约对账（客户端发送的查询参数/请求字段 ↔ 服务端 Swagger 声明）
ssh sqserver 'cd ~/MyProject/pkuim-alumni && node infra/scripts/check-request-contract.mjs \
  --root . --swagger http://127.0.0.1:18081/docs-json'

# 请求契约校验器的反向验证（注入 2 类请求契约缺陷，断言校验器确实会报错）
ssh sqserver 'cd ~/MyProject/pkuim-alumni && bash infra/scripts/check-request-contract-selftest.sh'

# 契约 ↔ 小程序类型镜像一致性校验
ssh sqserver 'cd ~/MyProject/pkuim-alumni && node infra/scripts/check-contract-mirror.mjs --root .'

# RBAC 三方对账（契约 ⟷ 种子 ⟷ 前端矩阵 ⟷ 服务端端点）
ssh sqserver 'cd ~/MyProject/pkuim-alumni && node infra/scripts/check-rbac-matrix.mjs --root .'

# Worker 投递链路自检（容器内 · 测试库 · 测试 Redis · 独立队列；25 项断言）
ssh sqserver 'cd ~/MyProject/pkuim-alumni && docker compose --project-name nmg-pku-alumni \
  --env-file .env.prod -f docker-compose.prod.yml exec -T \
  -e DB_NAME=nmg_alumni_test -e REDIS_DB=1 worker node dist/selfcheck.js'

# 管理后台真实浏览器只读冒烟（需本地装 playwright；不点任何创建/删除按钮）
#   PLAYWRIGHT_MODULE_DIR 指向 playwright 模块目录，避免污染 workspace 依赖
ssh -N -L 18090:127.0.0.1:18080 sqserver &   # 同源隧道（后台 + /api/v1）
PLAYWRIGHT_MODULE_DIR=/tmp/pw/node_modules node infra/scripts/admin-ui-smoke.mjs \
  http://127.0.0.1:18090 /tmp/pw/shots
```

> k6 安装（校园网 Docker Hub 不可达，用 Go 代理装二进制）：
> `GOPROXY=https://goproxy.cn,direct GOBIN=~/bin go install go.k6.io/k6@v0.50.0`

## 怎么看管理后台的真实界面

三种方式，按「临时看一眼」到「反复调样式」选：

### 1) 直接开浏览器（最快）

```bash
# 同源隧道（后台静态页 + /api/v1 一起代理，避免跨域）
ssh -N -L 18090:127.0.0.1:18080 -o ServerAliveInterval=30 sqserver &
```

浏览器打开 **http://127.0.0.1:18090** ，用种子管理员登录：

| 账号 | 密码 |
|---|---|
| `admin` | `Admin@2026` |

> 校园网内也可以直接开 **http://172.16.38.110:18080**（nginx 只绑服务器本机，
> 所以要走隧道或校园网）。
> 后端 API 挂在同一前缀 `/api/v1` 下，所以隧道只需要一个端口。

### 2) 自动逐页截图 + 体检（不想手点时）

```bash
PLAYWRIGHT_MODULE_DIR=/tmp/pw/node_modules node infra/scripts/admin-ui-smoke.mjs \
  http://127.0.0.1:18090 /tmp/pw/shots
```

它会：自动登录 → 逐页截图（13 页）→ 检查每个列表页的**关键列都有值** →
统计 console error / 未捕获异常 / ≥400 的请求。全绿才算通过。
截图在 `/tmp/pw/shots/`，另有 `report.json`。

> 仓库里也留了一份最近一次的结果：[`docs/screenshots/admin/`](docs/screenshots/admin/)
> （13 张页面截图 + `report.json`），可以直接翻看，不用起服务。

### 3) 改样式后重新出图

```bash
# 改完 apps/admin-web/src 下的代码后：
ssh sqserver 'cd ~/MyProject/pkuim-alumni && D="docker compose --project-name nmg-pku-alumni \
  --env-file .env.prod -f docker-compose.prod.yml" && $D build admin-web && $D up -d admin-web && \
  $D exec -T nginx nginx -s reload'
# 再跑一次 2) 的冒烟脚本即可看到新界面
```

> ⚠️ `nginx -s reload` 不能省：nginx 会在**加载配置时**把 upstream 容器名解析成 IP 并缓存，
> 容器重建后 IP 变了，不 reload 会全部 502（而直连 api 却是好的，极易误判）。

## 微信小程序：发一个临时预览版

### 一条命令发布

```bash
bash infra/scripts/release-miniprogram-preview.sh \
  --appid wx6761deb1125d858f \
  --private-key /secure/path/private.wx6761deb1125d858f.key \
  --api-base-url http://8.160.116.34:18080/api/v1 \
  --mock-login false \
  --version 0.1.0 --desc "临时预览版"
```

它按顺序做完：预检 → **离线编译自检** → 写 AppID → 构建期注入运行配置
（API 基址 / 登录方式 / 数据模式）→ **上传前在产物里对账** → 上传（体验版）→
再出一张扫码即开的预览二维码。

> 💡 **不要手改 `apps/miniprogram/src/config/index.ts`**：
> 那三个值（基址 / `USE_MOCK_LOGIN` / `DATA_MODE`）由脚本在**构建期注入**，
> 上传完自动还原源码（`trap` 保证异常路径也还原）。
> 手改极易漏 —— 漏了基址，真机上一个接口都调不通；漏了 `USE_MOCK_LOGIN`，
> 客户用的是「演示账号」而不是自己的微信身份。
>
> ⚠️ 「上传成功」**不代表**「包里的配置是对的」——
> 所以脚本在上传前会离编译一次，直接在**编译产物**里核对这三个值，
> 不符合就**中止上传**（见 `docs/KNOWN-ISSUES.md` #150）。

> ⚠️ 缺 AppID 与上传密钥时**没法上传**（微信公众平台「开发管理 → 开发设置 →
> 小程序代码上传」生成下载；密钥**必须放仓库外**，脚本会拒绝仓库内的路径）。
> 在拿到凭据之前，**离线编译自检**照样能跑通 —— 它不联网，
> 能证明这份工程确实能编译出包（见下文「编译自检」）。

### 后端从哪来：公网接入层

服务器在 NAT 后、无公网 IP，校园网又屏蔽了大部分免费内网穿透
（GitHub / ngrok / cloudflare / localhost.run 等均不可达）。
所以走「**临时公网服务器 + SSH 反向隧道**」：

```
手机 / 客户浏览器
      │  http(s)://<公网IP>
      ▼
[公网服务器] nginx ──127.0.0.1:18080──▶ [SSH 反向隧道]
      ▲                                      │
      └──────────────────────────────────────┘
                  （校园机上的 compose nginx：/ → 管理后台，/api/ → API）
```

**要一台什么配置的公网服务器？** 最低 1 核 / 1 GB / 20 GB 磁盘就够
（只跑 nginx + 一条隧道，内存占用 < 200 MB）；想顺便把整套系统搬过去就 2 核 / 2 GB。
完整清单、端口放行、部署步骤见 **[`docs/DEPLOY-PUBLIC-EDGE.md`](docs/DEPLOY-PUBLIC-EDGE.md)**。

三步：

```bash
# 1) 公网机上装边缘 nginx
bash infra/scripts/deploy-public-edge.sh --listen 80     # 在公网服务器上执行

# 2) 校园机上建反向隧道（脚本会打印公钥，贴到公网机的 authorized_keys）
bash infra/scripts/tunnel-public-edge.sh --public-host <公网IP> --remote-user root --daemon

# 3) 端到端自测（边缘 → 隧道 → 校园机 → API，整条链走一遍）
bash infra/scripts/check-public-edge-e2e.sh 38080 38081
```

### 离线演示兜底：客户手机连不上后端时也有完整界面

小程序内置了一份**离线演示数据**（`apps/miniprogram/src/demo/`）：

| 内容 | 来源 |
|---|---|
| 活动 / 资讯 / 公告 / 合作资源 / 地区行业字典 | **线上 API 导出的真实公开内容**（`infra/scripts/export-miniprogram-demo-data.mjs`） |
| 校友名录（通讯录） | **虚构条目**（线上接口对未认证用户返回 403，且涉及个人信息 → 不导出，改为生成 12 条虚构卡片） |
| 「我」的资料 | 种子账号的档案，导出时**剥掉了联系方式与实名字段**（包里连字段名都没有） |

切换方式在 `apps/miniprogram/src/config/index.ts`：

```ts
export const DATA_MODE: DataMode = 'auto';   // 'live' | 'demo' | 'auto'
```

- `auto`（默认）：先打真实接口，**只有网络层失败**才回退到演示数据，
  首页顶部显示「演示数据模式 · 未连接后端服务」；
- `demo`：完全不联网，纯演示；
- `live`：只走真实接口（公网服务器就位后改这个并重新编译）。

> ⚠️ 4xx/5xx **不会**回退 —— 那是服务端真实的业务响应，
> 用假数据盖住真实缺陷是最坏的结果。这条规则由校验器守着。

### 编译自检：证明「这个包是好的」

微信的 `ci.preview` / `ci.upload` 会**先联网取项目属性**，
没有真实凭据时在编译完成前就失败 → 「上传成功」并不证明「包是好的」。
所以另有一个**不联网**的离线编译自检：

```bash
node infra/scripts/miniprogram-compile-check.mjs apps/miniprogram
```

它检查四件事：产物能编译出来 / 产物里没有残留 TypeScript 语法 /
**每个源模块都在包里**（防止被编译器误剪） / 离线演示模块已入包。

> 这层校验不是白写的：它当场抓出了 **#145** ——
> `project.config.json` 里的 `ignoreUploadUnusedFiles: true` 会让微信编译器
> **误剪 11 个必需模块**（`services/index.js` 是所有页面 `require` 的桶文件），
> 编译「成功」、上传「成功」，但客户拿到的是一打开就崩的包。
> 已修复（该开关置 false），并用这条断言防止它再被打开。

### 你需要提供的两样东西

| 要什么 | 在哪拿 | 注意 |
|---|---|---|
| **AppID** | 小程序注册后，后台「开发管理 → 开发设置」 | **注册在哪个账号下要问客户**（个人 / 企业主体决定能开哪些能力） |
| **代码上传密钥** `private.<appid>.key` | 「开发管理 → 开发设置 → 小程序代码上传」→ 生成并下载 | 密钥**不会明文留存**，遗失只能重置；**放在仓库外** |
| IP 白名单 | 同上页面（建议开启） | 把**执行脚本这台机器的公网出口 IP** 加进白名单 |

> ✅ 本项目已拿到：`AppID = wx6761deb1125d858f`（已写入 `project.config.json`）、
> AppSecret（已接后端，`jscode2session` 验证凭据被微信接受）、
> 代码上传密钥（放在仓库外 `/root/nmg-keys/`）。
> 已上传体验版 `0.1.0`（连真实后端）与 `0.2.0`（离线演示版）。

### 真机能不能连上后端？

- 小程序默认 API 基址是 `http://127.0.0.1:3000/api/v1` —— **手机上的 127.0.0.1 指手机自己**，
  真机必然连不上。发布时用 `--api-base-url` 注入公网地址（构建期注入，编译完自动还原源文件）；
- ⚠️ **微信会强制校验「request 合法域名」**，硬性规则（官方文档）：
  只支持 `https`、**不能用 IP**（局域网 IP 除外）、**必须 ICP 备案**。
  → 我们现在的公网入口 `http://8.160.116.34:18080` **无法**配置成合法域名。
- **因此有两条路**：
  | 场景 | 做法 |
  |---|---|
  | 体验期（今天就能用） | ① 手机开**调试模式**：小程序右上角「…」→「开发调试」→「打开调试」→ 重进小程序（绿色 vConsole 浮标即生效）；② 或用**离线演示版**（`--data-mode demo`，完全不联网，扫码即用） |
  | 正式发布 | 买域名 → **ICP 备案** → HTTPS 证书 → 配置 `request 合法域名` → 重新上传。清单见 **[`docs/DOMAIN-AND-ICP-FILING.md`](docs/DOMAIN-AND-ICP-FILING.md)** |
- ⚠️ 「不校验合法域名」这个开关**只存在于微信开发者工具**
  （「详情 → 本地设置」），**公众平台没有**；手机端只能靠**调试模式**。
  详见 `docs/KNOWN-ISSUES.md` #151。

> 小程序工程在 `apps/miniprogram/`，用微信开发者工具直接「导入项目」即可
> （`project.config.json` 里的 `appid` 已是真实的 `wx6761deb1125d858f`，
> 脚本 `--write-appid` 仍可替你改写）。

## 尚未配置（需真实资质，与实现质量无关）

- 微信订阅消息模板（当前仅站内通知，Outbox 通道与 Worker 派发已实测可用）
- **自有域名 + ICP 备案 + HTTPS 证书**（小程序正式发布的硬前置，
  选型与材料清单见 [`docs/DOMAIN-AND-ICP-FILING.md`](docs/DOMAIN-AND-ICP-FILING.md)）
- OSS/COS 对象存储（当前使用 MinIO，切换只需改环境变量）
- 对象存储异地容灾（当前备份落在服务器本地磁盘）

## 关键约定

1. **契约先行**：`packages/contracts/src/api.ts` 的 `ApiPaths` 是前后端唯一事实来源；
   `contract-routes.e2e-spec.ts` 逐条比对契约路径与服务端路由，
   `infra/scripts/check-client-paths.mjs` 进一步比对**两端客户端的真实调用点**与
   **服务端的 (方法, 路径)**——路径对、方法错这类漂移会在集成测试阶段直接失败。
2. **数据库只走迁移**：`synchronize:false`，迁移必须幂等；生产改动一律新增迁移，不改历史迁移。
3. **隐私硬规则**：联系方式只存 `private_contacts`（AES-256-GCM），列表接口永不 SELECT；
   可见需「active 连接对 + 双方 allow_contact_share + 双方授权记录」四者同时成立。
4. **并发落在数据库层**：报名用条件更新 + 唯一索引；互申用规范化 `pair_key` + 可空 `pending_guard`；
   审核用 `version` 乐观锁；重复提交用 `idempotency_records` 唯一索引。
5. **测试隔离**：集成测试只允许对库名含 `test` 的库执行（脚本与测试基座双重护栏）。
6. **验收可追溯**：`docs/top.md` §10.4 的 18 步验收流程由 `acceptance.e2e-spec.ts` 逐步骤断言，
   失败时直接指出是哪一步。
7. **前端有静态防线**：小程序未在微信开发者工具中运行、管理后台不跑浏览器，
   `infra/scripts/check-frontend.sh` 用静态交叉校验挡住「编译期查不出、运行时才白屏」的缺陷
   （页面注册、跳转地址、事件绑定、模板字段、组件引用、路由与权限点）。
8. **需求可追溯**：`docs/top.md` 的页面体系与 API 分组落成 `docs/SPEC-COVERAGE.json` 矩阵，
   `check-spec-coverage.mjs` 校验「需求条目 ↔ 真实实现」双向一致 ——
   需求写了没实现、或实现了没登记需求出处，都会直接失败。
9. **校验器必须反向验证**：一个「通过」的校验器可能根本没校验任何东西
   （曾出现 SQL 库名写死导致结构指纹恒等成立，也曾出现两个校验器职责重叠）。
   因此**每个校验器都要做反向验证**：注入缺陷 → 确认报错且退出码非 0，否则视为恒过、不可信。
   反向验证已脚本化并接入回归链：
   `infra/scripts/check-frontend-selftest.sh`（6 个前端 / 契约校验器，12 类缺陷注入 + 元自检）、
   `infra/scripts/backup-restore-drill-selftest.sh`（恢复演练校验器，2 轮缺陷注入）。
10. **备份必须真的能恢复**：`backup-restore-drill.sh` 把恢复演练变成常规检查 ——
   全部表逐表行数 + 列结构/外键/索引/迁移指纹比对，演练库自动清理，线上库全程只读。
11. **契约是唯一事实来源，且集合级比对只做一处**：`check-contract-routes.mjs` 负责
    「契约 ApiPaths ↔ 服务端路由」双向比对（error 级，排除基础设施路径）；
    `check-client-paths.mjs` 专注镜像一致性与客户端真实调用点。两处不重复实现。
12. **幂等键按用户隔离**：幂等 scope 含用户维度，匿名请求不启用幂等 ——
    否则相同幂等键会把**他人的响应回放**给请求方（曾泄露联系方式明文与访问令牌）。
13. **数据必须自洽**：`infra/scripts/check-data-integrity.sh` 把设计约束变成 32 项可执行检查
    （字典外键、联系方式只以密文存储、认证状态机与流程记录一致、唯一性、外键存在性）。
    数据库层的数据不满足设计约束时，回归会直接失败 —— 种子数据也必须自洽。
14. **管理端路由统一在 `/admin` 命名空间**：公开只读接口（`GET /articles/categories` 等）
    与管理端写接口不得共用同一路径前缀；契约里管理端路径一律写在 `ApiPaths` 的
    Admin 区段。一致性校验只能保证「没有漂移」，**路径语义正确性要单独兜底**。
15. **私有资源必须校验归属**：文件、联系方式等私密数据，读取地址与写入入口都要比对归属；
    越权一律返回 **404**（不泄露资源是否存在）。端点覆盖必须闭合到 100% ——
    「从来没被调用过」的接口最容易藏着真实缺陷（私有文件横向越权就是这么发现的）。
16. **路径对不等于结构对**：契约声明了返回类型，服务端就**必须**按该类型返回 ——
    分页一律 `{ items, meta }`，字段一个都不能少；客户端在传的筛选项，
    服务端必须**真正支持**（否则筛选框只是摆设）。
    `infra/scripts/check-response-shape.mjs` 拿客户端声明的泛型返回类型当标准，
    真实调用服务端逐字段核对，已接入回归链第 12 步。
17. **「不抛异常」不等于「没问题」**：字段缺失、筛选失效这类缺陷不会报错，
    页面照常渲染，只是列是空的。因此除了自动校验，还要有**只读的真实浏览器冒烟**
    （`infra/scripts/admin-ui-smoke.mjs`）。
18. **客户端发了的，服务端必须真的接住**：查询参数没在 DTO 里声明会被剥掉，
    请求体字段没在 schema 里会被 `whitelist` 剥掉 —— 两种都**静默丢弃**，
    前者让筛选框变成摆设，后者让数据「保存成功却没存进去」。
    `infra/scripts/check-request-contract.mjs` 把「客户端发了什么」与
    「服务端接了什么」逐个对账，已接入回归链第 13 步。
19. **契约的镜像必须同步**：小程序无法在运行时引用 `@nmg/contracts`，
    只能手工镜像一份类型；镜像一旦滞后就会静默分叉
    （小程序编译照过、运行时字段 undefined）。
    `infra/scripts/check-contract-mirror.mjs` 逐类型比对，漂移即失败。
20. **角色权限矩阵只有一份事实**：后台「角色 × 权限矩阵」页面把角色与权限的
    对应关系**硬编码**在前端，而服务端真正生效的是 `role_permissions` 表 ——
    两边不同步，管理员看到的矩阵就是错的。
    `infra/scripts/check-rbac-matrix.mjs` 对账
    契约 ⟷ 种子 ⟷ 前端矩阵 ⟷ 服务端端点实际要求。

21. **服务端承诺的参数必须真的用上**：DTO 里声明了筛选条件、Swagger 如实对外公布，
    但 handler 只透传了一部分 → 其余参数被**静默丢弃**：请求照发、状态码 200、
    结果不受筛选影响，筛选框看起来能用、实际是摆设。
    响应结构校验（看返回了什么）与请求契约对账（看客户端发了什么）**都查不出这一类**，
    必须单独一层：`infra/scripts/check-swagger-param-usage.mjs`
    静态追踪 `query.<prop>` / 整体透传到 service 的链路，已接入回归链第 14 步。
    同时：**公开路径空间只放公开接口** —— 管理端能力收敛在 `/admin` 命名空间
    （需求基线 §4.3），管理端校友列表统一走 `GET /admin/alumni`。
22. **重建容器后必须 reload nginx**：nginx 的 `upstream` 在加载配置时一次性把容器名
    解析成 IP 并缓存；api / admin-web 容器重建后 IP 会变，不 reload 就会出现
    **502**（而 api 直连是好的，排查时极易误判成「服务挂了」）。
    `infra/scripts/deploy.sh` 已内置这一步；手工 `docker compose up -d` 重建时
    必须补一次 `docker compose exec -T nginx nginx -s reload`。
23. **声明出来的字段必须真的被用上**（查询参数与请求体字段同等对待）：
    DTO 声明了、Swagger 公布了、客户端照发，服务端却没接 ——
    请求照发、状态码 200、结果不受影响（筛选框是摆设）或数据没存进去
    （用户以为保存成功）。`infra/scripts/check-swagger-param-usage.mjs`
    静态追踪 `query.<prop>` / 整体透传到 service 的链路，
    查询参数与**请求体字段**一并覆盖，已接入回归链第 14 步。
    两点配套纪律：
    - 数组型字段必须写 `@IsArray()` + `@IsInt({ each: true })` +
      **`@Type(() => Number)`** —— `ValidationPipe` 开了
      `enableImplicitConversion`，少了 `@Type` 时畸形对象会被
      静默强转成**空数组**（= 清空数据），比 500 更糟；
    - 附件 / 媒体类字段落库前必须校验**归属**（必须是本人上传），
      否则就是跨用户私有文件泄露的口子。
24. **请求体必须用 DTO，且不能依赖隐式类型转换**：
    - `Record<string, unknown>` 或普通 `interface` 作为请求体 → 运行时 metatype 是
      `Object`，**ValidationPipe 会完全跳过校验**（脏数据入库、非法值变 500）；
      一律用带 `class-validator` 装饰器的 **DTO 类**，字段与契约一一对应；
    - `ValidationPipe` 的 `enableImplicitConversion` **必须关闭**：
      开启时 class-transformer 会按 `design:type` 隐式强转，
      把畸形输入悄悄「修正」成合法值 ——
      `'false'` → **true**（布尔筛选会反着筛）、`{}` → `"[object Object]"`（脏数据入库）、
      `{nope:true}` → `[]`（被当成「清空数据」）。
      需要转换就**显式**写 `@Type(() => Number)`；
      布尔用 `@ToBoolean()`（`common/dto/transforms.ts`），
      ⚠️ 不可用 `@Type(() => Boolean)`（`!!value` 语义，`'false'` 会变 true）。
    - 契约与实现冲突时**以实现为准修正契约**：契约里留着服务端从不接受的字段
      （如 `publishedAt` —— 发布时间已改为服务端按 `status` 推导），
      客户端照契约填了会被 whitelist 剥掉，接口照样 200 但「看起来设了、其实没生效」。
25. **管理端的写操作必须留下审计痕迹**：让管理员填「原因」就必须真的落库 ——
    静默丢弃等于让管理员白填，且事后无从追溯。
    账号状态变更写 `user.status.change`（带 `from / to / reason`），
    管理员新建 / 改角色写 `admin.user.create` / `admin.user.update`。
26. **校验器本身也会有盲点，必须能反向验证**：
    `check-swagger-param-usage.mjs` 一度把
    `this.setUserStatus(actor, id, body)`（**控制器自己的私有方法**）
    追丢，把合规实现误报成缺陷；解析器还会在遇到多行泛型返回类型
    `Promise<{ a: string; ... }>` 时**丢弃整个方法**。
    修完后新增反向验证用例 `swagger-param-own-helper-drop`
    （私有方法里删掉字段必须被抓出），自测用例 2 类 → 3 类；
    判定规则改为聚合 **used > unknown > unused** ——
    只要还有一条路径「判不了」，就不能断言「没用」。
27. **校验器的「提示」也可能是假的，判定条件要逐条自查**：
    响应结构校验器的「元素结构从未被校验」提示（缺陷 #76 加的）
    曾把判定条件写反 —— `if (!value.length) return;`，
    于是**数组非空时反而登记盲点**，而真正全空的情况永远不报：
    **那层保护从上线起就是失效的**，反向验证用例因为断言太宽也没发现。
    两条纪律：
    - 提示类断言要**双向**：既要「该报的时候报了」，
      也要「不该报的时候没报」（新增 `expect_no_note`）；
    - 盲点的口径是**元素类型**，不是某条路径 ——
      列表里第 1 条为空、第 2 条有内容时，元素结构其实已经校验过了；
    - 线上业务库没有的数据（没人上传附件、没人报名活动），
      元素结构就永远校验不到 —— 用**合成夹具**把这类结构补上，
      并接进回归链，让它们每轮都被核对。
28. **探针不要用 mock 登录建新用户**：mock 登录会**忽略传入的 openid**，
    随机生成一个并**新建用户** —— 一次探针就把业务库 `users` 计数 +1，
    破坏「业务库不被污染」的不变量（本轮实测踩过一次，已清理恢复）。
    正确做法：复用**已存在**的种子账号换令牌
    （回归链用的是 `mock_k6_alumni_001`），需要新数据就在**测试库**里造。
29. **「写了 DTO」不等于「会被校验」**：Nest 的 `ValidationPipe` 只校验
    **运行时 metatype 是「带 class-validator 装饰器的类」**的请求体。
    写成 `Record<string, unknown>` / 普通 `interface` / 内联对象字面量 / `any`
    时，运行时 metatype 是 `Object` → **整个请求体被静默跳过**：
    畸形输入进库、非法枚举变 500、契约外字段不被拒绝。
    这类缺陷靠人工审查一定会漏（#79 修了管理端 12 个端点，
    媒体登记 #88、活动报名 #89 仍漏在网外），
    现在由 `infra/scripts/check-request-dto.mjs` 自动对账
    （回归链第 15 步，自带 4 类注入用例的反向验证）。
30. **TS 的类型标注在运行时没有约束力**：写
    `status?: 'pending' | 'approved'` 只是给编辑器看的，
    运行时它就是任意字符串 —— 请求体校验、查询参数校验**都不会**因此生效。
    状态类字段（status / action / type / stage / visibility / source / level /
    channel / kind）必须写 **`@IsIn([...])`**，并让枚举值与**数据库 ENUM** 逐字一致：
    - DTO 放行 DB 不接受的值 → 落库被数据库拒绝 → **500**；
    - 没有 `@IsIn` → 传错值不报错，查询**静默返回空列表**，
      用户会误判成「数据丢了」而不是「参数写错了」；
    - 认证审核的 `action` 曾因此返回 **409**（参数非法却报成状态冲突）。
    现在由 `infra/scripts/check-enum-consistency.mjs` 对账
    （数据库 ENUM ⟷ DTO ⟷ 契约，回归链第 16 步）；
    自由文本列（如审计操作码、事件类型）走**显式豁免清单**，理由必须写明。
    ⚠️ `@Query()` 同理：写成交叉类型
    （`PaginationQueryDto & { keyword?: string }`）会让 metatype 退化成 `Object`
    → 参数不校验也不转换（`page` 变 NaN → 列表接口 500）。
31. **队列任务的 `jobId` 是去重键，不是标签**：BullMQ 对**相同 `jobId`** 的 `add`
    会**直接忽略**（第二次 `add` 什么都没发生，不报错、不计数）。
    如果 `jobId` 只由业务 ID 组成（`outbox-${id}`），那么「失败 → 重投」就会
    被去重**吞掉** —— 该通知**永远**投不出去，而系统看起来一切正常。
    两条纪律：
    - `jobId` 必须带**重试计数**（`outbox-${id}-a${attempts}`），
      失败时递增计数 → `jobId` 变化 → 重投能真正进队列；
      同一计数内的重复投递仍被去重（防重复消费）；
    - `UPDATE` 之后**必须检查 `affectedRows`**：更新 0 行说明目标记录不存在，
      此时继续往下走会把「没送达」写成「已送达」—— 消息**静默丢失**。
      不确定的事件要显式标 `failed`，不要留在 `pending` 里被无限重扫。
    这类失败**不抛异常、不影响任何接口响应码**，HTTP 层的集成测试一个都覆盖不到；
    现在由回归链**第 17 步**「Worker 投递链路自检」在容器内用
    **测试库 + 测试 Redis + 独立队列**真实跑一遍，并内置**反向验证**
    （复刻修复前的实现跑同一场景，确认旧实现确实会静默失败）。
32. **注释声称的事务边界，必须与代码一致**：Outbox 模式的全部价值在于
    「业务写入与 outbox 事件**同事务**」——
    `docs/top.md` §597、`docs/CONCURRENCY-DESIGN.md` §67、`docs/ARCHITECTURE.md` §58
    三处都这么要求。修复前 `NotificationService.push()` 的注释写着
    「与业务同事务，保证『业务成功但通知丢失』不会发生」，
    而**8 个调用点没有一个在事务内** —— 注释与事实相反。
    后果不是理论上的：通知写失败时业务数据**已经提交**，
    用户看到 500 却留下了一条永远收不到通知的记录，活动报名还会白占一个名额。
    两条纪律：
    - 注释里写了「同事务」，就必须真的能**证明**它同事务 ——
      现在由 `notification-atomicity.e2e-spec.ts` 用**故障注入**
      （让通知写入抛错）断言业务数据被整体回滚；
    - ⚠️ 事务内的仓储访问必须走 `manager.getRepository(...)` ——
      用默认仓储（`this.xxx`）会走**另一条连接**，写出去就**不在事务里**了，
      看上去包了事务，实际什么都没保证。
    同样地，「失败必须留痕」也要落到字段上：
    `notification_deliveries` 的 `status='failed'` / `attempts` / `last_error`
    三个字段修复前**从未被写过**，失败被彻底吞掉。
33. **幂等键必须能被释放，也必须有有效期**：幂等键的用途是「让重试安全」，
    但一个只覆盖「成功之后」的测试会让你以为它已经做到了：
    - **失败之后**：拦截器先占位（`in_progress`），只在成功时才改成 `completed`。
      handler 一旦抛错（参数校验失败、乐观锁冲突、名额已满……），
      记录就**永远停在 `in_progress`** → 客户端用**同一个键**重试只会拿到
      409「幂等键正在处理中」，最长 24 小时。
      幂等键反而成了「一次失败、永不重试」的地雷。
      正确做法：失败时**释放**键；同时严格区分「业务失败」与「业务成功但存档失败」——
      后者**不能**释放（否则重复执行），但要把成功响应还给客户端。
    - **有效期之后**：`expires_at` 只写不读时，「24 小时有效期」是装饰性的 ——
      `docs/API-SPEC.md` 写的「**在有效期内**只执行一次」实际成了「永远只执行一次」，
      过期后仍回放一份早已过时的响应。写了一个字段不等于实现了它。
    - **错误码**：`ErrorCode.IDEMPOTENCY_CONFLICT` 在契约里写着，
      实现却抛普通 `ConflictException` → 过滤器映射成通用 `CONFLICT`
      → 这个错误码**从未被返回过**，客户端按契约判断永远匹配不上。
34. **可读 ≠ 可写：签名地址要按「能力」分别授权**。
    同一个「取地址」接口可能返回两种**能力完全不同**的地址：
    - `intent=download` → MinIO 预签名 GET 地址 —— **读**；
    - `intent=upload` → `POST /uploads/:id/content?token=…` —— **写**（能覆盖那个对象）。

    如果只用「可见性」一个维度做鉴权，就会出现：
    「public 资产对所有人开放」→ 于是**任何登录用户**都拿到了**写入地址**
    → 可以把别人的文件（资讯封面等）**覆盖掉**。
    实测修复前：乙对甲的 public 资产取 upload 地址返回 **200** 并直接吐出可用的 token。
    两条纪律：
    - 鉴权要按**能力**分维度，不能按「可见性」一刀切 ——
      写能力永远只给上传者本人；
    - 修这类缺陷时，**对照用例必须同时写**：
      「public 资产**下载**地址仍应对所有人开放」——
      否则很容易把公开能力一起关掉，变成另一个缺陷。
35. **能被搜到的字段，必须是看得到的字段**。
    隐私开关最容易只在**一半**的路径上生效：
    响应组装时按开关裁剪（读侧 ✓），检索条件里却直接 `LIKE` 匹配同一列（检索侧 ✗）——
    用户明明关了「公开毕业院系」，别人照样能在通讯录里搜到他，
    返回的那一行字段是 `null`，但「搜得到」本身就已经把值泄露了。
    等值筛选（`regionCode` / `industryCode`）更糟：码表空间小，可以**逐个枚举**。
    两条纪律：
    - 开关要作用在**所有读取路径**上 —— 响应、检索、筛选、导出，一个都不能漏；
    - 开关覆盖不到的字段，要么补上开关（如 `showDirection` 此前**没有任何入口能改**），
      要么就别让它出现在响应里 —— 契约的 `DirectoryEntry` 里根本没有 `intro`，
      拿它当检索键等于一个「简介内容存在性」的预言机。
36. **密钥不能进 Docker 构建上下文**。没有 `.dockerignore` 时，
    `docker build` 会把**整个仓库**发给 Docker 守护进程 ——
    包括 `.env.prod`（数据库口令 / `JWT_SECRET` / 对象存储凭据）、`.git`，
    以及本机 `node_modules`（pnpm 符号链接，拷进镜像会变成指向宿主机的悬空软链）。
    守护进程与仓库同机时泄露面有限，但一旦换成**远程构建器 / CI**，
    这些文件就被上传到网络另一端 —— 这不能只靠部署者的自觉。
    另一条同样要记住：**`.dockerignore` 变了，BuildKit 的 `COPY` 层缓存就会失效**，
    `pnpm install` 需要重新访问 npm registry —— 也就是说**构建依赖 registry 可达**，
    依赖缓存只加速、不保证离线可构建。
37. **契约里的错误码必须真的能被返回**。契约的 `ErrorCode` 是客户端判断的唯一事实来源，
    但只要服务端**从不返回**某个码，它就是**死码** ——
    客户端按契约写的 `code === 'XXX'` 判断**永远走不到**，而且**没有任何报错**：
    - `VERIFICATION_REQUIRED`：未认证用户与无权限用户拿到**同一个** `FORBIDDEN`
      → 客户端无法区分「去认证页」与「没权限」，而这是两种完全不同的用户引导；
    - `AUTH_FAILED`：「没带令牌」与「密码错 / 令牌失效」被混为一谈
      → 用户被引导去做一件没用的事（重新登录）；
    - `IDEMPOTENCY_CONFLICT`：幂等冲突实际返回通用 `CONFLICT`。
    这类缺陷**响应结构校验、请求契约对账、端点覆盖全都查不出来**
    ——它们看的是字段、参数、路由，**没人看错误码**。
    现在由回归链**第 18 步**「错误码对账」守住：
    契约里的每一项都必须在服务端源码里找得到引用，否则报 `DEAD_ERROR_CODE`；
    反过来服务端会返回而契约里没有的码，报 `CONTRACT_MISSING_CODE`。
38. **管理端的写路径同样要有事务、正确的状态码与不变量**。
    管理后台「管理员账号」是这个仓库里最容易被忽略的写路径 ——
    它的每个端点都很短，于是谁也不会想到「短代码也会出事」：
    - **登录名重复**原本以 **500** 抛给前端 —— 唯一索引冲突是**客户端可修正**的输入问题，
      现在是 **409 + `CONFLICT`**；
    - **对象不存在**原本返回 **200 + `{error:'NOT_FOUND'}`** ——
      它会被统一包装成 `code:'OK'` 的**假成功响应**，
      客户端按 `code` 判断成功，于是**把「不存在」当成成功处理**；现在统一 **404**；
    - 「改资料 → 同步角色 → 写审计」是**多步写**，没有事务就会留下
      **角色被清空**的半成品账号（与通知写入的 #99 同一形态）；
    - 更危险的是：**没有任何保护**能阻止管理员把自己停用、
      或把最后一个能管管理员的人降权 —— 结果是**再没人能登录后台**。
      现在有一条硬不变量：**系统里至少存在一个 active 且拥有 `admin:manage` 的管理员**，
      在事务内、提交前校验。
    这类缺陷 HTTP 层的集成测试一个都覆盖不到：
    它们不抛异常、只影响**数据完整性**与**状态码语义**。
    现在由 `admin-account-management.e2e-spec.ts`（12 例，含 6 条对照用例防误伤）
    与「注入故障 → 断言整体回滚」的原子性用例守住。

39. **枚举校验必须知道「字段对应的是哪张表」**。
    只要求「DTO 的取值被**某个**数据库 ENUM 包含」是不够的 ——
    `['active','disabled','locked']` 恰好被 `users.status` 那个 ENUM 包含，
    于是一个**只存在于 `admin_users`** 的非法取值也能蒙混过关
    （后台「账号状态 = 已锁定」因此永远筛不出任何行）。
    现在枚举校验器有**表绑定**规则：绑定到具体列的 DTO / 契约字段，
    取值必须被**该列**的 ENUM 包含；契约侧还要求**该列的每个取值都被声明**，
    并支持解析**具名类型别名**（`UserStatus` 这类别名此前完全没被解析过）。

40. **多步写必须同事务：故障注入是这类缺陷唯一的自动防线**。
    「一个业务动作由多次写组成」在代码里看不出破绽 ——
    认证补交材料（改状态 → 挂材料 → 改用户阶段）、个人资料保存（资料 → 联系方式）、
    管理端改账号（资料 → 角色 → 审计日志）、通知投递（业务 → 通知），
    修复前**全都是各自提交**，任何一步失败都留下半成品。
    这类缺陷**静态检查判不出来**（两次写该不该同生共死取决于业务语义），
    但**故障注入判得出来**：在中间某一步制造失败，断言前面的写入**必须回滚**。
    现在这套手法收敛成一个套件（`multi-step-write-atomicity.e2e-spec.ts`），
    每个缺陷用例都配一条**对照用例**，并且每轮都在容器里**回退旧行为**确认用例真红。
    ⚠️ 注入点要打在**仓储原型**上 ——
    事务里的仓储是 `manager.getRepository(X)` 新建的另一个实例，
    只改注入实例上的方法**拦不住**事务内的那次写入。
    同理，**计数这类与业务数据无关的字段不能整行写回** ——
    「读出整行 → 计数 +1 → 整行 save」会让一次浏览把并发中的管理端修改覆盖回旧值。

41. **计数类不变量：条件更新必须看影响行数**。
    「用条件更新做状态迁移」只做了一半——**更新条件对了，但没人看它影响了多少行**。
    活动取消报名就是典型：
    `UPDATE … WHERE status='registered'` 若影响 **0 行**（说明这条报名**已被别人取消**），
    代码却仍继续回收名额 → `registered_count` 比真实报名数**少一个** →
    容量判定失真 → **看起来还有名额，实际会超卖**。
    而且外层那次读取发生在**事务之外**，正是竞态的窗口。
    规矩：**凡是「更新 + 依赖更新结果」的地方，都必须判断 affectedRows**；
    并把这类不变量写进数据完整性校验器（业务库只读、每日可跑），
    让它变成**永久约束**而不是一次性的用例。

42. **默认值不等于正确：HTTP 状态码也是要审的**。
    Nest 对 `POST` 的默认是 **201 Created**，而 201 的含义是
    「本次请求**创建了**新资源」且**应当**带 `Location` 头。
    仓库里有一批 POST 端点**根本不创建任何资源**（标记已读、全部已读、
    拒绝/撤回申请、提交/撤回发布、停用账号别名）却全都返回 201。
    最刺眼的一处：`POST /admin/users/:id/status` 是 PATCH 的**兼容别名**，
    却和 PATCH **返回不同的状态码**（201 vs 200）——
    同一个操作、两条路径、两种答案。
    另一个方向：**同一个对象、两个端点、相反语义**也不允许 ——
    `GET /notifications/:id` 对不存在返回 404，
    `POST /notifications/:id/read` 却对不存在返回 200「已读」。
    规矩：**写操作返回什么状态码，要按「它到底做了什么」来定**，
    并且「兼容别名」必须与主路径**逐字节一致**。

43. **改了服务端的语义，就得回头扫既有测试的断言**。
    #126 把 7 个端点从 201 改成 200 之后，`notifications.e2e-spec.ts`
    里的断言**当场就失效了**，但没人会想到去翻那个文件 ——
    改服务端的语义，**测试文件通常不在改动清单里**。
    更糟的是报错发生在**别的套件**里，离改动点很远；
    而「没人跑那批测试」时，它就静静烂在那里。
    规矩：**语义变更必须有对应的对账工具**，
    本仓库新增第 12 层校验 `check-status-code-assertions.mjs`：
    解析控制器声明的成功状态码（`@HttpCode` 优先，POST 默认 201），
    解析测试里的 `.expect(NNN)`，逐条对账。
    判定要**分方向**：服务端 200 而测试断言 201 → **失败**（语义变了、测试没跟上）；
    服务端 201 而测试断言 200 → 只**提示**（常见于「幂等回放返回 200」）。

44. **「单独跑绿、整条链跑红」通常不是业务逻辑，是隔离性**。
    回归链偶发报 `Table definition has changed` 与
    `Deadlock found when trying to get lock`，单独跑那个套件却是绿的。
    机制是**一个连接带着未提交事务回到池里**：
    它的读视图早于 `TRUNCATE` → 之后读该表报「表定义已变」；
    它持有的间隙锁让并发 `INSERT` 与它互等 → 死锁。
    另一个同源问题：`SET FOREIGN_KEY_CHECKS` 是**会话级**变量，
    而池化连接下 `query()` 每次可能换连接 ——
    「设变量」与「用变量」必须落在**同一条连接**上才成立。
    规矩：**测试夹具的会话级设置必须自建专用连接**，
    并在重置前先 `ROLLBACK`、在套件结束时**点名**残留事务；
    回归链也要在测试后断言「测试库残留事务数 = 0」。
    注意：让污染**无处藏身** ≠ 已修好泄漏点 ——
    两者都要如实说。

45. **校验必须先于写入，多步写必须同事务 —— 这两条要一起看**。
    资源「修改」这条链同时踩了两个坑：
    「附件归属校验」排在**内容写入之后**（#131），
    「内容写入」与「附件整体替换」**没有事务**（#132）。
    前者让**请求被拒却留下副作用**（400 返回给客户端，内容却改了）；
    后者让**半成品**留在库里（内容是新的、附件是旧的）。
    而同一个模块的「创建」早就用事务包好了 ——
    **同一个模块，两种写法**，说明上一轮修过的形态并没有被普遍执行。
    规矩：**任何校验都要排在所有写入之前**；
    任何「写 + 写」都要问一句「中途失败要不要一起回滚」。
    附一条工具层面的教训：`Repository` 继承自 `EntityManager`，
    `save` 只存在于**同一个原型**上 ——
    故障注入打在原型上会命中**所有**仓储，
    不按实体类型精确拦截，用例就会「假通过」。

46. **审计日志不是「顺便记一下」，它和业务写同生共死**。
    管理端 11 个写接口都是两步：改业务数据 → 写 `admin_action_logs`。
    修复前两步**各自提交** ——
    审计日志写失败时，业务改动**已经落地**，接口却返回 500，
    管理端以为失败、重试一次，业务数据被改两次；
    而且那一次操作**没有审计记录**，事后无法追溯。
    规矩：**「改了业务 + 留痕」必须同事务**；
    做法是让 service 方法接受可选的 `manager`，
    由控制器开事务并把同一个 manager 传给两边。
    顺带一个工具侧的教训：校验器判「事务逃逸」时，
    得看这次调用**有没有把 manager 传下去** ——
    传了就不是逃逸（否则规则会误报到卡住回归链的程度）；
    而「真逃逸」（不传 manager 的仓储写入）必须**仍然**被抓到，两头都要断言。

47. **校验器自己也会腐朽 —— 注入点必须与代码形状解耦**。
    一次重构把「注入用的目标代码」改了写法，
    回归链第 19 步的**反向验证当场挂掉**（注入失配）——
    这提醒我们：反向验证不只是「证明规则不恒过」，
    它还是**校验器自身健康度**的探针。
    处置有三条通用规矩：
      - **注入点不要依赖现有代码的形状** → 改成「新增一个文件」，
        实现怎么演进都能注入；
      - **规则要认得各种写法的全貌** → `this.x.save()` 与局部别名的 `x.save()`
        都是写，漏一种就会漏判；
      - **「有事务」不等于「在自己事务里」** →
        收 EntityManager 的方法由**调用方**开事务，不能当「无事务」候选；
        反过来，它若绕过 manager 写入，那次写**不在事务里**，必须点名。
    一句话：**规则和注入点都要按「语义」写，而不是按「当前代码长什么样」写**。

48. **「先查后插」在单线程下永远是对的 —— 只有并发才会撞唯一键**。
    这是本阶段挖出的缺陷 #137：`先 findOne 读，读不到就 INSERT`，
    单线程下「只发生一次写」没问题，**并发**下两个请求都读不到既有行 →
    都去 INSERT → 后到的撞唯一键 → 500。
    修法是**捕获 `ER_DUP_ENTRY`（errno 1062）后改为更新既有行**，
    而不是甩 500 给用户。
    更值得记的是**怎么测**：固定延时和「同时开始读」的屏障**都会假通过**
    （两个请求错开 / 先读到的那次抢先提交）→ 必须用**两段式屏障**
    （都到达 → 都**读完** → 才放行去写）才能让冲突必现。
    这类缺陷单线程用例覆盖不到 → 新增**第 13 层校验**静态兜底。

49. **夹具用 DDL 重置，会把「靠巧合通过的断言」藏起来**。
    老夹具用 `TRUNCATE` 清库，它**复位了每张表的自增计数器** →
    于是「通知 id」恰好等于「联系申请 id」，
    `expect(outbox.aggregate_id).toBe(String(request.id))` 这条断言
    **一直是靠巧合通过的** —— 它验证的其实是一个错误的值。
    改成 DELETE（DML）重置后，两个计数器不再同步，这条断言**立刻变红**，
    才把真缺陷 #139（`notification.push()` 静默丢弃 `options.aggregateId`）挖出来。
    一句话：**改夹具有可能改出真 bug**；
    而新写的用例要**自己把两个计数器拉开距离**
    （插一条 id=900000 的占位通知），否则换回 TRUNCATE 就又变成假通过。

50. **DDL 慢到能拖垮整条回归链**。
    这台服务器上 DDL 延迟在 2~30 秒/条剧烈波动
    （`TRUNCATE` 30s、`ALTER COMMENT` 9.4s、`RENAME TABLE` 15s），
    一次重置 25 张表可能要好几分钟。
    夹具改用**单事务 DELETE**（DML，毫秒级、不动表结构）后，
    既免疫 DDL 慢，也不再让其它事务的读视图失效。
    代价是**自增计数器不再复位** —— 副作用要显式记账，别装作没有。

51. **幂等键必须落到「这一次具体的操作」，而不是「这一类接口」**。
    拦截器把 scope 写成 `METHOD:${request.route.path}` —— `route.path` 是**路由模板**
    （`/connections/:id/contact-grant`），于是「同一把钥匙开 17 号和 18 号连接」
    落进**同一个 scope**：第二个请求被判成**回放**，返回 17 号的响应，
    而 **18 号根本没被写入**，客户端却收到 200（静默的数据丢失）。
    处置：scope 改用**实际路径**（含资源 id），请求指纹扩到
    「方法 + 实际路径（含查询串）+ body」→ 同一路径不同查询串/请求体仍按契约 409。
    顺带一条容易漏的：**scope 列长度要跟着改** —— 实际路径比模板长，
    长路由 + BIGINT id 会超过 `VARCHAR(64)` → `Data too long` → 500。

52. **每次请求都换一把新的幂等键 = 没有幂等**。
    管理后台的 axios 拦截器、小程序的请求层都在**每次发请求时现生成**随机钥匙，
    于是「首次其实写成功了、只是响应丢了」的重试被服务端当成**新请求** →
    **重复创建**；服务端那套「同键同体回放」一次都没被真正用到。
    已改：自动重试沿用同一把钥匙（管理后台「已有就别覆盖」；
    小程序把钥匙生成上移到请求层，重试走 `{ ...opts }` 天然沿用）。
    **但仍有缺口**：用户**手动重试**是两次独立动作，
    要去重必须由 UI 层「一个动作一把钥匙」—— 这次如实记为设计缺口，没有假装修好。

53. **「本地和测试环境都正常」不等于「结构是一致的」**。
    回归链第 1 步**重建**测试库、第 2 步**跑迁移** → 测试环境**天然不可能漂移**；
    真正会漂移的只有**业务库**，而它恰恰是**最晚**被验证的那一个。
    本轮就撞上了：deploy 的流程是「同步 → 构建 → `up -d` → 健康检查」，
    **中间没有迁移** —— 代码改了表结构，业务库还是旧结构，
    运行时才报错（`Data too long for column 'scope'` → 500）。
    处置：deploy 在**切流量之前**用新镜像跑一次迁移（迁移是加法式的，旧代码完全兼容），
    失败就**中止部署**；再加一层对账「代码清单 ⟷ 库里已应用」，
    缺一条就**当场失败**，而不是等到用户踩到。

54. **同一份清单不能抄两遍**。
    `migrations/index.ts`（应用用）与 `data-source.ts` 里的数组
    （**`migration:run` CLI 用的就是这份**）曾各抄一份类名 ——
    漏加一个，那条迁移就**永远不会被应用**，而且**没有任何报错**
    （CLI 只会说「没有新迁移」）。
    现在 `data-source.ts` 直接 `import { migrations } from './migrations'`，
    清单**只有一份**；再加一条规则「目录里的每个迁移文件都必须登记进清单」防它回退。

55. **「上传成功」不等于「包是好的」**。
    `ci.preview` / `ci.upload` 会**先联网取项目属性** —— 没有真实 AppID 与上传密钥时，
    它在**编译完成前就失败**。于是「编译这一步有没有问题」从来没人看见过：
    我们一度把「假密钥下只报 empty content」记成了「工程编译成功」，
    那句话**没有任何证据支撑**（Phase 44 已更正）。
    处置：另做一份**不联网**的离线编译自检（给 `utils/sign` 与 `utils/request` 本地打桩），
    并把「源模块 1:1 入包」「产物无残留 TS 语法」当成硬断言。

56. **编译器的「优化」可能比 bug 更危险**。
    `project.config.json` 里 `ignoreUploadUnusedFiles: true`（工具的默认选项）会让微信编译器
    剪掉「看起来没被引用」的文件 —— 而它**剪错了**：被剪掉的 11 个模块**全是必需的**
    （`services/index.js` 是**所有页面** `require` 的桶文件，`config/index.js` 被请求层引用）。
    后果：编译**成功**、上传**成功**、后台**显示已上传**，
    但客户拿到的是一打开就 `module not found` 的**必崩包**。
    对照实验：剪枝开 → 产物 70 个 .js（缺 11）；剪枝关 → 81 个（与源文件 1:1）。
    教训：**交付物要当面对账，不能相信命令的退出码**。

57. **拿不准的东西不能进交付物**。
    演示数据原本用 `import data from './data.json'`。
    微信小程序运行时**是否支持 require JSON 模块**我无法先试一次再决定（没有开发者工具/真机），
    于是改成**编译期内联**的 TS 模块（JSON 是对象字面量的子集）→ 运行时零风险；
    并加一条规则「源码里不得出现运行时 JSON 模块引用」。
    实现要点：**先剥注释再判定** —— 第一版把注释里写的 `require('*.json')` 当成了真引用。

58. **「只有网络失败才回退」是一条必须守住的边界**。
    小程序在 API 不可达时回退到离线演示数据，但**只有网络层失败**才回退：
    HTTP 4xx/5xx 是服务端**真实的业务响应**，用假数据盖住它 =
    把真实缺陷藏起来。这类「回退边界」很容易在后续改动里被无意放宽，
    所以它被写成校验器的一条硬规则（`DEMO_FALLBACK_UNSAFE`）。

59. **守护进程要连子进程一起收**。
    隧道守护收到 TERM 后只杀父 bash、不杀 ssh 子进程 → 远端监听端口**一直被占**；
    更坑的是：子进程被杀后 `while true` 又把它拉起来 → 端口永远腾不出来。
    处置：trap 里**收尾并退出循环**（`on_stop() { cleanup; exit 0; }`），
    停进程改用脚本自带的 `--stop`，并用「端口被占用」的用例反向验证。
