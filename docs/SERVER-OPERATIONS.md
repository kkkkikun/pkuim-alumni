# 服务器运维手册（SERVER-OPERATIONS）

> 私网服务器（172.16.38.110:56127，SSH 别名 `sqserver`）上的日常运维、排障与容量管理。
> 所有命令均在 `cd /home/kikun/MyProject/pkuim-alumni` 后执行。

---

## 0. 隔离规则（每次操作前默念）

本服务器**同时**运行着其它项目的容器。操作本项目时：

- 只用 `--project-name nmg-pku-alumni` 限定作用域；
- 只操作 `nmg-` 前缀的容器 / 卷 / 网络；
- **禁止** `docker system prune`、`docker volume prune`、不带项目名的 `docker compose down`、
  `docker compose down -v`；
- **禁止**删除或重建 `swload-api` / `swload-pg` / `swload-redis` / `swload-worker` 及其卷；
- 端口全部在 13xxx/16xxx/18xxx/19xxx 段且只绑 `127.0.0.1`，与既有端口无交集。

快速自查本项目资源：

```bash
docker ps --filter 'name=nmg-' --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker volume ls --filter 'name=nmg-'
docker network ls --filter 'name=nmg-'
```

---

## 1. 常用命令速查

```bash
cd /home/kikun/MyProject/pkuim-alumni
DC="docker compose --project-name nmg-pku-alumni --env-file .env.prod -f docker-compose.prod.yml"

$DC ps                       # 服务状态
$DC logs -f api              # 跟踪 API 日志
$DC logs --tail 200 worker   # Worker 最近 200 行
$DC top                      # 进程
$DC stats --no-stream        # 资源占用快照
$DC restart api              # 重启单个服务
$DC up -d --no-build         # 按当前镜像拉起（不改标签）
$DC exec -T mysql mysql -uroot -p'<root 密码>' -e 'SHOW DATABASES;'
$DC exec -T redis redis-cli -a '<redis 密码>' --no-auth-warning PING
```

> 把 `$DC` 存成 shell 变量前，**先确认 `$` 没被当成变量展开**；建议直接整条复制执行。

---

## 2. 服务状态与健康

```bash
cd /home/kikun/MyProject/pkuim-alumni
bash infra/scripts/healthcheck.sh                 # 一次性检查
bash infra/scripts/healthcheck.sh --wait --timeout 300   # 等待恢复

# 逐个容器看健康状态
for c in $(docker ps --filter 'name=nmg-' -q); do
  docker inspect -f '{{.Name}}  state={{.State.Status}}  health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c"
done
```

单个探针：

```bash
curl -i http://127.0.0.1:18080/healthz              # nginx → api
curl -i http://127.0.0.1:18081/healthz              # 直连 api
curl -I http://127.0.0.1:18082/                     # 直连 admin-web
```

### 2.1 共享失效总线的「自证」（多实例部署）

多实例部署时，「跨实例撤权 / 字典失效**到底生效没有**」用这个**只读**端点确认，
不必逐个实例翻日志（口径见 `docs/SECURITY.md` 第 2.1.9 节）：

```bash
# 逐个 API 实例查一次（每个实例的 subscribed 都要为 true）
for port in 18081 18091 18101; do
  echo "--- :$port"
  curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" \
    "http://127.0.0.1:$port/api/v1/admin/ops/invalidation-bus" | jq .
done
```

- ⚠️ 需要**管理员令牌**（`admin:manage` 权限点）：该端点**不对外公开**
  （频道名与错误信息属于内部信息）；匿名请求 401、普通校友 403。
- 读法：`enabled` = 总线是否开启；`channel` = **生效频道**
  （各实例必须一致，否则事件互相打不到）；`subscribed` = **本实例**是否订阅上；
  `published` / `received` = 本进程累计发布 / 收到的事件数；
  `lastError` = 最近一次总线错误；`degraded` = 总线开着但没订阅上
  （= 撤权延迟已回落到 **TTL 上界**，不是 0）。
- 各实例 `channel` 不一致 → 统一 `RBAC_INVALIDATION_CHANNEL` 与 `NODE_ENV`；
  `subscribed: false` → 查 `lastError`（通常是 Redis 不可达）。

---

## 3. 日志

所有容器使用 `json-file` 驱动，单文件 10MB、保留 3 个文件（`infra/docker` 与 compose 中的
`x-logging` 锚点），避免日志撑爆磁盘。

