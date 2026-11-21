## 发布顺序核对清单（第三轮契约变更）

> 适用范围：第三轮**允许变更对外响应结构**的那一轮（端点清单见 `docs/API-SPEC.md`
> 的「第三轮的契约变更」表）。本文件只讲**发布顺序**，不重复讲「改了什么」。
> 关联条目：`docs/KNOWN-ISSUES.md` 的「第三轮新增端点 / 契约变更的**部署顺序**」。

### 1. 规则

**服务端与两端客户端（admin-web + 微信小程序）必须在同一个发布窗口上线。**

理由不是「稳妥起见」，而是两个方向都**确定性地**坏掉：

| 方向 | 具体破坏形态 |
|---|---|
| 服务端先发，旧客户端在跑 | 旧客户端把响应当**裸数组**用（`roles.value = roleList`、`roster.value = await fetchEventRegistrations(id)`、`applications[0]`）。新服务端返回的是 `{items, meta}` 对象 -> 数组方法 `.map` / `.length` 全部失效 -> 管理端三个目录页（角色权限 / 系统设置 / 活动报名抽屉）抛 `TypeError` -> **整页空白**（`docs/TEST-REPORT.md` 第 9.7 节的 Before 截图就是这份证据）；小程序侧则是**静默降级**（`/alumni/verification/mine` 读到 `undefined` 长度 -> 认证状态恒为「未提交」；公开列表的 `body` 被截成 200 字）-> **不报错，更难发现** |
| 客户端先发，旧服务端在跑 | 新客户端按 `{items, meta}` 读旧服务端返回的**裸数组**，`.items` -> `undefined` -> **空列表**（未做 `Array.isArray` 兜底的页面）或退化成 `pending`（`/alumni/verification/mine` 做了兜底 -> `[]`）；管理端 `readPageResult` 则直接抛「响应缺少 items 数组」。旧服务端返回**全文** `body` 时新客户端照单全收 -> 功能不坏，但「公开列表只给 200 字摘要」的性能收益拿不到，单次响应仍是数十 MB |

结论：两端任一不同时更新，**对外可见的功能就是残缺的**。发布窗口 = 服务端部署
+ admin-web 构建产物发布 + 小程序版本提交，**同一窗口**完成。

### 2. 逐端点对照

| 端点 | 改动 | 服务端先发（旧客户端在跑） | 客户端先发（旧服务端在跑） | 必须同窗口 |
|---|---|---|---|---|
| `GET /admin/events/:id/registrations` | 裸数组（无上限）-> `{items, meta}`，入参 `page` / `pageSize` | 旧管理端把**整个响应**塞进表格（`roster.value = await fetchEventRegistrations(id)`），新服务端给的是 `{items, meta}` 对象 -> 表格拿到的不是数组 -> 报名名单**空白** | 旧服务端返回裸数组 -> 新管理端 `readPageResult` 抛「响应缺少 items 数组」-> 抽屉报错 | **是** |
| `GET /alumni/verification/mine` | 裸数组（无上限）-> `{items, meta}` | 旧小程序按**裸数组**读（`applications[0]`），新服务端给的是 `{items, meta}` -> `applications.length` 为 `undefined` -> 认证状态**恒为 `pending`（「未提交」）** | 旧服务端返回裸数组 -> 新小程序读 `page.items` -> `undefined` -> 同样退化成 `pending` | **是** |
| `GET /admin/roles`、`GET /admin/permissions`、`GET /admin/settings` | 裸数组（全表）-> `{items, meta}` | 旧管理端把响应直接当数组（`roles.value = roleList`），新服务端给的是 `{items, meta}` 对象 -> 模板里 `.map` 一个对象 -> `TypeError: ... .map is not a function` -> **角色权限页 / 系统设置页整页空白** | 旧服务端返回裸数组 -> 新管理端 `readPageResult` 抛「响应缺少 items 数组」-> 整页报错 | **是** |
| `GET /articles`、`GET /notices`、`GET /resources`（**仅公开列表**） | `body` 由整篇正文（MEDIUMTEXT）-> **前 200 字摘要**（末尾带 `…`）；管理端列表**不变**（仍全文） | 旧小程序的资源卡片直接渲染 `post.body` -> 描述被**截成 200 字**；资讯/公告卡片渲染的是 `summary` 字段，**不受影响**；详情页走详情接口，**正文不受影响** -> 可见但不致命 | 旧服务端返回全文 -> 新客户端照常显示全文 -> **不坏**，只是性能收益没拿到 | 建议是（非致命） |
| `GET /me/summary`（**新增**） | 一次返回 `eventCount` / `requestCount` / `postCount` / `unreadCount` | 旧小程序**根本不调**这个端点 -> 无影响（旧版仍用 4 个列表请求凑数字，首屏 5 个请求） | 旧服务端**没有这个路由** -> 404 -> `settle()` 兜住 -> `toSummaryView(null)` -> 「我的」页四个计数**静默显示 0** | **是** |
| `viewCount` 口径（详情接口） | 即时一致 -> **最终一致**：返回值 = 库里的基线值 + 尚未落库的增量 | 旧客户端读到的数字当场仍然正确（只是库里的行可能滞后一个刷回周期 60 秒） | 旧服务端仍是即时一致，数字照样正确 | **否**（口径变化，两个方向都不破坏客户端） |
| `AdminRoleDto` / `AdminPermissionDto` 条目类型 | 契约从「代码联合类型」写清楚为**目录整行**（含 id / 名称 / 描述 / 创建时间） | 服务端本来就返回整行，旧的窄契约没写准 -> 旧客户端把整行当代码字符串用，角色名渲染成 `[object Object]` | 旧服务端返回的也是整行 -> 新客户端按 `AdminRoleDto` 读 -> 正常 | 随上面 `/admin/roles` 一起同步（本身不单独构成破坏） |

