# 测试报告（V1 · 私网测试环境实测）

> 本报告只记录**真实执行**的结果。无法在本环境验证的项明确标注「待验证」，不做任何推测性结论。
> 关联文档：需求基线 `docs/top.md`、执行跟踪 `docs/plan.md`、问题记录 `docs/KNOWN-ISSUES.md`。

## 0. 测试环境

| 项 | 值 |
|---|---|
| 服务器 | `sqserver` → 172.16.38.110:56127，Ubuntu 24.04.5，**128 vCPU / 295 GiB / 991G**（学校私网） |
| 容器编排 | Docker 29.8.2 + Compose v5.5.1，Compose 项目 `nmg-pku-alumni` |
| 数据库 | MySQL 8.4（容器 `nmg-mysql`，127.0.0.1:13306） |
| 缓存 / 队列 | Redis 7（`nmg-redis`，16379）+ BullMQ（`nmg-worker`） |
| 对象存储 | MinIO（`nmg-minio`，19000 / 控制台 19001） |
| API | NestJS 11 容器 `nmg-api`（18081），nginx 入口 `nmg-nginx`（18080） |
| 管理后台 | `nmg-admin-web`（18082，Vue3 + TDesign Vue Next） |
| 压测工具 | k6 v0.50.0（源码安装：`GOPROXY=https://goproxy.cn GOBIN=~/bin go install go.k6.io/k6@v0.50.0`） |
| 数据 | Seed 生成：1000 虚构校友 + **200 压测专用账号** + 5 角色 + 12 权限 + 60 资源 + 5 活动 + 40 认证申请 + 40 连接对 |

> **隔离约定**：所有容器/卷前缀 `nmg-`，端口 18xxx/13306/16379/19000 段；
> 服务器上既有的 `swload-api / swload-pg / swload-redis / swload-worker`（SchoolWall 压测栈）全程未触碰。

---

## 1. 业务冒烟（`infra/scripts/smoke.sh`）

**结果：10 / 10 通过**

| # | 检查项 | 结果 |
|---|---|---|
| 1 | 健康检查返回 ok | ✅ |
| 2 | Mock 登录返回令牌 | ✅ |
| 3 | 读取本人资料成功 | ✅ |
| 4 | 本人资料包含 openid | ✅ |
| 5 | 未登录访问返回 401 | ✅ |
| 6 | 地区字典非空 | ✅ |
| 7 | 行业字典非空 | ✅ |
| 8 | 首页聚合返回快捷入口 | ✅ |
| 9 | 管理员登录成功 | ✅ |
| 10 | 管理端总览可读 | ✅ |

> 首次冒烟仅 6/10，根因是 `UserSession` 实体未注册进 `entities` 数组（登录 500 → 后续全 401），
> 已修复，见 `docs/KNOWN-ISSUES.md` #11。

---

## 2. 集成测试（真实 MySQL + Redis，`apps/api/test/integration`）

执行方式（服务器）：

```bash
bash infra/scripts/test-integration.sh
```

该脚本带**硬性护栏**：库名不含 `test` 直接拒绝执行；自动建库 → 迁移 → Seed → 跑测试 → 结束后校验业务库行数。

**结果：25 个测试套件 / 204 个用例全部通过**（约 60s）

| 套件 | 用例 | 覆盖的不变量 |
|---|---|---|
| `auth.e2e-spec` | 8 | Mock 登录、令牌签发、refresh 轮换、登出吊销、openid 隔离、管理员登录与权限点 |
| `directory.e2e-spec` | 6 | 只返回 `stage=verified` 且 `show_in_directory=1`；字段级可见开关裁剪；**响应中绝不出现联系方式字段**；地区/行业筛选；未公开资料返回 404（不泄露存在性） |
| `connections.e2e-spec` | 9 | 申请→接受→唯一连接关系；接受前双方看不到联系方式；撤回授权后立即不可见；**并发互申只产生一条待处理申请**；重复提交幂等；重复接受幂等；不能给自己发申请；对方关闭接收后无法发起 |
| `events.e2e-spec` | 6 | 同一用户重复报名幂等只产生一条记录；**报名不超卖**（`registered_count <= capacity`）；取消报名回收名额；管理员查看报名名单 |
| `resources.e2e-spec` | 5 | 新发布内容不进入公开列表、审核通过才公开；审核历史只追加不覆盖；作者修改已发布内容需重新审核；乐观锁冲突返回 409 |
| `verification.e2e-spec` | 4 | 提交认证→管理员审核通过→获得校友权限；要求补充材料后回到未认证并可重新提交；审核历史只追加 |
| `notifications.e2e-spec` | 4 | 站内通知链路：业务动作 → 通知入库 + **Outbox 同事务登记** → 未读计数 → 标记已读/全部已读；**通知只属于本人**（他人读详情 404、不能替对方标记已读） |
| `contract-routes.e2e-spec` | 1 | **`ApiPaths` 声明的每一条路径都已在服务端注册**（防止契约与实现漂移） |
| `acceptance.e2e-spec` | 18 | **`docs/top.md` §10.4 的 18 步端到端验收流程**（见下节） |
| `me.e2e-spec` | 5 | `/me` 系列接口的**响应形状**符合契约：`MyAlumniProfile` 内嵌 `privacy` 与自己的联系方式、隐私开关是**布尔**而非 MySQL tinyint、更新接口只返回该接口该有的字段 |
| `idempotency.e2e-spec` | 6 | **幂等接口行为**：回放 / 409 冲突 / 不同键 / **跨用户隔离**（修复前会把他人响应回放给请求方）/ 匿名接口不启用幂等，见 §2.11 |
| `authorization.e2e-spec` | 20 | **越权探测**：水平越权（连接关系 / 联系申请 / 通知 / 资源 / 认证申请）+ 垂直越权（普通校友 → 管理端）+ 匿名边界，见 §2.10 |
| `admin-content.e2e-spec` | 12 | 管理端内容与系统管理：分类/资讯/公告 CRUD、角色/权限/审计/设置读写、普通校友 403、联系申请 reject/cancel 与越权、**路由命名空间不变量**，见 §2.12 |
| `pagination.e2e-spec` | 8 | `page`/`pageSize` 边界（0、负数、>100、恰好上限、非法值、超页时 `meta` 自洽） |
| `rate-limit.e2e-spec` | 4 | 固定窗口限流：第 N+1 次 429、按用户隔离、按「用户 + 路由」计数、匿名按 IP 计数 |
| `admin-write.e2e-spec` | 10 | 管理端**写操作**：管理员账号增改、分类/资讯/公告/活动的改与删（含落库校验与公开侧一致性）、404/403 负向、审计日志，见 §2.13 |
| `uploads.e2e-spec` | 8 | 上传链路三段（登记 → 凭令牌接收字节流 → 直传）、MIME/扩展名白名单、令牌无效 401、**他人资产不可取地址**，见 §2.13 |
| `read-coverage.e2e-spec` | 19 | 管理端 8 条 + 本人 8 条 + 字典 3 条 + 健康检查 1 条，补齐读端点覆盖，见 §2.13 |
| `response-shape.e2e-spec` | 6 | **响应结构符合契约**：管理端列表的必填字段一个不少（`userStatus` / `intro` / `verifiedAt` / `contactVisible` / `updatedAt` / `adminName` / `verifications`）、分页结构自洽、**6 个筛选参数真正生效**，见 §2.14 |
| `request-contract.e2e-spec` | 10 | **请求契约对账**：客户端发的查询参数与请求体字段，服务端都声明、都接住，见 §2.15 |
| `attachments.e2e-spec` | 9 | **附件链路**：资源附件替换、畸形输入 400、附件结构完整、管理员按业务对象预览（认证 + 资源两个端点）、附件归属校验，见 §2.19 / §2.22 |
| `admin-body-validation.e2e-spec` | 9 | **管理端请求体校验**：畸形请求体一律 400、草稿无发布时间、角色响应诚实、审计留痕，见 §2.20 / §2.21 |
| `nested-element-shape.e2e-spec` | 6 | **嵌套元素结构契约**：附件 / 审核历史 / 报名列表等元素逐字段校验，见 §2.25 |
| `request-body-validation.e2e-spec` | 6 | **请求体校验盲区**：媒体登记 / 活动报名的畸形请求体必须是 400，见 §2.27 |
| `query-filter-validation.e2e-spec` | 5 | **状态筛选枚举校验**：非法状态值必须是 400（不是空列表 / 409），见 §2.29 |

> 测试库与业务库**物理隔离**（`nmg_alumni_test` vs `nmg_alumni`）。
> 首次执行时因配置不统一导致测试连上业务库并 TRUNCATE 了 Seed 数据，已恢复并加了双重护栏，
> 见 `docs/KNOWN-ISSUES.md` #20。

### 2.1 端到端验收（§10.4 的 18 步）

`apps/api/test/integration/acceptance.e2e-spec.ts` 把需求基线 §10.4 的验收流程落成可执行用例，
每步一个独立用例、逐步打印步骤号，任何一步失败都能定位到具体环节。

| 步骤 | 验收点 | 关键断言 |
|---|---|---|
| 1 | 游客浏览首页 | `GET /home/feed` 无需登录即可返回 `tabs.news/notices/shortcuts` |
| 2 | 用户登录 | 拿到令牌；`GET /me` 的 `stage=logged_in` |
| 3 | 提交校友认证 | `POST /alumni/verification` → 201 `pending`；`users.stage=pending_review` |
| 4 | 管理员审核 | 待审队列命中该申请；`POST /admin/verifications/:id/decision` → `approved` |
| 5 | 获得校友权限 | `users.stage=verified`、`alumni_profiles.verified=1`；通讯录由 **403 变 200** |
| 6 | 搜索校友 | 关键字命中目标校友；不匹配时 `meta.total=0` |
| 7 | 提交联系申请 | `POST /connections/requests` → 201 `pending` |
| 8 | 对方收到 | `GET /me/connection-requests` 返回该申请且状态 `pending` |
| 9 | 接受申请 | `POST /connections/requests/:id/accept` → `accepted` |
| 10 | 建立正式关系 | 连接列表出现 `active` 关系；DB 中 `connection_pairs` 恰有 1 条 active |
| 11 | 双方授权联系方式 | **单方授权仍不可见**；双方授权后 `peerContact.phone/wechat/email` 正确，反向同样可见 |
| 12 | 发布资源 | `POST /resources` → 201 `pending` |
| 13 | 管理员审核资源 | `POST /admin/resources/:id/decision` → `published` |
| 14 | 资源进入公开列表 | `GET /resources` 出现该标题 |
| 15 | 活动报名 | 管理员建活动 → 校友报名 → `registeredCount=1` |
| 16 | 管理员查看报名记录 | `GET /admin/events/:id/registrations` 返回该校友的报名记录 |
| 17 | 撤回授权 | `PUT /connections/:id/contact-grant {allow:false}` → `myContactShared=false` |
| 18 | 撤回后不可见 | `peerContact` 变 `null`；公开名片与通讯录条目中**不含任何联系方式字段**；数据库密文仍在但取不出 |

### 2.2 客户端 ↔ 服务端 路径一致性校验

```bash
node infra/scripts/check-client-paths.mjs --root . --swagger http://127.0.0.1:18081/docs-json
```

该校验已接入 `infra/scripts/test-integration.sh`（测试通过后自动执行，失败即中断）。

校验内容：
1. 解析契约 `packages/contracts/src/api.ts` 的 `ApiPaths` 与小程序镜像表 `apps/miniprogram/src/services/paths.ts`，
   逐键比对（镜像多键 / 值不一致 → 报错）；
2. 扫描小程序与管理后台源码中的**真实调用点**（`get/post/put/patch/del`、`apiGet/apiPost/...`、
   模板字面量），还原出 (HTTP 方法, 路径)；
3. 拉取运行中 API 的 Swagger 文档得到服务端真实注册的 (方法, 路径)；
4. 比对：路径未注册 → `ROUTE_NOT_FOUND`；路径存在但方法未注册 → `METHOD_NOT_ALLOWED`。

**结果：0 错误**（服务端 85 条路由 / 小程序 47 个调用点 / 管理后台 46 个调用点）。

> 首轮运行暴露 **12 处真实漂移**（小程序 9 + 管理后台 2 + 契约 1），其中「路径对、方法错」最隐蔽——
> 既有契约一致性测试只比对路径是否存在，因此一直放行。处置明细见 `docs/KNOWN-ISSUES.md` #28。
>
> 校验器自身也踩过一次坑：初版用正则抓取调用参数，在管理后台 `.vue` 的超长行上触发灾难性回溯，
> 进程 CPU 空转数分钟。改为线性扫描后本地实测 **0.1 秒**完成（见 `docs/KNOWN-ISSUES.md` #36）。

### 2.3 本轮验收新发现并修复的缺陷

验收与路径校验不是「跑一遍就过」——本轮实测暴露 **9 类真实缺陷**，均已修复并留有回归用例：

| # | 缺陷 | 影响 | 修复 |
|---|---|---|---|
| 28 | 客户端与服务端路径漂移 **12 处** | 小程序我的/认证进度/隐私页、多处管理端动作运行时 404/405 | 客户端改方法 + 服务端补端点 + 契约补键 + 下线两个无人调用的别名路由 |
| 29 | `GET /me/connection-requests` 返回 `[{}]` | 联系申请列表每项都是空对象 | `Promise.all` 整体 await（`toRequestView` 是 async） |
| 30 | 连接类列表未按契约返回 `PageResult` | 小程序「我的」角标计数恒为 0 | 服务端改分页返回，契约与客户端类型不变 |
| 31 | `/me` 系列响应形状与契约不符 | 小程序把整个响应塞进 `alumniProfile`；隐私开关是 `0/1` 而非布尔 | `MeService` 拆出 `toPrivacy/toMyProfile/toContact`，开关统一布尔 |
| 32 | 小程序 `tsc` 4 处类型错误 | 静态检查不过 | `RequestOption`、泛型化 `settleAll`、空值收敛 |
| 33 | 契约声明了服务端不存在的方法 | `GET /events/:id/registrations` 404 | 删除契约键与死函数，名单只走管理端（需权限） |
| 34 | `created_by` 外键指向 `users` 却存管理员 id | 测试库 500；业务库静默指向无关用户 | 新增迁移 `1730000002000-FixCreatedByForeignKey` 改指 `admin_users` |
| 35 | `GET /alumni/verification/mine` 被 `:id` 抢先匹配 | 小程序认证进度页 400 | 调整路由注册顺序并加注释约束 |
| 36 | 校验脚本正则回溯导致 CPU 空转 | 校验不可用 | 改为线性扫描，0.1 秒完成 |

> 明细见 `docs/KNOWN-ISSUES.md` #28–#36。

### 2.4 前端静态校验（小程序 + 管理后台）

```bash
bash infra/scripts/check-frontend.sh
```

小程序无法在微信开发者工具中运行（需真实 AppID），管理后台也不在 CI 里跑浏览器，
因此用**纯 node 的静态交叉校验**挡住「编译期查不出、运行时才白屏/无反应」的缺陷。
已接入 `infra/scripts/test-integration.sh`，测试通过后自动执行。

**小程序**（`check-miniprogram.mjs`）：41 个页面 / 6 个组件 / 152 处事件绑定 / 260 处模板字段 / 11 个服务模块

| 校验项 | 说明 | 结果 |
|---|---|---|
| 页面注册 | app.json 注册的页面必须有 .ts + .wxml；反之未注册的页面目录报错 | ✅ |
| 跳转地址 | 扫描**全部** `/pages/...` 字面量（`utils/navigate.ts` 的 URL 构造函数 + 页面内路由表 + 直接调用），未注册即报错 | ✅ |
| switchTab | 目标必须是 tabBar 页面 | ✅ |
| 事件绑定 | WXML 的 `bind*/catch*` 必须在对应 TS 中有同名方法（否则点击无反应） | ✅ |
| 模板字段 | WXML 引用的字段必须在 `data` / `setData` 中存在（否则永远空白） | ✅ |
| 组件引用 | `usingComponents` 指向的组件必须存在 | ✅ |
| 服务导出 | 从 `services` 引入的名字必须真实导出 | ✅ |

**管理后台**（`check-admin-web.mjs`）：19 条路由 / 16 个视图 / 6 处路径跳转 / 12 个契约权限点

| 校验项 | 说明 | 结果 |
|---|---|---|
| 路由组件 | 路由引用的视图文件必须存在 | ✅ |
| 视图可达 | `src/views` 下每个视图都被路由引用（无死页面） | ✅ |
| 权限点 | `meta.requiredPermission` 必须在契约 `AdminPermission` 中（拼错会被守卫**永远**拦下） | ✅ |
| 菜单路径 | 菜单指向的路径必须在路由表中 | ✅ |
| 路径跳转 | `router.push('/x')` 必须有对应路由 | ✅ |

**反向验证**（证明校验器确实能抓到问题，而非恒过）：

| 校验器 | 注入缺陷 | 结果 |
|---|---|---|
| 小程序 | 未注册页面 / 事件绑定不存在 / 组件不存在 / 路由表指向未注册页 / 服务导出不存在 / 模板字段拼错 | 6 类全部报出，退出码 1 ✅ |
| 管理后台 | 路由组件不存在 / 权限点拼错 / 路径跳转不存在 | 3 类全部报出，退出码 1 ✅ |

> 详见 `docs/KNOWN-ISSUES.md` #39。

### 2.5 需求覆盖矩阵校验

```bash
node infra/scripts/check-spec-coverage.mjs --root . --swagger http://127.0.0.1:18081/docs-json
```

`docs/top.md` 是需求基线，但基线条目此前只存在于文档里，没有机制保证被实现
（通知中心缺失就是这样漏掉的）。现把基线落成矩阵 `docs/SPEC-COVERAGE.json` 并机器校验。

| 校验项 | 说明 | 结果 |
|---|---|---|
| 页面需求 | 50 条页面需求（首页 10 / 通讯录 8 / 连接 11 / 我的 17 + 4 个一级导航）对应的页面必须真实存在 | ✅ |
| 孤儿页面 | app.json 里不得有矩阵未覆盖的页面（新增页面必须登记需求出处） | ✅ |
| 后台视图 | 16 个视图必须存在且被路由引用 | ✅ |
| API 分组 | `top.md` §4.3 要求的 13 个接口分组，每个都必须在服务端注册了路由 | ✅ |

**反向验证**：删掉「通知中心」页面注册 + 新增一个未登记页面 → 校验器分别报出
`PAGE_NOT_REGISTERED` 与 `PAGE_NOT_IN_MATRIX`，退出码 1 ✅

### 2.6 校验器的反向验证（`infra/scripts/check-frontend-selftest.sh`）

校验器「通过」本身需要被证明——否则它可能什么都没校验。
本脚本在**临时副本**上注入真实缺陷，断言 5 个校验器确实会报错（真实工作副本全程只读）。

```bash
bash infra/scripts/check-frontend-selftest.sh
```

**正向基线**（干净副本上必须全部退出码 0）：

| 校验器 | 结果 |
|---|---|
| `check-miniprogram.mjs` | ✅ 0 |
| `check-admin-web.mjs` | ✅ 0 |
| `check-spec-coverage.mjs` | ✅ 0 |
| `check-api-spec-doc.mjs` | ✅ 0 |
| `check-client-paths.mjs` | ✅ 0 |
| `check-contract-routes.mjs` | ✅ 0 |

**缺陷注入（12 类，每类一份独立副本）**：

| 注入的缺陷 | 期望错误码 | 实测 |
|---|---|---|
| 页面文件存在但未在 app.json 注册 | `PAGE_NOT_REGISTERED` | ✅ 退出码 1 |
| WXML 绑定 TS 中不存在的方法 | `HANDLER_MISSING` | ✅ 退出码 1 |
| usingComponents 指向不存在的组件 | `COMPONENT_MISSING` | ✅ 退出码 1 |
| 后台路由指向不存在的视图 | `ROUTE_COMPONENT_MISSING` | ✅ 退出码 1 |
| 路由声明契约外的权限点 | `PERMISSION_NOT_IN_CONTRACT` | ✅ 退出码 1 |
| app.json 注册了矩阵未覆盖的页面 | `PAGE_NOT_IN_MATRIX` | ✅ 退出码 1 |
| 矩阵登记了服务端没实现的 API 分组 | `API_GROUP_NOT_IMPLEMENTED` | ✅ 退出码 1 |
| API-SPEC 写了服务端不存在的端点 | `DOC_ENDPOINT_MISSING` | ✅ 退出码 1 |
| 客户端调用点指向未注册路径 | `ROUTE_NOT_FOUND` | ✅ 退出码 1 |
| 小程序绕过契约镜像直接写字面量路径 | `MIRROR_LITERAL_PATH` | ✅ 退出码 1 |
| 契约里多声明一个服务端没有的路径键 | `CONTRACT_ROUTE_MISSING` | ✅ 退出码 1 |
| 服务端多注册一条契约没声明的路由 | `SERVER_ROUTE_NOT_IN_CONTRACT` | ✅ 退出码 1 |

**元自检**：用一个永远返回 0 的假校验器跑断言函数，必须被判为「恒过」——
防止断言逻辑本身写坏导致自测假通过。实测 ✅。

> 演练校验器的反向验证见 §5.4。两个自测脚本合计覆盖全部 7 个校验器。

### 2.7 契约 ↔ 服务端路由 全量双向校验（`infra/scripts/check-contract-routes.mjs`）

契约 `ApiPaths` 被定义为「唯一事实来源」，但此前的集合级比对**散落在两个脚本里**
（`check-client-paths.mjs` 内部两段 + 契约测试抽样），容易各自漂移。
现把「契约 ↔ 服务端」的集合比对**收敛到单一脚本**，并按 error 级严格判定。

```bash
node infra/scripts/check-contract-routes.mjs --root . --swagger http://127.0.0.1:18081/docs-json
```

| 校验项 | 说明 | 结果 |
|---|---|---|
| 契约 → 服务端 | `ApiPaths` 每个路径都必须在服务端真实注册 | ✅ 84/84 命中 |
| 服务端 → 契约 | 服务端每条**业务**路径都必须在 `ApiPaths` 里声明 | ✅ 84/84 命中 |
| 基础设施路径 | `/healthz` 等不参与反向比对（服务端 85 条 = 84 业务 + 1 基础设施） | ✅ 已排除 |

**结论：契约 ApiPaths 84 键与服务端 84 条业务路由集合完全一一对应，当前无契约漂移。**

**反向验证**：① 契约加一个服务端没有的路径键 → `CONTRACT_ROUTE_MISSING`；
② Swagger 塞一条契约没声明的路由 → `SERVER_ROUTE_NOT_IN_CONTRACT`。两个用例退出码均为 1 ✅。

### 2.8 客户端路径校验的噪音清理与真检查

`check-client-paths.mjs` 此前每次运行都报 **32 条 `MIRROR_MISSING_KEY` 警告**
（契约 84 键 / 小程序镜像 52 键，差的都是管理后台与服务端专用路径）。
噪音会淹没真实警告，因此做了两处调整：

| 调整 | 内容 | 结果 |
|---|---|---|
| 噪音降级 | 「契约有键但镜像表没有」改为一行 INFO 说明，不再是警告 | ✅ 32 条警告 → 0 |
| 新增真检查 | `MIRROR_LITERAL_PATH`（error）：小程序绕过镜像表直接写字面量路径 | ✅ 当前小程序 0 处此类写法 |

「契约有键、小程序没镜像」本身不是缺陷——小程序镜像表本就是契约的子集；
真正要防的是客户端**写死路径**，契约改路径时客户端不会跟着改。

### 2.9 数据完整性校验（`infra/scripts/check-data-integrity.sh`）

此前的校验体系覆盖了契约 / 路径 / 需求 / 文档，但**数据库里存的数据本身**
是否满足设计约束，一直靠人工抽查。现把设计文档里的硬约束变成可执行检查：

```bash
bash infra/scripts/check-data-integrity.sh              # 业务库（只读）
bash infra/scripts/check-data-integrity.sh --db nmg_alumni_test
```

| 类别 | 检查项 | 说明 |
|---|---|---|
| A（5 项） | 字典外键 | `region_code` / `industry_code` 必须存在于字典表 |
| B（5 项） | 隐私存储 | 联系方式只能是密文：无明文手机号 / 邮箱 / 微信号；密文须为合法 base64 且长度不低于 IV+AuthTag |
| C（7 项） | 状态机自洽 | `stage` 与认证申请状态、与 `profile.verified` 三者互相一致；资源发布必有通过审核记录 |
| D（4 项） | 唯一性与时间戳 | `openid` 唯一；`updated_at >= created_at`；用户与档案一一对应 |
| E（6 项） | 认证记录一致性 | 已认证必有通过记录与审核记录；在途申请必有 `pending_review` 阶段；已认证者不应有在途申请 |
| F（3 项） | 结构保障 | 关键外键约束确实存在（防止有人误删外键导致 A 类检查失效） |

**实测（业务库）**：30 项全部为 **0 违规** —— 803 行联系方式全部为密文（无明文），
认证状态与流程记录完全对齐。

#### 首轮运行发现的真实缺陷（详见 `docs/KNOWN-ISSUES.md` #47）

首次运行报出 4 项非零：`stage='verified'` 但无通过记录 **801 条**、
`stage='pending_review'` 但无在途记录 **242 条**、
有通过记录但 `stage` 不符 **8 条**、有在途记录但 `stage` 不符 **16 条**。
根因是种子数据按 60/25/15 随机分配 `stage`，与认证流程记录互不关联。

处置：新增迁移 `1730000003000-BackfillVerificationHistory` 修正存量数据，
并改写 `seed.ts` 使新环境自洽。**空库 + 新 seed 实测：30 项全部归零。**

#### 校验器的反向验证（`infra/scripts/check-data-integrity-selftest.sh`）

| 注入的违规 | 期望错误码 | 实测 |
|---|---|---|
| 已认证用户 `stage` 被改成 `logged_in` | `E3` | ✅ 退出码 1 |
| 待审核用户 `stage` 被改成 `logged_in` | `E4` | ✅ 退出码 1 |
| 档案 `verified=1` 但用户 `stage` 不符 | `E1` | ✅ 退出码 1 |
| 私密切域被写入明文手机号 | `B1` | ✅ 退出码 1 |
| 删除一条通过认证记录 | `C1` | ✅ 退出码 1 |
| 删除档案地区码外键约束 | `F1` | ✅ 退出码 1 |

每个用例撤销注入后校验器均恢复为退出码 0。

> 注意：**A 类检查受数据库外键保护**，脏数据写不进去（注入会报 `ERROR 1452`），
> 属于「纵深防御」；其有效性由 F 类（断言外键约束存在）+ 「删外键」用例证明。
> 详见 `docs/KNOWN-ISSUES.md` #48。

---

### 2.10 越权探测（`apps/api/test/integration/authorization.e2e-spec.ts`）

此前的验收流程验证的是**正常路径**上的隐私可见性，但没有系统性地**主动攻击**：
拿 A 的令牌去碰 B 的数据，看服务端是否真的拒绝。新套件构造三个用户
（alice 关系发起方 / bob 关系对方 / carol 无关第三方），逐条断言「被拒绝」。

| # | 攻击动作 | 期望 | 实测 |
|---|---|---|---|
| 1 | 第三方读取他人连接关系详情 | 403 | ✅ |
| 2 | 第三方解除他人连接关系 | 403，且关系仍为 active | ✅ |
| 3 | 第三方替他人授权 / 撤回联系方式 | 403，且授权状态未变 | ✅ |
| 4 | 第三方查看他人的联系申请详情 | 403 | ✅ |
| 5 | 发起方替对方接受自己的申请 | 403 | ✅ |
| 6 | 读取他人的通知详情 | 404（按 userId 过滤） | ✅ |
| 7 | 标记他人通知为已读 | 不生效（对方仍未读） | ✅ |
| 8 | 修改他人发布的资源 | 403 | ✅ |
| 9 | 提交他人资源进入审核 | 403 | ✅ |
| 10 | 撤回他人资源 | 403 | ✅ |
| 11 | 查看他人的认证申请详情 | 403 | ✅ |
| 12 | 查看他人的认证审核历史 | 403 | ✅ |
| 13 | 第三方查看校友公开名片 | 不含联系方式 | ✅ |
| 14 | **对照组**：关系方在双方授权后可见联系方式 | 可见 | ✅ |
| 15 | 普通校友访问管理端总览 | 403 | ✅ |
| 16 | 普通校友访问管理端用户列表 | 403 | ✅ |
| 17 | 普通校友尝试修改他人账号状态 | 403 | ✅ |
| 18 | 未登录访问本人资料 | 401 | ✅ |
| 19 | 非法 id（非数字） | 400 参数错误 | ✅ |
| 20 | 不存在的连接关系 id | 404（与「存在但无权限」的 403 区分开） | ✅ |

> 第 13 / 14 条是**成对对照**：只断言「看不到」无法排除「字段根本没返回」，
> 必须同时证明在条件成立时确实能看到，才说明隐私规则生效而非接口空转。

**结论**：水平越权（关系、通知、资源、认证申请）与垂直越权（普通校友 → 管理端）
边界在服务端**均被真实拒绝**，未发现越权缺陷。

### 2.11 幂等接口行为（`apps/api/test/integration/idempotency.e2e-spec.ts`）

幂等机制此前**没有任何测试**。补测时发现一个 P0 级隐私缺陷（详见 `docs/KNOWN-ISSUES.md` #51）：
幂等 scope 只含「方法 + 路径」，不含用户维度，两个用户用同一幂等键时
后者会拿到**前者的响应回放** —— 而 `PUT /me/contacts` 的响应含**解密后的联系方式明文**。

| 用例 | 期望 | 修复前 | 修复后 |
|---|---|---|---|
| 同用户同键同体 | 回放首次响应（200 + `Idempotent-Replay` 头），业务只产生一条记录 | ✅ | ✅ |
| 同用户同键不同体 | 409「幂等键已用于不同的请求内容」 | ✅ | ✅ |
| 同用户不同键 | 两次都真正执行，产生两条记录 | ✅ | ✅ |
| **不同用户同键** | 各自独立执行，不得回放对方响应 | ❌ **200 回放对方响应** | ✅ 201 各自执行 |
| **跨用户联系方式请求** | 乙的请求真正执行，写入乙自己的行 | ❌ 被回放 | ✅ |
| **匿名写接口** | 不启用幂等，登录不得回放他人令牌 | ❌ 回放 | ✅ |

**修复**：scope 改为 `METHOD:path:u{userId}`（唯一索引不变、无需迁移）；
匿名请求直接放行（无法按用户隔离，回放令牌风险最高）。

---

### 2.12 管理端内容/系统管理、联系申请分支、限流与分页（补测即发现 4 个真实缺陷）

**背景**：端点覆盖分析（`infra/scripts/check-test-coverage.mjs`）暴露出三块空白 ——
管理后台的一批接口**从未被真实调用过**（管理端文章 / 公告 / 分类 / 角色 / 权限 /
审计日志 / 系统设置），联系申请的**拒绝**与**撤回**分支没有测试，
限流此前只被压测「放宽再回滚」地间接验证过、分页边界从未验证过。
「没人调用过」的功能最容易藏着真实缺陷 —— 本轮补测就挖出 4 个。

