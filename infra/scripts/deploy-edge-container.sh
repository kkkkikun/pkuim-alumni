#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 公网边缘节点（**容器版**）部署
#
#   bash deploy-edge-container.sh --backend 127.0.0.1:18081 --listen 18080 \
#        --dir /opt/nmg-pku-alumni/edge
#
# 为什么用容器而不是装系统 nginx：
#   这台公网服务器上**已经跑着别人的服务**（80/443 被 Caddy 占着，
#   还有两个既有 compose 项目）。装系统 nginx 会：
#     - 试图监听 80 → 直接起不来（端口已被占）；
#     - 往系统里塞一个要长期维护的 systemd 服务。
#   容器版则完全隔离：
#     - 独立 compose 项目 `nmg-pku-alumni`；
#     - 容器名 `nmg-edge-nginx`（**nmg- 前缀**，与既有容器不冲突）；
#     - `network_mode: host` → 容器里的 127.0.0.1 就是宿主机回环，
#       才能连到 SSH 反向隧道监听的端口；
#     - **不碰** /opt/openfeedback、/opt/schoolwall-cn、它们的容器与卷；
#     - 不执行任何 prune / 全局 compose down。
#
# 幂等：可重复执行；不删任何数据。
#
# 退出码：0 成功；1 失败。
# =============================================================================

set -euo pipefail

LISTEN_PORT="18080"
BACKEND="127.0.0.1:18081"
TARGET_DIR="/opt/nmg-pku-alumni/edge"
COMPOSE_PROJECT="nmg-pku-alumni"
CONTAINER_NAME="nmg-edge-nginx"
NGINX_IMAGE="swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/nginx:alpine"
# 公网入口默认**只放行 API**：
#   管理后台的默认密码是硬编码的 `Admin@2026`（还写在 README 里），
#   把它一起暴露到公网 = 任何人都能登后台。
#   小程序只需要 /api/，管理后台继续走 SSH 隧道（更安全）。
#   确实需要把后台也暴露时，加 --allow-admin（并**先改掉默认密码**）。
ALLOW_ADMIN=0

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
warn() { printf '[%s] WARN: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }
die() { printf '[%s] ERROR: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --listen)  LISTEN_PORT="${2:-}"; [ -n "$LISTEN_PORT" ] || die "--listen 需要一个值"; shift 2 ;;
    --backend) BACKEND="${2:-}"; [ -n "$BACKEND" ] || die "--backend 需要一个值"; shift 2 ;;
    --dir)     TARGET_DIR="${2:-}"; [ -n "$TARGET_DIR" ] || die "--dir 需要一个值"; shift 2 ;;
    --allow-admin) ALLOW_ADMIN=1; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

command -v docker >/dev/null 2>&1 || die "没装 docker"
docker compose version >/dev/null 2>&1 || die "docker compose 不可用"

# --- 0. 端口占用预检（绝不抢占别人的端口）---------------------------------
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk 'NR>1{print $4}' | sed 's/.*://' | grep -qx "$LISTEN_PORT"; then
  OWNER="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -x "$CONTAINER_NAME" || true)"
  if [ -z "$OWNER" ]; then
    die "端口 ${LISTEN_PORT} 已被其它服务占用 —— 换一个端口（--listen），不要抢"
  fi
  log "端口 ${LISTEN_PORT} 由本项目自己的容器 ${OWNER} 占用，继续（会重建它）"
fi

# --- 1. 目录与配置 -----------------------------------------------------------
mkdir -p "$TARGET_DIR"
CONF="${TARGET_DIR}/nginx-edge.conf"
if [ -f "$CONF" ]; then
  cp -p "$CONF" "${CONF}.bak.$(date +%Y%m%d-%H%M%S)"
fi

cat > "$CONF" <<EOF
# NMG-PKU-Alumni 公网边缘节点（由 infra/scripts/deploy-edge-container.sh 生成）
# 后端 = SSH 反向隧道在宿主机上监听的端口（host 网络 → 127.0.0.1 即宿主机回环）
upstream nmg_backend {
    server ${BACKEND};
    keepalive 32;
}

