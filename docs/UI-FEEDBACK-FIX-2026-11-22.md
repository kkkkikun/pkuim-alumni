# 真机体验反馈整改报告（缺陷 #161）

- **日期**：2026-11-22
- **来源**：客户 / 老板在真机上体验 v0.8.0 后投来的 **12 张截图**（`debug/user-feedback/`，文件名是中文问题描述）
- **当时状态**：24 步回归链 EXIT=0、42 个集成套件全绿、小程序单测全绿、类型检查通过 —— **但客户一眼看出了 4 类问题**
- **结论**：这 4 类问题**都不违反任何契约**。接口 200、类型检查过、样式校验过、单测全绿，只有人拿在手里才看得出来 → 已补为**第 23 层校验**（`infra/scripts/check-miniprogram-ui-feedback.mjs`）

---

## 一、12 张截图 → 5 个问题 → **1 个主根因 + 3 个独立缺陷**

| # | 截图文件名 | 客户看到的现象 | 判定 | 根因 |
|---|---|---|---|---|
| 1 | 输入框有显示bug | 输入框里的文字下半截被裁掉 | P0-A | 独立缺陷（小程序 input 高度） |
| 8 | 输入框文字显示bug | 同上 | P0-A | 同上 |
| 11 | 输入框显示bug | 同上 | P0-A | 同上 |
| 2 | 认证资料页的底部文字被挡住了 | 最后一段说明被底部按钮压住 | P0-B | 独立缺陷（固定底栏） |
| 9 | 底部文字无法完全显示出来 | 同上 | P0-B | 同上 |
| 12 | 底部无法完全显示bug | 「邮箱」输入框被「保存资料」压住 | P0-B | 同上 |
| 4 | 有选择毕业年份但是没有起作用 | 选了「数字科技」，列表还是全部 12 人、计数还是「共 12 位校友」 | P0-C | **主根因**（返回不重载） |
| 6 | 信息类型的筛选有bug | 选了「我能提供」，列表与计数完全不变 | P0-C | 同上 |
| 7 | 整体的筛选有bug-帅选过一次再去掉也没有信息了 | 去掉筛选后页面卡在空列表出不来 | P0-C | 同上 |
| 5 | 搜索功能有bug | 搜「张」→ 「没有找到符合条件的校友」（名单里明明有张同学） | P0-C | 同上（被残留的年份条件筛掉） |
| 10 | 提交发布按键位置应当垂直居中 | 与「底部文字无法完全显示出来」是**同一张图**（md5 相同） | P1-D | 底栏遮挡的连带观感 |
| 3 | 校友认证页可以去掉认证历史 | 认证页底部「认证历史」按钮多余 | P2-E | 客户明确要求 |

### 主根因（P0-C）：筛选条件变了，列表没有跟着重载

筛选页（`pages/directory/filter`、`pages/connect/filter`）是 `navigateTo` 打开的**独立页面**：
用户点「确定」→ 写全局 store → `navigateBack` 回列表页。

而列表页的 `onShow` **只同步了筛选标签文案，没有重新拉数据**。于是：

1. 选完「数字科技」→ 标签变红、列表没变、计数还是 12 → 客户判定「筛选坏了」；
2. 选完「我能提供」→ 同上；
3. 接着搜「张」→ 这时 store 里**还留着之前选的年份条件**（年份在列表页根本没有入口，客户看不见），
   于是「张同学（2015 届）」被年份条件筛掉 → 报「没有找到符合条件的校友」；
4. 想去掉年份条件 → 回到列表页**不重载** → 页面卡在空列表 → 客户判定「去掉也没有信息了」。

**一个根因，解释了这 4 张截图的全部现象。**

> 顺带查过演示路由本身：实测 `/directory?keyword=张` 正确返回 1 条、`/resources` 正确返回 27 条
> —— 筛选逻辑一直是对的，**问题 100% 在页面层**。

### 独立缺陷

- **P0-A 输入框文字被垂直裁切**：小程序 `<input>` 的内部原生输入框高度只有 `1.4em`，**纵向 padding 撑不开它**；
  再叠加 `page { line-height: 1.6 }` 继承下来后行盒（1.6em）比输入框（1.4em）高 → 文字下半截被裁。
  （对照证据：同一批截图里，**没有纵向 padding** 的搜索框文字显示完整；`textarea` 因为写了显式 `height` 也正常。）
