#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 版本回滚
#
# 在服务器上执行：
#   bash infra/scripts/rollback.sh                 # 回滚到 .env.prod.prev 记录的版本
#   bash infra/scripts/rollback.sh --wait --timeout 300
#
# 原理：build.sh 每次构建前会把「上一版本的镜像标签」写入 .env.prod.prev；
#       回滚即恢复该文件中的镜像标签并重新拉起服务。
#
# 安全约束：
#   - 只切换镜像标签，不删除任何数据卷；
#   - 数据卷（MySQL/Redis/MinIO）保持原样，回滚不会破坏数据；
#   - 不执行 prune / volume rm。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

PREV_FILE="${PREV_FILE:-${PROJECT_ROOT}/.env.prod.prev}"
WAIT=0
TIMEOUT="${HEALTHCHECK_TIMEOUT:-300}"

while [ $# -gt 0 ]; do
  case "$1" in
    --wait)    WAIT=1; shift ;;
    --timeout) TIMEOUT="${2:-}"; [ -n "$TIMEOUT" ] || die "--timeout 需要一个值"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

require_file "$ENV_FILE"
require_file "$PREV_FILE"

read_prev() {
  sed -n "s/^$1=//p" "$PREV_FILE" | tail -n 1
}

PREV_TAG="$(read_prev RELEASE_TAG)"
PREV_API="$(read_prev API_IMAGE)"
PREV_WORKER="$(read_prev WORKER_IMAGE)"
PREV_ADMIN="$(read_prev ADMIN_WEB_IMAGE)"

[ -n "$PREV_API" ] || die "回滚记录不完整（缺少 API_IMAGE）：${PREV_FILE}"

log "回滚目标版本：${PREV_TAG}"
log "  API        ${PREV_API}"
log "  Worker     ${PREV_WORKER}"
log "  Admin Web  ${PREV_ADMIN}"

# 确认镜像仍在本地（服务器无法访问外部仓库时尤其重要）
for img in "$PREV_API" "$PREV_WORKER" "$PREV_ADMIN"; do
  [ -n "$img" ] || continue
  if docker image inspect "$img" >/dev/null 2>&1; then
    log "镜像存在：${img}"
  else
    warn "镜像不存在（可能已被清理）：${img} —— 回滚后需要重新构建"
  fi
done

# 记录当前版本，便于「回滚回滚」
{
  printf 'RELEASE_TAG=%s\n' "$(env_get_or RELEASE_TAG "")"
  printf 'API_IMAGE=%s\n' "$(env_get_or API_IMAGE "")"
  printf 'WORKER_IMAGE=%s\n' "$(env_get_or WORKER_IMAGE "")"
  printf 'ADMIN_WEB_IMAGE=%s\n' "$(env_get_or ADMIN_WEB_IMAGE "")"
} > "${PROJECT_ROOT}/.env.prod.rollback-of"
chmod 600 "${PROJECT_ROOT}/.env.prod.rollback-of"

set_env_var RELEASE_TAG      "$PREV_TAG"
set_env_var API_IMAGE       "$PREV_API"
set_env_var WORKER_IMAGE    "$PREV_WORKER"
set_env_var ADMIN_WEB_IMAGE "$PREV_ADMIN"

log "拉起回滚后的服务"
compose up -d --no-build --remove-orphans
compose ps

if [ "$WAIT" -eq 1 ]; then
  bash "${SCRIPT_DIR}/healthcheck.sh" --wait --timeout "$TIMEOUT"
fi

log "回滚完成（RELEASE_TAG=${PREV_TAG}）"
