# 部署手册（DEPLOYMENT）

> 适用范围：内蒙古北京大学校友会数字化平台 V1 —— **私网测试环境**部署。
> 服务器：Ubuntu 24.04.5 / 128 vCPU / 295 GiB RAM / 991G 磁盘，Docker 29.8.2 + Compose v5.5.1。
> 本文件中的命令均为**可直接复制执行**的完整命令。

---

## 0. 硬性隔离规则（先读这一节）

服务器上**已运行**其它项目的容器（`swload-api`、`swload-pg`、`swload-redis`、`swload-worker`），
本项目**不得触碰**它们：

| 禁止 | 原因 | 正确做法 |
| --- | --- | --- |
| `docker system prune` / `docker image prune` / `docker volume prune` | 会清掉其它项目在用的镜像与卷 | 只用 `docker image rm <本项目镜像>` 精确删除 |
| `docker volume rm <未知卷名>` | 会破坏其它项目数据 | 本项目卷全部以 `nmg-` 开头，只操作这些 |
| 不带 `--project-name` 的 `docker compose down` | 可能停掉别的项目栈 | 始终 `docker compose --project-name nmg-pku-alumni ...` |
| `docker compose down -v` | 会删除数据卷 | 回滚/重启只用 `up -d`，不用 `down -v` |
| 修改 18080/13306/16379/19000 以外的既有端口 | 与 `swload-*` 占用冲突 | 本项目端口全部在 18xxx/13xxx/16xxx/19xxx 段且只绑 127.0.0.1 |

> 本项目容器前缀 `nmg-`，卷前缀 `nmg-`，Compose 项目名 `nmg-pku-alumni`，
> 网络名 `nmg-pku-alumni-net`。看到不匹配前缀的容器，一律不要操作。

---

## 1. 交付物清单

| 文件 | 作用 |
| --- | --- |
| `docker-compose.prod.yml` | 服务器栈（nginx / api / worker / admin-web / mysql / redis / minio / minio-init） |
| `docker-compose.yml` | 本地开发栈（默认只起 mysql/redis/minio；`--profile app` 起全套） |
| `infra/docker/api.Dockerfile` | API 镜像（NestJS，非 root） |
| `infra/docker/worker.Dockerfile` | Worker 镜像（BullMQ 消费者） |
| `infra/docker/admin-web.Dockerfile` | 管理后台镜像（Vite 产物 → nginx 静态托管） |
| `infra/nginx/nginx.conf` | 反向代理：`/api/` → api，`/` → admin-web，`/healthz` → api |
| `infra/nginx/admin-web.conf` | 管理后台站点配置（SPA 回退） |
| `infra/env/env.prod.example` | 环境变量模板（**不含真实密钥**，已提交仓库） |
| `infra/scripts/*.sh` | build / deploy / healthcheck / backup / restore / seed / rollback / init-env |
| `infra/monitoring/*` | 可选监控栈（Prometheus + Grafana + node-exporter + cAdvisor） |
| `tests/concurrency/*.js` | k6 并发测试脚本（见 `tests/concurrency/README.md`） |

---

## 2. 端口对照表

| 服务 | 容器内 | 宿主机（仅 127.0.0.1） | 用途 |
| --- | --- | --- | --- |
| nginx | 80 | **18080** | 统一入口（管理后台 + API） |
| api | 3000 | 18081 | 直连 API（排障用） |
| admin-web | 80 | 18082 | 直连管理后台静态站 |
| mysql | 3306 | 13306 | 数据库 |
| redis | 6379 | 16379 | 缓存 / 队列 |
| minio | 9000 / 9001 | 19000 / 19001 | 对象存储 / 控制台 |

默认全部绑定 `127.0.0.1`。若需要私网其它主机访问**只改 nginx**：

```bash
# 在服务器上
sed -i 's/^NGINX_BIND=.*/NGINX_BIND=0.0.0.0/' .env.prod
docker compose --project-name nmg-pku-alumni --env-file .env.prod -f docker-compose.prod.yml up -d nginx
```

> 私网服务器**不得**直接暴露给公网；正式对外需另行加 TLS 反代与防火墙策略。

---

## 3. 首次部署（服务器）

