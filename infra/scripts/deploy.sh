#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 远程构建 + 部署编排（在本地执行）
#
#   bash infra/scripts/deploy.sh                    # 同步 + 构建 + 启动 + 健康检查
#   bash infra/scripts/deploy.sh --skip-build       # 只同步并重启（复用已有镜像）
#   bash infra/scripts/deploy.sh --build-only       # 只构建不启动
#   bash infra/scripts/deploy.sh --release 20261115-01
#   bash infra/scripts/deploy.sh --no-rsync         # 服务器上直接执行（代码已同步）
#   bash infra/scripts/deploy.sh --rollback         # 回滚到 .env.prod.prev
#
# 流程：
#   本地 rsync → 服务器 build.sh → compose up -d → healthcheck.sh --wait
#
# 安全约束：
#   - compose 始终带 --project-name nmg-pku-alumni 与 --env-file .env.prod
#   - 绝不执行不带项目作用域的 compose down，绝不 prune
#   - rsync 不删除服务器上的 .env.prod / backups / node_modules
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

DO_BUILD=1
DO_UP=1
DO_RSYNC=1
DO_ROLLBACK=0
WAIT_TIMEOUT="${WAIT_TIMEOUT:-300}"

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) DO_BUILD=0; shift ;;
    --build-only) DO_UP=0; shift ;;
    --no-rsync)   DO_RSYNC=0; shift ;;
    --rollback)   DO_ROLLBACK=1; DO_BUILD=0; shift ;;
    --release)    RELEASE_TAG="${2:-}"; [ -n "$RELEASE_TAG" ] || die "--release 需要一个值"; shift 2 ;;
    --timeout)    WAIT_TIMEOUT="${2:-}"; [ -n "$WAIT_TIMEOUT" ] || die "--timeout 需要一个值"; shift 2 ;;
    -h|--help)    sed -n '2,24p' "$0"; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

RELEASE_TAG="${RELEASE_TAG:-$(date '+%Y%m%d-%H%M%S')}"
export RELEASE_TAG

require_cmd ssh
require_file "${PROJECT_ROOT}/docker-compose.prod.yml"
require_file "${PROJECT_ROOT}/infra/scripts/build.sh"

# --- 远程执行封装 -----------------------------------------------------------
remote_exec() {
  local cmd="$1"
  log "远端执行：${cmd}"
  ssh $SSH_OPTS "$REMOTE_HOST" "cd '$REMOTE_DIR' && ${cmd}"
}

# --- 0. 连通性预检 -----------------------------------------------------------
log "检查服务器连通性：${REMOTE_HOST}"
ssh $SSH_OPTS "$REMOTE_HOST" "hostname; docker --version; docker compose version" \
  || die "无法连接 ${REMOTE_HOST}（检查 ~/.ssh/config 中的 sqserver 别名）"

# --- 1. 同步代码 -------------------------------------------------------------
if [ "$DO_RSYNC" -eq 1 ]; then
  require_cmd rsync
  log "rsync 同步到 ${REMOTE_HOST}:${REMOTE_DIR}/"
  rsync_to_remote "${PROJECT_ROOT}/" "${REMOTE_HOST}:${REMOTE_DIR}/"
  log "同步完成（服务器上的 .env.prod / backups 未被改动）"
else
  log "跳过 rsync（--no-rsync）"
fi

# --- 2. 环境文件 -------------------------------------------------------------
remote_exec "bash infra/scripts/init-env.sh"

# --- 3. 回滚分支 -------------------------------------------------------------
if [ "$DO_ROLLBACK" -eq 1 ]; then
  remote_exec "bash infra/scripts/rollback.sh --wait --timeout '${WAIT_TIMEOUT}'"
  remote_exec "bash infra/scripts/healthcheck.sh"
  log "回滚完成"
  exit 0
fi

# --- 4. 构建 -----------------------------------------------------------------
if [ "$DO_BUILD" -eq 1 ]; then
  remote_exec "RELEASE_TAG='${RELEASE_TAG}' bash infra/scripts/build.sh"
else
  log "跳过构建（--skip-build）"
fi

