# 并发与一致性设计

> 目标（top.md §6）：并发是正式系统的基础能力。所有并发风险必须在**数据库约束 + 事务 + 条件更新**三层落地，
> 应用层的“先查再写”只作为可读性优化，不作为正确性依据。

## 1. 三类重点并发问题与解法

### 1.1 双向连接（最复杂）

**场景**：A 与 B 同时互相申请；同一申请重复点击接受；两人重复建立连接；拒绝后再次申请；解除关系与授权冲突。

**解法**：

1. **规范化连接对**：`connection_pairs(user_a_id, user_b_id)`，写入前用 `normalizePair()` 保证 `user_a_id < user_b_id`，
   唯一索引 `uk_connection_pairs(user_a_id,user_b_id)` 天然阻止重复连接（A→B 与 B→A 落到同一行）。
2. **同一对只有一条 pending 申请**：`connection_request_history.pending_guard` 列在状态为 `pending` 时写入 `pair_key`
   （`min:max`），其他状态写 `NULL`；唯一索引 `uk_connection_request_pending(pending_guard)` 利用
   “MySQL 唯一索引允许多个 NULL” 的特性，保证并发下只有一条待处理申请成功落库，后到者捕获唯一键冲突后
   **返回既有申请**（幂等 200），而不是插入第二条。
3. **接受申请幂等**：`UPDATE connection_request_history SET status='accepted', decided_at=NOW(3), decided_by=:admin
   WHERE id=:id AND status='pending'`。影响行数为 0 表示已被处理，直接返回当前状态（不报错、不重复建关系）。
4. **建立关系原子化**：接受成功后 `INSERT INTO connection_pairs ... ON DUPLICATE KEY UPDATE updated_at=updated_at`，
   依赖唯一索引兜底；随后回填 `request.pair_id`。
5. **拒绝后重申请**：拒绝写入新一行 `pending_guard=pair_key` 的记录，历史保留在同表（只追加）。
6. **解除关系与授权冲突**：`contact_share_grants` 以 `(pair_id, user_id)` 唯一；关系解除时在**同一事务**内
   把该 pair 的授权全部置 `allow=0`，避免残留授权导致越权读取联系方式。

**联系方式读取三重校验**（缺一不可）：
`connection_pairs.status='active'` ∧ 双方 `alumni_profiles.allow_contact_share=1` ∧ 存在
`contact_share_grants.allow=1`。任一方撤回后，另一方立即读不到。

### 1.2 资源审核

**场景**：两个管理员同时审核；审核期间用户修改内容；重复审核；审核通过后重复发布；已发布内容被并发修改。

**解法**：

1. **乐观锁**：`resource_posts.version`。审核语句为
   `UPDATE resource_posts SET status=:target, version=version+1, published_at=..., reviewed_at=NOW(3)
   WHERE id=:id AND status='pending' AND version=:expectedVersion`。
   影响行数 0 → 返回 `CONFLICT`（内容已被他人处理或已变更），前端需重新拉取。
2. **审核快照**：审核动作写入 `resource_post_reviews(snapshot_version)`，只追加不覆盖；内容变更后旧审核记录依然可追溯。
3. **修改即重审**：作者修改已发布内容时 `status` 回到 `pending` 且 `version+1`，避免“旧内容带新内容一起公开”。
4. **重复审核幂等**：同一 `action` 重复提交时条件更新影响行数为 0，返回既有审核记录。

### 1.3 活动报名

**场景**：同一用户重复报名；多人争抢最后一个名额；取消与报名竞争；活动关闭时仍有请求进入。

**解法**：

1. **容量条件更新**（单条 SQL 完成判断与占用，避免读-改-写竞态）：
   `UPDATE events SET registered_count = registered_count + 1
    WHERE id=:id AND status='published' AND (capacity = 0 OR registered_count < capacity)`。
   影响行数 0 → 名额已满或活动不可报名 → 返回 `CONFLICT`。
2. **唯一索引**：`uk_event_registration(event_id, user_id)`。重复报名捕获唯一键冲突 → 幂等返回既有记录（`200`）。
3. **同一事务**：占用名额与写入报名行必须在同一事务内，任一步失败整体回滚（计数不会泄漏）。
4. **取消**：软取消（`status='cancelled'`）并 `registered_count = registered_count - 1`，
   同样用条件更新 `WHERE registered_count > 0`；名额立即可被他人占用。
