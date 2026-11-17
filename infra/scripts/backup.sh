#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 数据备份（MySQL + MinIO + 配置文件）
#
# 在服务器上执行：
#   bash infra/scripts/backup.sh
#   BACKUP_DIR=/data/backups RETENTION_DAYS=14 bash infra/scripts/backup.sh
#
# 产物：${BACKUP_DIR}/<时间戳>/
#   mysql-<db>.sql.gz      mysqldump（--single-transaction 一致性快照）
#   minio/<bucket>/        对象存储镜像
#   config/                docker-compose.prod.yml + infra/ + .env.prod(600)
#   manifest.sha256        校验清单
#
# 保留策略：删除早于 RETENTION_DAYS 的备份目录（仅限 BACKUP_DIR 内部、且目录名
#          必须匹配时间戳格式，避免误删其它路径）。
#
# 安全约束：不 prune 容器/卷；不触碰 swload-* 项目的任何数据。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

BACKUP_ROOT="${BACKUP_DIR:-$(env_get_or BACKUP_DIR /home/kikun/backups/nmg-pku-alumni)}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-$(env_get_or BACKUP_RETENTION_DAYS 7)}"
MINIO_MC_IMAGE="${MINIO_MC_IMAGE:-$(env_get_or MINIO_MC_IMAGE swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/minio/mc:latest)}"
WITH_MINIO="${WITH_MINIO:-1}"
WITH_CONFIG="${WITH_CONFIG:-1}"

TS="$(date '+%Y%m%d-%H%M%S')"
TARGET_DIR="${BACKUP_ROOT}/${TS}"

require_cmd docker
require_cmd gzip
require_file "$ENV_FILE"

case "$BACKUP_ROOT" in
  /*) : ;;
  *) die "BACKUP_DIR 必须是绝对路径：${BACKUP_ROOT}" ;;
esac
case "$RETENTION_DAYS" in
  ''|*[!0-9]*) die "BACKUP_RETENTION_DAYS 必须是非负整数" ;;
esac

mkdir -p "${TARGET_DIR}/minio" "${TARGET_DIR}/config"
chmod 700 "$TARGET_DIR"

log "备份目录：${TARGET_DIR}"

# --- 1. MySQL ----------------------------------------------------------------
DB_NAME="$(env_get_or MYSQL_DATABASE nmg_alumni)"
MYSQL_ROOT_PASSWORD="$(env_get_or MYSQL_ROOT_PASSWORD "")"
DUMP_FILE="${TARGET_DIR}/mysql-${DB_NAME}.sql.gz"

log "导出 MySQL 数据库 ${DB_NAME}"
compose exec -T mysql mysqldump \
  --single-transaction \
  --quick \
  --routines \
  --events \
  --triggers \
  --no-tablespaces \
  --set-gtid-purged=OFF \
  --default-character-set=utf8mb4 \
  -uroot -p"${MYSQL_ROOT_PASSWORD}" \
  "${DB_NAME}" | gzip -9 > "$DUMP_FILE"

if [ ! -s "$DUMP_FILE" ]; then
  die "MySQL 备份为空，终止（保留现场目录 ${TARGET_DIR}）"
fi
gzip -t "$DUMP_FILE" || die "MySQL 备份 gzip 校验失败"
log "MySQL 备份完成：$(du -h "$DUMP_FILE" | cut -f1)"

# --- 2. MinIO ---------------------------------------------------------------
if [ "$WITH_MINIO" = "1" ]; then
  MINIO_USER="$(env_get_or MINIO_ROOT_USER nmgadmin)"
  MINIO_PASS="$(env_get_or MINIO_ROOT_PASSWORD "")"
  BUCKET_PUBLIC="$(env_get_or MINIO_BUCKET_PUBLIC nmg-public)"
  BUCKET_PRIVATE="$(env_get_or MINIO_BUCKET_PRIVATE nmg-private)"
  # 注意两点：
  #   1) mc 的 `local` 是内置保留别名（固定指向 localhost:9000），不能用环境变量覆盖；
  #   2) `MC_HOST_NMG` 对应的别名名是**大写** `NMG`，mc 的别名解析大小写敏感。
  export MC_HOST_NMG="http://${MINIO_USER}:${MINIO_PASS}@minio:9000"

  for bucket in "$BUCKET_PUBLIC" "$BUCKET_PRIVATE"; do
    log "镜像 MinIO 桶：${bucket}"
    mkdir -p "${TARGET_DIR}/minio/${bucket}"
    if ! docker run --rm \
      --network "$NETWORK_NAME" \
      --volume "${TARGET_DIR}/minio/${bucket}:/backup/${bucket}" \
      -e MC_HOST_NMG="$MC_HOST_NMG" \
      "$MINIO_MC_IMAGE" \
      mirror --overwrite --remove --preserve "NMG/${bucket}" "/backup/${bucket}"; then
      warn "MinIO 桶 ${bucket} 镜像失败（请检查镜像源可达性与桶名）"
    fi
  done
fi

# --- 3. 配置文件 -------------------------------------------------------------
if [ "$WITH_CONFIG" = "1" ]; then
  log "备份配置文件"
  cp -p "${PROJECT_ROOT}/docker-compose.prod.yml" "${TARGET_DIR}/config/" 2>/dev/null || true
  cp -p "${PROJECT_ROOT}/docker-compose.yml"       "${TARGET_DIR}/config/" 2>/dev/null || true
  if [ -d "${PROJECT_ROOT}/infra" ]; then
    cp -rp "${PROJECT_ROOT}/infra" "${TARGET_DIR}/config/" 2>/dev/null || true
  fi
  if [ -f "$ENV_FILE" ]; then
    cp -p "$ENV_FILE" "${TARGET_DIR}/config/env.prod"
    chmod 600 "${TARGET_DIR}/config/env.prod"
  fi
fi

# --- 4. 校验清单 -------------------------------------------------------------
log "生成校验清单"
( cd "$TARGET_DIR" && find . -type f ! -name 'manifest.sha256' -print0 \
    | sort -z | xargs -0 -r sha256sum > manifest.sha256 )
( cd "$TARGET_DIR" && sha256sum -c manifest.sha256 >/dev/null ) || die "备份校验失败"

printf 'created_at=%s\ndb=%s\nproject=%s\n' "$TS" "$DB_NAME" "$COMPOSE_PROJECT_NAME" \
  > "${TARGET_DIR}/manifest.meta"

log "备份完成并通过校验：${TARGET_DIR}"

# --- 5. 保留策略 -------------------------------------------------------------
if [ "$RETENTION_DAYS" -gt 0 ]; then
  log "清理早于 ${RETENTION_DAYS} 天的备份"
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    base="$(basename "$old")"
    # 仅删除时间戳命名的目录，且必须位于 BACKUP_ROOT 之内
    case "$base" in
      [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]) : ;;
      *) warn "跳过非时间戳目录：${old}"; continue ;;
    esac
    case "$old" in
      "${BACKUP_ROOT}"/*) rm -rf -- "$old"; log "已删除过期备份：${old}" ;;
      *) warn "跳过越界路径：${old}" ;;
    esac
  done < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+${RETENTION_DAYS}" 2>/dev/null || true)
fi

log "当前备份："
ls -1 "${BACKUP_ROOT}" 2>/dev/null | sed 's/^/  /' || true