| 套件 | 用例 | 覆盖内容 |
|---|---|---|
| `admin-content.e2e-spec.ts` | 10 | 管理端分类/资讯/公告的创建与可见性、草稿不外泄、角色/权限/审计日志/系统设置的读写、普通校友一律 403、联系申请 reject/cancel 与越权拒绝、**路由命名空间不变量** |
| `pagination.e2e-spec.ts` | 8 | `page`/`pageSize` 边界：0、负数、超过上限 100、恰好上限、非法值、超出总页数时 `meta` 自洽 |
| `rate-limit.e2e-spec.ts` | 4 | 固定窗口限流：第 N+1 次被 429、按用户隔离、按「用户 + 路由」计数、匿名按 IP 计数 |

#### 发现并修复的 4 个真实缺陷

| # | 缺陷 | 影响 | 处置 |
|---|---|---|---|
| 52 | `AdminUsersController` 用了**空前缀** `@Controller()` | 6 条**管理端**路由落在公开路径空间，与小程序可匿名读取的 `GET /articles/categories` 混同；契约还把它们写在了公共区（**三方同错**，一致性校验查不出来） | 服务端改 `@Controller('admin')`；契约管理路径移入 Admin 区（84 键总数不变）；管理后台调用点同步；需求基线 §4.3 勘误 |
| 55 | `resetDatabase` 用**手工表清单**（19 张 / 实际 34 张） | 跨次运行残留 →「单独跑是绿的，整条回归链跑就红」（撞唯一索引 500） | 表清单改为从 `information_schema` 动态获取并**逐张显式归类**，未归类即抛错；回归链改为**整库重建**测试库 |
| 54 | 18 个测试文件的 `afterAll` 写死 `await app.close()` | `beforeAll` 失败时抛 `Cannot read properties of undefined`，**把真实错误顶掉** | 改为可选调用 `await app?.close()` |
| 53 | 限流测试在**模块顶层**改 `process.env` | `jest --runInBand` 下污染同进程后续文件（阈值 2 → 后续文件随机 429；`REDIS_DB` 泄漏） | 顶层设置（配置在 `AppModule` 导入时固化，必须顶层）+ `afterAll` 原样恢复 |

另有一处**测试自身的臆测错误**：`/me/privacy` 服务端只有 `PUT`（`/me/contacts` 才是 PUT/PATCH 双别名），
测试却写成 `PATCH` → 404。这正是补测的价值：调用方对契约的记忆偏差会被立刻暴露。

#### 管理端路由命名空间的实测结果（缺陷 #52）

| 端点 | 修复前 | 修复后（实测） |
|---|---|---|
| `POST /articles/categories` | 201（**公开路径上的管理写接口**） | **404**（路由已迁走） |
| `POST /admin/articles/categories` | **404** | **201** |
| `PATCH /admin/articles/categories/:id` | — | **200** |
| `DELETE /admin/articles/categories/:id` | — | **200** |
| `GET /admin/users/:id` | — | **200** |
| `POST /admin/users/:id/status` | — | **201** |
| `PATCH /admin/users/:id/status` | — | **200** |
| `POST|PATCH /users/:id/status`、`GET /users/:id` | 200（**公开路径**） | **404** |

回归防线：`admin-content.e2e-spec.ts` 内置用例锁死两条不变量 ——
公开路径下的 6 个管理路由必须 404；迁到 `/admin` 之后未认证访问必须是 **401**（鉴权在前）
而不是 404（路由不存在）。

#### 本轮回归链结果

- 集成测试：**15 套件 / 115 用例全绿**（此前 11 套件 / 86 用例）
- 契约 ↔ 服务端：**84 键 ↔ 85 路由，0 差异**；API-SPEC 105 条声明与实现一致
- 端点覆盖：62/99（未覆盖 37，其中写操作 15 条）
- 业务冒烟：**10/10**；数据完整性 **30 项 0 违规**；数据反向验证 **6 类违规全抓出**
- 备份恢复演练：33 张表行数 / 列结构 / 外键 / 索引 / 迁移内容指纹**全部一致**，演练库自动清理
- 业务库 `users = 1202`，与测试前一致（测试未写入业务库）

---

### 2.13 端点覆盖闭环：99/99，并挖出私有文件横向越权

上一节补完管理端内容后，端点覆盖分析还剩 14 条写操作未触达。
本节把它们全部补齐，再把剩下的读端点一并收口 —— **服务端 99 条端点全部被集成测试触达**。

| 套件 | 用例 | 覆盖内容 |
|---|---|---|
| `admin-write.e2e-spec.ts` | 10 | 管理员账号的创建与更新、分类/资讯/公告/活动的**改与删**（含落库校验与公开侧一致性）、`PATCH /me/contacts` 别名、404 负向、普通校友 403、审计日志 |
| `uploads.e2e-spec.ts` | 8 | 上传链路三段：登记取直传地址 → 凭令牌接收字节流 → multipart 直传；MIME/扩展名白名单、无效令牌 401、匿名 401、**他人资产不可取地址** |
| `read-coverage.e2e-spec.ts` | 20 | 管理端 8 条列表/详情、本人 8 条列表、字典 3 条、健康检查 1 条 |

#### 补测即发现：私有文件的下载地址可被任意登录用户取走（P1 横向越权）

`GET /uploads/:id/url` **只校验登录、不校验文件归属** ——
用户乙能拿到用户甲**私有**附件的 MinIO 预签名下载地址（实测返回 200，预期 404）。
更严重的是 `intent=upload` 返回的是**带写入能力**的直传地址，
拿到就等于可以**覆盖**别人的私有文件。

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 本人取自己的资产 | 200 | 200 |
| 匿名取 | 401 | 401 |
| **他人取同一私有资产** | **200（拿到下载地址）** | **404** |

修复：`getUploadTarget` 增加 `requesterId`，私有资产要求 `uploaderId === requesterId`，
否则抛 **404**（与「通讯录未公开资料返回 404」的既有取舍一致，避免用状态码泄露文件是否存在）；
公开资产（如资讯封面）不受限；控制器 `url()` 注入 `@CurrentUser()`。
死代码 `urlFor()` 改为委托给 `getUploadTarget`，不留行为不一致的旁路。

#### 覆盖率终态

| 阶段 | 已覆盖 | 未覆盖 | 其中写操作 |
|---|---|---|---|
| 本轮开始 | 61/99 | 38 | 16 |
| 补管理端内容后 | 63/99 | 36 | 14 |
| 补管理端写操作后 | 79/99 | 20 | **0** |
| 补读端点后 | **99/99** | **0** | **0** |

所有服务端端点均已被集成测试触达 ✅

#### 覆盖校验器自身的反向验证

护栏本身恒过的话，「新增接口忘补测」就会悄无声息地长期存在 ——
这正是上一轮 37 条端点长期未被触达却无人察觉的原因。
因此新增 `infra/scripts/check-test-coverage-selftest.sh`：

| 用例 | 注入的缺陷 | 期望 | 实测 |
|---|---|---|---|
| 正向基线 | 无 | 干净副本 100% 覆盖、退出码 0 | ✅ |
| 元自检 | 用「永远返回 0 的假校验器」试探断言函数 | 必须被判失败 | ✅ |
| `coverage-new-endpoint` | 服务端新增一条端点但不写测试 | 必须报未覆盖并退出码非 0 | ✅ 退出码 1，命中 `admin/selftest-uncovered` |
| `coverage-remove-call` | 把测试里的调用点改掉 | 对应端点必须变未覆盖 | ✅ 退出码 1，命中 `system/health` |

该自测已接入回归链第 8 步（`--skip-coverage-selftest` 可跳过）。

### 2.14 运行时响应结构校验：路径对、契约对，结构依然可能错

前面所有校验器守的都是「**路径**」与「**是否被调用过**」。
但缺陷 #58 揭示了另一类问题：**路径完全对得上、契约也完全对得上，
服务端返回的响应结构却和客户端声明的不一样** ——
`GET /admin/users` 返回裸数组而不是 `{items, meta}`，页面在真实浏览器里直接崩。

这类缺陷有共同特征：**不抛异常**。页面照常渲染，只是列是空的、筛选框是摆设。

#### 2.14.1 新增校验器

`infra/scripts/check-response-shape.mjs`：

1. 扫描两端客户端的**真实调用点**，连同其**泛型返回类型**一起取出
   （`apiGet<PageResult<AdminUserDto>>(...)` / `get<ArticleDto[]>(...)`）；
2. 用契约（`packages/contracts`）里的 TS 类型定义解析出期望结构；
3. 真实调用服务端（**只读 GET**），把响应体按客户端声明的类型**逐字段核对**。

带路径参数的详情端点不做「随便编一个 id」（404 会掩盖真实问题），
而是从对应列表的真实响应里**采集真实 id** 再探测。

#### 2.14.2 首次运行就挖出 3 个真实缺陷

| 缺陷 | 端点 | 现象 | 性质 |
|---|---|---|---|
| **#59** | `GET /admin/alumni`、`GET /admin/alumni/:id` | 少返回 `userStatus` / `intro` / `verifiedAt` / `contactVisible` / `updatedAt`；详情缺 `verifications`；**6 个筛选条件里 5 个被静默忽略** | 列恒空、筛选框是摆设 |
| **#60** | `GET /admin/action-logs` | 少返回 `adminName` | 「操作人」列恒空，审计追溯断链 |
| **#61** | `GET /resources`、`GET /admin/verifications` | 审核记录少返回 `adminName` | 审核责任链断裂 |

修复内容：服务端补齐字段（`status` 改名为契约字段 `userStatus`）、
`AdminAlumniListQueryDto` 增加 `college` / `verified` / `status` / `industryCode` /
`graduationYear` 并逐条落实过滤、详情合并认证历史、
审核记录用一次 `In` 查询批量取管理员名称（避免 N+1）。

#### 2.14.3 校验覆盖与终态

| 项 | 数量 |
|---|---|
| 纳入校验的端点 | **49**（客户端声明了泛型返回类型的 GET） |
| 通过 | **28** |
| 跳过（需用户态令牌 / 未登记 id 来源） | 21 |
| 失败 | **0** |

**附带诊断**：校验器还会报告「**所有样本里都没出现过的可选字段**」——
这类字段服务端根本不给，客户端读到的是恒定的 undefined。
首跑即报出 `verificationStatus`（前端类型里声明了、页面并不用、服务端从不给）
与 `articleCount`（契约声明为可选、服务端从不算）→ 两者均已处置（#67）。

#### 2.14.4 校验器的反向验证

| 用例 | 注入的缺陷 | 期望 | 实测 |
|---|---|---|---|
| 正向基线 | 无 | 合成夹具结构自洽、退出码 0 | ✅ |
| 元自检 | 用「永远返回 0 的假校验器」试探断言函数 | 必须被判失败 | ✅ |
| `shape-bare-array` | 列表端点返回裸数组（缺陷 #58 原形） | 必须报错并退出码非 0 | ✅ 退出码 1，命中 `GET /admin/users` |
| `shape-missing-field` | 列表项缺少必填字段 `roles` | 必须报错 | ✅ 退出码 1，命中 `roles` |
| `shape-missing-meta` | 分页结构缺 `meta` | 必须报错 | ✅ 退出码 1，命中 `meta` |
| `shape-missing-admin-name` | 审核 / 审计记录缺 `adminName` | 必须报错 | ✅ 退出码 1，命中 `adminName` |

**真实部署级反向验证**（不止夹具）：在服务器上把
`listAdminUsers` 的 `roles` 字段**真的删掉**并重建镜像，
校验器报 `GET /admin/users.items[0].roles：缺失必填字段`、**退出码 1**；
恢复代码重建后复验 **退出码 0**。

该校验器已接入回归链**第 12 步**（只读 GET，不产生任何业务数据）。

#### 2.14.5 新增集成测试

`apps/api/test/integration/response-shape.e2e-spec.ts`（6 例）：
列表项字段齐全、5 个筛选条件逐个生效（非法 `status` → 400）、
详情带 `userStatus` / `verifiedAt` / `updatedAt` / `verifications`、
审计记录与审核记录的 `adminName` 非空。

#### 2.14.6 管理后台真实浏览器冒烟

`infra/scripts/admin-ui-smoke.mjs`（**只读**，不点任何创建 / 删除 / 提交按钮）：

| 项 | 结果 |
|---|---|
| 打开的后台路由 | 13 / 13 全部 ok |
| console error | **0** |
| 未捕获异常 | **0** |
| HTTP ≥ 400 的请求 | **0** |

首次运行即抓出缺陷 #58（`/system/admins` 页面崩溃）。

**列内容断言（不止「不报错」）**：仅检查 console error 是不够的 ——
字段缺失这类缺陷**不抛异常**，页面照常渲染，只是那一列恒为空。
因此冒烟脚本额外要求指定列**必须有值**：

| 页面 | 断言的列 | 实测 |
|---|---|---|
| /alumni | 账号状态、认证状态 | 20/20、20/20 行有值 |
| /system/logs | 操作人 | 20/20 行有值 |
| /verification | 申请人 | 20/20 行有值 |
| /resource | 标题、发布人 | 20/20、20/20 行有值 |
| /system/admins | 账号、角色 | 1/1、1/1 行有值 |
| /system/roles | 角色 | 5/5 行有值 |
| /system/dictionary | 名称 | 13/13 行有值 |
| /system/settings | 配置项 | 3/3 行有值 |
| /articles / /notices / /events | 标题 / 活动名称 | 8/8、4/4、7/7 行有值 |

「账号状态 20/20」「操作人 20/20」正是缺陷 #59 / #60 修复后的直接证据 ——
修复前这两列全是空的。

**检测器自身的有效性**（不是恒过）：在真实页面上人为把「账号状态」列清空后，
检测器从 `nonEmpty=20` 变为 `nonEmpty=0` 并判为缺陷 ✅。
（断言按**表**定位列下标 —— 一个页面上有多张表时，跨表累计的 `th` 下标会取错列。）

---

### 2.15 请求契约对账：客户端发了、服务端不接的，一律抓出来

前面所有校验器看的都是「**返回了什么**」。
但还有一类缺陷藏在**请求**这一侧：

- **查询参数**：服务端 DTO 没声明 → 被剥掉 → 筛选框成了摆设；
- **请求体字段**：ValidationPipe 的 `whitelist: true` → 直接剥掉 → 接口照样 200。

缺陷 #59（管理端校友列表）、#62（小程序联系方式丢失）、#63（6 个列表页筛选失效）
全是这一类：不抛异常、页面也看不出异常。

#### 2.15.1 新增校验器

`infra/scripts/check-request-contract.mjs`：

1. 静态解析两端客户端的**真实调用点**，取出它们**实际会带**的查询参数键与请求体字段
   （字面量直接取键；标识符则查其类型定义 → 展开 interface 字段）；
2. 用 **Swagger**（服务端唯一自述文档）取该操作声明的查询参数与请求体 schema；
3. 结论：**客户端发了、服务端没声明** → 报不一致。

反向方向（服务端声明了但客户端没发）只作提示，不算失败 ——
服务端可以支持更多参数（分页、兼容旧客户端）。

#### 2.15.2 首次运行就挖出 14 处不一致

| 端点 | 客户端发送 | 服务端原先声明 | 后果 |
|---|---|---|---|
| `GET /admin/verifications` | keyword | status | 认证审核的搜索框是摆设 |
| `GET /admin/resources` | keyword | status、type | 资源审核的搜索框是摆设 |
| `GET /admin/events` | keyword、status | 无 | 活动管理的搜索 + 状态筛选都是摆设 |
| `GET /admin/articles` | keyword、categoryId | status | 资讯管理的搜索 + 分类筛选是摆设 |
| `GET /admin/notices` | keyword | status | 公告管理的搜索框是摆设 |
| `GET /admin/action-logs` | adminId、action、startDate、endDate | 无 | 审计日志的 4 个筛选全是摆设 |
| `PATCH /me/profile`（小程序） | contactPhone、contactWechat、contactEmail | 无 | **联系方式保存后根本没存进去** |

修复：扩展各查询 DTO + 落实过滤条件 + 控制器透传；
`UpdateProfileDto` 补齐联系方式并复用加密写入路径。

#### 2.15.3 终态

| 项 | 数量 |
|---|---|
| 纳入对账的客户端调用点 | **97** |
| 匹配到服务端操作 | 97 |
| 不一致 | **0** |

另外，「可选字段服务端从不返回」的诊断还顺带挖出缺陷 #67
（分类「文章数」列恒空）—— 这类问题不写请求契约校验器根本不会有人发现。

#### 2.15.4 反向验证

| 用例 | 注入的缺陷 | 期望 | 实测 |
|---|---|---|---|
| 正向基线 | 无 | 退出码 0 | ✅ |
| 元自检 | 「永远返回 0 的假校验器」 | 必须被判失败 | ✅ |
| `request-extra-query-param` | 客户端多发一个服务端没声明的查询参数 | 必须报错并退出码非 0 | ✅ 退出码 1，命中 `selftestBogusFilter` |
| `request-extra-body-field` | 客户端多发一个服务端 schema 里没有的请求体字段 | 必须报错并退出码非 0 | ✅ 退出码 1，命中 `selftestExtraContact` |

已接入回归链**第 13 步**。

### 2.16 契约 ↔ 小程序类型镜像 一致性

小程序无法在运行时引用工作区包 `@nmg/contracts`，
因此在 `apps/miniprogram/src/types/index.ts` **手工镜像**了一份类型 ——
当前 74 个类型里有 **73 个与契约同名**。

镜像一旦不同步，两边就静默分叉：小程序 TypeScript 照样编译通过
（它用的是自己那份），但运行时按着「以为存在」的字段取值，得到 undefined；
「契约是唯一事实来源」在这条链路上被悄悄架空。

#### 2.16.1 新增校验器

`infra/scripts/check-contract-mirror.mjs`：逐个对比同名类型 ——
interface 比字段集合与可选性，type alias 比类型表达式。

#### 2.16.2 首次运行挖出 3 处漂移（都是契约写错了）

| 类型 | 契约 | 小程序镜像 | 真相 |
|---|---|---|---|
| `UserProfile.role` | `AdminRole \| null` | `string \| null` | 服务端普通校友返回 `'alumni'`，**不在 AdminRole 里** → 契约更窄（#64） |
| `SessionUser.permissions` | `AdminPermission[]` | `string[]` | 会话可能是普通校友（空数组），服务端内部类型是 `string[]` → 契约更窄（#65） |
| `MeResponse.stage` | `string` | `AlumniStage` | 服务端 stage 就是四个枚举值之一 → 契约更宽（#66） |

处置：以**实现为准**修正契约三处，小程序镜像本就正确。

#### 2.16.3 终态与反向验证

共对比 73 个同名类型（小程序 74 / 契约 102）：**漂移 0**。

反向验证并入前端 / 契约校验器自测（`mirror-type-drift`：
给镜像副本加一个契约没有的字段 → 必须报 `INTERFACE_DRIFT` 并退出码非 0）。

---

### 2.17 用户态端点的响应结构覆盖（小程序主路径）与 RBAC 三方对账

#### 2.17.1 用户态端点纳入结构校验

上一节的结构校验只覆盖了**不需要用户身份**的端点 —— 小程序的主用户路径
（`/me/**`、通讯录、我的通知、我的资源…）全部因为「需要用户令牌」被跳过（21 个）。
于是「小程序用户侧响应结构」长期无人看守。

现在回归链第 12 步会：
1. 先到**业务库**确认种子里的压测账号 `mock_k6_alumni_001` **确实存在**
   （不存在就跳过，**绝不为此新建用户** → 业务库 users 行数不变）；
2. 用它换一个**普通校友令牌**（mock 登录）；
3. 把令牌传给结构校验器 → 用户态端点一并纳入逐字段核对。

#### 2.17.2 一纳入就抓出 2 个真实缺陷

| 缺陷 | 端点 | 现象 | 影响 |
|---|---|---|---|
| **#69** | `GET /me/events` | 返回的是「报名记录数组」，而契约 `EventDto.myRegistration` 表示「我的报名状态」，小程序按 `PageResult<EventDto>` 消费 | 小程序「我的活动」页**恒空**、「我的」页计数**恒 0** |
| **#70** | `GET /me/verifications` | 返回裸数组，契约与小程序都按分页消费 | 小程序「认证历史」页**恒空** |

处置：两个端点统一改为**分页结构**；`/me/events` 顺带把 N+1 查询改成一次 `In` 批量查询。

#### 2.17.3 覆盖终态

| 项 | 用户态之前 | 用户态之后 |
|---|---|---|
| 纳入结构校验的端点 | 49 | 49 |
| 通过 | 28 | **41** |
| 跳过（需未登记 id 来源） | 21 | **8** |
| 失败 | 0 | **0** |

#### 2.17.4 RBAC 三方对账

新增 `infra/scripts/check-rbac-matrix.mjs`，对账 6 件事：

1. 权限点集合：契约 `AdminPermission` 联合 ≡ 种子 `PERMISSION_FIXTURES`；
2. 角色集合：契约 `AdminRole` 联合 ≡ 种子角色 ≡ 前端矩阵键；
3. 角色↔权限矩阵：种子 `ROLE_FIXTURES` ≡ 前端硬编码 `ROLE_PERMISSIONS`；
4. 服务端端点引用的权限点必须在集合里（拼错 = 该端点对所有管理员关闭）；
5. 每个权限点至少被一个角色授予（否则有端点不可达）；
6. 每个 `/admin` 端点都必须有 `@RequirePermissions`（否则任何管理员都能调用）。

实测：12 个权限点 / 5 个角色 / 106 条服务端端点 → **不一致 0**。
并输出提示：「有权限点但无端点引用」的悬空能力（`resource:manage`、
`notification:broadcast`）—— 见 KNOWN-ISSUES #71。

反向验证并入前端 / 契约自测（`rbac-matrix-drift`：
改掉前端矩阵里一个角色的权限 → 必须报 `ROLE_MATRIX_DRIFT`）。

### 2.18 声明参数消费对账：服务端承诺的参数，到底有没有被真的用上

#### 2.18.1 为什么还要第四层

前几层校验各自守住一件事：

| 校验层 | 回答的问题 | 抓不到的 |
|---|---|---|
| 响应结构校验 | 返回的**结构**对不对 | 请求带的参数有没有生效 |
| 请求契约对账 | 客户端**发了什么**、服务端**接不接** | 服务端接了之后**用没用** |
| 契约镜像 / RBAC 对账 | 两端**类型 / 权限**是否一致 | —— |

「服务端自己在 Swagger 里公布了参数，handler 却根本没用它」这一类，
前几层**全都查不出来**：

- 响应结构校验只看「返回了什么」；
- 请求契约对账只看「客户端发了什么」；
- 两者都不抛异常 —— 请求照发、状态码 200、结果不受筛选影响，
  筛选框看起来能用，实际上是个摆设。

#### 2.18.2 新增校验层：`infra/scripts/check-swagger-param-usage.mjs`

静态解析控制器源码 + 查询 DTO（含继承链），逐个参数判断 handler 是否真的消费它：

| 层级 | 判定方式 | 覆盖的写法 |
|---|---|---|
| 一级 | handler 里出现 `query.<prop>`，或从 query 解构出该字段 | `adminList({ keyword: query.keyword })` |
| 二级 | handler 把 query **整体透传**给 service → 到 service 方法体继续追踪 | `directoryService.list(user.id, query)` |
| 三级 | service 再整体透传给另一个 service → 再追一层 | service → service 链 |
| 兜底 | 仍追不到 → 记为「无法静态判定」的提示，**不判失败** | 避免误报 |

副检查（传入 `--swagger` 时）：把 Swagger 实际声明的查询参数与 DTO 推导出的参数集对账，
抓出「文档与 DTO 不同步」（例如手工 `@ApiQuery` 声明的额外参数）。

#### 2.18.3 一纳入就抓出 5 个真实缺陷

`GET /alumni` 在 Swagger 里公布了 10 个查询参数，handler 只透传了 4 个：

| 被丢弃的参数 | 后果 |
|---|---|
| `college` | 学院筛选框不生效 |
| `verified` | 认证状态筛选框不生效 |
| `status` | 账号状态筛选框不生效 |
| `industryCode` | 行业筛选框不生效 |
| `graduationYear` | 毕业年份筛选框不生效 |

#### 2.18.4 缺陷 #72：端点重复 + 路径空间错位

`GET /alumni` 不只是「参数没用上」，它本身还有两层问题：

1. **端点重复**：它是 `GET /admin/alumni`（#59 修复后的完整版）的**第二个副本**，
   两端客户端都没有调用它 —— 唯一的历史调用是集成测试里的一条无用例。
2. **路径空间错位**：`/alumni` 是**公开路径空间**
   （`GET /alumni/:id` 是公开名片，小程序匿名可读），
   而 `GET /alumni` 要求 `alumni:view` 权限、返回 `realName / openid / stage /
   userStatus` 等管理端字段 —— 与需求基线 `docs/top.md` §4.3 的收敛原则直接冲突
   （基线当年正是因为同样的理由把 `/users` 收敛成了 `/admin/users`）。

处置：**删除** `AlumniController.list`，管理端校友列表统一走 `GET /admin/alumni`；
契约 `ApiPaths.alumni` 与小程序本地路径镜像同步移除
（`alumniItem` = `GET /alumni/:id` 公开名片**保留**）；
`docs/API-SPEC.md` 端点表删除该行并补注；对应的无用例一并移除。

#### 2.18.5 反向验证（`infra/scripts/check-swagger-param-usage-selftest.sh`）

注入两类真实缺陷，必须都被抓出且退出码非 0：

| 用例 | 注入的缺陷 | 覆盖的判定路径 | 期望输出 |
|---|---|---|---|
| `swagger-param-declared-unused` | DTO 声明一个 handler 从不引用的字段 | 一级 | `DECLARED_PARAM_NOT_USED` + 参数名 |
| `swagger-param-service-drop` | handler 整体透传，但 service 里那个筛选条件被删掉 | 二级 | `DECLARED_PARAM_NOT_USED` + 参数名 |

自测脚本自带**元自检**（用「永远返回 0 的假校验器」证明断言函数本身有效）。

#### 2.18.6 覆盖终态（服务器实测）

| 项 | 删除 `/alumni` 列表之前 | 之后 |
|---|---|---|
| 带查询 DTO 的 handler | 23 | **22** |
| 声明参数 | 94 | **84** |
| 「声明了但没用」 | **5** | **0** |
| 无法静态判定（提示） | 0 | **0** |
| Swagger 端点对账（副检查） | — | **24 个操作，不一致 0** |

回归链第 14 步实测输出：

```
共检查 22 个带查询 DTO 的 handler、84 个声明参数，对账 24 个 swagger 操作：不一致 0，提示 0
```

#### 2.18.7 本轮回归链终态

| 项 | 结果 |
|---|---|
| 回归链步数 | 13 → **14** |
| 集成测试 | **22 套件 / 184 用例**全通过 |
| 端点覆盖 | **100%**（服务端端点 ↔ 集成测试） |
| 响应结构校验 | 49 端点：通过 41 / 跳过 8 / 失败 **0** |
| 请求契约对账 | 97 调用点：不一致 **0** |
| 契约镜像 | 73 个同名类型：漂移 **0** |
| RBAC 三方对账 | 12 权限 / 5 角色 / 106 端点：不一致 **0** |
| **声明参数消费对账** | 22 handler / 84 参数 / 24 swagger 操作：不一致 **0** |
| 反向验证 | 前端契约 **14 类** + 覆盖 **2 类** + 结构 **4 类** + 请求契约 **2 类** + **声明参数消费 2 类** —— 全部抓出 |
| 管理后台 UI 冒烟 | **13/13**，所有断言列有值，0 console error、0 失败请求 |
| 业务库 `users` 行数 | **1202**（未污染） |

> ⚠️ 本轮还发现并修掉一个**运维陷阱**：nginx 的 `upstream` 在加载配置时一次性把容器名
> 解析成 IP 并缓存，api / admin-web 容器重建后 IP 变化 → 经 nginx 的请求全部 **502**
> （而 api 直连是好的，排查时极易误判成「服务挂了」）。
> 处置：`infra/scripts/deploy.sh` 已内置 `nginx -s reload`；手工重建容器时必须补这一步。

### 2.19 附件链路闭环：5 个真实缺陷 + 1 个校验器盲点

#### 2.19.1 起点：一个「大家都没看」的字段

Phase 21 的**声明参数消费对账**只查查询参数。把它扩展到**请求体字段**后，
第一次运行就报出一条：

```
✗ PATCH /resources/:id  [DECLARED_PARAM_NOT_USED] 请求体字段 attachmentMediaIds
  在 UpdateResourceDto 里声明（对外可见），但服务端从未真正使用它
```

顺着这条线往下查，发现的是**一整条坏掉的链路**：

| # | 缺陷 | 表现 | 用户可见吗 |
|---|---|---|---|
| **#73** | `PATCH /resources/:id` 静默丢弃 `attachmentMediaIds` | 改资源换附件「保存成功」，附件纹丝不动 | 是 |
| **#74** | 资源附件字段无元素级校验 | 畸形输入 → 500；畸形对象还会被当成「清空附件」 | 是 |
| **#75** | 附件列表响应结构与契约不符 | 后台审核页 / 资源详情页附件区**恒空** | 是 |
| **#77** | 管理员预览证明材料 → 404 | **审核流程根本走不通** | 是 |
| **#78** | 提交时可引用他人的媒体 id | 跨用户私有文件泄露的口子 | 否（潜在） |

#### 2.19.2 缺陷是怎么藏住的

`#75` 尤其值得复盘 —— 它同时躲过了三道关：

1. **响应结构校验**：只校验「字段在不在」；而**数组为空时元素结构根本不会被校验**；
2. **列表采样**：只取前 5 条，而有附件的是第 1~10 号申请，
   列表接口返回的是最新 50 条（都没附件）→ 永远碰不到；
3. **人工核对**：契约里 `attachments: MediaAssetDto[]` 看起来"有声明"，
   没人去比对服务端实际返回的 `{ id, mediaId }`。

实测证据（修复前，线上业务库）：

```
GET /api/v1/admin/verifications/1
  → attachments = [{"id": 1, "mediaId": 1}]
  契约要求：id / mediaId / fileName / mimeType / size / uploadedAt
```

而后台模板渲染的正是 `attachment.mimeType` / `attachment.fileName` /
`formatBytes(attachment.size)` → 全是 undefined。

#### 2.19.3 一个比原缺陷更隐蔽的坑

给 DTO 补 `@IsArray()` 之后，`attachmentMediaIds: { nope: true }` 依然返回 200。
原因在 `ValidationPipe` 的 `enableImplicitConversion`：

> 属性上的 `design:type = Array` 会让 class-transformer 把**任意非数组值**
> 静默强转成数组 —— `{ nope: true }` 被转成**空数组**。

也就是说，畸形对象会被当成「清空全部附件」→ **静默丢数据**，比 500 更糟。
实测（容器内）：

| 输入 | 无 `@Type(() => Number)` | 有 `@Type(() => Number)` |
|---|---|---|
| `{ nope: true }` | `[]`（被当成清空） | `null` → @IsArray 失败 → **400** |
| `"abc"` | `["abc"]` → @IsInt 失败 → 400 | `null` → **400** |
| `["abc"]` | `["abc"]` → **400** | `[null]` → **400** |
| `[1, 2]` | `[1, 2]` ✓ | `[1, 2]` ✓ |

#### 2.19.4 修复