```bash
cd /home/kikun/MyProject/pkuim-alumni
DC="docker compose --project-name nmg-pku-alumni --env-file .env.prod -f docker-compose.prod.yml"

$DC logs -f --tail 100 nginx
$DC logs --since 30m api | grep -iE 'error|exception|timeout'
$DC logs --since 1h nginx | grep -E '"status":5[0-9][0-9]'   # nginx 5xx 统计
```

nginx 访问日志为 JSON 行（写 stdout），便于直接用 `jq` 分析：

```bash
$DC logs nginx --since 10m | jq -r 'select(.status>=400) | "\(.status) \(.uri)"' | sort | uniq -c | sort -rn | head -20
```

---

## 4. 常用运维动作

### 4.1 重启单个服务

```bash
cd /home/kikun/MyProject/pkuim-alumni
docker compose --project-name nmg-pku-alumni --env-file .env.prod \
  -f docker-compose.prod.yml restart api
bash infra/scripts/healthcheck.sh --wait --timeout 180
```

### 4.2 重新拉起（不改镜像版本）

```bash
docker compose --project-name nmg-pku-alumni --env-file .env.prod \
  -f docker-compose.prod.yml up -d --no-build --remove-orphans
```

### 4.3 升级到新版本

```bash
# 本地
cd /home/kikun/MyProject/pkuim-alumni
bash infra/scripts/deploy.sh --release 20261115-03
# 出问题立即回滚
bash infra/scripts/deploy.sh --rollback
```

### 4.4 扩缩容 worker（并行度）

worker 并发数由环境变量控制：

```bash
cd /home/kikun/MyProject/pkuim-alumni
sed -i 's/^WORKER_CONCURRENCY=.*/WORKER_CONCURRENCY=16/' .env.prod
docker compose --project-name nmg-pku-alumni --env-file .env.prod \
  -f docker-compose.prod.yml up -d worker
```

### 4.5 备份 / 恢复

见 `docs/BACKUP-RESTORE.md`。日常：

```bash
bash infra/scripts/backup.sh
bash infra/scripts/restore.sh --backup /home/kikun/backups/nmg-pku-alumni/<时间戳> --target-db nmg_restore_drill --drop
```

---

## 5. 数据库运维

```bash
cd /home/kikun/MyProject/pkuim-alumni
DC="docker compose --project-name nmg-pku-alumni --env-file .env.prod -f docker-compose.prod.yml"
PASS="$(grep '^MYSQL_ROOT_PASSWORD=' .env.prod | cut -d= -f2-)"

# 连接
$DC exec -T mysql mysql -uroot -p"$PASS" -e 'SHOW DATABASES;'

# 关键表行数
$DC exec -T mysql mysql -uroot -p"$PASS" -e "
  SELECT 'users' t, COUNT(*) n FROM users
  UNION ALL SELECT 'alumni_profiles', COUNT(*) FROM alumni_profiles
  UNION ALL SELECT 'events', COUNT(*) FROM events
  UNION ALL SELECT 'event_registrations', COUNT(*) FROM event_registrations
  UNION ALL SELECT 'resource_posts', COUNT(*) FROM resource_posts;"

# 连接数与锁等待（并发异常时先看这里）
$DC exec -T mysql mysql -uroot -p"$PASS" -e "SHOW STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Max_used_connections');"
$DC exec -T mysql mysql -uroot -p"$PASS" -e "SHOW ENGINE INNODB STATUS\G" | grep -A5 'LATEST DETECTED DEADLOCK'

# 慢查询（需在 my.cnf 打开 slow_query_log，默认镜像未开启）
$DC exec -T mysql mysql -uroot -p"$PASS" -e "SHOW VARIABLES LIKE 'slow_query_log';"
```

> 变更结构一律走迁移（`bash infra/scripts/seed.sh --migrate` 同款流程），
> **禁止**在生产库开 `synchronize: true`。

---

## 6. Redis / BullMQ 运维

```bash
cd /home/kikun/MyProject/pkuim-alumni
DC="docker compose --project-name nmg-pku-alumni --env-file .env.prod -f docker-compose.prod.yml"
RPASS="$(grep '^REDIS_PASSWORD=' .env.prod | cut -d= -f2-)"

$DC exec -T redis redis-cli -a "$RPASS" --no-auth-warning PING
$DC exec -T redis redis-cli -a "$RPASS" --no-auth-warning INFO memory | grep used_memory_human
$DC exec -T redis redis-cli -a "$RPASS" --no-auth-warning KEYS 'bull:*' | head -20
$DC exec -T redis redis-cli -a "$RPASS" --no-auth-warning LLEN bull:notifications:wait   # 队列积压
```

