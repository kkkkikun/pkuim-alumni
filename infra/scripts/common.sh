#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 脚本公共库
#
# 用法： source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
#
# 提供：
#   log / die / require_cmd / require_file
#   env_get KEY            从 .env.prod 读取单个键（不 source，避免注入风险）
#   compose ...            带 --project-name / --env-file 的 compose 包装
#   set_env_var KEY VALUE  幂等写入 .env.prod（保留 .env.prod.bak）
#   ssh_remote CMD...      通过 SSH 别名在服务器执行命令
#
# 安全约束：
#   - 不执行任何 prune / volume rm / 全局 compose down
#   - 所有危险动作必须显式带项目作用域（--project-name）
# =============================================================================

set -euo pipefail

# --- 路径 -------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# --- 可覆盖的默认值 ---------------------------------------------------------
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-nmg-pku-alumni}"
COMPOSE_FILE="${COMPOSE_FILE:-${PROJECT_ROOT}/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-${PROJECT_ROOT}/.env.prod}"
ENV_TEMPLATE="${ENV_TEMPLATE:-${PROJECT_ROOT}/infra/env/env.prod.example}"
REMOTE_HOST="${REMOTE_HOST:-sqserver}"
REMOTE_DIR="${REMOTE_DIR:-/home/kikun/MyProject/pkuim-alumni}"
SSH_OPTS="${SSH_OPTS:--o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30}"
NETWORK_NAME="${NETWORK_NAME:-${COMPOSE_PROJECT_NAME}-net}"

# --- 日志 -------------------------------------------------------------------
log()  { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
warn() { printf '[%s] WARN: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }
die()  { printf '[%s] ERROR: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少必需命令：$1"
}

require_file() {
  [ -f "$1" ] || die "缺少必需文件：$1"
}

# --- .env 读取 --------------------------------------------------------------
# 注意：值中不得包含换行；引号不被特殊处理（模板中不要加引号）。
env_get() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 1
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1
}

env_get_or() {
  local key="$1" default="$2" value
  value="$(env_get "$key" || true)"
  [ -n "$value" ] && printf '%s' "$value" || printf '%s' "$default"
}

# --- .env 写入（幂等）------------------------------------------------------
set_env_var() {
  local key="$1" value="$2" tmp
  [ -f "$ENV_FILE" ] || die "环境文件不存在：$ENV_FILE"
  cp -p "$ENV_FILE" "${ENV_FILE}.bak"
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  if grep -q "^${key}=" "$ENV_FILE"; then
    # 使用 | 分隔，避免值中的 / 触发 sed 分隔符冲突
    awk -v k="$key" -v v="$value" '
      BEGIN { FS = OFS = "=" }
      $1 == k { print k "=" v; next }
      { print }
    ' "$ENV_FILE" > "$tmp"
  else
    cp "$ENV_FILE" "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  chmod --reference="$ENV_FILE" "$tmp" 2>/dev/null || chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
  log "已更新 ${ENV_FILE}: ${key}"
}

# --- compose 包装（始终带项目作用域）---------------------------------------
compose() {
  require_cmd docker
  docker compose \
    --project-name "$COMPOSE_PROJECT_NAME" \
    --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" \
    "$@"
}

# --- SSH -------------------------------------------------------------------
ssh_remote() {
  require_cmd ssh
  # shellcheck disable=SC2086
  ssh $SSH_OPTS "$REMOTE_HOST" "$@"
}

rsync_to_remote() {
  require_cmd rsync
  # --delete 只在受保护清单之外生效；.env.prod / backups / node_modules 永不删除
  # shellcheck disable=SC2086
  rsync -az --partial --delete --info=stats2 \
    --exclude '.git/' \
    --exclude '.env' \
    --exclude '.env.prod' \
    --exclude '.env.prod.bak' \
    --exclude '.env.prod.prev' \
    --exclude '.env.prod.rollback-of' \
    --exclude 'backups/' \
    --exclude 'node_modules/' \
    --exclude '**/node_modules/' \
    --exclude '**/dist/' \
    --exclude '**/.vite/' \
    --exclude '**/coverage/' \
    --exclude '**/*.tsbuildinfo' \
    --exclude '*.log' \
    "$@"
}