| 缺陷 | 处置 |
|---|---|
| #73 | `update()` 实现附件**整体替换**（传了替换、没传保持），去重，落库前校验归属 |
| #74 | 三个数组字段统一补 `@IsArray()` / `@ArrayMaxSize(9)` / `@IsInt({ each: true })` / `@Type(() => Number)` |
| #75 | 服务端 join `media_assets` 返回完整媒体信息；契约新增 `ResourceAttachmentDto`（不含 `bucket / objectKey / visibility` 等内部存储细节），小程序镜像同步 |
| #77 | 新增**按业务对象鉴权**的管理端端点：`GET /admin/verifications/:id/attachments/:mediaId/url`（`verification:review`）、`GET /admin/resources/:id/attachments/:mediaId/url`（`resource:review`）；后台两个页面改用 |
| #78 | 资源 / 认证提交与重交都校验附件归属（必须存在且 `uploader_id` 是本人），否则 400 |

#### 2.19.5 校验器自身的盲点（#76）

修好服务端之后，**校验器**也得跟着加固，否则同类问题还会再藏一次：

1. 数组采样改为**优先挑「内部含非空数组 / 对象」的条目** → 嵌套结构真正被校验到；
2. 数组为空且元素是具名类型时，把该类型记进
   「**元素结构从未被校验**」清单并在输出里点名 —— 盲点必须显式报出；
3. 反向验证新增合成夹具 `GET_admin_verifications.json` 与两个用例：
   - `shape-nested-missing-field`：嵌套元素缺 `fileName` → 必须 **FAIL**
     （`GET /admin/verifications.items[0].attachments[0].fileName：缺失必填字段`）
   - `shape-nested-empty-array`：数组全空 → 必须**报出盲点**（退出码 0 + 提示）

响应结构自测由 4 类缺陷增至 **5 类缺陷 + 1 类盲点**，全部抓出。

#### 2.19.6 新增用例

`apps/api/test/integration/attachments.e2e-spec.ts`（本节 8 例，测试库执行；第 9 例见 §2.22.5）：

| 用例 | 覆盖 |
|---|---|
| `#73` 修改资源时提交附件列表 → 附件真的被替换 | 接口响应 + `resource_post_attachments` 落库双向断言 |
| `#73` 只改标题不动附件 → 附件保持原样 | PATCH 语义 |
| `#74` 附件列表类型非法 → 400 | 字符串 / 非数字元素 / 对象，三种畸形输入 |
| `#75` 认证申请详情返回完整附件信息 | `fileName / mimeType / size / uploadedAt` |
| `#75` 资源详情返回完整附件信息 | 同上 |
| `#77` 管理员凭审核权限可取证明材料地址 | 管理员可取 / 普通用户 403 / 他人资产 404 |
| `#77` 附件不属于该审核对象 → 404 | 不泄露存在性 |
| `#78` 引用他人的媒体 id → 400 | 资源与认证两条路径 + 未落库断言 |

### 2.20 管理端写接口的 DTO 校验与隐式转换陷阱（4 个真实缺陷）

#### 2.20.1 起点：一个从没被校验过的请求体

Phase 22 的**声明参数消费对账**扩展到请求体后，暴露出一个更基础的问题：
管理端 12 个写端点的请求体写的是 `Record<string, unknown>` 或普通 TS `interface`。

**运行时 metatype 是 `Object` → ValidationPipe 完全跳过校验**
（`toValidate()` 对 Object 返回 false）：

| 端点 | 原来的请求体类型 |
|---|---|
| `POST/PATCH /admin/events` | `Record<string, unknown>` |
| `POST/PATCH /admin/articles` | `Record<string, unknown>` |
| `POST/PATCH /admin/notices` | `Record<string, unknown>` |
| `POST/PATCH /admin/users` | `interface UpsertAdminUserBody` |
| `PATCH/POST /admin/users/:id/status` | `interface UpdateUserStatusBody` |
| `PUT /admin/settings` | `interface UpsertSettingBody` |
| `POST/PATCH /admin/articles/categories` | 内联对象类型 |

后果（需求基线 §4.3 明确要求「DTO 校验」「统一错误码」）：

- `title: {}` → service 里的 `String()` → `"[object Object]"` **直接存进库**；
- `status: 'bogus'` → 一路走到数据库 ENUM 约束 → **500**（而不是 400）；
- 客户端传了契约之外的字段也不会被剥掉（whitelist 对 Object 无效）。

#### 2.20.2 修复

新增 12 个请求体 DTO，按领域模块归属（避免 admin → events → admin 的循环依赖）：

| 文件 | DTO |
|---|---|
| `events/dto/event.dto.ts` | `CreateEventBodyDto` / `UpdateEventBodyDto` |
| `content/dto/content.dto.ts` | 文章 / 公告 / 分类 / 系统设置 共 7 个 |
| `admin/dto/admin-body.dto.ts` | 管理员账号 3 个 |

字段与契约 `packages/contracts/src/api.ts` **一一对应**（多一个 = 客户端能传服务端不认的东西；
少一个 = 客户端传了却被静默剥掉）；service 签名同步为 DTO 类型，并**去掉 `String()` /
`Number()` 强转** —— 强转只会把畸形输入悄悄变成合法值。

#### 2.20.3 一个更隐蔽的根因：隐式转换

补完 DTO 后仍有一个用例不过：`attachmentMediaIds: { nope: true }` 返回 200。
根因在 `ValidationPipe` 的 `enableImplicitConversion`：

> 属性上的 `design:type = Array` 会让 class-transformer 把**任意非数组值**
> 静默强转成数组 —— `{ nope: true }` 被转成**空数组**，
> 于是「清空附件」被当成合法请求 → **静默丢数据**。

把同类问题在全仓量一遍后，发现同一个根因还有两种更严重的表现：

| 输入 | 目标类型 | 隐式转换结果 | 后果 |
|---|---|---|---|
| `'false'` / `'0'` | Boolean | **true**（`!!value` 语义） | 后台「认证状态 = 未认证」筛选返回的是**已认证**名单 |
| `{}` | String | `"[object Object]"` | 脏数据入库 |
| `{nope:true}` | Array | `[]` | 被当成「清空附件」→ 静默丢数据 |

**第一条是线上实测复现的用户可见缺陷（#82）**：

```
GET /api/v1/admin/alumni?verified=true    → total=809，全部 verified=true
GET /api/v1/admin/alumni?verified=false   → total=809，全部 verified=true  ← 同样的结果！
```

注意 `@Type(() => Boolean)` 有同样问题（**不可用**），
自定义 `@Transform` 也来不及 —— 转换发生在自定义 transform **之前**（容器内实测确认）。

#### 2.20.4 处置

1. **全局关闭 `enableImplicitConversion`**
   （`common/pipes/validation.pipe.ts`），需要转换的地方一律**显式**声明：
   - 数字 → `@Type(() => Number)`；
   - 布尔 → 新增 `@ToBoolean()`（`common/dto/transforms.ts`）：
     `'true'/'1' → true`、`'false'/'0' → false`。
     关闭隐式转换后原始字符串能到达 transform，实测 `'false' → false` ✓。
2. `AdminAlumniListQueryDto.verified` 与隐私设置的 6 个布尔字段改用 `@ToBoolean()`。
3. 审计了全部 31 个 DTO 数字 / 布尔字段，确认都有显式 `@Type` / `@Transform`，
   关闭隐式转换不会影响既有功能。

#### 2.20.5 顺带修好的两个数据语义缺陷

- **#80 草稿也带着「发布时间」**：`publishedAt: payload.publishNow === false ? null : new Date()`
  —— 而 `publishNow` 是**死参数**（契约里没有、客户端也从没发过），
  条件恒为 false → 草稿也写入发布时间。改为只在 `status === 'published'` 时写，
  从已发布退回草稿时清空。
- **#81 角色响应不诚实**：`syncRoles()` 会静默忽略不存在的角色编码，
  但响应回显的是请求里的完整列表 → 接口「声称」给了一个其实没生效的角色。
  改为返回**实际生效**的角色编码；更新接口在未提交 `roles` 时回读当前实际角色。

#### 2.20.6 新增用例

`apps/api/test/integration/admin-body-validation.e2e-spec.ts`（本节 7 例；另 2 例见 §2.21.3，合计 9 例）：

| 用例 | 覆盖 |
|---|---|
| 活动：标题非字符串 / 容量非数字 / 时间非 ISO / 状态非法 / 缺字段 → 400 | 6 种畸形输入 |
| 资讯 / 公告：状态非法 / 标题缺失 → 400 | |
| 账号状态：非法状态值 → 400，且**库里不能出现脏值** | |
| 系统设置 / 管理员账号：字段类型非法、用户名过短、密码过短 → 400 | |
| 合法请求仍然通过 | DTO 不能把正常流程拦死 |
| 草稿资讯 / 公告的 `publishedAt` 必须是 null；已发布的必须有时间 | #80 |
| 角色编码不存在时，响应只回显**实际生效**的角色 | #81 |

#### 2.20.7 本轮终态实测

| 项 | 结果 |
|---|---|
| 集成测试 | **22 套件 / 184 用例**全通过 |
| 回归链 | 14 步 **EXIT=0** |
| 线上复验 `?verified=false` | 修复前 `total=809`（**全是已认证**）→ 修复后 `total=393`（全部未认证）✅ |
| 业务库 `users` 行数 | **1202**（未污染） |
| 管理后台 UI 冒烟 | **13/13**，所有断言列有值，0 console error、0 失败请求 |

---

### 2.21 管理端账号操作的审计留痕（2 个真实缺陷）

#### 2.21.1 #83 停用账号填写的「原因」被静默丢弃

- **现象**：后台「启用 / 停用」弹窗里让管理员填写原因，点确认后**原因没有留下任何痕迹**
  —— 审计日志里查不到。管理员等于白填。
- **根因**：契约 `UpdateUserStatusBody` 声明了 `reason?: string`，后台也确实在发，
  但服务端 `setUserStatus()` **根本没读这个字段** ——
  这正是「声明参数消费对账」抓出来的那一类（DTO 声明了，服务端从不使用）。
- **处置**：账号状态变更写审计日志 `user.status.change`，
  detail 里带 `from / to / reason`。

#### 2.21.2 #84 管理端账号类操作完全没有审计日志

- **现象**：后台「审计日志」页能看到内容审核、活动、资源的操作记录，
  但**管理员账号的变更（新建管理员、改角色、改状态）和普通账号的启停**
  一条记录都没有 —— 最该留痕的一类操作恰好是空白。
- **根因**：`AdminUsersController` 里**没有注入** `admin_action_logs` 仓储，
  也没有写日志的辅助方法（`AdminController` 里有 `log()`，但那是另一个控制器）。
- **处置**：`AdminUsersController` 注入 `AdminActionLog` 并补 `log()` 辅助方法：
  新建 / 更新管理员写 `admin.user.create` / `admin.user.update`，
  账号状态变更写 `user.status.change`。

#### 2.21.3 新增用例（2 例）

`apps/api/test/integration/admin-body-validation.e2e-spec.ts`：

| 用例 | 覆盖 |
|---|---|
| 停用账号填写的「原因」必须落进审计日志 | #83 |
| 管理端账号类操作必须留下审计日志 | #84 |

### 2.22 校验器自身的盲点：追不到控制器自己的私有方法（#85）

#### 2.22.1 现象：一个**正常实现**被判成了缺陷

修完 #83 之后，回归链里 `check-swagger-param-usage.mjs` **仍然**报
`UpdateUserStatusBodyDto.reason 未被消费` —— 可服务端明明用了
（`setUserStatus()` 里写着 `reason: body.reason ?? null`）。
校验器把合规实现判成缺陷，等于把回归链永久卡死。

#### 2.22.2 两个根因

1. **只认 service 调用**：校验器追的是 `this.<service>.<method>(...)`。
   `AdminUsersController` 把 body 整体交给**自己类内的私有方法**
   `this.setUserStatus(actor, id, body)`，追踪链断在私有方法上 → 误判「声明了但没用」。
2. **多行泛型返回类型导致整个方法被丢弃**：解析器在扫方法体起点时，
   遇到 `;` 就判定「方法体结束」。而返回类型是
   `Promise<{ accessToken: string; ... }>` 这种多行对象字面量时，
   `;` 出现在类型里 → **整个方法被解析丢弃**（`AuthService.adminLogin` 正是这样丢的），
   于是 `POST /auth/admin/login` 的 `username` / `password` 一度被误报成未消费。

#### 2.22.3 处置

1. 校验器新增「控制器私有方法」追踪（`findOwnMethodCalls`），与 service 调用同权重；
2. 解析器只在泛型闭合（`angle <= 0`）时才认 `;`；
3. 判定结果改为**聚合**：**used > unknown > unused** ——
   只要还有一条路径「判不了」，就不能断言「没用」（避免误报成缺陷）；
4. 找不到目标方法体时按「无法静态判定」处理，**不判失败**。

#### 2.22.4 反向验证（3 类缺陷全部被抓出）

`infra/scripts/check-swagger-param-usage-selftest.sh`：

| 注入 case | 覆盖的判定路径 | 结果 |
|---|---|---|
| `swagger-param-declared-unused` | 一级：handler 从不引用该参数 | 退出码 1 ✅ |
| `swagger-param-service-drop` | 二级：整体透传给 service，service 里被删掉 | 退出码 1 ✅ |
| `swagger-param-own-helper-drop` | 二级变体：整体透传给**控制器私有方法**，私有方法里被删掉 | 退出码 1 ✅ |

其中 `swagger-param-own-helper-drop` 正是本节盲点的**对偶**：
修好「追得到私有方法」之后，必须证明「私有方法里把字段删了」依然抓得住。

#### 2.22.5 连带发现：端点覆盖缺口

修完 #85 重跑回归链，端点覆盖校验立刻报出一条未覆盖端点：

```
[READ ] GET admin/resources/:id/attachments/:mediaId/url
```

这是 #77 新加的「资源附件预览」端点 —— 当时只补了认证材料的预览用例，
资源这条**从没被集成测试触达**。补 1 例（审核员可取地址 / 附件不挂在这条资源上 → 404 /
无 `resource:review` 权限 → 403），`attachments.e2e-spec` 由 8 例增至 **9 例**。

### 2.23 契约声明了服务端从不接受的字段（#86）

#### 2.23.1 现象

请求契约对账（客户端发送 ↔ 服务端声明）报出两处不一致：

```
POST /admin/articles  客户端发送了请求体字段 publishedAt，服务端 schema 里没有
                      （已知字段：categoryId, title, summary, body, coverMediaId, status）
POST /admin/notices   客户端发送了请求体字段 publishedAt，服务端 schema 里没有
                      （已知字段：title, body, status）
```

任何客户端若真按契约填了发布时间，字段会被 `ValidationPipe` 的 **whitelist 直接剥掉** ——
接口照样 200，但「发布时间」从未生效。

#### 2.23.2 根因与处置

契约 `CreateArticleBody` / `CreateNoticeBody` 里留着 `publishedAt?: string`，
而服务端**从来就不接**这个字段：发布时间由服务端按 `status` 推导
（只有 `status === 'published'` 才写，草稿一律 null，见 #80）——
契约是早期设计的残留，与实现早已分叉。

按「**契约与实现冲突时以实现为准修正契约**」的既定原则：
从契约里移除 `publishedAt`，并在注释里写清「发布时间由服务端按 `status` 推导」。
管理后台从来只**展示**发布时间、从不**发送**它，因此前端无需改动。

#### 2.23.3 对账结果

```
共检查 99 个调用点，匹配 99 个服务端操作：不一致 0，提示 0
```

### 2.24 上一轮终态实测（Phase 23 / 24）

| 项 | 结果 |
|---|---|
| 集成测试 | **22 套件 / 187 用例**全通过 |
| 回归链 | 14 步 **EXIT=0**（服务器全量日志 `/tmp/chain24.log`） |
| 端点覆盖 | **100%**（服务端 100 端点 ↔ 集成测试 398 调用点，未覆盖 0） |
| 响应结构校验 | 51 端点：通过 41 / 跳过 10 / 失败 **0** |
| 请求契约对账 | 99 调用点：不一致 **0** |
| 契约镜像 | 74 个同名类型：漂移 **0** |
| RBAC 三方对账 | 12 权限 / 5 角色 / 107 端点：不一致 **0** |
| **声明参数消费对账** | 53 handler / 196 参数 / 24 swagger 操作：不一致 **0** |
| 反向验证 | 前端契约 14 类 + 覆盖 2 类 + 结构 5 类 + 盲点 1 类 + 请求契约 2 类 + **声明参数消费 3 类** —— 全部抓出 |
| 业务库 `users` 行数 | **1202**（未污染） |
| 管理后台 UI 冒烟 | **13/13**，所有断言列有值，0 console error、0 失败请求 |

---

### 2.25 校验器盲点的对偶：判定条件写反（#87）

#### 2.25.1 现象：报出来的「盲点」全是假的

上一轮收尾时逐条核对「元素结构从未被校验」的提示清单，发现**一条都不对**：

```
· AdminRole（出现在 GET /admin/roles，所有样本里该数组都是空的）
· AdminPermission（出现在 GET /admin/permissions，所有样本里该数组都是空的）
· RegionDto（出现在 GET /system/regions，所有样本里该数组都是空的）
```

现场一查：`GET /admin/roles` 返回 **5** 条、`/admin/permissions` 返回 **12** 条、
`/system/regions` 返回 **13** 条 —— 数组根本不空。

#### 2.25.2 根因：守卫写反了

```js
// 修之前
function noteEmptyArray(value, inner, ctx, where) {
  if (!value.length) return;   // ← 数组「空」时直接返回
  ...
}
```

于是登记盲点的恰好是**非空**数组，而真正全空的情况**永远不会被报出来** ——
**#76 加的那层盲点提示，从上线起就是失效的**。
反向验证用例没能发现，是因为断言只 grep 提示文案（太宽）。

判定口径还漏了一层：盲点说的是「**元素类型**从未被校验」，
但原实现按「路径」判定 —— 列表里第 1 条为空、第 2 条有内容时仍会被误报。

#### 2.25.3 处置

1. 判定条件改正，并按**元素类型**聚合：
   只有该类型出现过的**每一个**样本都是空数组，才算盲点；
2. 提示文案改成如实描述（并列出所有出现位置）；
3. **反向验证补强**：新增「**不得**报盲点」的断言 `expect_no_note`
   （基线夹具 + 新用例 `shape-nested-sparse-array`：只有部分条目为空 → 不得报盲点）；
   盲点用例改为清空**所有**夹具里的该元素类型。

#### 2.25.4 线上真实盲点：5 个类型从未被校验

判定修正后，线上报出的才是真盲点 —— 一共 5 个契约类型的元素结构
**从未被校验过**：

| 类型 | 出现位置（节选） |
|---|---|
| `VerificationAttachmentDto` | 认证申请的附件数组 |
| `VerificationReviewDto` | 认证审核历史数组 |
| `ResourceAttachmentDto` | 资源附件数组 |
| `VerificationApplicationDto` | 校友详情里的认证数组 |
| `EventRegistrationDto` | 活动报名列表 |

根因是**线上业务库根本没有这类数据**（没人上传过附件、没人提交过认证、
没人报名过活动）→ 数组恒为空 → 元素结构一次都没被核对过。
这正是缺陷 #75（附件只返回 `{id, mediaId}`）能长期潜伏的土壤。

#### 2.25.5 两件事把这 5 个类型钉住

**（1）集成测试：真实数据 + 真实接口，逐字段断言**

`apps/api/test/integration/nested-element-shape.e2e-spec.ts`（6 例）：

| 用例 | 覆盖的元素类型 |
|---|---|
| 认证审核历史元素带齐 6 个字段（含 `adminName`） | `VerificationReviewDto` |
| 认证附件元素带齐 6 个字段 | `VerificationAttachmentDto` |
| 资源审核历史元素带齐 7 个字段（含 `adminName` / `snapshotVersion`） | `ResourceReviewDto` |
| 资源附件元素带齐 6 个字段 | `ResourceAttachmentDto` |
| 校友详情里的认证数组元素带齐 12 个字段 | `VerificationApplicationDto` |
| 活动报名元素带齐 7 个字段（含 `userName`） | `EventRegistrationDto` |

**结论：这 5 个类型的实现本身是对的**（6 例全绿），
缺的是**覆盖** —— 形状错了也没人看得见。

**（2）合成夹具：让元素结构每轮回归都被核对**

线上业务库没有的数据，用**合成夹具**补上
（`infra/fixtures/response-shape/`，11 个端点，不含任何业务数据）：
附件 / 审核历史 / 报名列表等嵌套数组一律带齐元素。

回归链第 12 步新增「**响应结构夹具校验**」子步骤：
离线校验这批夹具，且要求**夹具自身不得报出盲点**
（否则说明夹具又造出了空数组）：

```
共校验 11 个端点：通过 11，跳过 0，失败 0
[2026-11-16 18:26:05] 响应结构夹具校验通过 ✅（元素结构盲点已闭合）
```

#### 2.25.6 反向验证：5 类缺陷 + 1 类真盲点 + 1 类假盲点拦截

| 用例 | 作用 | 结果 |
|---|---|---|
| `shape-bare-array` / `shape-missing-field` / `shape-missing-meta` / `shape-missing-admin-name` / `shape-nested-missing-field` | 结构缺陷必须被抓出 | 退出码 1 ✅ |
| `shape-nested-empty-array` | 全空 → 必须**报出**盲点 | 退出码 0 且报出 ✅ |
| `shape-nested-sparse-array` | 部分为空 → 必须**不报**盲点 | 退出码 0 且不报 ✅ |
| 基线夹具 | 富夹具不得报盲点 | 无盲点 ✅ |

#### 2.25.7 附带：响应侧「可选字段从未返回」的诊断也按类型精确化

同一批诊断里还有一处按**字段名**统计的粗糙之处：
`ctx.optionalStats` 用字段名做键 → `note` 在 A 类型里从不出现、
在 B 类型里一直出现时，**A 的问题会被 B 掩盖**。
已改为按「类型.字段」统计，并把清单按类型分组输出。

线上实测结果（51 个端点的真实响应）：

```
被跟踪的可选字段：81 个
「服务端从未返回」的：0 个
```

即：**所有契约声明的可选字段，在真实响应里都出现过** ——
服务端是显式列出每个字段的（值为 `null` 也算出现过），
不存在「客户端恒读到 undefined」的情况。这一层现在是**干净**的。

### 2.26 上一轮终态实测（Phase 25）

| 项 | 结果 |
|---|---|
| 集成测试 | **23 套件 / 193 用例**全通过 |
| 回归链 | 14 步 **EXIT=0**（服务器全量日志 `/tmp/chain25.log`） |
| 端点覆盖 | **100%**（服务端 100 端点 ↔ 集成测试 413 调用点，未覆盖 0） |
| 响应结构校验（线上） | 51 端点：通过 41 / 跳过 10 / 失败 **0** |
| 响应结构校验（合成夹具） | 11 端点：通过 11 / 失败 **0**，且**无盲点** ✅ |
| 请求契约对账 | 99 调用点：不一致 **0** |
| 契约镜像 | 74 个同名类型：漂移 **0** |
| RBAC 三方对账 | 12 权限 / 5 角色 / 107 端点：不一致 **0** |
| **声明参数消费对账** | 53 handler / 196 参数 / 24 swagger 操作：不一致 **0** |
| 反向验证 | 契约 14 + 覆盖 2 + 结构 5 + 真盲点 1 + 假盲点 1 + 请求契约 2 + 参数消费 3 类，全部符合预期 |
| 业务库 `users` 行数 | **1202**（未污染） |
| 管理后台 UI 冒烟 | **13/13**，0 console error、0 失败请求 |

> 线上响应结构校验仍会提示 3 个类型「元素结构从未被校验」——
> 这是**如实反映业务库里没有这类数据**，不是缺陷；
> 这些元素结构已由「合成夹具 + 集成测试」两条腿覆盖（见 §2.25.5）。

---

### 2.27 请求体校验盲区：#79 之后仍漏在网外的两个端点（3 个缺陷）

#### 2.27.1 起因：把「#79 那类问题」再审一遍

#79 修的是**管理端 12 个**写端点。这次把审计范围扩到**全仓所有控制器**，
逐个看 `@Body()` 参数的类型，发现两个端点一直在网外：

| 端点 | 请求体写法 | 运行时 metatype |
|---|---|---|
| `POST /uploads/records` | `body: CreateUploadBody`（**普通 interface**） | `Object` |
| `POST /events/:id/registrations` | `body: { note?: string }`（**内联字面量**） | `Object` |

两者在运行时 metatype 都是 `Object` → **ValidationPipe 的 `toValidate()` 返回 false
→ 整个请求体被静默跳过校验**。

#### 2.27.2 #88 媒体登记：畸形请求体直接 500

线上实测（`POST /uploads/records`）：

```
{ fileName: 123,    mimeType: 'image/png', size: 10 }    → 500
{ fileName: 'a.png', mimeType: 'image/png', size: 'abc' } → 500
{ fileName: 'b.png', mimeType: 'image/png', size: -999 } → 500
```

根因：service 里只有手工的 `assertFile()`（非空 + MIME 白名单 + 扩展名白名单 + 上限），
**它不校验类型**：
- `fileName: 123` → `filename.lastIndexOf()` → TypeError → 500；
- `size: 'abc'` → `'abc' > 上限` 为 **false** → **放行** → 落库转换失败 → 500；
- `size: -999` → 负数同样放行。

修复：新增 `uploads/dto/upload.dto.ts` 的 `CreateUploadBodyDto`
（`@Type(() => Number) + @IsInt/@Min(1)/@Max(10MB)`、`@IsIn(MIME 白名单)` 等），
MIME / 扩展名 / 大小上限常量上移到 DTO 文件与 service 共用（避免白名单两处漂移）；
契约补 `CreateUploadBody`（**此前契约里根本没有这个请求体的定义**），小程序镜像同步。

#### 2.27.3 #89 活动报名：对象被直接塞进 TEXT 列

测试库实测：`POST /events/:id/registrations` 传 `{ note: { evil: true } }` → **201 Created**，
对象被直接塞进 `note` 列。契约 `RegisterEventBody` 里 `note` 明明是 `string`。

修复：新增 `events/dto/event.dto.ts` 的 `RegisterEventBodyDto`
（`@IsOptional/@IsString/@MaxLength(200)`）。

#### 2.27.4 #90 这类问题此前没有自动检查（流程缺口）

人工审查一定会漏（#79 修了管理端，媒体登记与活动报名仍漏在外）。
新增**第 8 层校验** `infra/scripts/check-request-dto.mjs`：
扫描**所有**控制器的 `@Body()` 与 `@Query()` 参数，判定其类型在运行时
是否真的会被校验 —— 六种情况全部报出：

| 判定 | 触发条件 |
|---|---|
| `INLINE_OBJECT_TYPE` | 类型是内联对象字面量 |
| `OPEN_OR_PRIMITIVE_TYPE` | 类型是 `Record<...>` / `any` / 原始类型 |
| `TYPE_NOT_RESOLVED` | 类型解析不到类定义（多半是普通 `interface`） |
| `NO_VALIDATOR_DECORATOR` | 类存在，但没有任何 class-validator 装饰器（沿继承链向上找） |
| `PROPERTY_PARAM`（提示级） | `@Body('field')` / `@Query('field')` 属性式取值不经过 DTO 校验 |

接入回归链**第 15 步**，自带反向验证（3 类注入缺陷必须被抓出）：

```
body-dto-to-any        → OPEN_OR_PRIMITIVE_TYPE   退出码 1 ✅
body-dto-to-inline     → INLINE_OBJECT_TYPE       退出码 1 ✅
body-dto-no-validator  → NO_VALIDATOR_DECORATOR   退出码 1 ✅
query-dto-to-intersection → TYPE_NOT_RESOLVED     退出码 1 ✅
```

`@Query()` 同样受这条规则约束：交叉类型
（`PaginationQueryDto & { keyword?: string }`）会让 metatype 退化成 `Object`
→ 参数不校验也不转换（`page` 变 NaN → 列表接口 500）——
仓库里已有的 `list-query.dto.ts` 注释正是为此写的。

当前基线：**54 个整体请求体 / 查询对象，0 个会被跳过校验**
（3 条属性式提示：multipart 的 `visibility`、直传 `token`、预签名 `intent`，
三者都在 service 里做了显式校验或白名单降级，无风险）。

#### 2.27.5 新增用例（6 例）

`apps/api/test/integration/request-body-validation.e2e-spec.ts`：

| 用例 | 覆盖 |
|---|---|
| 媒体登记：`fileName` 不是字符串 → 400（不是 500），且不落库 | #88 |
| 媒体登记：`size` 不是数字 / 负数 / 超上限 → 400 | #88 |
| 媒体登记：缺字段 / 非法 MIME → 400；合法请求仍然通过 | #88 |
| 媒体登记：契约外字段（bucket / objectKey）被剥掉，存储位置由服务端决定 | #88 |
| 活动报名：`note` 不是字符串 / 超长 → 400，且不落库 | #89 |
| 活动报名：合法请求与不带 `note` 的请求都能报名 | #89 |

### 2.28 本轮终态实测

| 项 | 结果 |
|---|---|
| 集成测试 | **24 套件 / 199 用例**全通过 |
| 回归链 | **15 步 EXIT=0**（服务器全量日志 `/tmp/chain26.log`） |
| 端点覆盖 | **100%**（服务端 100 端点 ↔ 集成测试 423 调用点，未覆盖 0） |
| 响应结构校验（线上） | 51 端点：通过 41 / 跳过 10 / 失败 **0** |
| 响应结构校验（合成夹具） | 11 端点：通过 11 / 失败 **0**，且**无盲点** ✅ |
| 请求契约对账 | 99 调用点：不一致 **0** |
| 契约镜像 | 75 个同名类型：漂移 **0** |
| RBAC 三方对账 | 12 权限 / 5 角色 / 107 端点：不一致 **0** |
| 声明参数消费对账 | 54 handler / 197 参数 / 24 swagger 操作：不一致 **0**，提示 **0** |
| **请求参数 DTO 校验（第 15 步）** | 54 个整体请求体 / 查询对象：会被跳过校验 **0** |
| 反向验证 | 契约 14 + 覆盖 2 + 结构 5 + 真盲点 1 + 假盲点 1 + 请求契约 2 + 参数消费 3 + **请求参数 DTO 4** 类，全部符合预期 |
| 业务库 `users` 行数 | **1202**（未污染） |
| 管理后台 UI 冒烟 | **13/13**，0 console error、0 失败请求 |

> 本轮有一条**流程教训**：探测线上接口时用 mock 登录建了一个新用户，
> 把业务库 `users` 计数从 1202 变成 1203 —— 已定位并清理干净（users / media_assets /
> alumni_profiles / user_sessions / private_contacts 全部删除），计数恢复 1202。
> 正确姿势见 README 第 28 条：**复用已存在的种子账号**，要造数据就在测试库造。

---

### 2.29 状态枚举一致性：DB ENUM ⟷ DTO ⟷ 契约（3 个缺陷 + 1 个校验器误报）

#### 2.29.1 起因：状态值要在**四个地方**对得上

状态值分散在四个地方，任何一处漂移都不抛异常：

