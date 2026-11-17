#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 公网边缘节点部署（在**公网服务器**上执行）
#
#   bash deploy-public-edge.sh --listen 80
#   bash deploy-public-edge.sh --domain api.example.com --listen 443 \
#        --tls-cert /etc/letsencrypt/live/api.example.com/fullchain.pem \
#        --tls-key  /etc/letsencrypt/live/api.example.com/privkey.pem
#
# 作用：
#   在公网服务器上装 nginx，把流量反代到 **SSH 反向隧道** 暴露出来的
#   127.0.0.1:18080（那是校园机上 compose 的 nginx：/ → 管理后台，/api/ → API）。
#
#   拓扑：
#       手机 / 客户浏览器
#            │  http(s)://<公网IP 或 域名>
#            ▼
#     [公网服务器] nginx  ──127.0.0.1:18080──▶  [SSH 反向隧道]
#            ▲                                      │
#            └──────────────────────────────────────┘
#                        （校园机上的 compose nginx）
#
# 前置条件：
#   1) 校园机已建立反向隧道（在校园机上跑 tunnel-public-edge.sh），
#      公网机 127.0.0.1:18080 能通（curl http://127.0.0.1:18080/api/v1/system/health）；
#   2) 防火墙/安全组已放行 80（以及启用 TLS 时的 443）。
#
# 幂等：可重复执行；不删用户数据，不做 prune。
#
# 退出码：0 成功；1 失败。
# =============================================================================

set -euo pipefail

LISTEN_PORT="80"
DOMAIN=""
TLS_CERT=""
TLS_KEY=""
BACKEND="127.0.0.1:18080"
NGINX_CONF_DIR="/etc/nginx/conf.d"
NGINX_CONF="${NGINX_CONF_DIR}/nmg-edge.conf"
PRINT_ONLY=0

log()  { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
warn() { printf '[%s] WARN: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }
die()  { printf '[%s] ERROR: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; exit 1; }

usage() {
  sed -n '2,40p' "$0"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --listen)    LISTEN_PORT="${2:-}"; [ -n "$LISTEN_PORT" ] || die "--listen 需要一个值"; shift 2 ;;
    --domain)    DOMAIN="${2:-}"; [ -n "$DOMAIN" ] || die "--domain 需要一个值"; shift 2 ;;
    --tls-cert)  TLS_CERT="${2:-}"; [ -n "$TLS_CERT" ] || die "--tls-cert 需要一个值"; shift 2 ;;
    --tls-key)   TLS_KEY="${2:-}"; [ -n "$TLS_KEY" ] || die "--tls-key 需要一个值"; shift 2 ;;
    --backend)   BACKEND="${2:-}"; [ -n "$BACKEND" ] || die "--backend 需要一个值"; shift 2 ;;
    --print-only) PRINT_ONLY=1; shift ;;
    -h|--help)   usage ;;
    *) die "未知参数：$1" ;;
  esac
done

if [ "$PRINT_ONLY" -eq 0 ]; then
  command -v nginx >/dev/null 2>&1 || die "未安装 nginx，请先安装（apt-get install -y nginx）"
fi

if [ -n "$DOMAIN" ]; then
  [ -n "$TLS_CERT" ] && [ -n "$TLS_KEY" ] || die "给了 --domain 就必须同时给 --tls-cert 与 --tls-key"
  if [ "$PRINT_ONLY" -eq 0 ]; then
    [ -f "$TLS_CERT" ] || die "证书文件不存在：$TLS_CERT"
    [ -f "$TLS_KEY" ]  || die "私钥文件不存在：$TLS_KEY"
  fi
fi

# --- 1. 隧道连通性预检（不通就别装 nginx，免得装完是个空壳）-----------------
if [ "$PRINT_ONLY" -eq 0 ]; then
  log "预检后端 ${BACKEND} ……"
  if curl -fsS --max-time 8 "http://${BACKEND}/api/v1/system/health" >/dev/null 2>&1; then
    log "  ✓ 后端可达（HTTP 200）"
  elif curl -fsS --max-time 8 "http://${BACKEND}/healthz" >/dev/null 2>&1; then
    log "  ✓ 后端可达（/healthz）"
  else
    warn "  ⚠️ 后端 ${BACKEND} 当前不可达 —— 请先在校园机上建立反向隧道。"
    warn "     仍然继续安装 nginx（隧道建好后无需重跑本脚本，reload 即可）。"
  fi
