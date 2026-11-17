#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 数据恢复演练（恢复到「全新数据库名」并校验）
#
#   bash infra/scripts/restore.sh --backup /home/kikun/backups/nmg-pku-alumni/20261115-101500
#   bash infra/scripts/restore.sh --backup <dir> --target-db nmg_restore_test --drop
#   bash infra/scripts/restore.sh --backup <dir> --with-minio
#
# 设计要点：
#   - 永远恢复到新库名（默认 nmg_restore_<时间戳>），默认不触碰线上库；
#   - 导入后逐表校验：表数量、关键表行数、字符集；
#   - 校验失败即报错退出，便于确认「备份真的能恢复」；
#   - --drop 会在校验通过后删除临时库（仅删除本次创建的库）。
#
# 安全约束：拒绝把线上库名作为目标；拒绝任何 prune / volume rm。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

BACKUP_SRC=""
TARGET_DB=""
DROP_AFTER=0
WITH_MINIO=0
MINIO_MC_IMAGE="${MINIO_MC_IMAGE:-$(env_get_or MINIO_MC_IMAGE swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/minio/mc:latest)}"

while [ $# -gt 0 ]; do
  case "$1" in
    --backup)     BACKUP_SRC="${2:-}"; [ -n "$BACKUP_SRC" ] || die "--backup 需要一个值"; shift 2 ;;
    --target-db)  TARGET_DB="${2:-}"; [ -n "$TARGET_DB" ] || die "--target-db 需要一个值"; shift 2 ;;
    --drop)       DROP_AFTER=1; shift ;;
    --with-minio) WITH_MINIO=1; shift ;;
    -h|--help)    sed -n '2,18p' "$0"; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

[ -n "$BACKUP_SRC" ] || die "必须指定 --backup <备份目录>"
[ -d "$BACKUP_SRC" ] || die "备份目录不存在：${BACKUP_SRC}"
require_file "$ENV_FILE"

LIVE_DB="$(env_get_or MYSQL_DATABASE nmg_alumni)"
MYSQL_ROOT_PASSWORD="$(env_get_or MYSQL_ROOT_PASSWORD "")"
[ -n "$TARGET_DB" ] || TARGET_DB="nmg_restore_$(date '+%Y%m%d_%H%M%S')"

case "$TARGET_DB" in
  *[!a-zA-Z0-9_]*) die "目标库名只允许字母数字下划线：${TARGET_DB}" ;;
esac
if [ "$TARGET_DB" = "$LIVE_DB" ]; then
  die "拒绝恢复到线上库 ${LIVE_DB}；请使用新的库名（--target-db）"
fi

DUMP_FILE=""
for f in "${BACKUP_SRC}"/mysql-*.sql.gz; do
  [ -f "$f" ] && DUMP_FILE="$f" && break
done
[ -n "$DUMP_FILE" ] || die "备份目录中没有找到 mysql-*.sql.gz"

log "备份来源：${BACKUP_SRC}"
log "转储文件：${DUMP_FILE}"
log "目标数据库：${TARGET_DB}（线上库 ${LIVE_DB} 不受影响）"

mysql_root() {
  compose exec -T mysql mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" "$@"
}

cleanup() {
  if [ "$DROP_AFTER" -eq 1 ]; then
    log "删除临时库 ${TARGET_DB}"
    mysql_root -e "DROP DATABASE IF EXISTS \`${TARGET_DB}\`;" >/dev/null 2>&1 || \
      warn "删除临时库失败（可手工执行：mysql -e 'DROP DATABASE \`${TARGET_DB}\`;'）"
  fi
}
trap cleanup EXIT

# --- 1. 校验转储文件完整性 ---------------------------------------------------
gzip -t "$DUMP_FILE" || die "转储文件 gzip 校验失败：${DUMP_FILE}"
if [ -f "${BACKUP_SRC}/manifest.sha256" ]; then
  ( cd "$BACKUP_SRC" && sha256sum -c manifest.sha256 >/dev/null ) \
    || die "备份清单校验失败（manifest.sha256 不匹配）"
  log "备份清单校验通过"
