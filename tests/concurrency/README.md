# 并发测试（k6）

> 对应 `docs/top.md` §6.4 / §10.5：20 / 50 / 100 / 200（极限探索 500）VU 分级测试，
> 以及三类关键业务竞争测试（连接互申请、资源重复提交、活动名额竞争）。
>
> **本目录只提供脚本与说明，不包含任何运行结果。测试结果必须由 Lead 在服务器上实际执行后写入报告。**

---

## 1. 目录内容

| 文件 | 场景 | 核心业务断言 |
| --- | --- | --- |
| `helpers.js` | 公共工具 | 基址/分档/阈值/路径覆盖/结果落盘 |
| `login.js` | 登录 | 2xx + 必须返回 `access_token` + 无 5xx |
| `directory.js` | 通讯录查询 | 不泄露联系方式 + 页内 id 不重复 + 跨页不重叠 |
| `connection-request.js` | A、B 互相同时申请 | 同一对用户 pending 申请 ≤ 1 + 重复提交幂等 + 无 5xx |
| `resource-submit.js` | 资源重复提交 | 同一幂等键只创建 1 条 + 重放返回同一 id + 未审核内容不外泄 |
| `event-registration.js` | 最后一个名额竞争 | 成功报名数 ≤ capacity + 重复报名不重复占位 + 结束时 `registered_count ≤ capacity` |

---

## 2. 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BASE_URL` | `http://127.0.0.1:18080` | nginx 入口（服务器本机访问） |
| `API_PREFIX` | `/api/v1` | API 前缀 |
| `VUS` | `20` | 虚拟用户数（分档 20/50/100/200/500） |
| `DURATION` | `60s` | 每个场景持续时间 |
| `P95_MS` | `800` | `http_req_duration` p95 阈值（毫秒） |
| `MAX_FAILED_RATE` | `0.01` | `http_req_failed` 阈值 |
| `SUMMARY_DIR` | `tests/concurrency/results` | 结果输出目录 |
| `EVENT_ID` | 空 | 活动报名场景目标活动；为空时需提供 `ADMIN_USER`/`ADMIN_PASS` 自动建活动 |
| `EVENT_CAPACITY` | `10` | 活动容量（超卖判定基准） |
| `IDEMPOTENCY_KEY` | `k6-resource-fixed-key` | 资源幂等键 |
| `USER_A_ID` / `USER_B_ID` | 自动从登录响应解析 | 连接场景的两方用户 id |

> 端点路径均可覆盖（`LOGIN_PATH`、`DIRECTORY_PATH`、`CONNECTIONS_PATH`、`RESOURCES_PATH`、
> `EVENT_REGISTRATION_PATH`、`MY_REQUESTS_PATH`、`ADMIN_EVENTS_PATH` …），
> 若后端实际路由与默认不同，用这些变量对齐即可，无需改脚本。

---

## 3. 执行方式

### 3.1 服务器已安装 k6

```bash
cd ~/MyProject/pkuim-alumni
mkdir -p tests/concurrency/results

# 单场景、分档执行
VUS=20  DURATION=60s k6 run tests/concurrency/login.js
VUS=50  DURATION=60s k6 run tests/concurrency/directory.js
VUS=100 DURATION=60s k6 run tests/concurrency/connection-request.js
VUS=100 DURATION=60s k6 run tests/concurrency/resource-submit.js
VUS=200 DURATION=60s k6 run tests/concurrency/event-registration.js
```

### 3.2 用 Docker 跑 k6（推荐，资源可控）

Docker Hub 直连被阻断，走华为云镜像源前缀：

```bash
cd ~/MyProject/pkuim-alumni
K6_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/grafana/k6:latest

docker run --rm --network host --cpus 16 --memory 32g \
  -v "$PWD/tests/concurrency:/work/tests/concurrency" \
  -w /work \
  -e BASE_URL=http://127.0.0.1:18080 \
  -e VUS=50 -e DURATION=60s \
  -e SUMMARY_DIR=/work/tests/concurrency/results \
  "$K6_IMAGE" run tests/concurrency/login.js
```

