#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 生成 .env.prod（幂等）
#
#   bash infra/scripts/init-env.sh            # 不存在则创建
#   bash infra/scripts/init-env.sh --force    # 已存在则重新生成密钥
#
# 行为：
#   - 以 infra/env/env.prod.example 为模板
#   - 为 JWT_SECRET / MYSQL_ROOT_PASSWORD / MYSQL_PASSWORD / REDIS_PASSWORD /
#     MINIO_ROOT_PASSWORD 生成随机值
#   - 已存在的 .env.prod 不会被覆盖（除非 --force，且会先备份）
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "未知参数：$arg" ;;
  esac
done

require_file "$ENV_TEMPLATE"

gen_secret() {
  local len="${1:-32}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$((len / 2))"
  else
    head -c "$len" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

if [ -f "$ENV_FILE" ] && [ "$FORCE" -eq 0 ]; then
  log ".env.prod 已存在，未做修改：${ENV_FILE}"
  exit 0
fi

if [ -f "$ENV_FILE" ]; then
  cp -p "$ENV_FILE" "${ENV_FILE}.bak.$(date '+%Y%m%d%H%M%S')"
  log "已备份原 .env.prod"
fi

tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
cp "$ENV_TEMPLATE" "$tmp"

replace_in_file() {
  local key="$1" value="$2" file="$3"
  awk -v k="$key" -v v="$value" '
    BEGIN { FS = OFS = "=" }
    $1 == k { print k "=" v; next }
    { print }
  ' "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
}

replace_in_file MYSQL_ROOT_PASSWORD "$(gen_secret 24)" "$tmp"
replace_in_file MYSQL_PASSWORD     "$(gen_secret 24)" "$tmp"
replace_in_file REDIS_PASSWORD     "$(gen_secret 24)" "$tmp"
replace_in_file MINIO_ROOT_PASSWORD "$(gen_secret 24)" "$tmp"
replace_in_file JWT_SECRET         "$(gen_secret 32)" "$tmp"

chmod 600 "$tmp"
mv "$tmp" "$ENV_FILE"

log "已生成 ${ENV_FILE}（权限 600，随机密钥已写入）"
log "请复核 JWT_SECRET / MYSQL_PASSWORD 等值后再启动服务。"