### 3.1 本地：提交锁文件并同步

```bash
cd /home/kikun/MyProject/pkuim-alumni

# pnpm 锁文件必须存在（Dockerfile 会 COPY 它）；没有就先生成并提交
pnpm install --lockfile-only
git add pnpm-lock.yaml && git commit -m "chore: add pnpm lockfile"

# 同步到服务器（也可直接用 infra/scripts/deploy.sh 自动同步）
rsync -az --delete \
  --exclude '.git/' --exclude '.env.prod' --exclude 'node_modules/' \
  --exclude '**/node_modules/' --exclude '**/dist/' \
  ./ sqserver:/home/kikun/MyProject/pkuim-alumni/
```

### 3.2 服务器：生成环境文件

```bash
ssh sqserver
cd /home/kikun/MyProject/pkuim-alumni
bash infra/scripts/init-env.sh          # 生成 .env.prod（随机密钥，权限 600）

# 复核关键变量
grep -E '^(MYSQL_|REDIS_|MINIO_|JWT_|NGINX_)' .env.prod | sed -E 's/(PASSWORD|SECRET)=.*/\1=***/'
```

> **关于模板文件位置**：环境变量模板放在 `infra/env/env.prod.example`（**已提交仓库**），
> 而不是仓库根的 `.env.prod.example`——仓库根 `.gitignore` 已有 `.env.*` 规则，
> 根目录的 `.env.prod.example` 会被忽略而无法提交。真实的 `.env.prod` 始终位于仓库根
> （compose 的 `env_file` 按 compose 文件所在目录解析），由 `init-env.sh` 从模板生成。
> 若 Lead 希望根目录也有同名副本，执行 `cp infra/env/env.prod.example .env.prod.example`
> 即可（该副本仍不会被提交，属预期行为）。

### 3.3 服务器：构建镜像（BuildKit）

```bash
cd /home/kikun/MyProject/pkuim-alumni
RELEASE_TAG=20261115-01 bash infra/scripts/build.sh
```

构建产物（本地 tag，不推送任何仓库）：

```
nmg-pku-alumni/api:20261115-01
nmg-pku-alumni/worker:20261115-01
nmg-pku-alumni/admin-web:20261115-01
```

构建预算：24 核 / 64GB（top.md §9.4）。脚本**串行**构建三个镜像，
pnpm store 使用 BuildKit cache mount，重复构建命中缓存。

### 3.4 服务器：启动

```bash
cd /home/kikun/MyProject/pkuim-alumni
docker compose --project-name nmg-pku-alumni \
  --env-file .env.prod -f docker-compose.prod.yml up -d --remove-orphans

# 查看状态
docker compose --project-name nmg-pku-alumni \
  --env-file .env.prod -f docker-compose.prod.yml ps
```

启动顺序由 `depends_on` + `condition: service_healthy` 保证：
`mysql/redis/minio` 健康 → `api/worker` 启动 → `api/admin-web` 健康 → `nginx` 启动。

### 3.5 服务器：健康检查

```bash
cd /home/kikun/MyProject/pkuim-alumni
bash infra/scripts/healthcheck.sh --wait --timeout 300

# 手工验证
curl -i http://127.0.0.1:18080/healthz
curl -i http://127.0.0.1:18080/api/v1/system/health
```

### 3.6 初始化数据（可选）

```bash
cd /home/kikun/MyProject/pkuim-alumni
bash infra/scripts/seed.sh --migrate
```

---

## 4. 一键部署（本地执行，推荐）

`infra/scripts/deploy.sh` 把「同步 → 构建 → 启动 → 健康检查」串成一条命令：

```bash
cd /home/kikun/MyProject/pkuim-alumni

# 完整发布
bash infra/scripts/deploy.sh --release 20261115-02

# 只同步并重启（复用已有镜像）
bash infra/scripts/deploy.sh --skip-build

# 只构建不启动
bash infra/scripts/deploy.sh --build-only

# 回滚到上一个版本
bash infra/scripts/deploy.sh --rollback
```

脚本内部通过 SSH 别名 `sqserver`（`~/.ssh/config`）连接服务器，
远端目录 `/home/kikun/MyProject/pkuim-alumni`，全程带 `--project-name nmg-pku-alumni`。