fi

# --- 2. 写配置 ---------------------------------------------------------------
if [ "$PRINT_ONLY" -eq 0 ]; then
  mkdir -p "$NGINX_CONF_DIR"
  if [ -f "$NGINX_CONF" ]; then
    cp -p "$NGINX_CONF" "${NGINX_CONF}.bak.$(date +%Y%m%d-%H%M%S)"
    log "已备份旧配置"
  fi
fi

CONF_TMP="$(mktemp /tmp/nmg-edge-conf.XXXXXX.conf)"
{
  cat <<EOF
# NMG-PKU-Alumni 公网边缘节点（由 infra/scripts/deploy-public-edge.sh 生成）
# 后端 = SSH 反向隧道在公网机上的本地监听端口
upstream nmg_backend {
    server ${BACKEND};
    keepalive 32;
}
EOF

  if [ -n "$DOMAIN" ]; then
    # 有域名 → 80 只做 ACME + 跳转，443 才带 ssl
    cat <<EOF

server {
    listen 80;
    server_name ${DOMAIN};
    # ACME 续期用；正式域名要 80 可达
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl;
    http2 on;
    server_name ${DOMAIN};
    client_max_body_size 20m;

    ssl_certificate     ${TLS_CERT};
    ssl_certificate_key ${TLS_KEY};
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 10m;

    proxy_connect_timeout 10s;
    proxy_send_timeout    60s;
    proxy_read_timeout    60s;

    proxy_http_version 1.1;
    proxy_set_header Host              \$host;
    proxy_set_header X-Real-IP         \$remote_addr;
    proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Connection        "";

    location / {
        proxy_pass http://nmg_backend;
    }
}
EOF
  else
    # 无域名 → 单端口直出（体验版够用）
    cat <<EOF

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

    location / {
        proxy_pass http://nmg_backend;
    }
}
EOF
  fi
} > "$CONF_TMP"

if [ "$PRINT_ONLY" -eq 1 ]; then
  # 只打印配置（供 nginx -t 语法校验 / 代码评审用），不落盘、不动服务
  cat "$CONF_TMP"
  exit 0
fi

mv "$CONF_TMP" "$NGINX_CONF"
log "已写入 ${NGINX_CONF}"

# --- 3. 生效 -----------------------------------------------------------------
nginx -t || die "nginx 配置校验失败（详见上面的输出）"
if command -v systemctl >/dev/null 2>&1 && systemctl is-active nginx >/dev/null 2>&1; then
  systemctl reload nginx
  log "nginx 已 reload"
else
  nginx -s reload 2>/dev/null || nginx
  log "nginx 已重启"
fi

# --- 4. 自检 -----------------------------------------------------------------
sleep 1
if curl -fsS --max-time 8 "http://127.0.0.1:${LISTEN_PORT}/api/v1/system/health" >/dev/null 2>&1; then
  log "=== 边缘节点就绪 ✅ ==="
else
  warn "=== nginx 已启动，但本机回环自检未通过 ==="
  warn "   可能是反向隧道还没建好 —— 建好后重跑本脚本即可。"
  exit 1
fi

log "公网入口："
if [ -n "$DOMAIN" ]; then
  log "  https://${DOMAIN}/        → 管理后台"
  log "  https://${DOMAIN}/api/v1/ → API"
else
  PUBLIC_IP="$(curl -fsS --max-time 5 http://ifconfig.me 2>/dev/null || echo '<公网IP>')"
  log "  http://${PUBLIC_IP}:${LISTEN_PORT}/        → 管理后台（小程序体验时请在后台勾选「不校验合法域名」）"
  log "  http://${PUBLIC_IP}:${LISTEN_PORT}/api/v1/ → API"
fi