server {
    listen ${LISTEN_PORT};
    server_name _;
    client_max_body_size 20m;

    proxy_connect_timeout 10s;
    proxy_send_timeout    60s;
    proxy_read_timeout    60s;

    proxy_http_version 1.1;
    proxy_set_header Host              \$host;
    proxy_set_header X-Real-IP         \$remote_addr;
    proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Connection        "";

    # 公网只放行 API
    location /api/ {
        proxy_pass http://nmg_backend;
    }
EOF

if [ "$ALLOW_ADMIN" -eq 1 ]; then
  cat >> "$CONF" <<'EOF'

    # 管理后台也放行（⚠️ 前提：默认密码必须已经改掉）
    location / {
        proxy_pass http://nmg_backend;
    }
EOF
else
  cat >> "$CONF" <<'EOF'

    # 其余路径一律 404：管理后台只走 SSH 隧道，不经公网
    location / {
        default_type text/plain;
        return 404 "NMG-PKU-Alumni API edge. Only /api/ is exposed.\n";
    }
EOF
fi

cat >> "$CONF" <<'EOF'
}
EOF

COMPOSE_FILE="${TARGET_DIR}/docker-compose.yml"
cat > "$COMPOSE_FILE" <<EOF
# NMG-PKU-Alumni 公网边缘节点（独立 compose 项目：${COMPOSE_PROJECT}）
# ⚠️ 与本机其它项目（openfeedback / schoolwall-cn）完全隔离，
#    不共享网络、不共享卷、不共用端口。
services:
  edge-nginx:
    image: ${NGINX_IMAGE}
    container_name: ${CONTAINER_NAME}
    # host 网络：容器内的 127.0.0.1 就是宿主机回环 → 才能连到 SSH 反向隧道
    network_mode: host
    restart: unless-stopped
    volumes:
      - ./nginx-edge.conf:/etc/nginx/conf.d/default.conf:ro
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
EOF

log "已写入 ${TARGET_DIR}/（compose 文件 + nginx 配置）"

# --- 2. 起服务（只作用于本项目）--------------------------------------------
cd "$TARGET_DIR"
docker compose --project-name "$COMPOSE_PROJECT" up -d
log "compose 已启动（项目 ${COMPOSE_PROJECT}）"

# --- 2.1 reload：nginx 配置是 bind mount，改了文件容器不会自动生效 ----------
# ⚠️ 不 reload 就会出现「配置已改、行为没变」的假象（真实踩过：
#    root 路径本该 404，却仍返回 200 —— 因为容器没重建也没 reload）。
if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  if docker exec "$CONTAINER_NAME" nginx -t >/dev/null 2>&1; then
    docker exec "$CONTAINER_NAME" nginx -s reload >/dev/null 2>&1 && log "nginx 配置已 reload"
  else
    warn "新配置校验失败，保持旧配置运行："
    docker exec "$CONTAINER_NAME" nginx -t 2>&1 >&2 || true
    die "nginx 配置有误，未 reload"
  fi
fi

# --- 3. 自检 -----------------------------------------------------------------
sleep 2
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  warn "容器 ${CONTAINER_NAME} 没起来，日志："
  docker logs --tail 20 "$CONTAINER_NAME" 2>&1 >&2 || true
  die "边缘节点启动失败"
fi
log "容器 ${CONTAINER_NAME} 运行中"

if curl -fsS --max-time 8 "http://127.0.0.1:${LISTEN_PORT}/api/v1/system/health" >/dev/null 2>&1; then
  log "=== 边缘节点就绪 ✅ ==="
  log "  对外入口：http://<公网IP>:${LISTEN_PORT}/api/v1/ （API，仅此路径开放）"
  if [ "$ALLOW_ADMIN" -eq 1 ]; then
    log "             http://<公网IP>:${LISTEN_PORT}/        （管理后台，⚠️ 确认密码已改）"
  else
    log "             http://<公网IP>:${LISTEN_PORT}/        → 404（管理后台只走 SSH 隧道）"
  fi
else
  warn "=== 容器已起，但回环自检未通过 ==="
  warn "   多半是 SSH 反向隧道还没建好（隧道通了之后重跑本脚本即可）"
  exit 1
fi