> 若 `grafana/k6` 镜像拉取失败，改用服务器本地 k6 二进制，或在华为云镜像源中确认
> `docker.io/grafana/k6` 的实际可用标签。

### 3.3 全档位批量执行（20 → 50 → 100 → 200）

```bash
cd ~/MyProject/pkuim-alumni
for v in 20 50 100 200; do
  for s in login directory connection-request resource-submit event-registration; do
    echo "=== ${s} @ ${v} VU ==="
    VUS="$v" DURATION=60s \
      SUMMARY_PREFIX="${s}" \
      k6 run "tests/concurrency/${s}.js" || echo "!!! ${s} @ ${v} VU 未通过阈值"
  done
done
```

### 3.4 极限探索（500 VU，需评估服务器其它任务占用）

```bash
VUS=500 DURATION=120s k6 run tests/concurrency/login.js
```

### 3.5 活动名额竞争的前置条件

活动必须先存在且容量明确：

```bash
# 方式一：管理后台手工创建，记住活动 id
# 方式二：由脚本用管理端接口自动创建（需管理员账号）
EVENT_ID=12 EVENT_CAPACITY=5 VUS=100 DURATION=60s \
  k6 run tests/concurrency/event-registration.js

# 自动创建（脚本会用 ADMIN_USER/ADMIN_PASS 登录管理端并创建活动）
EVENT_CAPACITY=5 ADMIN_USER=admin ADMIN_PASS='***' VUS=100 \
  k6 run tests/concurrency/event-registration.js
```

---

## 4. 判定标准

任一阈值不满足 → 该档位**不通过**：

| 指标 | 阈值 | 含义 |
| --- | --- | --- |
| `http_req_failed` | `< 1%` | 服务器错误率（409 业务冲突不计） |
| `http_req_duration` | `p(95) < P95_MS` | 端到端时延 |
| `checks` | `rate > 99%` | 断言通过率（仅 login / directory 启用） |
| `connection_pending_created` | `count <= 1` | 同一对用户最多一条 pending 申请 |
| `resources_created` | `count == 1` | 同一幂等键只创建一条资源 |
| `idempotent_replays` | `count > 0` | 重复提交确实走了幂等回放 |
| `event_seats_taken` | `count <= capacity` | **绝不超卖** |
| `event_final_registered_count` | `count <= capacity` | 结束时 `registered_count` 不超过容量 |

> 超卖、重复连接、重复报名、资源未审核公开、联系方式越权——这五类属于**正确性缺陷**，
> 任何档位出现即判定失败，不能用「性能达标」掩盖。

---

## 5. 结果落盘

脚本通过 `handleSummary` 把完整 JSON 写入 `${SUMMARY_DIR}/${SUMMARY_PREFIX}-${VUS}vu.json`。
建议同时保留 k6 的文本输出：

```bash
VUS=100 DURATION=60s k6 run --summary-export=tests/concurrency/results/login-100vu-summary.json \
  tests/concurrency/login.js
```

报告归档位置建议：`docs/TEST-REPORT.md`（由 QA/Lead 撰写，勿在本目录手写结论）。

---

## 6. 注意事项

1. 测试必须打在**专用测试环境**上，禁止指向生产数据库。
2. 压测前用 `infra/scripts/backup.sh` 备份，异常时用 `infra/scripts/restore.sh` 演练恢复。
3. 压测期间不要在同一台服务器跑 `docker compose build`（会抢 24 核/64GB 构建预算）。
4. `connection-request.js` / `resource-submit.js` 依赖幂等实现，**若后端尚未实现幂等键，
   这两个脚本会失败**——这是缺陷暴露，不是脚本问题。
5. 服务器上还有 `swload-*` 项目的容器在运行，k6 压测只打 `127.0.0.1:18080`，
   不要改动其它项目的端口与容器。