| 位置 | 漂移后的后果 |
|---|---|
| 数据库 ENUM | 决定能落库的值 |
| DTO 的 `@IsIn` | DTO 放行 DB 不接受的值 → 落库被拒 → **500** |
| 契约的联合类型 | 契约声明 DB 不接受的值 → 客户端照传 → **500** |
| 客户端下拉框 | 传了服务端不认的值 → **400**（若服务端有校验） |

人工审计「状态筛选参数」时发现它们与数据库 ENUM、契约枚举、客户端下拉框**四处**要对得上，
但没有任何检查能保证它们不漂移。

#### 2.29.2 #91 认证审核的非法 action 返回 409

```
POST /admin/verifications/:id/decision  { "action": "bogus-action" }  →  409 Conflict
POST /admin/resources/:id/decision      { "action": "bogus-action" }  →  400 Bad Request
```

同一类「非法参数」，两种错误码。根因：`VerificationDecisionDto.action` 只有
**TS 联合类型** + `@IsString()/@Length(4,32)`，**没有 `@IsIn`** →
运行时不做枚举校验 → 非法值一路走到 service，被 `statusMap[dto.action]` 判空后
抛 `ConflictException`。

> **TS 的类型标注在运行时没有约束力** ——
> `action: 'approve' | 'reject' | 'request_changes'` 和 `action: string` 完全一样。

处置：补 `@IsIn([...])` → 非法值直接 **400**。

#### 2.29.3 #92 7 个状态筛选参数没有枚举校验，传错值静默返回空列表

| DTO | 字段 | 枚举值 |
|---|---|---|
| `AdminVerificationListQueryDto` | `status` | pending / needs_more_material / approved / rejected / resubmitted |
| `AdminResourceListQueryDto` | `status` | draft / pending / published / rejected / offline / withdrawn |
| `AdminArticleListQueryDto` | `status` | draft / published / offline |
| `AdminNoticeListQueryDto` | `status` | draft / published / offline |
| `AdminEventListQueryDto` | `status` | draft / published / closed / cancelled |
| `AdminAlumniListQueryDto` | `stage` | logged_in / pending_review / verified |
| `ListRequestsQueryDto` | `status` | pending / accepted / rejected / cancelled / expired |

传 `status=bogus` 不报错 → 直接查库 → 返回**空列表** →
用户看到「筛选后没有数据」，极易误判成「数据丢了 / 功能坏了」。
同一批字段里 `userStatus` 却有 `@IsIn` —— 不一致本身就是信号。

处置：7 处全部补 `@IsIn([...])` + 与契约一致的 TS 联合类型，
枚举值逐字对齐数据库 ENUM。

#### 2.29.4 #93 枚举漂移没有自动检查（流程缺口）→ 新增第 9 层校验

`infra/scripts/check-enum-consistency.mjs`：

| 规则 | 内容 |
|---|---|
| **R1** | DTO 的每个 `@IsIn([...])` 列表，必须被**某个**数据库 ENUM 完全包含（否则存在「DTO 放行、数据库拒绝」→ 500 的值） |
| **R2** | DTO 里名为 status / action / type / stage / visibility / source / level / channel / kind 的字段，**必须**有 `@IsIn`（TS 类型标注在运行时无约束力，不能作为「已校验」的依据） |
| **R3** | 契约枚举与数据库 ENUM 的关系（提示级；部分重叠时提示「多出的值通常表示不落库的状态」） |

接入回归链**第 16 步**（15 步 → **16 步**），自带反向验证：

```
enum-dto-not-in-db        → DTO_ENUM_NOT_IN_DB            退出码 1 ✅
enum-status-not-validated → STATE_FIELD_NOT_ENUM_VALIDATED 退出码 1 ✅
```

自由文本列走**显式豁免清单**（每条写明理由，且每次运行都打印出来）：

| 豁免 | 理由 |
|---|---|
| `AdminActionLogQueryDto.action` | `admin_action_logs.action` 是 VARCHAR(64) —— 审计操作码是开放集合 |
| `CreateEventBodyDto.kind` / `UpdateEventBodyDto.kind` | `events.kind` 是 VARCHAR(32) —— 活动类型是自由文本 |

当前基线：**22 个数据库 ENUM / 765 个 DTO 字段 / 13 个契约枚举，0 处漂移**。

#### 2.29.5 #94 顺带修掉一个校验器误报

补完枚举校验后，回归链第 7 步反而失败了，报出 7 处
「**查询参数 enum** 在 XxxQueryDto 里声明，但服务端从未真正使用它」——
而服务端根本没有任何名为 `enum` 的参数。

根因：DTO 字段正则的 `[^;]*` **会跨行匹配**，于是多行装饰器里的
`enum: [...]` 被当成了字段声明。修复：解析字段前先剥掉装饰器
（新增 `stripDecorators()`，支持跨行与嵌套括号），
并补一条**防误报**的反向验证用例 `swagger-param-multiline-decorator`
（把装饰器改成多行后，校验器必须仍然 0 误报）。

#### 2.29.6 新增用例（5 例）

`apps/api/test/integration/query-filter-validation.e2e-spec.ts`：

| 用例 | 覆盖 |
|---|---|
| 认证 / 资源 / 资讯 / 公告 / 活动的非法状态筛选 → 400 | #92 |
| 校友列表的非法 stage / 账号列表的非法 status → 400 | #92 |
| 联系申请列表的非法状态 → 400 | #92 |
| 合法状态筛选仍然可用（DTO 不能把正常流程拦死） | #92 |
| 认证审核的非法 action → 400（此前是 409，与资源审核不一致） | #91 |

### 2.30 本轮终态实测

| 项 | 结果 |
|---|---|
| 集成测试 | **25 套件 / 204 用例**全通过 |
| 回归链 | **16 步 EXIT=0**（服务器全量日志 `/tmp/chain29.log`） |
| 端点覆盖 | **100%**（服务端 100 端点 ↔ 集成测试 433 调用点，未覆盖 0） |
| 响应结构校验（线上） | 51 端点：通过 41 / 跳过 10 / 失败 **0** |
| 响应结构校验（合成夹具） | 11 端点：通过 11 / 失败 **0**，且**无盲点** ✅ |
| 请求契约对账 | 99 调用点：不一致 **0** |
| 契约镜像 | 75 个同名类型：漂移 **0** |
| RBAC 三方对账 | 12 权限 / 5 角色 / 107 端点：不一致 **0** |
| 声明参数消费对账 | 54 handler / 197 参数 / 24 swagger 操作：不一致 **0**，提示 **0** |
| 请求参数 DTO 校验（第 15 步） | 54 个整体请求体 / 查询对象：会被跳过校验 **0** |
| **枚举一致性对账（第 16 步，新增）** | 22 ENUM / 765 DTO 字段 / 13 契约枚举：漂移 **0** |
| 反向验证 | 契约 14 + 覆盖 2 + 结构 5 + 真盲点 1 + 假盲点 1 + 请求契约 2 + 参数消费 3 + **防误报 1** + 请求参数 DTO 4 + **枚举漂移 2** 类，全部符合预期 |
| 业务库 `users` 行数 | **1202**（未污染） |
| 管理后台 UI 冒烟 | **13/13**，0 console error、0 失败请求 |

---

### 2.31 Worker 投递链路：Outbox → 队列 → 投递 → 重试（4 个缺陷 + 1 个流程缺口）

> 前面 16 步全部走 HTTP 接口；Outbox 投递是**独立进程 + 独立中间件（BullMQ/Redis）**，
> 一个接口测试都覆盖不到。这一层此前**完全没有自动检查**，
> 于是三处「不抛异常、不影响响应码」的静默失败长期存在。

#### 2.31.1 缺陷复现（实测，修复前）

在 worker 容器内（bullmq 5.81.5、Redis db=1、临时队列 `nmg-outbox-selftest`）实测：

| 缺陷 | 现象 | 复现命令 / 判据 |
|---|---|---|
| **#95** BullMQ 同 `jobId` 的 `add` 被忽略 | 首次 `add` + 失败后 `failed:1`；第二次**同 jobId** 再 `add` → `failed` **仍为 1**，任务根本没进队列 | 队列 `failed` 计数不变 + 消费者回调次数不增加 |
| **#96** 投递记录更新不校验 `affectedRows` | `notification_deliveries` 里没有对应行时，`outbox_events` 仍被标记 `done` | 更新 0 行 → 事件状态为 `done` |
| **#97** 缺 `notificationId` 的事件 `continue` 跳过 | 事件永远停在 `pending`，被 dispatcher 每 2 秒重复扫描 | 反复扫描后状态仍为 `pending`、从不为 `failed` |

#### 2.31.2 处置

- `jobId` 改为携带 `attempts`：`outbox-${outboxId}-a${attempts}`（`buildJobId()`），
  且回退路径 `markRetry()` 必须 `attempts + 1` —— 否则 `jobId` 不变，重投必被去重吞掉。
- `processOutboxJob()` 强制校验 `affectedRows === 1`，否则抛错**回滚整个事务**；
  认领事件时加 `AND status = 'pending'` 守卫，防并发重复投递。
- `dispatchPending()` 对无效 payload 显式标记 `failed`，不再永远卡在 `pending`。
- 回退只处理 `status = 'pending'` 的行：终态事件不会被改回 `pending`（防重复投递）。
- 超过 `MAX_DELIVERY_ATTEMPTS = 10` 的事件标记 `failed`，不再无限重试。

核心逻辑抽到 `apps/worker/src/outbox.ts`（不碰 Redis 连接、不起定时器），
因此可以在**测试库 + 测试队列**里被完整执行一遍。

#### 2.31.3 新增回归链第 17 步「Worker 投递链路自检」

```bash
# 容器内执行（测试库 + 测试 Redis db=1 + 独立队列名）
docker compose exec -T -e DB_NAME=nmg_alumni_test -e REDIS_DB=1 worker node dist/selfcheck.js
```

**25 项断言全通过**，分组如下：

| 组 | 断言 | 结果 |
|---|---|---|
| T0 元自检 | BullMQ 同 `jobId` 的第二次 `add` **确实被忽略**（证明 #95 的成因成立，否则「重投能成功」可能只是巧合） | ✅ |
| T1 正常路径 | `pending` → 派发 → 消费 → 投递记录 `sent` + 事件 `done`，且 worker 确实消费到该事件 | ✅ |
| T2 #96 | 投递记录缺失 → 任务**被判定为失败**；事件**不得**为 `done`；投递记录条数仍为 0；`attempts` 已递增 | ✅ |
| T3 #95 | 失败后重投**真的再次进队列并被消费**（消费次数 1 → 2）；重投的 `jobId` 与首次不同；`attempts` 继续递增 | ✅ |
| T4 #97 | 无效 payload 事件被跳过（不计入入队）→ 被标记 `failed` → 从未被投递 | ✅ |
| T5 重试上限 | 超过上限 → 不再重试 → 事件标记 `failed`（可见、可查） | ✅ |
| T6 终态保护 | 已 `done` 的事件走回退路径不做任何改动，不会被改回 `pending`（防重复投递） | ✅ |
| **T7 反向验证** | 复刻**修复前**的实现跑同一场景：旧实现把无投递记录的事件标记为 `done`（消息静默丢失）、回退不递增 `attempts`、重投 `jobId` 相同被吞掉；新实现抛错回滚、递增 `attempts`、`jobId` 变化 | ✅ |

反向验证是这一层自检的**关键**：少了它就无法区分「我们修好了」和「这个场景本来就不会出事」。

#### 2.31.4 本轮终态实测

回归链全量日志：`/tmp/chain30.log`（**17 步 EXIT=0**）

| 项 | 结果 |
|---|---|
| **回归链** | **17 步 EXIT=0**（新增第 17 步 Worker 投递链路自检） |
| **Worker 投递链路自检（第 17 步，新增）** | **25/25** 通过（含 5 项反向验证） |
| 集成测试 | **25 套件 / 204 用例**全通过 |
| 端点覆盖 | **100/100**（服务端 100 端点 / 433 处调用点，未覆盖 0） |
| 响应结构校验（线上） | 51 端点：通过 41 / 跳过 10 / 失败 **0** |
| 响应结构校验（合成夹具） | 11 端点：通过 11 / 失败 **0**，且**无盲点** ✅ |
| 请求契约对账 | 99 调用点：不一致 **0** |
| 声明参数消费对账 | 54 handler / 197 参数：不一致 **0**，提示 **0** |
| 请求参数 DTO 校验 | 54 个整体请求体 / 查询对象：会被跳过校验 **0** |
| 枚举一致性对账 | 22 ENUM / 765 DTO 字段 / 13 契约枚举：漂移 **0** |
| 反向验证 | 契约 14 + 覆盖 2 + 结构 5 + 真盲点 1 + 假盲点 1 + 请求契约 2 + 参数消费 3 + **防误报 1** + 请求参数 DTO 4 + 枚举漂移 2 + **Worker 投递链路 5（含元自检 1）** 类，全部符合预期 |
| 业务库 `users` 行数 | **1202**（未污染） |
| 业务库 `outbox_events` | 15 条，全部 `status=done`（种子残留，无 `pending`，dispatcher 不会触碰） |
| 测试库自检残留 | `outbox_events` / `notifications` / `users` 中自建数据 **0** 条（自检结束自动清理） |
| 容器健康 | nmg-api / admin-web / **worker（已用新镜像重建）** / mysql / redis / minio / nginx 全部 healthy |

---

### 2.32 通知的原子性：Outbox 模式在**生产端**同样成立（2 个缺陷）

> 上一节修的是 Worker（消费端）。这一节查的是**生产端** ——
> 业务写入与 outbox 事件是不是真的在同一个事务里。
> 结论：修复前**一个都不在**，三份权威文档的硬性要求在实现里落空了。

#### 2.32.1 缺陷复现（实测，修复前）

| 缺陷 | 现象 | 依据 |
|---|---|---|
| **#99** | 通知写入不在业务事务内 → 通知写失败时**业务数据已提交**；活动报名还会白占一个名额 | `docs/top.md` §597、`docs/CONCURRENCY-DESIGN.md` §67、`docs/ARCHITECTURE.md` §58 三处都要求「业务事务内写 outbox_events」；而 8 个通知调用点**全部在事务外**，`push()` 的注释还写着「与业务同事务」——**注释与事实相反** |
| **#100** | 投递失败在数据库里**完全不可见**：`notification_deliveries.status` 永远是 `'pending'`、`attempts` 永远是 `0`、`last_error` 永远是 `NULL`；ENUM 里预留的 `'failed'` 值**整个代码里从未被使用过** | 修复前 Worker 只在成功时 UPDATE 投递记录一次；`failed` 处理器只改 outbox 事件状态，对投递记录一个字都没写 |

#### 2.32.2 处置

- **#99**：`NotificationService.push()` 增加可选 `EntityManager`；8 个通知写入点全部改为
  「业务写入 + 通知写入」同事务（`alumni.submit` / `alumni.decide` / `connections.createRequest` /
  `connections.accept` / `connections.reject` / `events.register` / `resources.create` / `resources.review`）。
  ⚠️ 事务内的仓储访问必须走 `manager.getRepository(...)` —— 用默认仓储会走**另一条连接**，写出去就不在事务里。
- **#100**：新增 `recordDeliveryFailure()`（失败递增 `attempts` + 写 `last_error`）与
  `markDeliveryFailed()`（超限后 `status='failed'`）；成功路径补 `attempts + 1`、`last_error = NULL`；
  只更新尚未送达（`status <> 'sent'`）的记录。

#### 2.32.3 新增集成测试：`notification-atomicity.e2e-spec.ts`（6 例）

用**故障注入**（`jest.spyOn(notifications, 'push').mockRejectedValue(...)`）把通知写入打断，
断言业务写入被整体回滚：

| 用例 | 断言 |
|---|---|
| 联系申请 | 通知写失败 → 申请整体回滚，`outbox_events` 也不留孤儿事件 |
| 活动报名 | 通知写失败 → 报名回滚，**且 `registered_count` 回到原值**（名额不能被白吃） |
| 认证提交 | 通知写失败 → 申请回滚，用户 `stage` 不变 |
| 资源提交审核 | 通知写失败 → 内容整体回滚 |
| **反向验证** | 复刻「业务写在事务外」→ 报名记录与名额计数**都留在库里**（证明上面的断言不是恒过的） |
| 正向对照 | 正常路径：业务数据与 `outbox_events` 事件**一起落库**，投递记录为 `pending` |

**反向验证（真实执行）**：把 `events.register` 在容器内临时还原成「通知写在事务外」后重跑 ——
「活动报名」用例**真的变红**（`Expected: 0, Received: 1`，`registered_count` 停在 1），
其余 5 例仍绿（本次只还原了 events 一处）→ 断言有鉴别力。

> 附带发现：测试护栏 `[测试护栏] 拒绝在非测试库上运行集成测试` 在我漏传 `DATABASE_URL` 时
> 正确拦下并拒绝执行 —— 护栏本身是有效的。

#### 2.32.4 本轮终态实测

| 项 | 结果 |
|---|---|
| 新增集成测试 | **6/6** 通过（含 1 例反向验证 + 1 例正向对照） |
| 全量集成测试 | **26 套件 / 210 用例**（详见 §2.32.5） |
| 回归链 | **17 步 EXIT=0**（服务器全量日志 `/tmp/chain31.log`） |
| Worker 投递链路自检 | **33/33** 通过（新增 8 项 #100 断言） |
| 业务库 `users` 行数 | **1202**（未污染） |

#### 2.32.5 未消除的残余局限（如实记录，不夸大）

投递记录**本身不存在**时（通知被删除 → `notification_deliveries` 级联删除，而 outbox 事件还在），
失败原因只能落在 `outbox_events.status='failed'` + `outbox_events.attempts` 上，
具体原因留在 Worker 日志 —— 因为没有行可以写。
彻底解决需要给 `outbox_events` 增加一列 `last_error`，属于**业务库 schema 变更**，本轮**未做**。

---

### 2.33 幂等键的生命周期：失败之后与有效期之后（3 个缺陷）

> 既有的 `idempotency.e2e-spec.ts` 覆盖的是「**成功之后**的行为」：
> 回放、哈希不一致、跨用户隔离、匿名放行。
> 但「**失败之后**会发生什么」与「**有效期**是否真的生效」从未被验证过 ——
> 三处实现与文档不一致的地方因此长期存在。

#### 2.33.1 缺陷复现（实测，修复前）

用 `idempotency-lifecycle.e2e-spec.ts` 打出的真实结果：

| 缺陷 | 实测现象 | 文档依据 |
|---|---|---|
| **#101** | 写接口失败后，同一个键再发 → 实得 **409**（应为 400，即重新执行）；`idempotency_records` 里留下 1 条 `in_progress` 记录 | 幂等键的本职是「安全重试」；失败后把键卡死等于让重试永远失败 |
| **#102** | 把 `expires_at` 改成过去后，同一个键再发 → 实得 **200 回放**（应为 201 重新执行）；资源表里只有 1 条记录 | `docs/API-SPEC.md` §13：「同一 (scope, key) **在有效期内**只执行一次并回放原响应」——「有效期」三个字从未落到实现 |
| **#103** | 幂等冲突（409）的响应 `code` 是通用 `CONFLICT`，不是 `IDEMPOTENCY_CONFLICT` | `packages/contracts/src/common.ts` 的 `ErrorCode` 与 `docs/CONCURRENCY-DESIGN.md` §66 都写明应为 `IDEMPOTENCY_CONFLICT` |

#### 2.33.2 处置

- **#101**：handler 抛错时**释放**幂等键（删除 `in_progress` 记录），同键可安全重试；
  严格区分「业务失败」与「业务成功但响应存档失败」——
  后者**不释放**（否则重复执行），但仍把成功响应返回给客户端
  （否则客户端以为失败而重试 → 又撞 409 → 彻底卡住）。
- **#102**：`claim()` 发现已有记录**已过期**时删除旧记录并重新占用 → 本次真正执行。
- **#103**：改抛 `new HttpException({ code: ResponseCode.IDEMPOTENCY_CONFLICT, message }, 409)`，
  与限流守卫 `RATE_LIMITED` 的写法一致；并把该语义补进 `docs/API-SPEC.md` 的幂等约定。

#### 2.33.3 新增集成测试：`idempotency-lifecycle.e2e-spec.ts`（4 例）

| 用例 | 断言 |
|---|---|
| #101 | 写接口失败 → 同键重试**重新执行**（400，不是 409）；且不留 `in_progress` 记录 |
| #102 | 键过期 → **真正重新执行**（201 + 新 id + 无 `Idempotent-Replay` 头），资源表 2 条 |
| #103 | 哈希不一致 → 409 且 `code === 'IDEMPOTENCY_CONFLICT'` |
| 正向对照 | 未过期的成功请求**仍然回放**（200 + `Idempotent-Replay: true` + 同一 id），资源表 1 条 |

**反向验证（真实执行）**：修复前跑同一份测试，三条缺陷用例**全部变红** ——
`Expected: 400, Received: 409`（#101）、`Expected: 201, Received: 200`（#102）、
错误码不匹配（#103）；只有正向对照是绿的 → 断言有鉴别力，不是恒过。
修复后：**2 套件 / 10 用例**全通过（既有 6 例 + 新增 4 例）。

#### 2.33.4 未消除的残余局限（如实记录）

过期记录目前是**惰性清理**的（下次用到同一个键时才删），
没有任何后台任务定期清理 `idempotency_records` ——
长期不被复用的键会一直留在表里。要彻底解决需要一个定时清理任务，本轮**未做**。

---

### 2.34 上传链路的写入授权：public 资产把「可读」当成了「可写」（1 个缺陷）

#### 2.34.1 缺陷复现（实测，修复前）

| 缺陷 | 实测现象 | 依据 |
|---|---|---|
| **#104** | 乙对甲的 **public** 资产调用 `GET /uploads/{id}/url?intent=upload` → 实得 **200**，并直接返回了可用的写入地址 `.../uploads/1/content?token=1794860031.6ad29ad3b005…`（应为 404） | 拿到直传地址 = 拿到**覆盖该对象**的权限；越权一律 404（既有取舍） |

根因：`assertOwnership()` 对 public 资产**直接放行**。
这对**下载**是对的（公开资产任何登录用户都能看），
但 `intent=upload` 返回的是**带写入能力的签名地址** ——
**「可读」被当成了「可写」**，于是形成横向越权写入：
乙可以覆盖甲的文件（如资讯封面）。

⚠️ 既有测试只覆盖了「他人**私有**资产取**下载**地址 → 404」，
「他人 **public** 资产取 **upload** 地址」这条路径**从未被验证过**。

#### 2.34.2 处置

`assertOwnership()` 增加 `intent` 维度：

- `intent=download`：公开资产放行，私有资产只允许上传者本人（**行为不变**）；
- `intent=upload`：**无论公开还是私有，都只允许上传者本人** ——
  直传地址是写入能力，不因「公开可见」而外泄。失败一律 **404**。

#### 2.34.3 新增集成测试：`upload-authorization.e2e-spec.ts`（5 例）

| 用例 | 断言 | 修复前 |
|---|---|---|
| 他人对我的 public 资产索取 upload 地址 | **404**，且响应里不得有写入地址 | ✕ 实得 200 + 可用 token |
| 用自己资产的令牌改路径去写别人的资产 | **被拒**（令牌与 assetId 绑定） | ✓（本来就对） |
| 对照：甲对自己的 public 资产取 upload 地址 | 200 | ✓ |
| 对照：乙对甲的 public 资产取**下载**地址 | 200（公开可下载是设计意图，不该被误伤） | ✓ |
| 对照：乙对甲的 private 资产取 upload 地址 | 404 | ✓ |

**反向验证（真实执行）**：修复前跑同一份测试，两条 #104 用例变红
（`Expected: 404, Received: 200`，并打印出了那条可用的写入地址），
三条对照用例全绿 → 断言有鉴别力，且**没有误伤**原本正确的公开下载行为。

修复后：**2 套件 / 13 用例**全通过（既有上传链路 8 例 + 新增 5 例）。

---

### 2.35 字段可见开关：读取侧生效，检索侧失效（2 个缺陷）

#### 2.35.1 缺陷复现（实测，修复前）

| 缺陷 | 实测现象 | 依据 |
|---|---|---|
| **#105** | 隐藏学院 / 方向 / 地区 / 行业的人，**仍被搜出**（响应里字段是 `null`，但「搜得到」已经泄露了值）；简介同样可被搜出 | 小程序隐私页的开关文案写的是「**在通讯录中**显示你的毕业院系」—— 开关承诺的是通讯录内的可见性，而通讯录自己的检索把它绕过去了 |
| **#106** | `showDirection` 被服务端用来裁掉 `direction`，但 DTO / 契约 / 小程序隐私页**都没有这个开关** → 被 seed 随机关掉的用户方向**永远**不可见且无从恢复 | 与另外 6 个开关行为不一致 |

根因（#105）：开关在**响应组装**时被尊重，在**检索条件**里被无视：

```ts
.orWhere('p.college LIKE :keyword', { keyword })      // ← 直接匹配被开关控制的列
...
college: profile.showCollege ? profile.college : null  // ← 响应里却裁剪了
```

地区 / 行业筛选更糟 —— 那是**等值匹配**，码表空间小 → 可**逐个枚举**。

#### 2.35.2 处置

- **#105**：检索条件按开关**条件化**（`p.showCollege = 1 AND p.college LIKE …`，
  方向 / 地区 / 行业同理）；`regionCode` / `industryCode` 筛选同样加开关条件；
  `p.intro` 从**公开**检索中移除（契约的 `DirectoryEntry` 里根本没有 `intro`，
  它对他人从来不可见，拿它当检索键等于一个「简介内容存在性」的预言机；
  管理端检索不受影响，管理员本来就看得到）。
  > 原则：**能被搜到的字段，必须是看得到的字段。**
- **#106**：`showDirection` 补齐为一等可读写开关 ——
  `UpdatePrivacyDto` + `MeService.updatePrivacy/toPrivacy` +
  契约 `PrivacySettings`/`UpdatePrivacyBody` + 小程序类型镜像 + 隐私页开关。

#### 2.35.3 新增集成测试：`directory-search-privacy.e2e-spec.ts`（9 例）

| 用例 | 修复前 |
|---|---|
| 隐藏学院 → 不得被按学院搜出 | ✕ 被搜出 |
| 隐藏方向 → 不得被按方向搜出 | ✕ 被搜出 |
| 隐藏地区 → 不得被按地区筛出 | ✕ 被筛出 |
| 隐藏行业 → 不得被按行业筛出 | ✕ 被筛出 |
| 简介 → 不得作为检索键 | ✕ 被搜出 |
| 对照：未隐藏学院的人**可以**被按学院搜出 | ✓ |
| 对照：按姓名搜索始终可用 | ✓ |
| 对照：按毕业年份筛选可用 | ✓ |
| #106 端到端：读得到开关 → 改成 true → 落库 → **别人真的能搜到他** | ✕ 响应里无此字段、写入被剥掉 |

**反向验证（真实执行）**：修复前 5 条缺陷用例 + #106 全红，3 条对照全绿
→ 断言有鉴别力，且**没有把发现能力一起关掉**。

修复后：**2 套件 / 15 用例**全通过（既有通讯录 6 例 + 新增 9 例）。

#### 2.35.4 本轮终态实测

回归链全量日志：`/tmp/chain35.log`（**17 步 EXIT=0**）

| 项 | 结果 |
|---|---|
| **回归链** | **17 步 EXIT=0** |
| 集成测试 | **29 套件 / 228 用例**全通过 |
| 端点覆盖 | **100/100**（服务端 100 端点 / 451 处调用点，未覆盖 0） |
| 响应结构校验（线上） | 51 端点：通过 41 / 跳过 10 / 失败 **0** |
| 响应结构校验（合成夹具） | 11 端点：通过 11 / 失败 **0**，且**无盲点** ✅ |
| 请求契约对账 | 99 调用点：不一致 **0** |
| 声明参数消费对账 | 54 handler / 197 参数：不一致 **0** |
| 请求参数 DTO 校验 | 54 个整体请求体 / 查询对象：会被跳过校验 **0** |
| 枚举一致性对账 | 22 ENUM / 769 DTO 字段 / 13 契约枚举：漂移 **0** |
| 契约 ↔ 小程序类型镜像 | 75 个同名类型：漂移 **0** |
| 小程序静态校验 | 43 页面 / 6 组件 / 157 事件绑定 / 272 模板字段引用：未发现静态一致性问题 |
| Worker 投递链路自检 | **33/33** 通过 |
| 业务库 `users` 行数 | **1202**（未污染） |

> 附带收获：契约变更（`PrivacySettings` 增加 `showDirection`）被既有的
> **形状契约测试** `me.e2e-spec.ts` 当场抓出来（响应多了一个字段）——
> 这条测试证明「契约 ↔ 响应」的耦合确实被守住了，不是摆设。

---

### 2.36 部署链路：构建上下文里的密钥，与生产镜像里的测试代码（2 个缺陷）

#### 2.36.1 缺陷复现（实测）

| 缺陷 | 实测现象 |
|---|---|
| **#107** | 服务器仓库存在 `.env.prod`（MySQL 口令 / `JWT_SECRET` / MinIO 凭据），而仓库根目录**没有 `.dockerignore`** → 整个仓库（含密钥、`.git`）被当作构建上下文发送给 Docker 守护进程 |
| **#108** | 生产 api 容器内 `ls /app/apps/api/test/integration` → **29 个集成测试文件**；`node_modules/.bin` 里有 `jest` / `ts-jest` / `ts-node` —— **生产镜像携带整套测试代码与开发依赖** |

#### 2.36.2 处置

- **#107（已修）**：新增 `.dockerignore`，排除 `.env` / `.env.*`（保留 `.env.example`）、
  `.git`、`node_modules`、`dist`、`coverage`、`*.tsbuildinfo`、`logs`、`*.log`、
  `tests/concurrency/results`、编辑器与系统文件。
  ⚠️ **刻意不排除** `apps/*/test/` —— 回归链第 4 步要在 api 容器内跑 jest。
- **#108（未修，如实记录）**：剥离生产镜像里的测试代码与开发依赖，
  需要给 api.Dockerfile 拆测试 stage、在 compose 加 `api-test` 服务、
  把回归链第 4 步改成 `docker compose run --rm api-test jest …`、
  生产 stage 执行 `pnpm prune --prod` —— 属于**部署链路的结构性改造**，
  风险是回归链本身跑不起来，不在缺陷修复里顺手改基础设施。

#### 2.36.3 本轮终态实测

| 项 | 结果 |
|---|---|
| 三个镜像用新 `.dockerignore` 重建 | **成功**（api / worker / admin-web） |
| 镜像内密钥残留 | **无**（镜像根目录无 `.env` / `.git`） |
| 镜像内测试代码 | 仍在（29 个集成测试文件）—— 回归链第 4 步依赖它 |
| 回归链 | **17 步 EXIT=0**（服务器全量日志 `/tmp/chain36.log`） |
| 业务库 `users` 行数 | **1202**（未污染） |

> 过程中还实测到一处**部署脆弱性**（不作为缺陷条目，仅记录）：
> `.dockerignore` 变更会让 BuildKit 的 `COPY` 层缓存失效 →
> `pnpm install` 需要重新访问 `registry.npmmirror.com`；
> 本轮遇到瞬时 `ETIMEDOUT`（重试后成功）。
> 也就是说**构建依赖 npm registry 的可达性**，
> pnpm store 缓存只加速、不保证离线可构建。

---