### 3. 小程序不能热更新（窗口的现实约束）

- **admin-web 是网页**：刷新即拿到新构建产物 -> 可以和服务端**原子切换**（服务端切换后立刻刷新管理端）。
- **微信小程序不是**：已安装的旧版本会**继续调用服务端**，直到用户更新到新版本；而新版本还要先过
  微信审核（提审约 1~3 天，见 `docs/SELF-CHECK-AND-SCHEDULE.md` 第 4.3 节），发布后也是**灰度推进**。
  小程序**没有**「热更新」这回事 —— 服务端一换，线上所有还在跑旧包的客户端**同时**打到新服务端。
- **实践后果**：服务端一旦改了这几个端点的形状
  （`/alumni/verification/mine`、`/me/summary`、公开列表的 `body`），
  **旧版小程序会在审核窗口 + 灰度窗口内持续访问新服务端**。因此只有两条路：
  1. **服务端在整个窗口内继续兼容旧客户端**（响应形状保持不变，等小程序全量升级后再切）
     —— 即「旧服务端必须一直能用」，而不是「旧客户端必须一直能用」；
  2. **把小程序版本提升与服务端部署排成一次协调发布**：先让**新小程序版本兼容新旧两种响应**
     （发布后等它铺开），再切服务端。
- **本轮的现实答案**：第 2 条做不到「原子」，因为微信审核 + 灰度是**外部节奏**。
  所以本轮**必须**接受一个「旧服务端保持兼容 -> 小程序新版过审发布 -> 再切服务端」的**两段式**，
  或者让服务端在切换后**同时容忍新旧两种形状**（响应里既给 `items` 又能被当数组用的字段）。
- 兜底程度不同：**管理端是崩**（`TypeError` / `readPageResult` 抛错 -> 整页空白），
  **小程序是静默降级**（列表空、四个计数为 0、认证状态错）——
  后者没有报错堆栈，**只能靠人工点页面 + 本文件的验证清单**发现。
- ⚠️ **一个必须提前知道的例外**：`GET /alumni/verification/mine` **两个方向都坏**——
  旧小程序读 `applications.length`（新服务端给的是对象 -> `undefined` -> 状态恒为 `pending`），
  新小程序读 `page.items`（旧服务端给的是裸数组 -> `undefined` -> 同样恒为 `pending`）。
  所以这个端点的**唯一正确顺序是「服务端先、客户端后」**，且切换后到小程序新版铺开之前，
  「我的」页的认证状态会**一直显示「未提交」**。这一条要在发布窗口里**人工告知**。

### 4. 发布前核对清单

- [ ] `packages/contracts/src/api.ts` 已含本轮全部改动（`PageResult` 形状、`AdminRoleDto` /
      `AdminPermissionDto` / `SystemSettingDto`、`GET /me/summary`），且 `docs/API-SPEC.md`
      的「第三轮的契约变更」表与之**一致**（`packages/contracts` 是唯一事实来源）。
- [ ] 两端客户端已同步到同一份契约：admin-web 直接引用契约包；小程序的路径镜像表
      （`apps/miniprogram/src/services/paths.ts`）与契约一致（`check-contract-mirror.mjs` 守这一条）。
- [ ] `GET /me/summary` 已在服务端存在并返回四个计数；小程序「我的」页已改为调它。
- [ ] `GET /articles` / `GET /notices` / `GET /resources` 的**公开**列表 `body` 只返回
      **<= 200 字**摘要；`/admin/articles` / `/admin/notices` / `/admin/resources`
      仍返回**全文**（截断会让管理员保存时**静默截断正文**，那是数据损坏）。
- [ ] `GET /admin/roles` / `/admin/permissions` / `/admin/settings` 返回 `{items, meta}`，
      条目是 `AdminRoleDto` / `AdminPermissionDto` / `SystemSettingDto`（目录整行，不是裸代码字符串）。
- [ ] 三份契约检查脚本对着**跑起来的 API** 全部退出码 0：
      `infra/scripts/check-contract-routes.mjs`、`infra/scripts/check-client-paths.mjs`、
      `infra/scripts/check-response-shape.mjs`。
- [ ] 管理后台真实浏览器冒烟通过：`infra/scripts/admin-ui-smoke.mjs`
      （13 个路由 0 console error / 0 未捕获异常 / 0 个 >=400 的请求；含本轮四项专项检查：
      报名抽屉分页、角色目录条目、系统设置分页、**管理端列表正文完整性**）。