---

## 5. 回滚

镜像标签在每次构建前自动记录到 `.env.prod.prev`，回滚即恢复旧标签：

```bash
# 服务器上
cd /home/kikun/MyProject/pkuim-alumni
cat .env.prod.prev        # 确认上一个版本

bash infra/scripts/rollback.sh --wait --timeout 300
```

或本地：

```bash
bash infra/scripts/deploy.sh --rollback
```

回滚**不会**删除数据卷：MySQL / Redis / MinIO 数据保持原样。
若回滚后数据库结构不兼容（旧版本不认识新列），按 `docs/BACKUP-RESTORE.md` 用备份恢复。

---

## 6. 资源限制（top.md §9.4 预算落地）

| 组件 | CPU 上限 | 内存上限 | 落地位置 |
| --- | --- | --- | --- |
| Docker 构建 | 24 核 / 64GB | — | `build.sh` 串行构建 + BuildKit cache mount |
| MySQL | 8 核 | 32GB | `docker-compose.prod.yml` → `deploy.resources.limits` |
| Redis | 2 核 | 8GB | 同上 |
| MinIO | 6 核 | 16GB | 同上 |
| API | 5 核 | 10GB | 同上 |
| Worker | 3 核 | 6GB | 同上 |
| nginx | 2 核 | 2GB | 同上 |
| admin-web | 1 核 | 1GB | 同上 |
| 自动化测试 | 8 核 / 16GB | — | 测试容器由 QA/Lead 按需指定 |
| k6 压测 | 16 核 / 32GB | — | `docker run --cpus 16 --memory 32g ...` |

> Redis + MinIO = 8 核 / 24GB；API + Worker = 8 核 / 16GB，与预算表一致。

---

## 7. 镜像源（Docker Hub 被阻断）

所有官方镜像统一走华为云镜像源前缀：

```
swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/<image>
swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/<namespace>/<image>
```

已在 `.env.prod` 中集中定义（`MYSQL_IMAGE` / `REDIS_IMAGE` / `MINIO_IMAGE` /
`MINIO_MC_IMAGE` / `NODE_IMAGE` / `NGINX_IMAGE`），改一处即可整体切换。

包管理源：

| 生态 | 地址 |
| --- | --- |
| npm | `https://registry.npmmirror.com/`（仓库根 `.npmrc`） |
| pnpm | 由 corepack 下载，`COREPACK_NPM_REGISTRY` 指向同一地址 |
| Docker | 华为云镜像源前缀 |

---

## 8. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 构建报 `Headless installation requires a pnpm-lock.yaml` | 仓库未提交锁文件 | 本地 `pnpm install --lockfile-only` 并提交；或服务器端 `build.sh` 会自动生成（仅服务器） |
| `corepack` 下载 pnpm 超时 | 未设 npmmirror | 镜像构建参数已设 `COREPACK_NPM_REGISTRY`；确认 `.npmrc` 存在 |
| `minio-init` 拉不到镜像 | `minio/mc` 在镜像源中缺失 | 手工建桶：`docker compose --project-name nmg-pku-alumni --env-file .env.prod -f docker-compose.prod.yml run --rm minio-init` |
| `/healthz` 返回 404 | 后端未实现该路径 | 后端需暴露 `GET /healthz`；或改用 `/api/v1/system/health` |
| nginx 一直 unhealthy | 上游 api 未就绪 | `docker compose ... logs api`；`healthcheck.sh` 会列出每个容器状态 |
| 端口被占用 | 与既有服务冲突 | 本项目端口段独占；`ss -lntp \| grep -E '18080\|13306'` 确认 |
| 磁盘写满 | 镜像/日志堆积 | 只清理本项目镜像：`docker image rm nmg-pku-alumni/api:<tag>`；**禁止** `docker system prune` |

---

## 9. 相关文档

- `docs/BACKUP-RESTORE.md` —— 备份、恢复演练、灾备
- `docs/SERVER-OPERATIONS.md` —— 日常运维、排障、监控
- `tests/concurrency/README.md` —— k6 并发测试
- `docs/top.md` §9 —— Docker 与私网服务器总纲
