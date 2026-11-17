#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 初始化测试数据（Seed）
#
# 在服务器上执行：
#   bash infra/scripts/seed.sh                     # 只跑 Seed
#   bash infra/scripts/seed.sh --migrate           # 先迁移再 Seed
#   bash infra/scripts/seed.sh --command "node apps/api/dist/seed.js"
#
# 实现：在一次性容器中执行 `docker compose run --rm api <命令>`，
#       复用 api 服务相同的环境变量与网络（不改任何在跑的服务）。
#
# 安全约束：不删除数据库；不触碰线上卷；Seed 数据仅用于测试环境。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

RUN_MIGRATE=0
SEED_COMMAND="${SEED_COMMAND:-pnpm --filter @nmg/api run db:seed}"
MIGRATION_COMMAND="${MIGRATION_COMMAND:-pnpm --filter @nmg/api run db:migrate}"

while [ $# -gt 0 ]; do
  case "$1" in
    --migrate)  RUN_MIGRATE=1; shift ;;
    --command)  SEED_COMMAND="${2:-}"; [ -n "$SEED_COMMAND" ] || die "--command 需要一个值"; shift 2 ;;
    --migration-command) MIGRATION_COMMAND="${2:-}"; [ -n "$MIGRATION_COMMAND" ] || die "--migration-command 需要一个值"; shift 2 ;;
    -h|--help)  sed -n '2,16p' "$0"; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

require_cmd docker
require_file "$ENV_FILE"

log "确认数据库与缓存健康……"
compose ps mysql redis minio

# -----------------------------------------------------------------------------
# 在一次性容器中执行命令：`docker compose run --rm api <cmd>`（首选）。
# 某些 Compose 版本在服务定义了 container_name 时拒绝 run，此时降级为
# 在**正在运行的** api 容器内 exec 执行同一条命令，效果等价。
# -----------------------------------------------------------------------------
run_in_api() {
  local cmd="$1" label="$2" out rc
  set +e
  out="$(compose run --rm --workdir /app api sh -lc "${cmd}" 2>&1)"
  rc=$?
  set -e
  printf '%s\n' "$out"
  if [ "$rc" -eq 0 ]; then
    return 0
  fi
  if printf '%s' "$out" | grep -qi 'container_name'; then
    warn "compose run 与 container_name 冲突，降级为在运行中的 api 容器内执行"
    set +e
    compose exec -T --workdir /app api sh -lc "${cmd}"
    rc=$?
    set -e
    return "$rc"
  fi
  return "$rc"
}

if [ "$RUN_MIGRATE" -eq 1 ]; then
  log "执行数据库迁移：${MIGRATION_COMMAND}"
  run_in_api "${MIGRATION_COMMAND}" "迁移" || die "迁移失败"
  log "迁移完成"
fi

log "执行 Seed：${SEED_COMMAND}"
run_in_api "${SEED_COMMAND}" "Seed" || die "Seed 执行失败"

log "Seed 完成"
log "校验数据量："
compose exec -T mysql mysql -uroot -p"$(env_get_or MYSQL_ROOT_PASSWORD "")" \
  -e "USE \`$(env_get_or MYSQL_DATABASE nmg_alumni)\`; SELECT 'users' t, COUNT(*) n FROM users UNION ALL SELECT 'alumni_profiles', COUNT(*) FROM alumni_profiles UNION ALL SELECT 'events', COUNT(*) FROM events UNION ALL SELECT 'resource_posts', COUNT(*) FROM resource_posts;" \
  2>/dev/null || warn "数据量统计失败（表可能尚未创建）"