- [ ] 两条 TypeORM 迁移已在**业务库**应用：
      `AddQueryIndexesAndProtectAuditLogs1730000005000`、
      `AddRemainingQueryIndexes1730000006000`
      （`infra/scripts/check-pending-migrations.sh` 的 R2 检查会报出未应用的迁移）。
- [ ] 小程序新版本已提审通过（或已明确：服务端切换**晚于**小程序发布），发布窗口已排期。

### 5. 发布后怎么验证

```bash
# 0) 迁移一致性对账（业务库；在服务器上执行）——确认两条迁移已应用
bash infra/scripts/check-pending-migrations.sh --db nmg_alumni

# 1) 契约 <-> 服务端路由（双向：契约缺实现 / 实现缺契约）
node infra/scripts/check-contract-routes.mjs --root . \
  --swagger http://127.0.0.1:18081/docs-json

# 2) 两端客户端 <-> 服务端路径（真实调用点 + Swagger；含方法是否注册）
node infra/scripts/check-client-paths.mjs --root . \
  --swagger http://127.0.0.1:18081/docs-json

# 3) 运行时响应结构（客户端声明的泛型返回类型 vs 服务端真实响应）
#    --user-token 用**已存在**账号换取的令牌（不新建用户、不污染业务库）：
#    先 curl /auth/mock/login 取 data.accessToken，再作为 --user-token 传入
node infra/scripts/check-response-shape.mjs --root . \
  --base http://127.0.0.1:18081/api/v1 --user-token "$USER_TOKEN"

# 4) 新增端点与公开列表摘要的定点核对
curl -sS -H "Authorization: Bearer $USER_TOKEN" \
  http://127.0.0.1:18081/api/v1/me/summary
curl -sS 'http://127.0.0.1:18081/api/v1/resources?page=1&pageSize=5'   # body 长度 <= 200

# 5) 管理后台真实浏览器冒烟（需本地 playwright + chromium）
PLAYWRIGHT_MODULE_DIR=/tmp/pw/node_modules node infra/scripts/admin-ui-smoke.mjs \
  http://127.0.0.1:18090 /tmp/pw/shots
```

> 管理端登录凭据由**环境变量** `ADMIN_USER` / `ADMIN_PASS` 传入
> （默认值 `admin` / `Admin@2026`）；**不要**把凭据写进仓库。
>
> ⚠️ 三个脚本的「服务地址」参数**各不相同**，别写错：
> `check-contract-routes.mjs` / `check-client-paths.mjs` 收的是 **Swagger 文档地址**
> （`--swagger http://127.0.0.1:18081/docs-json`，根路径，不带 `/api/v1`）；
> `check-response-shape.mjs` 收的是 **API 根地址**（`--base http://127.0.0.1:18081/api/v1`）。
> `admin-ui-smoke.mjs` 不收 flag，**管理后台入口地址是位置参数**（第一个位置参数），
> 截图输出目录是**第二个**位置参数。

### 6. 回滚

服务端回滚 = 响应形状回到**裸数组** + `body` 回到**全文** + `GET /me/summary` 消失。
于是：

- **admin-web 必须一起回滚**：已发布的新管理端按 `{items, meta}` 读旧服务端返回的裸数组 ->
  `readPageResult` 抛「响应缺少 items 数组」-> 角色权限页 / 系统设置页 / 报名抽屉**报错**
  （`readPageResult` 的设计就是把白屏变成一条能定位端点的报错）。admin-web 是网页产物，
  换回旧构建产物即可，**代价可控**。
- **小程序版本要么一起回滚、要么接受降级**：小程序不能热更新，回退版本要**再走一次微信审核**
  （1~3 天），窗口内不可能立即回退。回滚后的实际表现是**静默降级**而非崩溃：
  `/me/summary` -> 404 -> `settle()` 兜住 -> 「我的」页四个计数变 **0**；
  `/alumni/verification/mine` 返回裸数组 -> 新小程序读 `page.items` 得 `undefined` ->
  认证状态恒为 `pending`（「未提交」）。这两条要在回滚窗口里**人工告知**。
- **数据库不需要回滚**：本轮两条迁移是**加法式**的（补索引 + 审计外键改 `RESTRICT`），
  旧代码对新结构完全兼容；`migration:revert` 会**删掉索引**，反而让回滚后的服务失去索引。
- **回滚的代价**：`viewCount` 回到即时一致（每次浏览写一行，热点行锁回来）；
  公开列表响应体回到数十 MB。
- **回滚动作**：`bash infra/scripts/deploy.sh --rollback`（或服务器上
  `bash infra/scripts/rollback.sh --wait --timeout 300`）—— 回滚只换镜像标签，
  **不删数据卷**；admin-web 随后单独回退，小程序按上面的「静默降级」处理。
- **回滚后仍需跑**：第 5 节的 1 / 2 / 3 / 5 四条命令（响应结构回到旧形状，
  `check-response-shape.mjs` 应当仍为 0 —— 它守的是「当前部署的代码与当前客户端声明一致」，
  所以**回滚 admin-web 产物之后**这一条才是对的）。