5. **关闭活动**：`status` 改为 `closed/cancelled` 后，条件更新中的 `status='published'` 判定自然阻止新报名进入。

## 2. 通用一致性机制

| 机制 | 实现 |
|---|---|
| 幂等键 | `idempotency_records(scope, idem_key)` 唯一索引；写接口以 `Idempotency-Key` 头提交，命中且已完成则回放 `response_body`；请求指纹不一致返回 `IDEMPOTENCY_CONFLICT`。**scope = `METHOD:实际路径:u{用户ID}`** —— 路径必须是**实际路径（含资源 id）**，不是路由模板：模板会让「同一把钥匙开两个不同资源」落进同一个 scope，后一个被当成回放而**根本没被执行**（缺陷 #140） |
| 事务边界 | 写操作使用 `DataSource.transaction()`；跨表写入（申请接受→建关系→回填）必须同事务 |
| 唯一索引兜底 | 重复数据由数据库拦截，应用层捕获后转成幂等成功或 409 |
| 状态机 | 所有状态流转使用带前置状态的条件 UPDATE，杜绝非法跃迁 |
| 审计只追加 | `admin_action_logs`、`resource_post_reviews`、`verification_applications` 历史只追加，不 UPDATE/DELETE |
| Outbox | 通知等副作用先写 `outbox_events`（与业务同事务），由 Worker 消费投递，避免「业务成功但通知丢失」 |
| 多实例 | API 无状态，会话与限流状态存 Redis/MySQL，可水平扩容 |
| Redis 定位 | 只做缓存、限流、队列，**不承担业务最终一致性**；Redis 不可用时限流降级放行而非阻断业务 |

## 3. 连接池与实例数

> 复核补漏（第二轮）：此前 `connectionLimit: 20` 是 `app.module.ts` 里的**硬编码魔数**，
> 既不能按环境调，本文件也**从未写过**连接池的口径 —— 谁都说不清 20 是怎么定的。

| 位置 | 配置项 | 默认值 |
|---|---|---|
| API（每个实例） | `DB_POOL_SIZE` → `extra.connectionLimit` | 20 |
| Worker | 硬编码 | 10 |
| Worker 自检脚本 | 硬编码 | 4 |

**口径**：

```
总连接数 ≈ API 实例数 × DB_POOL_SIZE + Worker(10) + 自检(4)
约束：    总连接数 ≤ MySQL max_connections × 0.8
```

- `docs/ARCHITECTURE.md` 的起步规模是 **API 2 实例** → 2 × 20 + 10 + 4 = **54**；
  `docs/PRODUCTION-DEPLOY-SPEC.md` 里生产 `max_connections` 收窄到 200 → 余量充足。
- **调大 `DB_POOL_SIZE` 必须同时看 MySQL 的 `max_connections`**：
  每条连接都独立占用缓冲，连接数不是越大越快。
- 观察点：`/admin/stats` 一次并发 12 条 COUNT（复核后去掉了 1 条完全重复的），
  单个请求就可能占掉池子的 60%；池子被打满时表现是「请求排队等连接」而不是报错，
  排查时看 MySQL 的 `Threads_connected` 与 `Max_used_connections`。

## 4. 压测验证口径（k6）

| 脚本 | 断言（业务正确性，不能只看 HTTP 状态码） |
|---|---|
| `event-registration.js` | 报名 N 人容量为 M 的活动，`events.registered_count <= M` 且等于有效报名行数；重复报名不产生第二行 |
| `connection-request.js` | A、B 同时互申，最终同一 pair 只有 1 条 `pending`；重复接受后 `connection_pairs` 只有 1 行 |
| `resource-submit.js` | 相同 `Idempotency-Key` 重复提交只产生 1 条 `resource_posts` |
| `login.js` / `directory.js` | 错误率与 p95 达标；通讯录响应中不出现 `contact_*` 字段 |

分级 VU：20 / 50 / 100 / 200 / 500（500 档需先确认服务器其他任务负载）。
性能目标由实测确定，不预设未经验证的数字。