# --- 5. 迁移（**切流量之前**）-----------------------------------------------
# ⚠️ 缺陷 #142：部署流程原本**没有迁移这一步** ——
#    「同步 → 构建 → up -d」之间库表结构不会跟着代码走，
#    代码已经按新结构工作、库里还是旧结构 → 运行时才报错
#    （例：#140 把 idempotency_records.scope 放宽到 VARCHAR(255)，
#    库里还是 64 → 长路径幂等请求 Data too long → 500）。
#
# 放在 up -d **之前**的原因：
#   1) 迁移用**新镜像**里的代码执行（`compose run --rm api`），
#      此时旧容器还在正常服务旧代码 —— 迁移是**加法式**的（只加列/加表），
#      旧代码对新结构完全兼容 → 不会出现「切了流量才发现结构不对」；
#   2) 新代码上线时，结构**已经就位** → 没有「新代码跑在旧结构上」的窗口。
#
# 迁移是幂等的（每条迁移自己判断是否已应用），重复执行安全。
log "应用待执行迁移（幂等；切流量之前完成）……"
if [ "$DO_UP" -eq 1 ]; then
  remote_exec "docker compose --project-name '${COMPOSE_PROJECT_NAME}' --env-file .env.prod -f docker-compose.prod.yml run --rm --no-deps api sh -lc 'cd /app/apps/api && ./node_modules/.bin/typeorm-ts-node-commonjs -d src/database/data-source.ts migration:run'" \
    || die "迁移执行失败 —— 已中止部署（避免新代码跑在旧结构上）"
else
  # --build-only：只构建不启动 → 不动数据库
  log "跳过迁移（--build-only：不启动就不动库）"
fi

# --- 6. 启动 -----------------------------------------------------------------
if [ "$DO_UP" -eq 1 ]; then
  remote_exec "docker compose --project-name '${COMPOSE_PROJECT_NAME}' --env-file .env.prod -f docker-compose.prod.yml up -d --remove-orphans"
  remote_exec "docker compose --project-name '${COMPOSE_PROJECT_NAME}' --env-file .env.prod -f docker-compose.prod.yml ps"

  # 6.1 重载 nginx（**必须**）
  #     nginx 的 `upstream api_backend` / `upstream admin_web_backend` 在**加载配置时**
  #     一次性把容器名解析成 IP 并缓存。api / admin-web 容器一旦重建，IP 就变了，
  #     而 nginx 仍指向旧 IP → 经 nginx 的请求全部 502（api 直连却是好的，
  #     排查时极易误判成「服务挂了」）。
  #     reload 会重新解析 upstream，因此每次部署后都要补这一下。
  log "重载 nginx（刷新 upstream 容器 IP）……"
  remote_exec "docker compose --project-name '${COMPOSE_PROJECT_NAME}' --env-file .env.prod -f docker-compose.prod.yml exec -T nginx nginx -s reload" \
    || warn "nginx 重载失败，请手工执行：docker compose exec nginx nginx -s reload"
else
  log "跳过启动（--build-only）"
  exit 0
fi

# --- 7. 健康检查等待 ---------------------------------------------------------
remote_exec "bash infra/scripts/healthcheck.sh --wait --timeout '${WAIT_TIMEOUT}'"

# --- 8. 迁移一致性对账（**发布后**再确认一次）------------------------------
# 部署时跑过迁移，但「跑过」不等于「跑全了」——
# 这里再对一次账：代码清单里的迁移必须**全部**在库的 migrations 表里。
log "迁移一致性对账（代码清单 ⟷ 数据库已应用）……"
remote_exec "bash infra/scripts/check-pending-migrations.sh" \
  || die "迁移一致性对账失败 —— 代码与库表结构不一致"

# --- 9. 结果摘要 -------------------------------------------------------------
NGINX_BIND_LOCAL="$(env_get_or NGINX_BIND 127.0.0.1)"
NGINX_PORT_LOCAL="$(env_get_or NGINX_HTTP_PORT 18080)"
ADMIN_PORT_LOCAL="$(env_get_or ADMIN_PORT 18082)"
API_PORT_LOCAL="$(env_get_or API_PORT 18081)"

log "部署完成（RELEASE_TAG=${RELEASE_TAG}）"
log "  管理后台   http://${NGINX_BIND_LOCAL}:${NGINX_PORT_LOCAL}/"
log "  API        http://${NGINX_BIND_LOCAL}:${NGINX_PORT_LOCAL}/api/v1"
log "  健康检查   http://${NGINX_BIND_LOCAL}:${NGINX_PORT_LOCAL}/healthz"
log "  直连端口   api=${API_PORT_LOCAL} admin=${ADMIN_PORT_LOCAL}（均绑定 127.0.0.1）"
log "  服务器部署目录 ${REMOTE_DIR}"