### 2.37 错误码死码：契约声明了，服务端从不返回（2 个缺陷 + 1 个流程缺口）

#### 2.37.1 缺陷复现（实测）

用新写的校验器扫出来的结果：

| 错误码 | 服务端引用处 | 修复前实际返回 |
|---|---|---|
| `VERIFICATION_REQUIRED` | **0** | 403 + `FORBIDDEN`（与「没权限」无法区分） |
| `AUTH_FAILED` | **0** | 401 + `AUTH_REQUIRED`（与「没带令牌」无法区分） |
| `IDEMPOTENCY_CONFLICT` | 0（#103 已修） | 409 + `CONFLICT` |

共同根因：契约（`packages/contracts/src/common.ts`）是客户端判断的唯一事实来源，
而**没有任何一层检查过**「契约声明的错误码，服务端到底会不会返回」。
响应结构校验看**字段**、请求契约对账看**参数**、端点覆盖看**路由** —— 都没人看**错误码**。

#### 2.37.2 处置

- **#109**：`AlumniStageGuard` 改抛
  `{ code: VERIFICATION_REQUIRED, message }` + **HTTP 403 不变**；
  小程序请求层新增 `ApiError.isVerificationRequired`，命中时**引导到认证页**
  （5 秒冷却，避免失败风暴时反复跳转）。
- **#110**：新增 `authFailed()` 工厂，凭据类失败统一返回 `AUTH_FAILED`（401）；
  「没带令牌」仍由 JWT 守卫返回 `AUTH_REQUIRED` —— 两者被明确区分开。
- **#111（流程缺口）**：新增**第 10 层校验** `infra/scripts/check-dead-error-code.mjs`：
  - **R1 死错误码**：契约 `ErrorCode` 每一项，服务端源码里必须有引用
    （`ResponseCode.X` 或字面量）→ `DEAD_ERROR_CODE`（失败）；
  - **R2 契约缺码**：服务端会返回、契约里没有 → `CONTRACT_MISSING_CODE`（失败）；
  - **R3 客户端未消费**：提示级，不判失败；
  - 非错误码豁免清单（当前只有成功信封业务码 `OK`）**每次运行都打印**。

#### 2.37.3 新增集成测试：`error-codes.e2e-spec.ts`（5 例）

| 用例 | 断言 |
|---|---|
| #109 | 身份阶段不够 → 403 且 `code === 'VERIFICATION_REQUIRED'`（且不是 `FORBIDDEN`） |
| **对照** | 普通越权（改别人的资源）→ 403 且 `code === 'FORBIDDEN'`（**不是** `VERIFICATION_REQUIRED`） |
| #110 | 管理员密码错误 → 401 且 `code === 'AUTH_FAILED'`（且不是 `AUTH_REQUIRED`） |
| **对照** | 完全不带令牌 → 401 且 `code === 'AUTH_REQUIRED'`（且不是 `AUTH_FAILED`） |
| #110 | 刷新令牌无效 → 401 且 `code === 'AUTH_FAILED'` |

> 写测试时踩到一个**有价值的坑**：管理员密码若长度不合规（DTO 要求 8~128 位），
> 请求在校验阶段就被拦下返回 **400 `VALIDATION_ERROR`** ——
> 根本走不到凭据比对，测的就不是 `AUTH_FAILED` 了。
> 测试必须用**长度合规**的错误密码，否则断言的是另一条路径。

#### 2.37.4 校验器的反向验证（自带）

`check-dead-error-code-selftest.sh`：

| 用例 | 注入的缺陷 | 期望 |
|---|---|---|
| `dead-error-code` | 往契约 `ErrorCode` 里加一个服务端从不引用的码 | 退出码非 0 且命中 `DEAD_ERROR_CODE` |
| `contract-missing-code` | 把服务端会返回的 `NOT_FOUND` 从契约里删掉 | 退出码非 0 且命中 `CONTRACT_MISSING_CODE` |
| 元自检 | 换成「永远返回 0 的假校验器」 | 断言函数必须判失败 |

**正向基线**：干净副本 0 问题、退出码 0。

#### 2.37.5 本轮终态实测

| 项 | 结果 |
|---|---|
| 回归链 | **18 步 EXIT=0**（服务器全量日志 `/tmp/chain38.log`） |
| 集成测试 | **30 套件 / 233 用例**全通过 |
| 错误码对账（第 18 步） | **0 死码 / 0 契约缺码**，反向验证 2/2 命中 + 元自检通过 |
| 错误码语义用例 | **5/5** 通过（含 2 条对照，防误伤） |
| 业务库 `users` 行数 | **1202**（未污染） |

> 本轮同步更新了 `auth.e2e-spec.ts` 里两处**旧错误码断言**
> （语义变更，用例意图不变）：原先把「未带令牌」与「凭据无效」都断言成同一个码，
> 现在按新语义分别断言 `AUTH_REQUIRED` / `AUTH_FAILED`。

---

### 2.38 管理端账号与角色：写入的完整性、原子性与「后台锁死」（5 个缺陷 + 1 个流程缺口）

#### 2.38.1 缺陷复现（实测）

这一组缺陷全部集中在 `apps/api/src/modules/admin/admin-users.controller.ts`
—— 管理后台「管理员账号」这一块，是全仓库**唯一**还没有被上一轮扫过的写路径。

| 编号 | 缺陷 | 修复前的实测行为 |
|---|---|---|
| #112 | 登录名重复 | **500 `INTERNAL_ERROR`**（唯一索引冲突未捕获） |
| #113 | 对象不存在 | **200 + `{code:'OK', data:{error:'NOT_FOUND'}}`** —— 假成功响应 |
| #114 | 管理员账号的「已锁定」 | `admin_users.status` 的 ENUM 只有 `('active','disabled')`，但筛选放行了 `'locked'` → **永远筛不出任何行**；契约 `AdminUserDto.status` 也借用了 `UserStatus` |
| #115 | 多步写没有事务 | 「改资料 → 同步角色 → 写审计」三步各自提交，中途失败留下**角色被清空**的半成品账号 |
| #116 | 后台锁死 | 管理员可以把自己停用、或把最后一个 `admin:manage` 持有者降权 → **再没人能登录后台** |

关键证据（#113）：`{error:'NOT_FOUND'}` 会被统一响应包装成
`{code:'OK', message:'success', data:{error:'NOT_FOUND'}}` ——
客户端按 `code === 'OK'` 判定成功，于是**把「对象不存在」当成成功处理**。
全仓库其它模块（资源 / 认证 / 联系申请 / 附件）一律 `NotFoundException` → 404，
只有管理端这三处是历史遗留写法。

#### 2.38.2 处置

- **#112**：捕获 `ER_DUP_ENTRY` → `ConflictException` → **409 + `CONFLICT`**；
  其它数据库错误仍按原样抛出（不当成 409 吞掉）。
- **#113**：三处统一改为 `NotFoundException` → **404 + `NOT_FOUND`**。
- **#114**：`AdminUserListQueryDto.status` 收紧为 `@IsIn(['active','disabled'])`；
  契约 `AdminUserDto.status` 改为 `'active' | 'disabled'`；
  管理后台「管理员账号」页移除「已锁定」筛选项。
- **#115**：`createAdmin` / `updateAdmin` / `setUserStatus` 全部改为
  `dataSource.transaction(...)`，事务内**一律用 `manager.getRepository(...)`**
  （注入的默认仓储走另一条连接，用它写数据会跳出事务）。
- **#116**：在 `updateAdmin` 的**事务内、提交前**校验不变量 ——
  「系统里至少存在一个 `status='active'` 且拥有 `admin:manage` 权限的管理员」，
  不满足即 **400 + `VALIDATION_ERROR`** 并整体回滚。
  只在「本次操作真的动了状态或角色」时才校验，单纯改显示名不受影响。

#### 2.38.3 新增集成测试：`admin-account-management.e2e-spec.ts`（12 例）

| 用例 | 断言 |
|---|---|
| #112 | 登录名重复 → **409** 且 `code === 'CONFLICT'` |
| **对照** | 换个登录名 → **201** 正常 |
| #113 | 三个端点对不存在的对象 → **404** 且 `code === 'NOT_FOUND'`，且**不得**出现 `code === 'OK'` |
| **对照** | 真实存在的普通账号 → 查得到、停用得了 |
| #114 | `GET /admin/users?status=locked` → **400**（而不是返回空列表） |
| **对照** | `status=active` 筛选照常工作 |
| #115 | 注入「角色同步失败」→ 接口 500，但**资料改动被回滚**、**审计日志不留痕** |
| **对照** | 正常改账号 → 生效且留痕 |
| #116 | 把自己停用 → **400**，状态仍是 `active` |
| #116 | 把最后一个 `admin:manage` 持有者降权 → **400**，角色关联仍在 |
| **对照** | 只改显示名不受该规则影响 |
| **对照** | 还有别的管理员时，停用自己**放行** |

> 原子性用例的做法：直接 `app.get(AdminUsersController)` 拿到控制器实例，
> 把它的 `syncRoles` 替换成「抛错」的桩，再调接口。
> 这样**不依赖任何外部故障注入手段**，失败路径每次都能稳定复现。

#### 2.38.4 校验器的反向验证（容器内回退旧行为）

把控制器与 DTO **在容器里回退成旧行为**再跑同一套用例：

| 用例 | 修复前 | 修复后 |
|---|---|---|
| 6 条缺陷用例 | **全部真红** | 全部通过 |
| 6 条对照用例 | 全部通过（证明不是「见红就红」） | 全部通过 |

#### 2.38.5 校验器增强：枚举一致性新增「表绑定」规则（#117）

#114 之所以能溜过去，是因为枚举校验器的 R1 只要求
「DTO 的取值被**某个**数据库 ENUM 包含」——**不关心是哪张表**。
`['active','disabled','locked']` 恰好被 `users.status` 那个 ENUM 包含，于是判过；
而 `admin_users.status` 里根本没有 `'locked'`。

`infra/scripts/check-enum-consistency.mjs` 因此增强：

| 规则 | 内容 | 判定 |
|---|---|---|
| **R4** | 绑定到具体列的 DTO 字段，取值必须被**该列**的 ENUM 包含 | 失败 `DTO_ENUM_WRONG_TABLE` |
| **R5** | 绑定到具体列的契约字段同理；且该列的每个取值都必须在契约里出现 | 失败 `CONTRACT_ENUM_WRONG_TABLE` / `CONTRACT_ENUM_MISSING_VALUE` |

配套改动：

- 迁移解析从「只认列名」升级为「**认表名 + 列名**」
  （按 `createTable(queryRunner, '表名', '列定义…')` 调用块切分）；
- 契约侧新增 interface 字段解析，**支持具名类型别名**
  （`UserStatus` 这类别名此前完全没被解析过）；
- 顺手修掉一个盲点：`name!:`（确定赋值断言）形式的字段此前**整个字段对校验器不可见**
  （`UpdateUserStatusBodyDto.status` 就是这种写法），
  现在字段总数从 770 → **786**。

反向验证新增 2 个注入用例：

| 注入用例 | 注入的缺陷 | 期望 |
|---|---|---|
| `enum-wrong-table-binding` | 管理员筛选放行 `'locked'`（`users.status` 有、`admin_users.status` 没有） | 命中 `DTO_ENUM_WRONG_TABLE` |
| `enum-contract-wrong-table` | 契约 `AdminUserDto.status` 改回 `UserStatus` | 命中 `CONTRACT_ENUM_WRONG_TABLE` |

枚举校验器反向验证现为 **4/4 命中 + 元自检通过**。

#### 2.38.6 本轮终态实测

| 项 | 结果 |
|---|---|
| 回归链 | **18 步 EXIT=0**（服务器全量日志 `/tmp/chain39.log`） |
| 集成测试 | **31 套件 / 245 用例**全通过 |
| 枚举一致性对账（第 16 步） | 22 个 DB ENUM / 786 个 DTO 字段 / 13 个契约枚举，**漂移 0** |
| 枚举校验器反向验证 | **4/4** 命中 + 元自检通过 |
| 业务库 `users` 行数 | **1202**（未污染） |

---

### 2.39 多步写的原子性：把「同一种形态」一次找齐（3 个缺陷 + 1 个流程缺口）

#### 2.39.1 起因：同一种形态，被分四次挖出来

#115（管理端账号与角色的多步写）暴露的其实是一类**通用形态**：
**一个业务动作由多次写组成，但这些写不在同一个事务里**。
本轮把仓库里剩下的同类问题一次找齐 —— 结果又挖出 3 个。

| 编号 | 缺陷 | 修复前的实测行为 |
|---|---|---|
| #118 | 认证「补交材料」三步写无事务 | 申请状态、材料、用户阶段**各自提交** → 可留下「已补交但没材料」或「已补交但用户阶段没动」的状态机矛盾 |
| #119 | 个人资料「资料 + 联系方式」两步写无事务 | 名字改了、手机号没存，而接口返回 500 |
| #120 | 资讯/公告详情用**整行 save** 计浏览量 | 一次浏览把**并发中的管理端修改静默覆盖回旧值**；`updated_at` 被刷新 |

补充的细节：#118 里材料归属校验原本放在「改状态」**之后** ——
材料不合法时接口报错，申请却已经变成「已补交」。

#### 2.39.2 处置

- **#118**：`resubmit()` 三步写全部进 `dataSource.transaction(...)`，
  事务内一律 `manager.getRepository(...)`；
  事务内**重新取一次**申请以最新状态判定；材料归属校验**前移到任何写入之前**。
- **#119**：`updateProfile()` 改为 `dataSource.transaction(...)`；
  `updateContact()` 增加可选 `manager` 参数（事务内用 `manager.getRepository(...)`）；
  `requireProfile()` 同样支持传入仓储。
- **#120**：浏览计数改为**只动计数列**的原子更新：
  `UPDATE articles SET view_count = view_count + 1, updated_at = updated_at WHERE id = ?`。
  显式赋值 `updated_at = updated_at` 是关键 ——
  MySQL 在**显式赋值**时不应用 `ON UPDATE CURRENT_TIMESTAMP`，
  于是「浏览」彻底不产生副作用（计数 +1，其余一列不动，**不需要改表结构**）。

#### 2.39.3 新增集成测试：`multi-step-write-atomicity.e2e-spec.ts`（6 例）

| 用例 | 断言 | 注入点 |
|---|---|---|
| #118 | 最后一步失败 → 申请状态**回滚**到 `needs_more_material` | 仓储**原型**的 `update` 替换为抛错桩 |
| **对照** | 正常补交 → 状态 `resubmitted` + 用户阶段 `pending_review` | — |
| #119 | 联系方式写入失败 → 资料改动**回滚** | 服务实例的 `updateContact` 替换为抛错桩 |
| **对照** | 正常保存 → 资料改了 + `private_contacts` 有密文 | — |
| #120 | 浏览不得覆盖并发中的管理端修改（标题保持「并发改的标题」）+ 计数 +1 | 仓储 `findOne` 返回后模拟一次并发 UPDATE |
| **对照** | 正常浏览 → 计数 +1 且 **`updated_at` 不变** | — |

> ⚠️ 注入点的坑：事务里的仓储是 `manager.getRepository(User)` **新建的另一个实例**，
> 只改注入实例上的方法**拦不住**事务内的那次写入 ——
> 必须打在**仓储原型**（`Object.getPrototypeOf(repo)`）上。

#### 2.39.4 反向验证（容器内回退旧行为）

把三个服务文件回退成修复前的形态再跑同一套用例：

| 用例 | 修复前 | 修复后 |
|---|---|---|
| 3 条缺陷用例 | **全部真红** | 全部通过 |
| 3 条对照用例 | 全部通过（证明不是「见红就红」） | 全部通过 |

#### 2.39.5 本轮终态实测

| 项 | 结果 |
|---|---|
| 回归链 | **19 步 EXIT=0**（服务器全量日志 `/tmp/chain42.log`，新增第 19 步事务逃逸对账） |
| 集成测试 | **32 套件 / 251 用例**全通过 |
| 事务逃逸对账（第 19 步） | **0 处逃逸** + 2 条已确认豁免；反向验证 2/2 命中 + 元自检通过 |
| 业务库 `users` 行数 | **1202**（未污染） |

---

### 2.40 活动名额计数的守恒性：并发取消多回收名额（2 个缺陷）

#### 2.40.1 缺陷复现（实测）

活动的真实名额只有一个真相：
**`events.registered_count` 必须等于「当前 `status='registered'` 的报名记录条数」**。
两者不等，容量判定（`registered_count < capacity`）就失真 ——
表现为「看起来还有名额、实际已超卖」。

| 编号 | 缺陷 | 修复前的实测行为 |
|---|---|---|
| #122 | 取消报名时**条件更新的影响行数没检查** | 并发取消时，名额被**多回收一个**（`registered_count` 比有效报名数少） |
| #123 | 管理端可把人数上限改到**小于已报名人数** | 接口返回 200，活动进入「报名人数 > 上限」的不可能状态，且无任何报错 |

#122 的具体路径（需求基线 §活动报名 明确要求处理的「取消报名与其他报名请求竞争」）：

1. 外层 `findOne` 读到报名状态 = `registered`（**在事务之外**）；
2. 事务内 `UPDATE ... WHERE status='registered'` —— 若此时报名**已被别人取消**，
   影响 **0 行**；
3. 代码**没有检查影响行数**，继续执行 `registered_count = registered_count - 1`
   → 名额被**凭空多出来一个**。

#123 则是另一侧的不变量缺失：管理端表单只校验「不小于 0 的整数」（0 = 不限），
服务端也只做赋值，没有任何地方拿 `registered_count` 去对照新容量。

#### 2.40.2 处置

- **#122**：条件更新影响 0 行 → 说明**这次取消没有真正生效**
  → **不再回收名额**，并读一下当前状态如实返回 `cancelled` / `idempotent`。
- **#123**：容量改为正数且小于当前已报名人数 → **400 + `VALIDATION_ERROR`**；
  `capacity = 0`（不限）不参与比较。
- **永久防线**：数据完整性校验器新增两条约束（业务库只读）：
  - **C8** 活动已报名计数与实际报名记录数不一致 → 必须为 0；
  - **C9** 活动人数上限小于当前已报名人数 → 必须为 0。
  （业务库预检：C8 = 0、C9 = 0 ✓，加进去不会让既有数据变红。）

#### 2.40.3 新增集成测试：`event-capacity-accounting.e2e-spec.ts`（6 例）

| 用例 | 断言 |
|---|---|
| #122 | 模拟并发取消（他人已完整取消：改状态 + 回收名额）→ 计数**不得**再减；`registered_count` 必须等于有效报名条数 |
| **对照** | 正常取消 → 回收一次名额、`idempotent=false` |
| **对照** | 连续取消两次 → 只回收一次、第二次幂等 |
| #123 | 容量改到小于已报名人数 → **400** 且容量**未被改小** |
| **对照** | 容量改成 ≥ 已报名人数 → 200 |
| **对照** | 容量改成 0（不限）→ 200 |

#### 2.40.4 反向验证（容器内回退旧行为）

| 用例 | 修复前 | 修复后 |
|---|---|---|
| 2 条缺陷用例 | **全部真红** | 全部通过 |
| 4 条对照用例 | 全部通过（证明不是「见红就红」） | 全部通过 |

#### 2.40.5 本轮终态实测

| 项 | 结果 |
|---|---|
| 回归链 | **19 步 EXIT=0**（服务器全量日志 `/tmp/chain43.log`） |
| 集成测试 | **33 套件 / 257 用例**全通过 |
| 数据完整性校验（第 10 步） | **32 项**全部 0 违规（新增 C8 / C9） |
| 业务库 `users` 行数 | **1202**（未污染） |

---

### 2.41 HTTP 语义与「同一操作两条路径」：201 的默认值也是错的（3 个缺陷）

#### 2.41.1 缺陷复现（实测）

| 编号 | 缺陷 | 修复前的实测行为 |
|---|---|---|
| #124 | 标记通知已读不检查影响行数 | `POST /notifications/:id/read` 对**不存在**的通知返回 **200「已读」**；而 `GET /notifications/:id` 对不存在返回 **404** —— 同一对象、两个端点、相反语义 |
| #125 | 「标记已读」实现了**两遍** | 控制器里自己写了一遍条件更新，`NotificationService.markRead()` 里还有一份**从未被调用**的同名实现（死代码） |
| #126 | 「不创建资源」的 POST 端点返回 **201 Created** | 7 个端点（标记已读 ×2、拒绝/撤回申请、提交/撤回发布、停用账号别名）全返回 201；其中 `POST /admin/users/:id/status` 与它的 PATCH 主路径**返回码不一致**（201 vs 200） |

#126 的判定依据是 HTTP 规范：**201 Created** 表示「本次请求创建了新资源」，
且**应当**带 `Location` 头 —— 这批端点两样都不成立。
而仓库**自己已有正确做法**：活动报名首次 201、幂等命中 200（显式设置），
说明「只有真的创建了资源才 201」是本仓库的既定约定。

#### 2.41.2 处置

- **#124**：逻辑收敛到 service，由它判断影响行数：
  影响 0 行 → 再查一次存在性 → 确实不存在 → **404 + `NOT_FOUND`**；
  已读通知重复标记仍 **200**（幂等）。
- **#125**：删除控制器里的重复实现，统一调用 service。
- **#126**：7 个端点全部加 `@HttpCode(HttpStatus.OK)` → **200**；
  真正创建资源的 POST 端点**保持 201**。

#### 2.41.3 新增集成测试

**`notification-read-semantics.e2e-spec.ts`（5 例）**

| 用例 | 断言 |
|---|---|
| #124 | 标记不存在的通知 → **404** 且 `code === 'NOT_FOUND'` |
| #124 | 标记**别人的**通知 → **404**，且对方的通知**仍是未读** |
| **对照** | 标记自己的通知 → 200 且 `read_at` 真的被写入 |
| **对照** | 重复标记已读 → 仍然 200（**不得**变成 404） |
| #124 | GET 与 POST 对「不存在」的语义必须一致（404 / 404，同一个 code） |

**`http-status-semantics.e2e-spec.ts`（5 例）**

| 用例 | 断言 |
|---|---|
| #126 | 标记已读 / 全部已读 → **200** |
| #126 | `POST /admin/users/:id/status` 与 `PATCH` 版本返回**相同**的状态码（且都是 200） |
| #126 | 拒绝 / 撤回联系申请 → **200** |
| #126 | 提交审核 / 撤回发布 → **200** |
| **对照** | 真正创建资源的 4 个端点（认证申请、联系申请、活动报名、管理端建活动）→ **仍必须是 201** |

#### 2.41.4 反向验证（容器内回退旧行为）

把 4 个控制器与 service 回退成修复前的形态再跑同一批用例：

| 用例 | 修复前 | 修复后 |
|---|---|---|
| 9 条用例 | **真红** | 全通过 |
| 1 条**对照组**（创建型端点必须 201） | **通过**（两种状态下都应如此） | 通过 |

> 对照组在两种状态下都通过 —— 这正是「防误伤」该有的样子：
> 它证明用例不是「见红就红」，而是**只**对那批端点的状态码敏感。

#### 2.41.5 本轮终态实测

| 项 | 结果 |
|---|---|
| 回归链 | **19 步 EXIT=0**（服务器全量日志 `/tmp/chain45.log`） |
| 集成测试 | **35 套件 / 267 用例**全通过 |
| 业务库 `users` 行数 | **1202**（未污染） |

> **订正**：本节最初记录的是 `/tmp/chain44.log`，但那条链的退出码其实是 **1** ——
> 它暴露了 #129（本阶段改的状态码没同步到既有测试断言）。
> 绿链是随后重跑的 `/tmp/chain45.log`；#129 的处置见 §2.42。

---

### 2.42 测试隔离性与「状态码断言漂移」：新增第 12 层校验（4 个缺陷 + 1 个流程缺口）

#### 2.42.1 本轮的起因：一次间歇性失败

第 37 阶段改完 HTTP 语义后，回归链 `/tmp/chain44.log` 出现 **4 个套件红**：

| 套件 | 失败用例 | 表面症状 |
|---|---|---|
| `authorization` | 1 | 标记他人通知期望 200，实际 404（**这条是真问题**：断言没跟上 #124 的语义变更） |
| `directory-search-privacy` | 2 | `INSERT INTO users` → **Deadlock found when trying to get lock**；随后 `verification_applications` 外键约束失败 |
| `notifications` | 3 | 标记已读 / 全部已读期望 201，实际 200（**真问题**：断言没跟上 #126） |
| `resources` | 3 | 通知写入报 **Table definition has changed, please retry transaction** → 资源没建成 → 后续审核 404、改稿 403 |

把失败套件**单独**拿出来跑：`authorization` / `directory-search-privacy` / `resources` **全部变绿**，
只有 `notifications` 因为旧断言而红。
→ 说明前三个是**跨套件污染**，不是业务逻辑问题。

#### 2.42.2 缺陷与处置

| 编号 | 缺陷 | 处置 |
|---|---|---|
| #129 | #126 改了状态码，**既有测试断言没同步**（`notifications.e2e-spec.ts` 三处） | 同步断言（201→200；标记他人通知 201→**404**），并新增第 12 层校验把这类漂移变成可自动发现的问题 |
| #127 | 夹具的 `SET FOREIGN_KEY_CHECKS` 是**会话级**变量，却用在了会换连接的 `dataSource.query()` 上 | 整段重置改用**一条专用连接**（`createQueryRunner`），重置前先 `ROLLBACK` |
| #128 | 跨用例**残留事务**：连接带着未提交事务回池 → 读视图早于 `TRUNCATE`（表定义已变）+ 间隙锁互等（死锁） | 夹具侧重置前/套件结束时**点名**残留事务；回归链第 4 步后断言**残留事务数 = 0** |
| #130 | 流程缺口：没有「服务端状态码 ⟷ 测试断言」的对账层 | 新增**第 12 层校验** `check-status-code-assertions.mjs` + 反向验证自测，接入回归链**第 20 步** |

#### 2.42.3 新增第 12 层校验：HTTP 状态码对账

```
node infra/scripts/check-status-code-assertions.mjs --root .
```

| 项 | 实测 |
|---|---|
| 服务端端点（控制器声明） | **107** 个 |
| 集成测试里的状态码断言 | **485** 条 |
| **漂移（失败项）** | **0** 条 |
| 提示 | **3** 条 —— 全部是仓库既有的幂等回放约定（联系申请 / 活动报名 / 资源发布：首次 201、幂等命中 200） |

判定规则：

| 情形 | 判定 | 理由 |
|---|---|---|
| 服务端声明 200、测试断言 201 | **失败** | 语义变了、测试没跟上（#129 的形态） |
| 服务端声明 201、测试断言 200 | **提示** | 常见于「幂等回放返回 200」，不判失败以免误伤 |
| 4xx / 5xx 断言 | 不参与本层 | 错误语义由响应结构校验器负责 |
| 路径在服务端找不到 | **提示** | 可能是故意打的错误路径 |

#### 2.42.4 反向验证（注入真实漂移）

`check-status-code-assertions-selftest.sh`：

| 用例 | 期望 | 实测 |
|---|---|---|
| 正向基线（干净副本） | 退出码 0 且**无** `STATUS_ASSERTION_MISMATCH` | ✅ |
| 注入 `status-code-assertion-stale`（把通知断言改回 201） | 退出码**非 0** 且命中 `STATUS_ASSERTION_MISMATCH` | ✅ 退出码 1，命中 `notifications.e2e-spec.ts:115` |
| 元自检（恒过的假校验器） | 必须被判失败 | ✅ |

#### 2.42.5 机制复现探针（间隙锁 + 残留事务）

用一次性探针在测试库上**确定性复现** chain44 观察到的那对错误：

- 会话 A：未提交事务里
  ① 对**不存在的** `users.id` 做 UPDATE → **间隙锁**；
  ② 往 `verification_applications` 插一行（外键指向不存在的父行）→ 外键检查；
- 会话 B：并发 `INSERT INTO users` → 需要同一间隙的插入意向锁 → 与 A 互等。

实测（探针输出，与 chain44 对照）：

| 现象 | chain44 实测 | 探针实测 | 判定 |
|---|---|---|---|
| 会话 A 往子表插 FK 行 | `errno 1452 ER_NO_REFERENCED_ROW_2`「Cannot add or update a child row … `verification_applications`」 | **完全相同**（errno 1452，同一条约束名） | ✅ 机制一致 |
| 会话 B 并发插 `users` | `errno 1213 ER_LOCK_DEADLOCK`「Deadlock found when trying to get lock」 | `errno 1205 ER_LOCK_WAIT_TIMEOUT`「Lock wait timeout exceeded」 | ✅ 同一族：按定时序，InnoDB 或**检测到死锁**（1213）或**等到锁超时**（1205） |

> 诚实说明：机制链已实测复现（同一对错误、同一条约束），
> 但**泄漏事务的具体来源用例尚未定位到**（后续两轮全量回归未再复现）。
> 当前处置是「**让污染无处藏身 + 让它一出现就叫名**」，
> 而不是「已修好泄漏点」。

#### 2.42.6 本轮终态实测

| 项 | 结果 |
|---|---|
| 回归链 | **20 步 EXIT=0**（服务器全量日志 `/tmp/chain45.log`） |
| 集成测试 | **35 套件 / 267 用例**全通过 |
| 测试库残留事务 | **0**（第 4 步后新增断言） |
| 业务库 `users` 行数 | **1202**（未污染） |
| HTTP 状态码对账 | 107 端点 / 485 断言 / **0 漂移** / 3 条幂等回放提示 |

---

### 2.43 资源「修改」的多步写完整性：校验要前置、写入要同事务（3 个缺陷 + 1 个待修）

#### 2.43.1 缺陷复现（实测）

资源「修改」(`PATCH /resources/:id`) 有两个写动作：内容写入 + 附件**整体替换**。
修复前它们既**不在一个事务里**，**附件归属校验还排在内容写入之后**：

| 编号 | 缺陷 | 修复前的实测行为 |
|---|---|---|
| #131 | 附件归属校验排在写入之后 | 带着**别人的** mediaId → 返回 **400**，但资源**已经被改了**（标题 / 正文 / `version` / 状态全变） |
| #132 | 两个写没有事务 | 注入「附件写失败」→ 返回 **500**，但**内容写入已经提交**（留下「内容是新的、附件是旧的」的半成品） |

> 这两个缺陷与 #118（材料归属校验排在写入之后）**同源**：
> 「校验失败却留下副作用」+「多步写没进事务」。

#### 2.43.2 处置

- **#131**：附件归属校验**前移到任何写入之前**；
- **#132**：整段修改进 `dataSource.transaction(...)`，
  事务内 `manager.getRepository(ResourcePost)` **重取**再写，
  附件替换也走同一个 manager（`replaceAttachments(postId, mediaIds, manager)`）。

#### 2.43.3 新增集成测试

**`apps/api/test/integration/resource-update-atomicity.e2e-spec.ts`（4 例）**

| 用例 | 断言 |
|---|---|
| #131 | 附件归属校验失败 → 400，且资源的标题 / 正文 / `version` / 状态**一点都没变** |
| #132 | 附件写失败（故障注入）→ 500，且**内容写入整体回滚**（标题 / `version` / 状态回到原值） |
| **对照** | 不带附件字段的普通修改 → 照常 200，`version+1` |
| **对照** | 带**本人**合法附件的修改 → 附件**真的被替换**（旧的全没了，新的挂上了） |