Redis 配置为 `--maxmemory-policy noeviction`（BullMQ 队列不允许被淘汰），
内存打满会写失败而不是丢任务 —— 出现写入错误时先看 `used_memory_human`。

---

## 7. MinIO 运维

```bash
cd /home/kikun/MyProject/pkuim-alumni
DC="docker compose --project-name nmg-pku-alumni --env-file .env.prod -f docker-compose.prod.yml"
MINIO_IMAGE="$(grep '^MINIO_MC_IMAGE=' .env.prod | cut -d= -f2-)"

$DC exec -T minio curl -fsS http://127.0.0.1:9000/minio/health/live && echo OK

# 桶与对象量
docker run --rm --network nmg-pku-alumni-net \
  --env MC_HOST_local="http://$(grep '^MINIO_ROOT_USER=' .env.prod | cut -d= -f2-):$(grep '^MINIO_ROOT_PASSWORD=' .env.prod | cut -d= -f2-)@minio:9000" \
  "$MINIO_IMAGE" ls local/
```

控制台：`http://127.0.0.1:19001`（账号见 `.env.prod` 的 `MINIO_ROOT_USER`）。

---

## 8. 容量与资源

```bash
# 宿主机
free -h
df -h / /var/lib/docker
uptime
nproc

# 容器占用
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}' $(docker ps --filter 'name=nmg-' -q)
```

本项目资源上限（top.md §9.4）：

| 组件 | 上限 |
| --- | --- |
| MySQL | 8 核 / 32GB |
| Redis + MinIO | 合计 8 核 / 24GB |
| API + Worker | 合计 8 核 / 16GB |
| 构建 | 24 核 / 64GB（串行构建） |
| k6 | 16 核 / 32GB |

清理空间（**只清理本项目**，禁止全局 prune）：

```bash
# 列出本项目镜像
docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep '^nmg-pku-alumni/'

# 删除旧版本镜像（逐个精确删除）
docker image rm nmg-pku-alumni/api:20261115-01 nmg-pku-alumni/worker:20261115-01
```

---

## 9. 可选监控栈

```bash
cd /home/kikun/MyProject/pkuim-alumni
docker compose --project-name nmg-pku-alumni-monitor \
  -f infra/monitoring/docker-compose.monitoring.yml up -d
```

- Prometheus：`http://127.0.0.1:19090`
- Grafana：`http://127.0.0.1:13000`（账号见 `.env.prod` 的 `GRAFANA_USER` / `GRAFANA_PASSWORD`）

监控栈与主栈项目名、网络、卷完全独立，停它不影响主栈：

```bash
docker compose --project-name nmg-pku-alumni-monitor \
  -f infra/monitoring/docker-compose.monitoring.yml stop
```

---

## 10. 故障排查速查

| 现象 | 首查 | 常见原因 |
| --- | --- | --- |
| nginx 502 | `$DC logs api` | API 崩溃 / 未监听 3000 |
| API 启动即退出 | `$DC logs api` | 数据库连不上、迁移未执行、`JWT_SECRET` 太短 |
| 接口大量 429 | nginx `login_zone` 限流 | 压测或脚本误打登录接口 |
| 报名报超卖 | `SELECT capacity, registered_count FROM events;` | 并发逻辑缺陷，需 Backend 修复（数据库应靠条件更新兜底） |
| 队列不消费 | `$DC logs worker`、`LLEN bull:*` | worker 容器异常、Redis 内存满 |
| 磁盘满 | `df -h`、`docker system df` | 日志/镜像堆积；只清理本项目镜像 |
| 连接被拒 | `ss -lntp \| grep 18080` | nginx 未启动或端口被改 |
| 容器反复重启 | `$DC ps` 看 `Restarting` | healthcheck 失败；先 `--no-deps` 单独起看日志 |

---

## 11. 账号与密钥

- `.env.prod` 权限 `600`，属主 `kikun`，**不要**提交仓库、不要复制到聊天窗口；
- JWT / MySQL / Redis / MinIO 密码轮换：改 `.env.prod` → `docker compose up -d` 重建对应服务；
- MinIO 控制台、Grafana 使用独立账号，不要复用数据库密码；
- 真实校友信息在取得授权前不得进入测试环境（top.md §11.2）。

---

## 12. 相关文档

- `docs/DEPLOYMENT.md` —— 部署、升级、回滚
- `docs/BACKUP-RESTORE.md` —— 备份、恢复演练、灾备
- `tests/concurrency/README.md` —— k6 并发测试
- `docs/top.md` §9 / §11 —— 服务器与数据保护总纲