- **P0-B 固定底栏压住正文**：`.fixed-bar` 是 `position: fixed; bottom: 0`，而 `.detail-page` 的下内边距只有 `60rpx`。
- **P1-D 提交发布按钮**：与 P0-B 是同一张截图。**实测按钮内文字其实是居中的**（上间距 22px / 下间距 20px，误差 1px）；
  客户的观感来自底栏贴底 + 遮住正文，P0-B 修好后即恢复。

---

## 二、改了什么

| 文件 | 改动 |
|---|---|
| `apps/miniprogram/src/app.wxss` | `.form-input` 去掉纵向 padding，改用显式 `height: 88rpx` + `line-height: 88rpx`；新增 `.page-with-fixed-bar`（底部留白 `260rpx + env(safe-area-inset-bottom)`） |
| `apps/miniprogram/src/styles/blocks.wxss` | 新增 `.empty-action`（空状态插槽里的按钮样式；组件样式隔离，组件自己的 `.state-btn` 作用不到插槽内容上） |
| 17 个使用 `.fixed-bar` 的页面 | 根节点加 `page-with-fixed-bar`（认证表单 / 编辑资料 / 发布资源 / 发布需求 / 两个筛选页 / 各类详情页 / 认证引导页 …） |
| `apps/miniprogram/src/utils/filter.ts`（新增） | 筛选条件**签名**（纯函数、可单测）：`directoryFilterSignature` / `connectFilterSignature` / `isDirectoryFilterActive` / `isConnectFilterActive` / `buildGraduationYearOptions` |
| `apps/miniprogram/src/pages/directory/index/index.ts` | 记住上次请求用的筛选签名；`onShow` 比对，**变了就重新加载**；新增年份标签与「清空筛选条件」 |
| `apps/miniprogram/src/pages/connect/index/index.ts` | 同上；新增「按类型查看」chip 行（全部 / 我有需求 / 我能提供，点完立即生效） |
| `apps/miniprogram/src/pages/directory/index/index.wxml` | 加「全部年份 ▾」入口（年份不再隐形）；空状态区分「有筛选条件 / 无筛选条件」，并给出清空出口 |
| `apps/miniprogram/src/pages/connect/index/index.wxml` | 同上（类型 chip + 空状态出口） |
| `apps/miniprogram/src/pages/directory/filter/index.ts` | 毕业年份选项由**最近 6 年**放宽到**最近 21 年**（真实校友跨越几十年，只给 6 年必然选到 0 条） |
| `apps/miniprogram/src/store/index.ts` | 新增 `resetConnectFilter` |
| `apps/miniprogram/src/pages/me/verify-intro/index.{wxml,ts}` | 去掉「认证历史」按钮（该入口在「认证进度」页仍有，客户原话是「可以去掉」） |
| `infra/demo-content/demo-content.json` | 补 5 条资源（呼和浩特 3 条 / 乌兰察布 1 条 / 锡林郭勒 1 条）→ **13 个地区全覆盖**（此前有 3 个地区一条资源都没有，客户选「呼和浩特市」必然 0 条） |
| `apps/miniprogram/src/demo/dataset.data.ts` | 重新导出（资源 27 → 32 条） |
| `apps/miniprogram/test/filter.spec.ts`（新增） | 对照用例 **19 例**：签名变化 / 「无筛选」判定 / 年份选项区间 / 演示路由筛选行为 / 地区覆盖不变量 |
| `infra/scripts/check-miniprogram-ui-feedback.mjs`（新增） | **第 23 层校验**：R1 底栏留白、R2 输入框高度与纵向 padding、R3 筛选变化必须重载、R4 空列表必须给出路、R5 筛选条件必须可见、R6 演示资源地区全覆盖 |
| `infra/scripts/check-miniprogram-ui-feedback-inject.mjs`（新增） | 反向验证注入器（8 类缺陷 + 1 类合法改动） |
| `infra/scripts/check-miniprogram-ui-feedback-selftest.sh`（新增） | 反向验证 **19/19 通过**（含防误报与元自检） |
| `infra/scripts/test-integration.sh` | 回归链接入第 23 层 |
| `infra/scripts/miniprogram-ci-upload.sh` | 上传闸门接入第 23 层（不通过即中止上传） |