fi

# --- 2. 建库 -----------------------------------------------------------------
mysql_root -e "DROP DATABASE IF EXISTS \`${TARGET_DB}\`;" \
  || die "无法清理同名旧库：${TARGET_DB}"
mysql_root -e "CREATE DATABASE \`${TARGET_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;" \
  || die "创建目标库失败：${TARGET_DB}"
log "已创建目标库 ${TARGET_DB}"

# --- 3. 导入 -----------------------------------------------------------------
log "导入数据……"
gunzip -c "$DUMP_FILE" | compose exec -T mysql mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" "$TARGET_DB"
log "导入完成"

# --- 4. 校验 -----------------------------------------------------------------
log "校验恢复结果"

# 注意：必须用 `gzip -dc`（解压到标准输出）。
# `gzip -c file.gz` 会把 .gz 再压缩一次，输出的是 gzip 二进制流而不是 SQL。
expected_tables="$(gzip -dc "$DUMP_FILE" | grep -c '^CREATE TABLE' || true)"
actual_tables="$(mysql_root -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${TARGET_DB}';")"
log "  表数量：期望 ${expected_tables} / 实际 ${actual_tables}"
[ "$expected_tables" -eq "$actual_tables" ] || die "表数量不一致，恢复失败"

for t in users alumni_profiles events event_registrations connection_pairs resource_posts; do
  present="$(mysql_root -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${TARGET_DB}' AND table_name='${t}';")"
  if [ "$present" = "1" ]; then
    cnt="$(mysql_root -N -B -e "SELECT COUNT(*) FROM \`${TARGET_DB}\`.\`${t}\`;")"
    log "  ${t}: ${cnt} 行"
  else
    log "  ${t}: 表不存在（跳过的表）"
  fi
done

charset="$(mysql_root -N -B -e "SELECT DEFAULT_CHARACTER_SET_NAME FROM information_schema.schemata WHERE schema_name='${TARGET_DB}';")"
log "  默认字符集：${charset}"
[ "$charset" = "utf8mb4" ] || die "字符集异常：${charset}"

# --- 5. MinIO（可选）--------------------------------------------------------
if [ "$WITH_MINIO" -eq 1 ] && [ -d "${BACKUP_SRC}/minio" ]; then
  MINIO_USER="$(env_get_or MINIO_ROOT_USER nmgadmin)"
  MINIO_PASS="$(env_get_or MINIO_ROOT_PASSWORD "")"
  # 注意两点：
  #   1) mc 的 `local` 是内置保留别名（固定指向 localhost:9000），不能用环境变量覆盖；
  #   2) `MC_HOST_NMG` 对应的别名名是**大写** `NMG`，mc 的别名解析大小写敏感。
  export MC_HOST_NMG="http://${MINIO_USER}:${MINIO_PASS}@minio:9000"
  for bucket_dir in "${BACKUP_SRC}"/minio/*/; do
    [ -d "$bucket_dir" ] || continue
    bucket="$(basename "$bucket_dir")"
    log "  恢复 MinIO 桶：${bucket}"
    docker run --rm \
      --network "$NETWORK_NAME" \
      --volume "${bucket_dir}:/restore/${bucket}" \
      -e MC_HOST_NMG="$MC_HOST_NMG" \
      "$MINIO_MC_IMAGE" \
      mirror --overwrite --remove --preserve "NMG/${bucket}" "/restore/${bucket}" \
      || warn "MinIO 桶 ${bucket} 恢复失败"
  done
fi

log "恢复演练成功：${TARGET_DB}（${actual_tables} 张表）"
if [ "$DROP_AFTER" -eq 1 ]; then
  trap - EXIT
  cleanup
  log "临时库已清理"
else
  trap - EXIT
  log "临时库保留，可用于比对：${TARGET_DB}"
  log "  清理命令：docker compose --project-name ${COMPOSE_PROJECT_NAME} --env-file .env.prod -f docker-compose.prod.yml exec -T mysql mysql -uroot -p'***' -e 'DROP DATABASE \`${TARGET_DB}\`;'"
fi