> **故障注入的一个坑**：`Repository` 继承自 `EntityManager`，`save` 只存在于**同一个原型**上 ——
> 原型级注入会命中**所有**仓储（包括内容写入）。
> 若不按实体类型精确拦截，#132 会「假通过」：
> 它退化成「第一次写就失败」，根本测不到回滚。
> 所以用例里按 `instanceof ResourcePostAttachment` **只拦附件**。

#### 2.43.4 反向验证（容器内回退旧行为）

把 `update()` 回退成修复前的形态再跑同一批用例：

| 用例 | 回退后 | 修复后 |
|---|---|---|
| #131、#132 | **真红**（标题分别是「被拒绝的标题」「不该留下的标题」） | 全通过 |
| 2 条**对照组** | **真绿** | 真绿 |

> 对照组在两种状态下都通过 —— 防误伤成立：
> 用例**只**对「校验顺序」与「事务边界」敏感。

#### 2.43.5 流程缺口：第 11 层校验器的 R2 看不见「跨方法的多步写」

R2 规则（「同一方法里有 2 次以上写入且没有事务」）**抓不到 #132** ——
那两次写分散在 `update()` 与 `replaceAttachments()` 两个方法里。已新增 **R3（提示级）**：

| 增强点 | 说明 |
|---|---|
| 写操作识别 | 扩展到**局部别名**（`const attachments = manager.getRepository(X)` 后的 `attachments.save(...)`） |
| 方法识别 | 扩展到 `private` 修饰与**跨行签名**（`private async replaceAttachments(` 原本压根没被当成方法） |
| R3 命中条件 | 方法自己有写、又调用同类里**会写库**的其它方法、且方法内没有事务 |

反向验证：`check-transaction-escape-selftest.sh` 新增第 4 个用例
（注入 `multi-step-across-methods`）→ 修复前命中 `MULTI_STEP_WRITE_ACROSS_METHODS`，
修复后该提示**自动消失**；基线无该提示（防误报）。

> R3 同时**挖出了一个新候选**：管理端 11 处「业务写 + 审计日志」没有同事务
> （`admin.controller.ts · updateEvent`）→ 记为 **#134（待修）**，
> 由 R3 持续点名，不会被悄悄放过。

#### 2.43.6 本轮终态实测

| 项 | 结果 |
|---|---|
| 回归链 | **20 步 EXIT=0**（服务器全量日志 `/tmp/chain47.log`） |
| 集成测试 | **36 套件 / 271 用例**全通过 |
| 事务逃逸对账 | 事务逃逸 **0** 处；豁免 2 条；**跨方法多步写候选 1 条（#134，待修）** |
| 业务库 `users` 行数 | **1202**（未污染） |

---

### 2.44 管理端「业务写 + 审计日志」的原子性：审计写失败必须整体回滚（2 个缺陷）

#### 2.44.1 缺陷复现（实测）

管理端 11 个写接口都是两步：改业务数据 → 写 `admin_action_logs` 审计日志。
修复前两步**各自提交**：

| 编号 | 缺陷 | 修复前的实测行为（注入「审计日志写失败」） |
|---|---|---|
| #134 | 业务写与审计日志**没有同事务** | `POST /admin/events` → 500，但 `events` 表里**活动已经建出来了**；`DELETE /admin/notices/:id` → 500，但公告**已经被删掉了** |
| #135 | 校验器 R1 把「把 manager 传下去的服务调用」**误判**为事务逃逸 | 修复 #134 后，R1 开始点名 `this.eventsService.update(…)`（退出码非 0，会卡住回归链） |

后果：管理端收到 500 会以为操作失败 → 重试 → 业务数据被改两次；
而且那一次操作**没有审计记录**，事后无法追溯。

#### 2.44.2 处置

- **#134**：
  - 活动服务 3 个、内容服务 6 个、两个 `decide` 方法都接受**可选的 `manager`**；
    两个 `decide` 原来自带事务，改成「有外部 manager 就加入外部事务，否则自己开事务」；
  - 控制器 11 个写端点统一包进 `this.dataSource.transaction(...)`，
    业务写与 `log()` 用**同一个 manager**；
  - `log()` 增加可选 `manager` 参数。
- **#135**：R1 增加判据 —— 若这次调用的**实参里带了事务的 manager**，
  被调方就能加入同一事务，**不算逃逸**（实参做了括号配对解析、跳过字符串）。

#### 2.44.3 新增集成测试

**`apps/api/test/integration/admin-audit-atomicity.e2e-spec.ts`（4 例）**

| 用例 | 断言 |
|---|---|
| #134 | 审计日志写失败 → `POST /admin/events` 返回 500，且 `events` 表**仍为空** |
| #134 | 审计日志写失败 → `DELETE /admin/notices/:id` 返回 500，且公告**还在** |
| **对照** | 正常创建活动 → 201，活动**在**，审计日志里有 `event.create` |
| **对照** | 正常删除公告 → 公告**没了**，审计日志里有 `notice.delete` |

#### 2.44.4 反向验证（容器内回退旧行为）

在**未修复**的代码上跑同一批用例：

| 用例 | 回退后 | 修复后 |
|---|---|---|
| 2 条 #134 用例 | **真红**（`events` 多 1 条 / `notices` 少 1 条） | 全通过 |
| 2 条**对照组** | **真绿** | 真绿 |

#### 2.44.5 工具侧的交叉验证

- 第 11 层校验器的 R3 提示（`admin.controller.ts · updateEvent`）**自动消失**；
- R1 的**双向断言**成立：
  - 真逃逸仍被抓到（`tx-escape-in-transaction`：事务里 `this.applications.save(...)`，
    **不**传 manager → 退出码 1）；
  - 传 manager 的调用**不得**被抓到（基线里控制器有 11 处这种调用 → 基线退出码必须为 0）。

#### 2.44.5.1 校验器自身的盲点（#136，回归链当场暴露）

第一次跑链时，第 19 步的**反向验证挂了**——注入用例的目标模式被这次重构改失配。
这正是反向验证的价值。处置过程中又发现两个**误报**盲点：

| 盲点 | 现象 | 处置 |
|---|---|---|
| R2 不认局部别名的写 | `articles.save(...)`（别名）不算「写」 | R2/R3 统一用同一套写操作识别（认 `this.x.write` **和**局部别名） |
| 事务感知的方法被误判 | `syncRoles(manager, …)`、`replaceAttachments(…, manager?)` 由**调用方**开事务，却被判「无事务多步写」 | 新增「事务感知」判定（签名收 EntityManager 且写走它）→ 不再当候选 |
| 注入点依赖代码形状 | 实现一改写法，注入就失配 | 注入用例改为**新增文件**，不再改现有代码 |

并顺带新增 **R4（提示级）**：事务感知的方法里出现 `this.<repo>.<write>(`
→ 那次写**不在调用方的事务里** → 必须点名（这正是 #134 修复中最易引入的形态）。
自测从 4 例扩到 **5 例**（新增注入 `transaction-aware-bypass`）。

#### 2.44.6 本轮终态实测

| 项 | 结果 |
|---|---|
| 回归链 | **20 步 EXIT=0**（服务器全量日志 `/tmp/chain48.log`） |
| 集成测试 | **37 套件 / 275 用例**全通过 |
| 事务逃逸对账 | 事务逃逸 **0** 处；豁免 2 条；**跨方法多步写候选 0 条**（#134 已修） |
| 业务库 `users` 行数 | **1202**（未污染） |

---

### 2.45 并发撞唯一键、夹具的 DDL 重置，以及一个「靠巧合通过」的断言（3 个缺陷 + 新增第 13 层校验）

#### 2.45.1 #137 「先查后插」在并发下撞唯一键

**形态**（两处同源）：

```ts
const existing = await this.repo.findOne({ where: { ... } });
if (existing) { /* 改并保存 */ } else { await this.repo.save(this.repo.create({ ... })); }
```

单线程下「只发生一次写」没问题；**并发**下两个请求都读不到既有行 → 都去 INSERT →
后到的那一个撞唯一键 → **500**。

| 位置 | 唯一约束 | 现实场景 |
|---|---|---|
| `ConnectionsService.setContactGrant()` | `uk_contact_grant (pair_id, user_id)` | 同一用户在两台设备同时打开「联系方式授权」开关 |
| `ContentService.upsertSetting()` | `system_settings.key`（主键） | 两个管理员同时保存同一条系统设置 |

**处置**：两处都改成「捕获 `ER_DUP_ENTRY`（errno 1062）→ 重新读出既有行 → **改为更新**」，
与仓库既有的 `isDuplicateKey()` 模式一致；顺带把 `connections.service.ts` 的
`isDuplicateKey(error: QueryFailedError)` 放宽为 `error: unknown`
（TS 严格模式下 `catch` 变量是 `unknown`，原签名编译不过）。

**用例设计上的两个坑**（都是先踩了才知道的）：

| 做法 | 结果 | 为什么 |
|---|---|---|
| 固定延时 150ms | **假通过**（两个 200） | 两个请求**错开**：先到的读完直接 INSERT 并提交 → 后到的醒来时行已存在 → 走「更新」分支 → 撞不出冲突 |
| 只做「同时开始读」的屏障 | **假通过** | 放行 ≠ 两次读都完成：先读到的那次可能一路冲到 INSERT 并提交 → 后一次 SELECT 就读到了行 |
| **两段式屏障**（都到达 → 都读完 → 才放行去写） | **必现** | 两次读都发生在任何 INSERT 提交之前 → 必然都读到「行不存在」→ 都去 INSERT → 后到的撞唯一键 |

**反向验证**（未修代码 vs 修复版）：

| 用例 | 未修代码 | 修复版 |
|---|---|---|
| 2 条 #137 用例 | **真红**：`Duplicate entry '9-21' for key 'contact_share_grants.uk_contact_grant'` / `Duplicate entry 'concurrency_probe_setting' for key 'system_settings.PRIMARY'`（均 500） | 全通过 |
| 1 条**对照组**（单次授权真的生效） | 真绿 | 真绿 |

> 用例里还有一个**夹具陷阱**：`system_settings` 属于**保留表**（seed 基座，不在清理清单里），
> 之前那轮运行已经把 `site_notice` 写进去了 → 之后每次都走「更新」分支 → 天然撞不出冲突。
> 最终用一把**专属探针 key**（`concurrency_probe_setting`）并在用例前后显式清理。

#### 2.45.2 #138 夹具用 TRUNCATE 重置的三个脆弱点

| 脆弱点 | 现象 | 处置 |
|---|---|---|
| **DDL 慢** | 这台服务器 DDL 延迟在 2~30 秒/条剧烈波动（`TRUNCATE` 30s、`ALTER COMMENT` 9.4s、`RENAME TABLE` 15s）→ 一次重置 25 张表可能好几分钟 | 改用**单事务 DELETE（DML）**：一条专用 QueryRunner → `ROLLBACK` 清残留事务 → `FOREIGN_KEY_CHECKS=0`（会话级变量，必须同连接）→ 一个事务逐表 DELETE → 提交 |
| **让其它事务的读视图失效** | DDL 会让其它连接上的事务之后再读该表报 `Table definition has changed`（#128 的症状来源） | DELETE 是 DML，不动表结构 |
| **复位了自增计数器** | 掩盖真实缺陷（见 #139） | 接受该副作用（仅 1 处测试硬编码 id，已修） |

#### 2.45.3 #139 `notification.push()` 丢弃 `options.aggregateId`

库里出现自相矛盾的 Outbox 行：

```
event_type     = 'connection.request.created'
aggregate_type = 'connection_request'
aggregate_id   = <通知自己的 id>      ← 指向了一条通知，不是联系申请
```

`notification.service.ts` 的 `push()` 签名里有 `options.aggregateId`，
但写库时写死成 `String(notification.id)` → 调用方传的 `aggregateId` 被**静默丢弃**。
受影响调用点共 **8 处**：联系申请（创建 / 接受 / 拒绝）、认证（提交 / 决定）、
资源（投稿 / 审核）、活动报名。

**为什么长期没被发现**：`notifications.e2e-spec.ts` 里那条
`expect(outbox.aggregate_id).toBe(String(created.body.data.id))` 一直是**靠巧合通过**的 ——
老夹具用 TRUNCATE 重置，**每张表的自增计数器都从 1 重新开始**，
于是「通知 id」恰好等于「联系申请 id」（都是 1、2、3…）。
#138 改用 DELETE 重置后两个计数器不再同步，这条断言**立刻变红**，才把真缺陷挖出来。

**处置**：`aggregateId: options.aggregateId ?? String(notification.id)`
（调用方给了就用调用方给的，没给才退回通知 id，默认语义不变）。

**用例必须自己把两个计数器拉开距离**，否则换回 TRUNCATE 重置又会变成假通过 ——
先往 `notifications` 插一条 **id=900000 的占位通知**，把通知的自增计数器顶到远处。

**反向验证**：

| 用例 | 未修代码 | 修复版 |
|---|---|---|
| 3 条事件类型用例（联系申请 / 资源投稿 / 活动报名） | **真红**：`aggregate_id` 实际是 `900001` / `900002` / `900003`（通知 id） | 全通过 |
| 1 条**对照组**（不传 `aggregateId` 时默认仍指向通知 id） | 真绿 | 真绿 |

#### 2.45.4 新增第 13 层校验：`check-concurrent-upsert.mjs`

「先查后插」这类缺陷**单线程测试覆盖不到**（用例再全也测不出来），且形态会在代码里**重复出现**
（修一处还有下一处）→ 只能由工具兜住。

| 规则 | 判定 |
|---|---|
| **R1 并发撞唯一键**（失败） | 方法内「读同一张表 + 往同一张表插」且**没有**唯一键兜底 → 点名 |
| **R2 兜底存在**（通过） | 方法体内捕获 `ER_DUP_ENTRY` / 1062，或捕获 `QueryFailedError` 并转 `ConflictException`（409） |
| **R3 行级锁**（通过） | 方法内有 `FOR UPDATE` / `pessimistic_write` → 并发下安全 |

判定口径（都是实战踩出来的）：

- **跨行识别**：`save(\n  repo.create({...})\n)` 这种跨行写法很常见（#137 的 `upsertSetting` 就是）→ 逐行匹配会直接漏判；
- **必须同一个仓储**：「读 A 校验、往 B 插子行」（读帖子校验、再插评论）是安全形态 → 只有「读 A 再插 A」才是撞键形态；
- **注入按语义写**：注入用例**新增文件**，不改动现有代码（实现怎么演进都能注入）。

**反向验证**（`check-concurrent-upsert-selftest.sh`）：

| 步骤 | 期望 | 实测 |
|---|---|---|
| 正向基线 | 退出码 0 且无 `CONCURRENT_UPSERT` | ✅ 0（扫描 11 个 service 文件） |
| 注入 `concurrent-upsert-unprotected`（先查后插且无兜底） | 退出码非 0 且命中 `CONCURRENT_UPSERT` | ✅ 退出码 1，点名 `injected-upsert.service.ts · upsertSetting` |
| 注入 `concurrent-upsert-safe-cross-table`（读 A 插 B） | **退出码 0**（**防误报**） | ✅ 0（扫描 12 个 service 文件） |
| 元自检（恒过的假校验器） | 必须被判失败 | ✅ |

> 基线里还有一条**真实命中过的误报**：`events.service.ts · register` 曾被判成缺口，
> 实际它捕获 `QueryFailedError` 并转 409「报名信息冲突，请重试」→ 兜底是有的，
> 只是形态与 `ER_DUP_ENTRY` 不同 → 规则补上这一形态后消失。

#### 2.45.5 本轮终态实测

| 项 | 结果 |
|---|---|
| 回归链 | **21 步 EXIT=0**（服务器全量日志 `/tmp/chain54.log`） |
| 集成测试 | **39 套件 / 282 用例**全通过 |
| 并发撞唯一键对账（第 21 步） | 缺口 **0**；反向验证通过（注入必红 + **防误报**断言通过 + 元自检） |
| 测试库残留事务 | **0** |
| 业务库 `users` 行数 | **1202**（未污染）；events=7 / articles=10 / notices=5 / registrations=21 / admins=1 / action_logs=24 |
| 管理后台只读冒烟 | **13/13** 页面正常，**0** console error、**0** 失败请求（≥400） |
| 临时 `PROCESS` 授权 | **已撤销**（`REVOKE PROCESS ON *.* FROM 'nmg'@'%'`） |

### 2.46 幂等键的作用域：路由模板会让「一把钥匙开两个资源」互相串扰（2 个缺陷）

#### 2.46.1 #140 scope 用路由模板 → 跨资源回放，第二个资源根本没被写

**形态**：幂等拦截器把 scope 写成 `METHOD:${request.route.path}:u{userId}`，
而 `request.route.path` 是**路由模板**（`/connections/:id/contact-grant`），
不是实际路径（`/api/v1/connections/17/contact-grant`）。

于是「同一把钥匙开两个不同资源」落进**同一个 scope**：

- 请求体相同 → 第二个请求被判成**回放**，返回**第一个**资源的响应；
- 而第二个资源**根本没有被写入** → 客户端却收到 **200**，像是成功了
  （**静默的数据丢失**）。

**实测（未修代码，容器内）**：

| 请求 | 期望 | 实测 |
|---|---|---|
| `PUT /connections/58/contact-grant`（key=K, body 相同） | 200，id=58 | 200，id=**58** ✓ |
| `PUT /connections/59/contact-grant`（**同一把** key=K, 同一 body） | 200，id=**59**，且 59 真的被写入 | 200，id=**58** ✗ —— 回放了第一个资源；数据库只有 **1 条**授权记录 |

**处置**：

- scope 改用**实际路径**（`request.originalUrl` 去查询串）：
  `METHOD:/api/v1/connections/17/contact-grant:u3`；
- 请求指纹从「只有 body」扩到「方法 + 实际路径（含查询串）+ body」
  → 同一路径但查询串/请求体不同，仍按契约返回 **409 `IDEMPOTENCY_CONFLICT`**；
- `idempotency_records.scope` 由 `VARCHAR(64)` 放宽到 `VARCHAR(255)`
  （新迁移 `1730000004000-WidenIdempotencyScope`，**幂等**：先查列的实际类型再决定是否 ALTER）。
  实际路径比模板长 —— 长路由（如 `/api/v1/admin/verification/applications/:id/decision`）
  加上 BIGINT id 后**会超过 64 字符** → 不放宽就直接 `Data too long for column 'scope'` → 500。

**配套**：`idempotency-scope.e2e-spec.ts`（3 例）

| 用例 | 未修代码 | 修复版 |
|---|---|---|
| 1 条 #140 用例 | **真红**（`data.id` 是 58 而非 59） | 通过 |
| 2 条**对照组**（同一资源仍回放 / 同一资源不同 body 仍 409） | 真绿 | 真绿 |

> 反向验证时还踩了两个**用例自身的坑**（都记在用例注释里）：
> ① 授权只能由**关系双方**发起 → 最初用的 owner 不是第二条关系的成员，403；
> ② `system_settings` 那类保留表残留会让用例永远走「更新」分支。

#### 2.46.2 #141 客户端每次请求都换一把新的幂等键

管理后台与小程序的请求层都在**每次发请求时现生成**随机幂等键：

- `apps/admin-web/src/api/http.ts`：请求拦截器 `config.headers.set('Idempotency-Key', config.idempotencyKey || randomId())`
  —— 拦截器**每次**都跑，axios 的 401 刷新重试（复用同一个 config）也会被换成新钥匙；
- `apps/miniprogram/src/services/request.ts`：`header['Idempotency-Key'] = generateId()`。

幂等键的用途是「**首次其实写成功了、只是响应丢了**，重试不要写第二遍」。
每次换新钥匙 → 重试被当成**新请求** → **重复创建**，服务端那套能力一次都没被真正用到。

**已做的处置**：管理后台「已经有钥匙就不再覆盖」（自动重试沿用同一把）；
小程序把钥匙生成上移到 `request()` 这一层（401 重试走 `{ ...opts }` → 天然沿用），
并新增 `RequestOptions.idempotencyKey` 让调用方可显式指定。

**仍存在的缺口（如实记录，不宣称已解决）**：

| 缺口 | 说明 |
|---|---|
| **用户手动重试**仍是两次独立动作 | 要去重必须由 UI 层「一个动作一把钥匙」；目前各页面**没有**持有这个键 |
| 无自动化测试 | 两端都**没有**测试运行器；给 admin-web 引入 vitest 会新增 workspace 依赖（与「playwright 不得进 workspace 依赖」同类），本轮未做 |
| 结论 | 服务端已就绪，客户端还需在 UI 层补「动作级钥匙」——记为**设计缺口** |

#### 2.46.3 顺带修掉的一个噪声源：夹具诊断查询的「Access denied」

撤销测试库账号的 `PROCESS` 权限后，夹具的残留事务诊断会**必然失败**，
而 TypeORM 会把查询失败打到控制台 → 一大段「Access denied; you need PROCESS」
夹在测试输出里，**很容易被误读成测试失败**。

处置：诊断前先用 `information_schema.user_privileges`（任何用户都可读、只显示自己的权限）
**探针**一下有没有 `PROCESS`；没有就**根本不去查** `innodb_trx`。
探针与诊断查询期间还会把 `dataSource.options.logger` 临时换成静默版
（它是**日志时读取**的，所以换掉就彻底无声）。

实测：chain53 之前日志里每轮都有 4 条 Access denied 噪声 → chain55 起 **0 条**。

#### 2.46.4 本轮终态实测

| 项 | 结果 |
|---|---|
| 回归链 | **21 步 EXIT=0**（服务器全量日志 `/tmp/chain55.log`） |
| 集成测试 | **40 套件 / 285 用例**全通过 |
| 幂等相关用例 | 幂等相关 **13/13** 全通过（含新增的 3 条作用域用例） |
| 业务库迁移 | `1730000004000-WidenIdempotencyScope` 已应用（改前已备份 `20261117-010714`） |
| 测试库残留事务 / 业务库 users | **0** / **1202**（未污染） |
| 管理后台构建 | `vue-tsc --noEmit && vite build` 通过（镜像重建成功） |

### 2.47 迁移一致性：部署不跑迁移、迁移清单有两份（3 个缺陷 + 新增第 14 层校验）

#### 2.47.1 #142 部署流程不执行迁移 → 代码与业务库表结构悄悄漂移

**形态**：deploy 的流程是「同步 → 构建 → `up -d` → 健康检查」，**中间没有迁移**。

**这轮就被它咬到了**：#140 把 `idempotency_records.scope` 放宽到 `VARCHAR(255)`，
迁移若没手工补上，库里还是 64 → 长路径的幂等请求 `Data too long for column 'scope'` → **500**。

**为什么本地与测试库测不出来**：回归链第 1 步**重建**测试库、第 2 步**跑迁移**，
测试环境永远是「结构与代码一致」的；业务库是**唯一**会漂移的地方
→ 这类缺陷**天然只在生产暴露**。

**处置**：`deploy.sh` 在 **`up -d` 之前**用新镜像跑一次迁移
（`compose run --rm --no-deps api ... migration:run`）：

| 位置选择 | 理由 |
|---|---|
| **切流量之前** | 此时旧容器还在服务旧代码；迁移是**加法式**的（只加列/加表），旧代码对新结构完全兼容 → 不会出现「切了流量才发现结构不对」 |
| **用新镜像执行** | 迁移文件在镜像里；`--no-deps` 不额外起依赖容器 |
| 迁移失败 → **中止部署** | 不带着不一致的结构上线 |
| `--build-only` → **不动库** | 只构建不启动就不碰数据库 |

并在部署**之后**再跑一次**迁移一致性对账**（「跑过」≠「跑全了」）。

#### 2.47.2 #143 迁移清单有**两份**，真正应用迁移的那份容易漏加

`migrations/index.ts`（应用运行时用）与 `data-source.ts` 里的 `migrations: [...]`
（**`typeorm migration:run` CLI 用的就是这一份**）曾**各抄一份**类名。

新增迁移时若只改 `index.ts`，那条迁移就**永远不会被应用**，而且**没有任何报错** ——
CLI 只会说「没有新迁移」，一切看起来正常。

**处置**：`data-source.ts` 改为 `import { migrations } from './migrations'`，
清单**只有一份** → 两边不可能再不一致。

#### 2.47.3 #144 新增第 14 层校验：迁移一致性对账

`infra/scripts/check-pending-migrations.sh`（**只读**，不写库、不跑迁移）：

| 规则 | 判定 | 挡住的坑 |
|---|---|---|
| R1 清单 ↔ 文件一致（**失败**） | 目录里的每个迁移文件都必须登记进 `migrations/index.ts`；清单里也不能有**不存在的**文件 | #143 |
| R2 业务库无未应用迁移（**失败**） | 代码清单里的每个迁移都必须在库的 `migrations` 表里有对应记录 | #142 |
| R3 库里有清单之外的迁移（**提示**） | 分支不一致 / 回滚痕迹 → 只提示不判失败 | 避免误伤 |

参数：`--db <库名>` 指定目标库；`--static-only` 只做静态核对（不需要 `.env.prod`，本机可跑）。

**反向验证**（`check-pending-migrations-selftest.sh`）：

| 步骤 | 期望 | 实测 |
|---|---|---|
| 正向基线 | 退出码 0 且无 `PENDING_*` | ✅ 0（R1 5↔5 一一对应、R2 全部已应用） |
| 注入「迁移文件未登记进清单」 | 退出码非 0 且命中 `PENDING_MIGRATION_UNREGISTERED` | ✅ 退出码 1 |
| 注入「已登记但数据库里没有」 | 退出码非 0 且命中 `PENDING_MIGRATION` | ✅ 退出码 1 |
| 元自检（恒过的假校验器） | 必须被判失败 | ✅ |

接入回归链**第 22 步**。

### 2.48 临时预览版：离线演示兜底层（新增第 15 层校验）

**背景**：要先把「临时预览版」交给客户体验，而后端服务器在 NAT 后、
无公网 IP，校园网屏蔽了 81% 的免费内网穿透服务（实测不可达：
GitHub、ngrok、cloudflare、localhost.run、localtunnel、serveo、pinggy、bore、
ipify、ifconfig.me……）。免费方案里能用的只有 cpolar / 花生壳 / natapp，
但它们都需要注册账号拿 token。

**做法**：小程序内置一份离线演示数据，**API 不可达时自动回退**，
公网服务器就位后一个开关切回真实接口。

#### 2.48.1 数据集：真实公开内容 + 虚构通讯录

| 内容 | 来源 | 理由 |
|---|---|---|
| 活动 / 资讯 / 公告 / 合作资源 / 地区行业字典 | 线上 API 导出（`infra/scripts/export-miniprogram-demo-data.mjs`） | 这些本来就是对外公开内容，且库里的种子数据本身标注为「【虚构】/【虚构测试数据】」 |
| 校友名录（通讯录） | **12 条虚构卡片**（`src/demo/directory.ts`） | 线上 `/directory` 对未认证用户返回 **403**，且涉及个人信息 → 不导出 |
| 「我」的档案 | 种子账号 `mock_smoke-tester` | 导出时**剥掉**联系方式与实名字段 |

**隐私验证**（导出的数据集里连**字段名**都没有）：

```
contactPhone => 0
contactWechat => 0
contactEmail => 0
realName => 0
private_contacts => 0
```

数据集体积 24 KB（编译期内联后 33 KB）。

#### 2.48.2 切换机制与「回退边界」

`config.DATA_MODE`：`live` / `demo` / `auto`（默认 `auto`）。

**关键设计**：`auto` 模式下**只有网络层失败**（`NETWORK_ERROR`）才回退到演示数据，
**HTTP 4xx/5xx 一律不回退** —— 那是服务端真实的业务响应，
用假数据盖住真实缺陷是最坏的结果。首页顶部显示「演示数据模式 · 未连接后端服务」。

#### 2.48.3 #147 数据以 `.json` 进包 → 运行时能否 `require('*.json')` 不确定

拿不准的东西不能进交付物，而没有开发者工具/真机就没法先试一次。
→ 改成**编译期内联**：导出脚本生成 `src/demo/dataset.data.ts`
（内容是 TS 对象字面量，JSON 是它的子集），运行时零风险。

#### 2.48.4 新增第 15 层校验：离线演示兜底层

`infra/scripts/check-miniprogram-demo.sh`（**只读**）：