---

## 三、验证

| 项目 | 结果 |
|---|---|
| 小程序单测 | **61 例全绿**（原 42 例 → 新增 19 例） |
| `tsc --noEmit`（小程序） | 通过 |
| 第 19/20/21/22/23 层校验 | 全部通过 |
| 第 23 层反向验证 | **19/19 通过**（8 类注入缺陷全部被抓出且退出码非 0；合法改动不误判；恒过的假校验器被判失败） |
| **24 步回归链** | **EXIT=0**（2026-11-22 08:19 收尾） |
| └ 集成测试 | **57 套件 / 563 用例全绿**（对齐后才是仓库当前代码的规模） |
| └ 隔离性自检 | **57 绿 / 0 红**（每个套件单独跑都绿） |
| └ 小程序单测 | 5 套件 / 61 例全绿 |
| └ 数据完整性 | 32 项全部 0 违规 |
| └ 备份恢复演练 | 通过 |
| └ 迁移一致性对账 | 7/7 已应用 |
| └ 业务库 | `users` = **1202**（未受影响）；测试库残留事务 0 |

---

## 四、待验证（**不得声称已通过**）

1. **真机复验**：以上都是「按截图定位 → 按根因改 → 机器可验证的部分已验证」。
   渲染层面的最终效果（输入框文字是否真的完整、底栏是否真的不再压住正文）**必须客户在真机上再看一次**。
   已上传 v0.9.0 体验版，扫码即可复验。
2. **第 23 层是「代理判据」**：它挡的是「根因复发」（没有留白、没有重载、条件不可见），
   **挡不住**「新的视觉问题」—— 那类问题仍然只能靠真机看。
3. 演示数据里资源 32 条全部带「【虚构】」前缀，正式发布前仍须替换为校友会确认的真实内容。

---

## 五、这一轮暴露出来的**更大问题**（不修就等于白测）

跑回归链时最后一步「客户端 ↔ 服务端路径一致性校验」报错：

```
[ERROR] MIRROR_EXTRA_KEY 小程序镜像包含契约中不存在的路径键：meSummary
[ERROR] ROUTE_NOT_FOUND 小程序 调用 GET /me/summary，服务端未注册该路径
```

查下来是：**校园机（后端真源）上的 API 代码比仓库旧了整整一轮** ——
`apps/api/src` 缺 19 个文件（`me-summary.service.ts`、`ttl-cache.service.ts`、
`invalidation-bus.service.ts`、两条新迁移、`admin-ops.controller.ts` …），
`apps/api/test` 缺 15 个套件，容器里的 swagger **没有** `/me/summary`。

也就是说：**此前几轮报告里的「24 步回归链 EXIT=0、42 个集成套件全绿」，验的是 11 月中旬的旧后端，
不是仓库里的当前代码**。这正是老板批的「没做好自查」的同一类毛病 ——
**绿灯不等于验的是你以为的那个东西**。

处置：按仓库自带的部署流水线（同步 → 构建 → 幂等迁移 → 切流量 → nginx reload → 健康检查 → 迁移对账）
把校园机对齐到仓库当前代码，再重跑整链。详见 `docs/DEPLOYMENT.md` 与 `docs/KNOWN-ISSUES.md` #204。

对齐后又暴露出 **5 个套件 / 7 个用例红** —— 逐条查完**全是环境问题，没有一条是实现问题**
（镜像里没有仓库的部署产物与文档、失效总线用例把上游 Redis 写死 127.0.0.1、
端点覆盖反向验证注入不够狠、事务逃逸校验器把缓存失效误判成写库）。
四条都已按「不改对外行为」的方式修掉，详见 `docs/KNOWN-ISSUES.md` #205。

**现在这盏绿灯是有意义的**：验的是仓库当前代码，57 套件 / 563 用例 / 隔离性 57 绿 0 红 / EXIT=0。