| 规则 | 判定 | 挡住的坑 |
|---|---|---|
| R1 路由覆盖（**失败**） | `src/demo/router.ts` 必须覆盖约定的 37 个端点 | 演示模式缺接口 → 页面空白 |
| R2 模式开关（**失败**） | `DATA_MODE` 存在且取值 ∈ {live, demo, auto} | 拼写错误 → 行为不可预期 |
| R3 隐私红线（**失败**） | 数据集与虚构名录里不得出现 contactPhone / contactWechat / contactEmail / realName / private_contacts | **把联系方式打进分发包** |
| R4 回退边界（**失败**） | 回退分支必须绑定 `NETWORK_ERROR`；不得由 HTTP 状态码触发 | 4xx 被假数据盖住 |
| R5 演示分支无网络调用（**失败**） | `auth.ts` 的演示分支里不得出现 wx.request / wx.login / post( | 演示模式仍在联网 → 卡死 |
| R6 类型检查（**失败**） | `tsc --noEmit` 通过 | 类型错误 |
| R7 无运行时 JSON 模块（**失败**） | 源码里不得出现 `from '*.json'` / `require('*.json')` | #147 |

**反向验证**（`check-miniprogram-demo-selftest.sh`，八段式）：

| 步骤 | 期望 | 实测 |
|---|---|---|
| 正向基线 | 退出码 0，R1~R7 全绿 | ✅ 0 |
| 注入「路由漏覆盖」 | 非 0 且命中 `DEMO_ROUTE_MISSING` | ✅ 1 |
| 注入「DATA_MODE 取值非法」 | 非 0 且命中 `DEMO_DATA_MODE_INVALID` | ✅ 1 |
| 注入「数据集出现 contactPhone」 | 非 0 且命中 `DEMO_PII_FIELD` | ✅ 1 |
| 注入「回退改由 HTTP 状态码触发」 | 非 0 且命中 `DEMO_FALLBACK_UNSAFE` | ✅ 1 |
| 注入「演示分支里调用 wx.request」 | 非 0 且命中 `DEMO_AUTH_NETWORK_CALL` | ✅ 1 |
| 注入「类型错误」 | 非 0 且命中 `DEMO_TYPECHECK_FAILED` | ✅ 1 |
| 注入「运行时 import .json」 | 非 0 且命中 `DEMO_JSON_IMPORT` | ✅ 1 |

> R7 的实现要点：**先剥注释再判定**。第一版把注释里写的
> 「`require('*.json')`」当成了真引用，误报了一次 —— 教训已写进脚本注释。

### 2.49 编译产物对账：一个会让客户拿到「必崩包」的缺陷（新增第 16 层校验）

#### 2.49.1 #145 微信编译器误剪 11 个**必需**模块

**形态**：`apps/miniprogram/project.config.json` 里
`setting.ignoreUploadUnusedFiles: true`（微信开发者工具的默认选项），
编译器会做「未被引用的文件不上传」的剪枝 —— 但它**剪错了**。

被剪掉的 11 个模块**全部是必需的**：

| 被剪掉的模块 | 谁在用它 |
|---|---|
| `services/index.js` | **所有页面**都 `require("../../../services")`（barrel 文件） |
| `config/index.js` | `services/request.js` 里 `require("config")` |
| `store/index.js` | 全局状态 |
| `types/index.js` | 类型（运行时已擦除，但 import 还在） |
| `services/{connections,content,directory,events,notifications,resources,uploads}.js` | 被 `services/index.ts` 再导出 |

**为什么危险**：编译**成功**、上传**成功**、后台**显示已上传**，
但包一打开就是 `module not found`
（小程序模块路径相对**包根**，`require("config")` 找的是 `<root>/config/index.js`）。
**照原样发布，客户拿到的是一个必崩的包。**

**处置**：`ignoreUploadUnusedFiles` 置 `false`（包大 44 KB，可接受）。

**对照实验**（同一工程，只改这一个开关）：

| | 剪枝开（修复前） | 剪枝关（修复后） |
|---|---|---|
| 产物 .js 数 | 70 | **81**（与源文件 1:1） |
| 源模块缺失 | **11** | **0** |
| 产物文件总数 / 体积 | 251 / 287.6 KB | 263 / 331.9 KB |
| 注入语法错误 | 编译**仍「成功」**（坏文件被剪掉，根本没编译） | 编译**失败**（BABEL_PARSE_ERROR） |

> 同一个根因引出两个症状：坏文件被剪掉 → 编译不报错。

#### 2.49.2 #146 流程缺口：没有「编译产物 ⟷ 源文件」的对账层

**为什么之前没人发现**：

1. `ci.preview` / `ci.upload` 会先联网「取项目属性」，
   没有真实 AppID + 上传密钥时**在编译完成前就失败** → 「上传前的编译」从没被观察到；
2. 微信编译器的输出**不落盘**（临时目录用完即删）→ 没有现成手段能看产物。

**新增第 16 层校验** `infra/scripts/miniprogram-compile-check.mjs`（**不联网**）：

| 规则 | 判定 | 挡住的坑 |
|---|---|---|
| R1 产物能编译出来（**失败**） | 离线编译不抛错 | 语法错误级的坏包 |
| R2 产物里无残留 TS 语法（**失败**） | 扫 `interface` / `export type` / `as unknown as` / `implements` | TS 没被转译 → 运行时必崩 |
| R3 源模块 1:1 入包（**失败**） | 每个源 `.ts` 都要有对应 `.js` | **#145** |
| R4 演示兜底模块入包（**失败**） | `demo/router.js`、`demo/dataset.data.js` 必须在包里 | 断网兜底失效 → 白屏 |

**怎么做到离线编译**：`getCompiledResult` 走本地编译，但内部会调 `getProjectAttr`（要联网）。
→ 在脚本里把 `utils/sign` 与 `utils/request` **本地打桩**，返回默认项目属性。
（打桩**只用于本地自检**，真正的上传仍然走真实凭据。）

**反向验证**（`check-miniprogram-compile-selftest.sh`）：

| 步骤 | 期望 | 实测 |
|---|---|---|
| 正向基线 | 退出码 0，产物 263 文件 / 331.9 KB | ✅ 0 |
| 注入语法错误 | 编译必须失败 | ✅ 退出码 1（BABEL_PARSE_ERROR） |
| 注入类型错误 | 编译仍过（**只转译不检查**），`tsc --noEmit` 必须红 | ✅ tsc 退出码 2（TS2322） |

> 顺带确认了一个重要事实：**微信编译器只转译、不做类型检查** ——
> 注入类型错误，编译照样「成功」。类型问题只能靠 `tsc --noEmit` 抓，
> 两道检查都得跑。

**接入发布流程**：`release-miniprogram-preview.sh` 第 1.5 步
—— **离线编译自检不过就不上传**。

#### 2.49.3 公网接入层的端到端自测

`infra/scripts/check-public-edge-e2e.sh` 在校园机上**模拟「公网服务器」**，
把整条链真跑一遍：

```
边缘 nginx → SSH 反向隧道 → 校园机 compose nginx → API / 管理后台
```

| 检查点 | 结果 |
|---|---|
| 隧道口取 API（**必须是 JSON，不能是 SPA 页面**） | ✅ |
| 经边缘入口访问 API / 管理后台 / 业务列表 | ✅ 200 且内容正确 |
| 端口真被占用时，日志必须明确报错、不得静默打错服务 | ✅ |

> 这条自测当场抓到两个真问题：
> ① 边缘 nginx 的 HTTPS 分支里两个 server 块都监听 443 → `nginx -t` 直接报错（已修）；
> ② 隧道守护收到 TERM 后只杀 ssh 子进程，`while true` 又把它拉起来 → 端口一直被占（已修）。

### 2.50 微信登录的真实失败语义 + 上传前产物对账（2 个缺陷 + 1 个流程缺口）

> 本节对应 `docs/KNOWN-ISSUES.md` 的 #148 / #149 / #150。

#### 2.50.1 #148 微信登录失败一律返回 500

**触发方式**：小程序接入真实微信登录后，第一次打真实链路就撞上：

```bash
curl -X POST http://8.160.116.34:18080/api/v1/auth/wechat/login \
     -H 'Content-Type: application/json' -d '{"code":"invalid_code_for_test"}'
# → HTTP 500 {"code":"INTERNAL_ERROR","message":"服务器内部错误"}
```

**根因**：`auth.service.ts` 里**已经有** `authFailed()` 助手（#110 修死码时加的），
但 `loginWithWechat` 没用它；provider 抛**普通 `Error`**，
被 `AllExceptionsFilter` 按「非 HttpException」一律映射成 500。
→ 契约里的 `AUTH_FAILED`（401）**在微信登录路径上从未出现过**。

**修复**（provider 引入可分类的 `WechatAuthError`，service 负责翻译）：

| 真实情况 | 修复后 | 修复前 |
|---|---|---|
| 微信拒绝凭据（errcode / 无 openid / code 为空） | **401 `AUTH_FAILED`** | 500 `INTERNAL_ERROR` |
| 微信接口不可达（axios 抛错：超时 / 连接被拒） | **502 `INTERNAL_ERROR`** | 500 `INTERNAL_ERROR` |
| Mock 登录入参非法（`mock:` 去前缀后为空） | **400 `VALIDATION_ERROR`** | 500 `INTERNAL_ERROR` |

微信返回的 `errmsg`（含 `hints` / `req_id`）**只进服务端日志**，不返回给客户端。

**对照用例**（新增 `apps/api/test/integration/wechat-login.e2e-spec.ts`，6 例）：
用**本地假微信服务器**（`WECHAT_API_BASE` 是现成的测试缝）精确制造四类情形：

| `js_code` 前缀 | 假服务器行为 | 期望 |
|---|---|---|
| `valid_` | 返回 openid | 200，登录成功并落库 |
| `errcode_` | `errcode=40029` | 401 `AUTH_FAILED`，响应体不含 `hints` |
| `noopenid_` | 200 但无 openid | 401 `AUTH_FAILED` |
| `unreachable_` | 直接掐断连接 | 502 `INTERNAL_ERROR` |

**防误报断言**：每个用例都断言假服务器**确实收到了请求**。
没有这条，「环境变量没生效 → 请求打到真实微信（同样返回 40029）」会让 401 变成假阳性。

**反向验证**（把 provider 退回「抛普通 Error」= 修复前行为，重建镜像后重跑）：

| 用例组 | 修复后 | 退回旧行为 |
|---|---|---|
| `wechat-login`（6 例） | 6 通过 | **4 失败**（401 / 502 全变 500）✅ |
| `auth-mode`（4 例） | 4 通过 | 4 通过（该组不依赖 provider 错误类型） |

**公网入口实测**（`http://8.160.116.34:18080`）：
无效 code → **HTTP 401 `AUTH_FAILED`** ✅；code 过短 → HTTP 400 `VALIDATION_ERROR` ✅。

#### 2.50.2 #149 `AUTH_MODE` 是死配置 → 生产环境有 Mock 登录后门

`.env.prod` 里一直写着 `AUTH_MODE=both`，但**全仓库没有任何代码读它** →
Mock 登录与微信登录永远同时可用 → `POST /api/v1/auth/mock/login` 是**公开可用的后门**。

修复后（`apps/api/test/integration/auth-mode.e2e-spec.ts`，4 例）：

| `AUTH_MODE` | Mock 登录 | 微信登录 |
|---|---|---|
| `mock` | ✅ 200 | **403 `FORBIDDEN`** |
| `wechat` | **403 `FORBIDDEN`** | ✅ |
| `both` | ✅ | ✅ |

- 非法取值按 `both` 处理（配置写错不该让登录瘫掉）；
- 被拒的请求**不造用户**（用例断言 403 之后 `users` 仍为空）。

#### 2.50.3 #150 流程缺口：上传「成功」≠ 包里的配置是对的

`ci.upload` 返回成功只说明「代码传到微信服务器了」，以下三种事故它一个都拦不住：

| 事故 | 客户看到的表现 |
|---|---|
| 基址没注入（还是 `127.0.0.1:3000`） | 真机**一个接口都调不通** |
| `USE_MOCK_LOGIN` 还是 `true` | 客户用的是「演示账号」，不是自己的微信身份 |
| `DATA_MODE` 落在 `demo` | 全是假数据 |

**处置**：
1. 上传脚本增**构建期注入** `--api-base-url` / `--mock-login` / `--data-mode`，
   `trap` 保证上传完（含异常路径）**自动还原源码**；
2. 注入统一走 `inject_const`，**保留类型注解**
   （`DATA_MODE: DataMode` 少了注解会变成 `string`，赋给 `DataMode` 参数直接编译报错）；
3. **上传前在产物里对账**（`miniprogram-ci-upload.sh` 第 4.5 步）：
   注入之后、上传之前离编译一次，直接在**编译产物**里找这三个值，找不到就**中止上传**；
4. 断言必须容错 minify：实测产物是 `exports.USE_MOCK_LOGIN=!1` / `exports.DATA_MODE="auto"`
   —— 断言同时认 `false`/`!1` 与 `true`/`!0`。

**反向验证**（阿里云实测，两次离线编译）：

| 对象 | 期望 | 实测 |
|---|---|---|
| 注入后的工程副本 | 退出码 0，三项配置全部符合预期 | ✅ `A_RC=0` |
| 未注入的工程副本 | 必须**失败**并点名哪几项不符 | ✅ `B_RC=1` |

失败输出示例：

```
产物里的运行配置与本次发布预期不符（客户端会连错地址 / 用错登录方式）：
  - API 基址：期望 http://8.160.116.34:18080/api/v1 —— 产物里找不到这个基址
  - 登录方式：期望 USE_MOCK_LOGIN = false —— 产物里 USE_MOCK_LOGIN 不是 false
```

#### 2.50.4 发布链上抓到的两个真 bug

| bug | 现象 | 处置 |
|---|---|---|
| `release-miniprogram-preview.sh` 的 `--desc` 只 `shift` 一次 | `--desc "临时预览版"` 被当成**未知参数**，发布直接退出 1 | 改 `shift 2` 并补空值检查 |
| rsync 多个文件到同一目录会**丢掉子目录层级** | `src/config/index.ts` 被传到 `apps/miniprogram/index.ts`（静默污染工程） | 逐文件传完整路径，并核对目标目录顶层文件清单 |

> 第二个不是「脚本 bug」而是**操作习惯**：rsync 的多文件目标必须是**目录**，
> 目录一给，路径就塌成 basename。两次都踩到，已改为逐文件传完整路径 + 事后核对目录清单。

### 2.51 真机白屏：微信运行时**不做「目录 → index.js」回退**（真根因）

> 对应 `docs/KNOWN-ISSUES.md` #152。

#### 2.51.1 现场证据（客户提供的 vConsole 报错）

```
MiniProgramError
module 'services.js' is not defined, require args is '../../../services'
    at require (pages/home/index/index.ts:1:1)
    at <require(pages/home/index/index.js)>

MiniProgramError
module 'store.js' is not defined, require args is '../store'
```

现场表现：**页面全白、图标全无，只剩底部 tabBar 的文字**。

#### 2.51.2 根因

微信小程序的运行时**不做「目录 → index.js」的回退**：
源码 `from '../../../services'` → 产物 `require("../../../services")`
→ 运行时解析成模块 `services.js` → **找不到**（包里明明有 `services/index.js`）
→ 页面 JS 加载失败 → 白屏。
tabBar 组件**没有 import**，能正常加载 → 所以只剩它的文字（极具迷惑性）。

**规模**：130 处目录导入（services 39 / types 58 / store 28 / config 5），涉及 65 个文件。

#### 2.51.3 为什么 16 层校验全都没拦住

| 校验 | 结果 | 原因 |
|---|---|---|
| 编译成功 | ✅ | 编译器照抄 import，**它自己也不做 index 回退** |
| 无残留 TS 语法 | ✅ | 产物是合法 JS |
| 源模块 1:1 入包 | ✅ | `services/index.js` **确实在包里** |
| 产物内 require 可解析（第 17 层 R5） | ✅ | R5 按 **Node 规则**判定 → 能解析 |
| `tsc --noEmit` | ✅ | **TS 规则有** index 回退 |
| 43 页面 / 43 组件注册完整性 | ✅ | 都在包里 |

> **每一层都按自己的规则判「合法」，唯独没人用「微信运行时的规则」判过。**
> 产物层的检查**在原理上就查不出它**，必须在**源码层**查。

#### 2.51.4 修复与新增校验

1. 130 处目录导入 → 显式指向 index（`'../../../services/index'`）；
2. **新增第 18 层校验** `infra/scripts/check-miniprogram-imports.mjs`
   （源码层禁止指向目录的 import），接入上传流程第 4.6 步；
   配套反向验证 `check-miniprogram-imports-selftest.sh` → **实测 5/5 通过**；
3. **新增第 17 层校验的 R5**（产物内 require 可解析）
   配套反向验证 `check-miniprogram-requires-selftest.sh` → **实测 4/4 通过**。

#### 2.51.5 修复后的产物证据

```
产物里 pages/home/index/index.js 的第一行：
  require("../../../services/index")     ← 不再是 "../../../services"
```

- 产物：263 文件（172 页面 / 6 演示模块） / 353.0 KB；
- 产物内 361 条 require **全部可解析** ✅；
- `tsc --noEmit` 退出码 0 ✅；
- 第 18 层校验：81 个源文件、**0 处**目录导入 ✅；
- 已上传 `0.3.0`（真实后端）/ `0.4.0`（离线演示）。

#### 2.51.6 留档：一次被推翻的判断

我曾判定「产物引用了包外的 `@babel/runtime` → 真机 module not found → 白屏」。
逐字节核对后**不成立**：编译器会把这 26 个 helper **自动打进包里**，require 能正常解析。
**是被反向验证当场抓出来的**（注入缺陷后校验器本该失败却通过了 → 前提就是错的）。

> **教训**：拿到「符合现象的解释」不等于「找到根因」。
> 必须有一份**来自现场的证据**（客户的 vConsole 报错）才能定案；
> 静态推断出来的原因，只能算**假设**。

---

### 2.52 界面还原度（缺陷 #154 / #155 / #156 / #157）

> 背景：客户真机截图反馈「显示出来了，但细节没有 HTML 那么精致，
> 还有一些显示 bug」。逐条落到具体成因，**不是一条缺陷，而是四条**。
> 它们的共同点：**对接口、类型检查、单测全是静默的** ——
> 没有任何既有校验层能发现它们，只有真机截图才看得到。

#### 2.52.1 缺陷 #154：首页 32 个类一个都没有样式

| 现象 | 真机截图里页面上半部分全是裸文字，下半部分的文章卡片却有样式 |
|---|---|
| 真凶 | 首页 WXML 用了 32 个类（`.home`/`.hero*`/`.home-tabs`/`.shortcut*`/`.notice-row`/`.state-wrap`/`.loading-line`/`.error-tip`/`.notice-list`/`.empty-mini`），而这些类**在所有 WXSS 里都没有定义**；首页 `index.wxss` 此前只有 6 行且没 import 共享样式 |
| 为什么没被发现 | 页面能开、数据能加载；底部卡片与 tabBar 是自定义组件、**各带自己的 wxss** → 一眼看过去「好像是有样式的」，只是上半截裸了 |
| 修复 | 重写首页 wxss（照 `prototype/html-v1/index.html` 移植，px→rpx）；`blocks.wxss` 补共享块；补 `article-card`/`opportunity-card`/`notification-detail` 缺失的类 |
| 新增校验 | **第 19 层** `check-miniprogram-styles.mjs`（类名对账）；反向验证 **5/5 通过** |

#### 2.52.2 缺陷 #155：全项目一张图片资源都没有，图标是 CSS 手绘 + 汉字占位

| 现象 | tabBar 图标是 CSS 伪元素手绘的三角形/半圆；首页快捷入口是「人/连/历/燕」；我的页菜单是「名/历/连/知/发/隐/燕/设」；通知类型是「认/连/审/活/通」；隐私提示是「盾」；搜索框是「搜」；活动卡标记是活动类型首字；原型的塔楼线描插画**完全缺失** |
| 根因 | **WXSS 不支持 SVG data URI**，而项目从未引入任何图片资源，也没有把原型 SVG 转成 PNG 的工具 → 只能手绘 CSS 或拿汉字凑 |
| 修复 | 新增 `infra/scripts/generate-miniprogram-assets.py`：**从原型 HTML 现读现提取** 31 个图标 + 4 幅插画（塔楼群 / 校园建筑 / 校友网络 / 焦点卡装饰），用 `cairosvg` 栅格化，并按原型 `currentColor` 还原**每个位置各自的色调** → **102 个 PNG / 约 130 KB**；tabBar 改 `<image>`（选中/未选中两套），删掉 8 条 CSS 手绘规则；9 处汉字占位全部换成 SVG 栅格图；4 幅插画按原型定位与透明度接回 |
| 新增校验 | **第 21 层** `check-miniprogram-assets.mjs`（图片引用必须有效 + 禁止单字占位图标）；反向验证 **7/7 通过** |
| 成本 | 主包 353 KB → **515 KB**（上限 2 MB） |

#### 2.52.3 缺陷 #156：20+ 处直接渲染原始 ISO 时间戳

| 现象 | 卡片日期显示 `2026-01-08T08:00:00.000Z`，列表、详情、申请记录、个人页到处都是 |
| 真凶 | **不是后端返回错了** —— DTO 里的时间字段本来就该是 ISO 串；是**展示层没做格式化**。WXML 数据绑定不能调用 JS 函数，直接把 DTO 丢给 WXML 就等于把原始串显示给用户。而 `utils/format.ts` 里的格式化函数**早就存在**，只是一直没人调用；更糟的是三个页面挂着**从未被 WXML 调用**的格式化方法（死代码），让人以为「已经处理过了」 |
| 修复 | 新增展示模型层 `apps/miniprogram/src/utils/view.ts`（`toArticleView`/`toNoticeView`/`toEventView`/`toOpportunityView`/`toRequestView`）+ `formatRelativeTime`；20 处渲染点全部改为绑定展示字段；清掉三个死方法 |
| 新增校验 | **第 20 层** `check-miniprogram-dates.mjs`（WXML 不得出现 `xxxAt` 插值）；反向验证 **5/5 通过** |

#### 2.52.4 缺陷 #157：「昨天」按时长而非日历日判定（单元测试抓出）

写 #156 的单元测试时**测试先红了**（当时红的是我自己的预期写错），
顺着查下去发现实现里真有一个语义缺陷：

| 场景 | 旧实现（按「距今不足 48 小时」） | 正确（按日历日） |
|---|---|---|
| 昨天 23:50 的事，今天 03:00 看 | `昨天 23:50` ✅ | `昨天 23:50` ✅ |
| 昨天 23:50 的事，今天 12:00 看 | `昨天 23:50` ❌（按日历已是**前天**） | `2天前` ✅ |

修复：`formatRelativeTime` 改为**按本地日历日之差**分级；
回归用例两条（跨零点的昨天 / 前天显示「2天前」）在旧实现下**会红**。

#### 2.52.5 本轮实测结果

| 项 | 结果 |
|---|---|
| 小程序端单元测试（`apps/miniprogram/test/`，**2 套件 38 例**） | **38/38 通过** ✅ |
| 第 19 层（类名对账） | 50 个 WXML、**1173 处类名引用**全部有对应 WXSS 定义 ✅ |
| 第 19 层反向验证 | **5/5 通过** ✅ |
| 第 20 层（无原始时间戳） | 50 个 WXML、**0 处**原始时间字段插值 ✅ |
| 第 20 层反向验证 | **5/5 通过** ✅ |
| 第 21 层（资产引用有效 + 无占位图标） | 102 个本地 PNG，引用全部有效，无单字占位图标 ✅ |
| 第 21 层反向验证 | **7/7 通过** ✅ |
| `tsc --noEmit`（小程序） | 退出码 0 ✅ |
| 产物包大小 | **515 KB**（原 353 KB；上限 2 MB） |
| 已上传 | `0.5.0`（真实后端 / auto）、`0.6.0`（离线演示 / demo） |

> ⚠️ **待验证**：新版样式与图标**尚未在真机复验** ——
> 以上全部是**静态与构建期**证据，真机视觉效果需客户扫码确认。

---

### 2.53 集成测试的隔离性（缺陷 #158）

> 本轮交付界面还原度后跑完整回归链，`http-status-semantics.e2e-spec.ts` 红了
> （`PATCH /admin/users/:id/status` 期望 200，实得 **403**）。
> 而**上一轮同一套代码**（`git HEAD` 一致、api 镜像与仓库逐字节一致）
> 是 **42 套件 / 295 用例全绿** —— 同一份代码，一轮绿一轮红。

#### 2.53.1 真凶

| 环节 | 事实 |
|---|---|
| `resetDatabase()` | `admin_users` / `admin_user_roles` / `roles` / `role_permissions` 是**保留表**（只清「测试数据表」） |
| 账号共用 | `admin-test` 被**十几个套件共用**，每个套件都往它身上 `ensureAdmin()` 授不同角色 → **角色跨套件、跨运行累积** |
| 用例自身 | `http-status-semantics` 只授了 `event:manage`；而 `PATCH /admin/users/:id/status` 的守卫是 `@RequirePermissions('alumni:manage')` → **单独跑必然 403** |
| 上一轮为何绿 | **碰巧**有别的套件（`admin-account-management`）先跑，把 `alumni_reviewer` 留给了 `admin-test` |
| 为何这次红 | 容器重建 → jest 的**执行顺序缓存**清空 → 顺序变了 → 依赖没了 |

> 「整链绿」只证明**某种执行顺序下**没问题；
> 而执行顺序是**环境产物**（容器一重建就失效），**不是代码属性**。

#### 2.53.2 修复

`http-status-semantics.e2e-spec.ts` 改为**自带权限**，照仓库里已有的正确范式
（`admin-account-management.e2e-spec.ts`）：**唯一账号 + 唯一角色 + 显式授权**
（`event:manage` + `alumni:manage`），并在 `afterAll` 清理自己创建的账号与角色。

#### 2.53.3 新增「集成测试隔离性自检」

`infra/scripts/check-test-isolation.sh`：**每个套件单独跑都必须绿**。
这是「不依赖执行顺序」的可验证口径。

配套反向验证 `check-test-isolation-selftest.sh`：

| 反向验证项 | 做法 | 期望 |
|---|---|---|
| 跨套件权限依赖 | 在**容器内**把 `alumni:manage` 授权换成 `event:manage`（精确复现 #158 原貌） | 必须被判红 → 还原后判绿 |
| 包根目录残留副本 | 在 `apps/api/` 根目录放一份残留 `.e2e-spec.ts` | 必须被判红 → 清理后判绿 |

#### 2.53.4 隔离性自检当场抓出的第二个问题

第一次跑隔离性自检：**41 绿 / 1 红** —— `event-capacity-accounting.e2e-spec.ts` 报
「Test suite failed to run」。查下去发现：

- `apps/api/` 根目录残留着两份 **Nov 16 调试时 cp 出来的副本**
  （`event-capacity-accounting.e2e-spec.ts` / `events.service.ts`）；
- 它们**不在 git 里**，但**在服务器的工作副本里** ——
  而 Docker 构建上下文就是服务器工作副本 → **被烘进了镜像**；
- jest 的 `testRegex` 匹配**整棵目录树** → 那份残留副本**和正式套件同时被匹配**，
  而它引用的 `../helpers` 在那个位置不存在 → 整条链报「Test suite failed to run」。

处置：删除残留 → **重建镜像**（旧镜像里那份还在）→ 并在隔离性自检里加一条前置守卫
（包根目录不允许出现测试文件）。这条守卫也进了反向验证。

#### 2.53.5 本轮实测结果

| 项 | 结果 |
|---|---|
| 隔离性自检（42 个套件逐个单独跑） | **42/42 绿** ✅ |
| 隔离性自检反向验证 | 跨套件权限依赖 + 包根目录残留，**两项都判红**，还原后判绿 ✅ |
| 完整回归链 | 24 步全绿 ✅（详见 §2.52 与本节） |
| 业务库 `users` 行数 | **1202**（未被测试污染）✅ |
| api 镜像 | 已重建（清理残留副本），7 个容器全 healthy ✅ |

---

## 3. 管理后台构建
```bash
pnpm --filter @nmg/admin-web build     # vue-tsc --noEmit + vite build
```

**结果：通过**（服务器实测，18.85s）。40 个源文件，真实 API 调用 + 权限菜单/路由守卫。

---

## 4. 并发压测（k6 v0.50.0）

> 本轮（2026-11-16 22:32–22:43）在**管理端路由归位 + 端点覆盖补测 + 上传归属校验**之后完整重跑了一遍，
> 用于证明本轮改动没有破坏并发语义。下表为**本次重跑**的实测数据（非上一轮数据）。

执行方式（服务器）：

```bash
bash infra/scripts/loadtest.sh --vus="20 50 100 200" --duration=30s
```

- 入口统一走 nginx（`http://127.0.0.1:18080`），覆盖 nginx → API → MySQL 全链路；
- 单机压测所有请求来自同一 IP，必然触发登录限流，因此脚本在压测期间**自动放宽限流阈值并在结束后回滚**
  （`RATE_LIMIT_*` 写回 `.env.prod` 并重启 API，`--no-relax` 可关闭）；
- 原始结果落盘 `tests/concurrency/results/<场景>-<VU>vu.json`（JSON）与 `.log`。

### 4.1 实测指标（p50 取 `med`）

| 场景 | VU | 请求数 | 吞吐 (req/s) | 错误率 | p50 | p95 | p99 | 平均 | 关键业务指标 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| login | 20 | 4434 | 147 | 0.000% | 127 ms | 183 ms | 218 ms | 135 ms | unique_accounts=4433; login_errors=0 |
| login | 50 | 4892 | 162 | 0.000% | 306 ms | 340 ms | 376 ms | 307 ms | login_errors=0; unique_accounts=4891 |
| login | 100 | 5042 | 166 | 0.000% | 599 ms | 647 ms | 672 ms | 601 ms | login_errors=0; unique_accounts=5041 |
| login | 200 | 5002 | 163 | 0.000% | 1214 ms | 1326 ms | 1786 ms | 1219 ms | login_errors=0; unique_accounts=5001 |
| directory | 20 | 9194 | 306 | 0.000% | 64 ms | 78 ms | 89 ms | 65 ms | duplicate_ids_in_page=0; directory_errors=0; leaked_contact_fields=0; page_overlap_ids=0 |
| directory | 50 | 9595 | 319 | 0.000% | 155 ms | 178 ms | 191 ms | 156 ms | duplicate_ids_in_page=0; directory_errors=0; leaked_contact_fields=0; page_overlap_ids=0 |
| directory | 100 | 9555 | 317 | 0.000% | 314 ms | 338 ms | 352 ms | 315 ms | leaked_contact_fields=0; duplicate_ids_in_page=0; directory_errors=0; page_overlap_ids=0 |
| directory | 200 | 9732 | 321 | 0.000% | 618 ms | 659 ms | 738 ms | 622 ms | leaked_contact_fields=0; duplicate_ids_in_page=0; page_overlap_ids=0; directory_errors=0 |
| connection-request | 20 | 10649 | 354 | 0.000% | 112 ms | 125 ms | 148 ms | 113 ms | connection_idempotent_replays=10646; connection_server_errors=0; final_connection_count=0; connection_pending_created=1 |
| connection-request | 50 | 10795 | 358 | 0.000% | 277 ms | 290 ms | 300 ms | 278 ms | final_connection_count=0; connection_server_errors=0; connection_idempotent_replays=10792; connection_pending_created=1 |
| connection-request | 100 | 10918 | 361 | 0.000% | 549 ms | 586 ms | 606 ms | 552 ms | connection_pending_created=1; final_connection_count=0; connection_idempotent_replays=10915; connection_server_errors=0 |
| connection-request | 200 | 10307 | 339 | 0.000% | 1153 ms | 1257 ms | 1968 ms | 1172 ms | final_connection_count=0; connection_idempotent_replays=10304; connection_server_errors=0; connection_pending_created=1 |
| event-registration | 20 | 12934 | 429 | 0.000% | 30 ms | 119 ms | 123 ms | 46 ms | event_seats_taken=10; event_server_errors=0; event_final_registered_count=0; event_seat_conflicts=2763 |
| event-registration | 50 | 11642 | 386 | 0.000% | 133 ms | 141 ms | 149 ms | 129 ms | event_seat_conflicts=8855; event_seats_taken=10; event_server_errors=0; event_final_registered_count=0 |
| event-registration | 100 | 11407 | 377 | 0.000% | 257 ms | 307 ms | 337 ms | 263 ms | event_seat_conflicts=10340; event_final_registered_count=0; event_seats_taken=10; event_server_errors=0 |
| event-registration | 200 | 11580 | 381 | 0.000% | 503 ms | 603 ms | 1098 ms | 520 ms | event_seat_conflicts=10946; event_server_errors=0; event_final_registered_count=0; event_seats_taken=10 |
| resource-submit | 20 | 5053 | 167 | 0.000% | 119 ms | 187 ms | 201 ms | 119 ms | unpublished_resource_leaked=0; idempotent_replays=2525; resources_created=1; resource_server_errors=0 |
| resource-submit | 50 | 4933 | 162 | 0.000% | 307 ms | 462 ms | 511 ms | 306 ms | resources_created=1; resource_server_errors=0; idempotent_replays=2465; unpublished_resource_leaked=0 |
| resource-submit | 100 | 4961 | 161 | 0.000% | 617 ms | 916 ms | 986 ms | 614 ms | resources_created=1; unpublished_resource_leaked=0; resource_server_errors=0; idempotent_replays=2479 |
| resource-submit | 200 | 5235 | 164 | 0.000% | 1177 ms | 1818 ms | 1962 ms | 1184 ms | idempotent_replays=2616; resources_created=1; unpublished_resource_leaked=0; resource_server_errors=0 |

### 4.2 业务正确性断言（全部通过）

| 场景 | 断言 | 结果 |
|---|---|---|
| login | 每次登录返回 2xx 且含 access_token；无 5xx | ✅ |
| directory | 列表 2xx；**响应体不含任何联系方式字段**；页内 id 不重复；分页无重叠 | ✅ |
| connection-request | A→B 与 B→A 并发互申：**同一对用户最终只有 1 条 pending 申请**（唯一索引 `uk_connection_request_pending` 生效），其余为幂等回放 | ✅ |
| event-registration | 容量 10 的活动在 20/50/100/200 VU 下**报名人数恰好 10**，其余为「名额已满」冲突；teardown 复核 `registered_count <= capacity` | ✅ |
| resource-submit | 同一 `Idempotency-Key` 的并发提交**只创建 1 条资源**，其余为 409/200 回放；未审核资源不出现在公开列表 | ✅ |

### 4.3 性能基线说明

`docs/top.md` §6 明确「性能目标应通过实际测试确定，不允许虚构已经达到的并发能力」。
因此阈值不是预设目标，而是**本次实测的观测上限**：

| 场景 | 基线 p95 | 200 VU 实测 p95 |
|---|---|---|
| login（每次迭代新建用户，最重的写路径） | 2000 ms | 见上表 |
| directory（通讯录查询 + 关系状态） | 1200 ms | 见上表 |
| connection-request | 3000 ms | 见上表 |
| event-registration | 1600 ms | 见上表 |
| resource-submit | 2600 ms | 见上表 |

后续版本应在同等硬件上以更严的基线回归。

---

## 5. 备份与恢复演练

### 5.1 备份（`infra/scripts/backup.sh`）

实测产物（本轮重跑）：`/home/kikun/backups/nmg-pku-alumni/20261116-025626/`

| 内容 | 大小 | 说明 |
|---|---|---|
| `mysql-nmg_alumni.sql.gz` | 2.1 MB | `mysqldump --single-transaction --routines --events --triggers` 一致性快照 |
| `minio/nmg-public/`、`minio/nmg-private/` | — | 对象存储镜像（含上传实测的对象文件） |
| `config/` | — | `docker-compose.prod.yml` + `infra/` + `.env.prod`（600） |
| `manifest.sha256` | — | 全量校验清单，`sha256sum -c` 通过 |

- gzip 完整性校验通过（`gzip -t`）；
- 清单校验通过；
- 保留策略：删除早于 `BACKUP_RETENTION_DAYS`（默认 7 天）的**时间戳命名**目录，且只允许删除 `BACKUP_DIR` 内部的目录。

### 5.2 恢复演练（`infra/scripts/restore.sh`）

实测命令：

```bash
bash infra/scripts/restore.sh \
  --backup /home/kikun/backups/nmg-pku-alumni/20261116-025626 \
  --target-db nmg_restore_drill --with-minio
```

**结果：恢复成功**（线上库 `nmg_alumni` 全程只读，未受影响）

| 校验项 | 期望 | 实际 |
|---|---|---|
| 备份清单 `sha256sum -c` | 通过 | ✅ 通过 |
| 转储 gzip 完整性 | 通过 | ✅ 通过 |
| 表数量 | 33 | ✅ 33 |
| 默认字符集 | utf8mb4 | ✅ utf8mb4 |
| 关键表行数抽样 | 与源库一致 | ✅ users / alumni_profiles / events / event_registrations / resource_posts 全部一致 |
| MinIO 桶回灌 | 成功 | ✅ 完成（0 B 为对象已在目标桶中的幂等结果） |

**本轮补充校验（新外键迁移后的结构保真度）**：

| 校验项 | 期望 | 实际 |
|---|---|---|
| 迁移记录 | 含 `FixCreatedByForeignKey1730000002000` | ✅ InitSchema / FixVerifiedByForeignKey / FixCreatedByForeignKey 三条齐全 |
| `created_by` 外键指向 | 4 张表均指向 `admin_users` | ✅ articles / events / notices / resource_posts 全部指向 `admin_users` |

演练结束后临时库 `nmg_restore_drill` 已删除；脚本默认**拒绝**把线上库名作为恢复目标。

### 5.3 一键恢复演练（`infra/scripts/backup-restore-drill.sh`）

把「备份真的能恢复」从一次性人工动作变成**可重复执行的常规检查**。

```bash
bash infra/scripts/backup-restore-drill.sh            # 备份 → 恢复 → 比对 → 清理
bash infra/scripts/backup-restore-drill.sh --keep      # 保留演练库供人工比对
bash infra/scripts/backup-restore-drill.sh --no-backup  # 复用最近一次备份
bash infra/scripts/backup-restore-drill.sh --compare-only  # 只比对已存在的演练库
```

**实测结果（退出码 0）**：

| 校验项 | 结果 |
|---|---|
| 表数量 | ✅ 33 = 33 |
| **全部 33 张表逐表行数** | ✅ 完全一致（`users` 1202 / `alumni_profiles` 1202 / `events` 7 / `event_registrations` 21 / `resource_posts` 64 …） |
| 列结构指纹（MD5：表名/列名/类型/可空/默认值/键位） | ✅ `b1befb26120bcbf220b5be0d1da58503` 两库相同 |
| 外键定义指纹（约束名/列/被引用表/被引用列） | ✅ `4ca42c672cf427a8ec853b084b8b8393` 两库相同 |
| 索引指纹 | ✅ `6e4522a6e31b0d13e28e8d2f502f31b1` 两库相同 |
| 迁移记录数 / 内容 | ✅ 3 条 / 内容指纹 `9acc22bb0028e1a2af48a42dca16f615` |
| 默认字符集 | ✅ utf8mb4 |
| 演练库清理 | ✅ 自动删除；服务器数据库仅剩 `nmg_alumni` 与 `nmg_alumni_test` |

安全护栏：演练库名不得等于线上库名、必须含 `restore`/`drill` 字样、只允许字母数字下划线；
线上库全程只读；无论成功失败都清理演练库（`--keep` 除外）。

### 5.4 演练校验器的反向验证（`infra/scripts/backup-restore-drill-selftest.sh`）

**校验器本身必须被验证**——否则「通过」可能只是恒过。实测：

| 步骤 | 期望 | 实测 |
|---|---|---|
| 正常演练（保留演练库） | 退出码 0 | ✅ 0 |
| 正向基线：完好演练库 `--compare-only` | 退出码 0 | ✅ 0 |
| 注入缺陷 A：删一条 `event_registrations` | 比对退出码非 0 且命中「行数」 | ✅ 退出码 1，报 `表 event_registrations 行数：源库=21 演练库=20` |
| 重新演练回到完好状态 | 退出码 0 | ✅ 0 |
| 注入缺陷 B：`users.nickname` → `VARCHAR(255)` | 比对退出码非 0 且命中「列结构指纹」 | ✅ 退出码 1，报 `列结构指纹：源库=b1befb26… 演练库=e66a14df…` |

> 反向验证直接暴露了校验器自身的两个缺陷（详见 `docs/KNOWN-ISSUES.md` #43）：
> ① 比对用的表名写错且 SQL 错误被静默吞掉，脚本在第一条比对后**假完成**；
> ② 库名在 SQL 模板里写死，导致结构指纹三项**恒等成立**。
> 两者均已修复，修复后正向演练与反向验证同时成立。

### 5.5 演练中发现并修复的问题

| 问题 | 根因 | 处置 |
|---|---|---|
| MinIO 桶镜像失败：`Unable to stat source 'local/nmg-public'` | mc 的 `local` 是**内置保留别名**（固定指向 `localhost:9000`），环境变量无法覆盖 | 改用自定义别名 `MC_HOST_NMG` |
| 仍失败：`Requested path '/nmg/nmg-public' not found` | mc 的别名解析**大小写敏感**：`MC_HOST_NMG` 对应的别名名是大写 `NMG` | 脚本统一引用 `NMG/<bucket>` |
| 恢复校验「表数量不一致：期望 0 / 实际 33」 | `gzip -c file.gz` 会把已压缩文件**再压缩一次**，输出的是 gzip 二进制流 | 改用 `gzip -dc`（解压到标准输出） |
| MinIO 桶根本不存在（上传必然 NoSuchBucket） | 全项目没有任何建桶逻辑 | `UploadsService.onModuleInit()` 启动时幂等建桶；对象存储不可用时只告警不阻断启动 |
| `POST /uploads` 返回 500 | 控制器导入了 `FileInterceptor` 却**从未应用**，`@UploadedFile()` 恒为 undefined | 两个上传端点补 `@UseInterceptors(FileInterceptor('file', { limits }))`，并按 10 MiB 限制请求体 |
| 恢复演练脚本首轮比对「假完成」 | 表名清单写错 + SQL 错误被 `2>/dev/null` 吞掉，`pipefail` 让脚本在第一条比对后静默退出 | 重写脚本：错误显式抛出、SQL 改用 stdin 传递、比对改为全表逐表（见 #43） |
| 列结构 / 外键 / 索引三项指纹恒等成立 | SQL 模板中库名写死为源库，在演练库上执行时读的仍是源库元数据 | 引入 `__DB__` 占位符，按当前被查询的库替换（见 #43） |

---

## 6. 未验证项（不得声称已通过）

| 项 | 原因 | 计划 |
|---|---|---|
| 微信小程序真实登录 | 小程序已注册（`wx6761deb1125d858f`），凭据经 `jscode2session` 验证有效（返回 40029）；**尚未在真机跑过一次完整登录** | 客户扫码真机实测；体验期结束后切 `AUTH_MODE=wechat` |
| 小程序在真机 / 开发者工具中的运行 | **已上传体验版 `0.1.0` 并出预览二维码**，但**没有微信客户端，未在真机打开过** | 客户扫码实测（手机端需开「调试模式」跳过域名校验） |
| 小程序 request 合法域名 | 后端入口是 `http://IP:18080`，微信强制要求 **HTTPS + 已备案域名**、**不能用 IP** | 体验期靠手机调试模式；正式发布需买域名 → 备案 → 证书 → 配置合法域名 |
| 微信订阅消息 | 仅站内通知；Outbox 通道与 Worker 派发已就绪，模板适配未接 | 配置消息模板后接通 Worker 的 `wechat` 渠道 |
| 正式域名 / HTTPS 证书 | 私网环境用 nginx 明文回环 | 上线前配置证书与域名 |
| 对象存储托管服务（OSS/COS） | 当前用自建 MinIO | 切换 `MINIO_*` 环境变量即可，接口不变 |
| 对象存储异地容灾 | 备份只落在服务器本地磁盘 | 接入异地存储后由 `backup.sh` 定时推送 |

---

## 7. 安全与性能专项落实（2026-11-20）

> 本节记录「按 `docs/SECURITY.md` 第 3~8 节逐条落实安全缺口 + 性能缺口」这一轮的结果。
> **安全结论一律以用例为准**（负向验证单列）；**性能结论一律附改动前后的实测数字**，
> 没有实测数字的一律进 `docs/KNOWN-ISSUES.md` 的待办，不在这里出现「已优化」的说法。

### 7.0 环境

| 项 | 值 |
|---|---|
| 日期 | 2026-11-20 |
| 运行时 | Node 22.21.1 / pnpm 11.7.0 |
| 数据库 | MySQL 8.4.10（容器 `nmg-mysql`，映射 `127.0.0.1:13306`） |
| 缓存 | Redis 7.4.7（`127.0.0.1:16379`） |
| 对象存储 | MinIO（`127.0.0.1:19000`） |
| 测试库 | `nmg_alumni_test`（`DATABASE_URL=mysql://nmg:***@127.0.0.1:13306/nmg_alumni_test`） |
| 业务库 | `nmg_alumni` **只读**，本轮未对其做任何写操作 |

复现命令（后端）：

```bash
cd apps/api
DATABASE_URL='mysql://nmg:<密码>@127.0.0.1:13306/nmg_alumni_test' \
REDIS_HOST=127.0.0.1 REDIS_PORT=16379 REDIS_PASSWORD=<密码> \
MINIO_ENDPOINT=127.0.0.1 MINIO_PORT=19000 \
MINIO_ACCESS_KEY=<key> MINIO_SECRET_KEY=<secret> \
npx jest --config jest.config.js --runInBand --testPathPattern=integration/<文件名>
```

### 7.1 安全：承诺 → 落地 → 验证

| 承诺（`docs/SECURITY.md`） | 落地 | 验证用例（**负向验证**已标注） |
|---|---|---|
| 缺 `JWT_SECRET` / 数据库口令 / MinIO 密钥 → 生产环境拒绝启动 | `src/config/config-validation.ts` + `ConfigModule.forRoot({ validate })` | `config-validation.e2e-spec.ts`（9 例负向：缺配置 / 占位值 / 密钥过短 / 通配 CORS / `AUTH_MODE` 未设或非法或为 `mock` → 全部拒绝启动） |
| `AUTH_MODE` 非法取值不得退回 `both`（fail-closed） | `src/auth/auth.service.ts` | `auth-mode.e2e-spec.ts`（负向：`AUTH_MODE=wechats` → Mock 登录 403，且**不创建用户**） |
| CORS 只接受白名单内的 Origin | `src/config/cors.ts` + `main.ts` | `security-hardening.e2e-spec.ts`（负向：白名单外 Origin **拿不到任何 CORS 头**；预检返回 403；生产态 `*` 不放行） |
| 安全响应头（应用层 + Nginx） | `src/common/middleware/security-headers.ts`、`infra/nginx/*.conf` | `security-hardening.e2e-spec.ts`（逐头断言；非生产态不下发 HSTS） |
| 限流按「身份 + 接口类别」计数 | `src/common/guards/rate-limit.guard.ts` | `rate-limit.e2e-spec.ts`（写端点之间共享额度） |
| 限流按真实客户端 IP 计数 | `src/main.ts`（`TRUST_PROXY_HOPS`，默认 1） | 随 nginx 链路生效（私有网部署） |
| 学号脱敏存储 | `src/common/utils/mask.ts` + `alumni.service.ts` | `privacy-hardening.e2e-spec.ts`（负向：库里检索不到完整学号；后台按完整学号仍能搜到） |
| 证明材料只接受私有桶资产 | `alumni.service.ts::assertOwnedMedia` | `privacy-hardening.e2e-spec.ts`（负向：public 桶文件被引用 → 400，且**不写入关联表**） |
| 审计记录只追加（删账号不删证据） | 迁移 `1730000005000`（外键 `CASCADE` → `RESTRICT`） | 迁移在测试库上 `migration:revert` → `migration:run` 往返验证通过 |
| 审计日志记录来源 IP | `src/common/services/request-context.service.ts` + 全局拦截器 | `admin-audit-atomicity.e2e-spec.ts`（审计行的 `ip` 必须有值；此前该列从未被写过） |

### 7.2 性能：实测数字

#### 7.2.1 列表接口的 N+1 查询（后端）

命令：

```bash
cd apps/api && npx jest --config jest.config.js --runInBand --testPathPattern=integration/query-efficiency
```

数据：测试库内每端点 20 行（`query-efficiency.e2e-spec.ts` 内置播种），
口径：**一次请求里服务端实际执行的 SQL 条数**（TypeORM logger 计数）。

| 端点 | 改动前 | 改动后 | 说明 |
|---|---:|---:|---|
| `GET /api/v1/admin/resources?pageSize=20` | **66 条** | **9 条** | 逐行查作者/附件/审核记录/管理员名 → 批量 `In(...)` |
| `GET /api/v1/admin/verifications?pageSize=20` | **65 条** | **8 条** | 同上 |
| `GET /api/v1/connections?pageSize=20` | **103 条** | **6 条** | 资料/授权/联系方式批量查；「我方资料」原本每行重复查一次 |
| `GET /api/v1/admin/resources?pageSize=5` | 21 条 | **9 条** | 页大小翻倍时条数**不变**（这就是「与页大小无关」的证据） |

> 改动前的数字由 `git stash` 掉三个 service 的改动后，用**同一个用例、同一份数据**跑出来
> （用例此时会红，正是它该红的原因：SQL 条数越界）。
> 新增用例同时是**回归守卫**：`queries <= 20` 的断言会让逐行查询一旦回来就被抓住。

#### 7.2.2 缺失索引

迁移：`1730000005000-AddQueryIndexesAndProtectAuditLogs`（TypeORM migration，含回滚路径）。

| 查询 | 数据量 | 改动前 | 改动后 | 口径 |
|---|---:|---|---|---|
| `SELECT id,title FROM notices WHERE status='published' ORDER BY published_at DESC LIMIT 20` | 5000 行 | **2.27 ms**（全表扫 + filesort，`type=ALL`） | **0.048 ms**（索引反向扫描，`type=ref`） | `EXPLAIN ANALYZE` |
| `SELECT id,user_id,display_name FROM alumni_profiles WHERE show_in_directory=1 AND graduation_year=2015` | 5021 行 | **1.61 ms**（全表扫） | **0.63 ms**（索引查找） | `EXPLAIN ANALYZE` |
| `SELECT id,user_id FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 20 OFFSET 1000` | 10 万行（同一用户） | **119 ms**（旧索引 + 排序） | **1.5 ms**（`FORCE INDEX (user_id,id)`） | `EXPLAIN ANALYZE` |

```bash
docker exec -i nmg-mysql mysql -uroot -p*** nmg_alumni_test < measure.sql
# measure.sql 内容：EXPLAIN ANALYZE <查询>  /  EXPLAIN ANALYZE <查询> IGNORE INDEX (<新索引>)
```

> ⚠️ 诚实说明：第三条里，优化器在**本次数据集**（所有通知都属于同一用户）上**没有自动改选**
> 新建的 `(user_id, id)` 索引，仍走旧索引 + 排序；`FORCE INDEX` 下才是 1.5 ms。
> 该索引是「`WHERE user_id=? ORDER BY id DESC`」的标准索引，收益取决于真实数据分布，
> 因此**深分页的收益标为「待验证」**，不计入「已优化」。
>
> ⚠️ 另有两个候选索引（`articles(category_id,status,published_at)`、
> `admin_action_logs(created_at)`）**实测无收益**（现有索引已能供排序），
> 因此**没有加进迁移** —— 没有实测数字的索引不写进生产库。

#### 7.2.3 管理后台产物体积

命令：`cd apps/admin-web && pnpm build`，产物用 `du -sb dist` 与 `gzip -c <file> | wc -c` 计量。

| 指标 | 改动前 | 改动后 |
|---|---:|---:|
| 主 chunk `index-*.js` | 1,379,729 B（gzip 345,916） | **23,724 B**（gzip 8,245） |
| 主 CSS `index-*.css` | 453,410 B（gzip 52,667） | **4,167 B**（gzip 1,405） |
| 新增 `tdesign-*.js` / `tdesign-*.css` | —（原先在主 chunk 里） | 1,356,203 B / 449,244 B |
| `dist` 总量 | 2,119,876 B | 2,120,718 B（+842 B） |
| **首屏实际下载量** | **2,011,181 B**（gzip 466,643） | **2,011,270 B**（gzip 466,698） |

> ⚠️ 诚实说明：把 TDesign 拆成独立 chunk **没有减少首屏下载量**
> （`main.ts` 里 `app.use(TDesign)` 是全局注册，产物仍被首屏预加载）。
> 本轮拿到的是「主 chunk 从 1.38 MB 降到 23 KB」的**结构收益**（应用代码与 UI 库可分别缓存、
> 主 chunk 不再被 UI 库拖住），**不是**流量收益。
> 真正的减负需要把全局注册改成按需引入（会改动管理后台的组件注册方式），
> 本轮**未做**，已记入 `docs/KNOWN-ISSUES.md` 待办。

#### 7.2.4 小程序首屏请求数

| 页面 | 改动前 | 改动后 |
|---|---:|---:|
| 「我的」首页 | 9 | **5** |
| 通知中心 | 4 | **2** |
| 隐私设置 | 2 | **1** |
| 个人资料 | 2 | **1** |
| 我的连接 | 2 | **1** |
| 认证进度 | 4 | **2** |
| 认证历史 | 2 | **1** |
| 收到的申请 | 2 | **1** |
| 发出的申请 | 2 | **1** |
| **合计** | **29** | **15**（-48%） |

原因：这些页面在 `onLoad` 与 `onShow` 里**都**调了同一个 loader，
而微信的生命周期是 `onLoad → onShow → onReady`，首屏因此把每个请求打了两遍。
现在用 `apps/miniprogram/src/utils/first-show.ts`（按页面实例记录的 WeakMap 守卫）
让**首次进入只加载一次**，返回页面时仍然刷新。

#### 7.2.5 管理后台首屏统计

`GET /api/v1/admin/stats`：此前 **12 条独立 COUNT**（其中 `users.count()` 还重复算了两次），
现在同表多口径合并为条件聚合（`SUM(CASE WHEN ...)`），**12 → 8 条**，返回结构与口径不变。

### 7.3 本轮未做完、已记入待办的项

见 `docs/KNOWN-ISSUES.md` 的「待办 / 需人工动作」小节：
生产密钥轮转与密钥管理服务接入、正式 AppID/AppSecret 与 `AUTH_MODE=wechat` 切换、
正式域名与 HTTPS 证书、微信订阅消息模板、WAF 与备份定时任务、
管理后台 UI 库按需引入（首屏减负）、两个无上限列表端点（需同步契约）。

---

## 8. 第二轮（opt-002）：复核上一轮（opt-001）的产出 + 清掉剩余安全与性能缺口

> 执行日期：2026-11-20；环境：本机 Docker（MySQL 8.4 / Redis 7 / MinIO，端口 13307 / 16380 / 19002），
> Node 22.21.1、pnpm 11.7.0；数据集：`pnpm --filter @nmg/api db:migrate && db:seed` 造出的固定数据
> （1000 校友 / 200 通讯录可见 / 连接 / 资源 / 活动 / 资讯 / 公告）。
> 本机与上一轮的服务器环境不同，**延迟绝对值不可与历史数字直接比较**，
> 可比的是「同一数据集、同一命令」的改动前后对比。

### 8.1 复核：上一轮新增的防线，断言是否真的会在防线被拆掉时失败

逐个核对了上一轮新增的 9 个集成测试套件（config-validation / security-hardening /
privacy-hardening / rate-limit / auth-mode / admin-account-management / admin-audit-atomicity /
http-status-semantics / query-efficiency）：这些用例的断言都指向**具体的状态码或响应头**，
删掉对应防护代码后会失败（例如删掉 `applyHttpHardening` 的 CORS 中间件，
`security-hardening` 的「白名单外 Origin 拿不到任何 CORS 头」立刻红）。
**没有发现「删掉防护代码测试仍绿」的用例。**

但复核发现**上一轮的防线对仓库自己的文件无效**，以及**上一轮引入了两处新问题**，本轮一并修掉
（逐条记录见 `docs/KNOWN-ISSUES.md` #173~#180）：

| # | 复核发现 | 本轮处置 | 负向验证 |
|---|---|---|---|
| #173 | 占位值黑名单只认 `-`，仓库模板用的是 `CHANGE_ME_xxx` → **用默认 compose 参数起生产环境，JWT 密钥是公开常量** | 归一化分隔符；补常见弱默认口令 | `config-validation` 新增 1 例 + 「模板/compose 对账」1 例 |
| #174 | 上一轮把生产 `AUTH_MODE=mock` 改成拒绝启动，而**仓库自己的生产模板仍是 mock** → 按文档部署会起不来 | 模板与 compose 默认改为 `both`（与现网一致）；生产用 mock 依然被拒 | 「模板不得设 mock」「compose 默认不得是 mock」2 例 |
| #175 | 管理员默认口令 `Admin@2026` 是**公开常量**（Seed 硬编码 + 建号时 `?? 'Admin@2026'`），且 Seed 每次重置它 | Seed 改走环境变量、生产要求强口令且不重置；建号初始口令**必填** | `admin-account-management` 新增 2 例 |
| #176 | CORS 白名单接受子域通配，与文档「不接受通配符」不一致 | 只做精确匹配；启动期也判非法 | `security-hardening` 改为「通配不被接受」 |
| #177 | 解除连接后，详情接口仍返回对方学院/地区/行业 | 非 active 一律 404 | `connections` 新增 1 例 |
| #178 | nginx `location /assets/` 里的 `add_header` 让该块**丢掉全部安全响应头** | 该块补齐同一份清单 | 配置对账（端到端抓包待部署后核对） |
| #179 | 限流守卫排在 JWT 守卫之后 → **伪造令牌的请求完全不受限流保护** | 计数逻辑抽成服务，认证失败也计额（按 IP）；顺带修正类别判定顺序（登录档此前被写成死代码） | `rate-limit` 新增 1 例 |

### 8.2 安全改动的负向验证（攻击面确实被挡住）

| 场景 | 期望 | 实测 | 用例 |
|---|---|---|---|
| 生产环境用仓库默认的 `CHANGE_ME_jwt_secret_min_32_chars` | 拒绝启动 | `fatal=true`，问题项 `JWT_SECRET` | `config-validation` |
| 生产环境未设置 `ADMIN_BOOTSTRAP_PASSWORD` | Seed 拒绝建号 | `fatal=true` | `config-validation` |
| 管理端建号不传初始口令 | 400，且账号**没被建出来** | 400 `VALIDATION_ERROR`，`admin_users` 里 0 行 | `admin-account-management` |
| 用仓库里的公开默认口令登录新建的管理员 | 401 | 401；用正确口令登录 200 | `admin-account-management` |
| 白名单外的 Origin | 拿不到任何 CORS 头；预检 403 | 无 `access-control-allow-origin`；预检 403 | `security-hardening` |
| 通配 origin（`https://*.example.com`） | 一条都匹配不上 | `isOriginAllowed` 全部 false | `security-hardening` |
| 带伪造令牌的请求连打 6 次 | 前 5 次 401，第 6 次 429 | 429 `RATE_LIMITED` | `rate-limit` |
| 解除连接后取连接详情 | 404 | 404 `NOT_FOUND`，列表里也没有 | `connections` |
| 生产环境 `AUTH_MODE=mock` | 拒绝启动 | `fatal=true` | `config-validation` |

### 8.3 性能：同一数据集、同一命令的前后实测

#### 8.3.1 接口级基线（`pnpm --filter @nmg/api perf:baseline`）

命令：`source .env.test && pnpm --filter @nmg/api db:migrate && pnpm --filter @nmg/api db:seed &&
pnpm --filter @nmg/api perf:baseline`
（该脚本在本轮新增：`apps/api/test/perf/api-performance.ts`，统计每个请求打了几条 SQL 与 p50/p95 延迟。）

| 接口 | SQL 条数（前 → 后） | p50(ms)（前 → 后） |
|---|---:|---:|
| `GET /me/contacts`（我的联系方式） | **5 → 2** | 4.7 → 2.9 |
| `GET /admin/stats`（管理端数据总览） | **15 → 14** | 5.3 → 4.8 |
| 其余 18 个列表接口 | 不变（1~8 条） | 不变（±0.5ms，属机器负载抖动） |

- `/me/contacts`：此前为了返回 3 个联系方式字段，把 user / profile / region / industry / contact
  全查了一遍（关系懒加载各多一条）；现在只查联系方式那一张表。
- `/admin/stats`：此前 `this.users.count()` 出现了**两次**（`alumniTotal` 与 `userTotal`），
  两条 SQL 完全一样；现在复用同一个值，并发查询 13 → 12（+ 鉴权 1 条 = 14）。

#### 8.3.2 索引：逐条实测（10 万行审计日志 / 2 万篇资讯 / 2 万条报名 / 2 万对连接）

测量方式：同一张表上分别用「带新索引」与 `IGNORE INDEX (新索引)`（等价于迁移前的可用索引集合）
各跑 9 次取中位数，同时打印 `EXPLAIN` 的 key / rows。

| 查询 | 改动前 | 改动后 | 执行计划变化 |
|---|---|---|---|
| 资讯按分类筛选的 COUNT（`status='published' AND category_id=?`） | **23.99 ms**（扫 10005 行） | **2.50 ms**（扫 2002 行） | `idx_articles_published` → `idx_articles_category`，**9.6×** |
| 资讯按分类筛选的 SELECT（`ORDER BY published_at DESC LIMIT 20`） | 0.44 ms | 0.70 ms | 同样换成新索引（扫的行数从 10005 降到 2002，但这一条本来就只要 20 行，收益被常数项吃掉） |
| 我的活动报名 SELECT（`WHERE user_id=? ORDER BY id DESC LIMIT 20`） | **5.45 ms** | **0.23 ms** | 主键倒序扫 + 逐行过滤 → `ref` 直接定位，**23×** |
| 我的活动报名 COUNT | **2.07 ms** | **0.14 ms** | `uk_event_registration` 全扫 → `ref` 直接定位，**14×** |

**没有实测收益、因此没有写进迁移的两个候选索引**（沿用上一轮定下的规矩「没有实测数字的索引不写进生产库」）：

| 候选 | 实测 | 结论 |
|---|---|---|
| `admin_action_logs(created_at)` | 宽区间（30 天）COUNT 20.94 ms → 21.47 ms（优化器仍选 `idx_admin_action_logs_admin` 的 skip scan）；窄区间（1 天）COUNT 0.94 ms → 0.80 ms | 收益微弱，**不加**；迁移 5000 的注释已改成不再声称自己建了它 |
| `connection_pairs(user_b_id, id)` | SELECT 0.266 ms → 0.313 ms；COUNT 4.676 ms → 4.747 ms（OR 两侧仍走主键倒序扫 / 全表扫） | 优化器**没有改选**，**不加** |

本轮落地的新索引只有两个，走 TypeORM 迁移 `1730000006000-AddRemainingQueryIndexes`
（幂等：先查 `information_schema.statistics`，存在就跳过）：

- `articles(category_id, published_at)` —— `idx_articles_category`
- `event_registrations(user_id, id)` —— `idx_event_registration_user`

实体侧同步加了 `@Index`，避免「库里有、代码里没有」的反向漂移。

#### 8.3.3 事务与连接池

- **bcrypt 移出事务**：创建 / 修改管理员时，`bcrypt`（cost 10，单次 60~120ms 纯 CPU）
  此前在 `dataSource.transaction()` 回调里执行 —— 事务期间**白占一条数据库连接**。
  现在哈希在事务外算好再传进去，一致性语义不变（哈希失败仍在任何写入之前）。
- **角色批量插入**：管理员角色同步此前是逐条 `await links.save(...)`（每角色一条 INSERT），
  现在一次批量插入。
- **连接池不再是魔数**：`connectionLimit: 20` 此前硬编码在 `app.module.ts`，
  现在由环境变量 `DB_POOL_SIZE` 控制（默认 20 不变），
  并在 `docs/CONCURRENCY-DESIGN.md` 补了「连接池与实例数」的口径。

### 8.4 CI

- 小程序的三个 spec（`first-show` / `format` / `view`，共 44 例）此前**没有 runner** ——
  `apps/miniprogram/package.json` 里没有 `test` 脚本。现在补上
  （复用 api 包里已装好的 jest，**不引入新依赖**，锁文件不变），
  并在 `.github/workflows/ci.yml` 里新增「Miniprogram unit tests」一步。
- 本地实跑：`pnpm --filter @nmg/miniprogram test` → 3 套件 / 44 例全绿；
  `pnpm typecheck` / `pnpm lint` 退出码 0；
  `pnpm --filter @nmg/api test:integration` → **46 套件 / 359 例全绿**。

### 8.5 本轮未做完、已记入待办的项

见 `docs/KNOWN-ISSUES.md` 的「待验证 / 未完成」小节（表格已更新）：
三个无上限列表端点与列表返回正文（**契约变更轮**）、RBAC 与字典的缓存层、
`view_count` 的异步计数、`/admin/stats` 的 `connectionTotal` 口径、
连接列表是否也应受对方字段可见开关约束（**需要产品口径**）、
以及全部需要人工动作的项（正式密钥、AppID/AppSecret、域名与证书、订阅消息模板、WAF 与备份定时任务）。
