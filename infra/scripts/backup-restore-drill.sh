#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 一键恢复演练
#
#   bash infra/scripts/backup-restore-drill.sh
#   bash infra/scripts/backup-restore-drill.sh --keep        # 保留演练库供比对
#   bash infra/scripts/backup-restore-drill.sh --no-backup    # 用最近一次备份演练
#   bash infra/scripts/backup-restore-drill.sh --target-db nmg_restore_drill2
#   bash infra/scripts/backup-restore-drill.sh --compare-only # 只比对已存在的演练库
#
# 演练步骤：
#   1. 生成一份新备份（除非 --no-backup / --compare-only）；
#   2. 恢复到**全新数据库名**（演练库，除非 --compare-only）；
#   3. 逐项比对源库与演练库：
#        - 表数量
#        - **全部表**逐表行数
#        - 列结构指纹（表名/列名/类型/可空/默认值/键位）
#        - 外键定义指纹（约束名/列/被引用表/被引用列）
#        - 索引指纹
#        - 迁移记录数与内容
#        - 默认字符集
#   4. 删除演练库（除非 --keep / --compare-only），线上库全程只读。
#
# 目的：把「备份真的能恢复」从一次性的人工演练变成可重复执行的常规检查。
#
# 退出码：0 演练通过；1 演练失败（备份/恢复/比对任一环节不通过）。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

TARGET_DB="nmg_restore_drill"
DO_BACKUP=1
KEEP=0
COMPARE_ONLY=0
DRILL_CREATED=0
FAILED=0

while [ $# -gt 0 ]; do
  case "$1" in
    --keep)      KEEP=1; shift ;;
    --no-backup) DO_BACKUP=0; shift ;;
    --compare-only) COMPARE_ONLY=1; shift ;;
    --target-db) TARGET_DB="${2:-}"; [ -n "$TARGET_DB" ] || die "--target-db 需要一个值"; shift 2 ;;
    -h|--help)   sed -n '2,30p' "$0"; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

require_cmd docker
DB_NAME="$(env_get_or MYSQL_DATABASE nmg_alumni)"
BACKUP_ROOT="$(env_get_or BACKUP_ROOT "${HOME}/backups/nmg-pku-alumni")"

# --- 安全护栏 ---------------------------------------------------------------
# 1) 演练库名不能与线上库相同
[ "$TARGET_DB" != "$DB_NAME" ] || die "演练库名不能与线上库名相同：${TARGET_DB}"
# 2) 演练库名必须带「演练」语义
case "$TARGET_DB" in
  *restore*|*drill*) : ;;
  *) die "演练库名必须包含 restore 或 drill 字样：${TARGET_DB}" ;;
esac
# 3) 演练库名只允许字母数字与下划线（避免 SQL 注入 / 引号转义问题）
case "$TARGET_DB" in
  *[!A-Za-z0-9_]*) die "演练库名只能包含字母、数字与下划线：${TARGET_DB}" ;;
esac

# --- SQL 执行助手 -----------------------------------------------------------
# 在 MySQL 容器内执行一条 SQL，返回纯文本结果。
# SQL 通过 stdin 传入（不经多层 shell 解析），表名反引号等字符不会被吃掉。
# 任何错误都显式抛出（不依赖 pipefail 静默退出），并过滤密码告警噪声。
mysql_query() {
  local db="$1" sql="$2" out
  out="$(printf '%s\n' "SET SESSION group_concat_max_len=4194304;" "$sql" \
    | compose exec -T mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -B "$1"' sh "$db" 2>&1 \
    | grep -v 'Using a password on the command line' || true)"
  if printf '%s' "$out" | grep -q 'ERROR'; then
    warn "SQL 执行失败（库=${db}）：$(printf '%s' "$out" | head -3 | tr '\n' ' ')"
    return 1
  fi
  printf '%s\n' "$out"
}

# 单值查询：结果取最后一行
sql_scalar() {
  mysql_query "$1" "$2" | tail -1
}

# 多值查询：结果逐行输出
sql_rows() {
  mysql_query "$1" "$2" | sed '/^$/d'
}

# --- 演练库清理（无论成功失败都执行，--keep 时保留）------------------------
drop_drill_db() {
  compose exec -T mysql sh -c \
    "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -e 'DROP DATABASE IF EXISTS ${TARGET_DB};'" \
    >/dev/null 2>&1 || warn "演练库删除失败，请手动清理：${TARGET_DB}"
}

on_exit() {
  if [ "$KEEP" -eq 0 ] && [ "$DRILL_CREATED" -eq 1 ]; then
    drop_drill_db
  fi
}
trap on_exit EXIT

log "=== 恢复演练开始（线上库=${DB_NAME}，演练库=${TARGET_DB}）==="

BACKUP_DIR="-"
if [ "$COMPARE_ONLY" -eq 0 ]; then
  # --- 1. 备份 -------------------------------------------------------------
  if [ "$DO_BACKUP" -eq 1 ]; then
    log "第 1 步：生成新备份……"
    bash "${PROJECT_ROOT}/infra/scripts/backup.sh" >/dev/null 2>&1 || die "备份失败"
  else
    log "第 1 步：使用最近一次备份……"
  fi
  BACKUP_DIR="$(ls -1dt "${BACKUP_ROOT}"/*/ 2>/dev/null | head -1)"
  [ -n "$BACKUP_DIR" ] || die "备份根目录下没有任何备份：${BACKUP_ROOT}"
  BACKUP_DIR="${BACKUP_DIR%/}"
  log "备份目录：${BACKUP_DIR}"

  # --- 2. 恢复 -------------------------------------------------------------
  log "第 2 步：恢复到演练库 ${TARGET_DB} ……"
  bash "${PROJECT_ROOT}/infra/scripts/restore.sh" --backup "${BACKUP_DIR}" --target-db "${TARGET_DB}" \
    | grep -v 'Using a password on the command line' | sed 's/^/  /'
  DRILL_CREATED=1
else
  log "只比对模式：使用已存在的演练库 ${TARGET_DB}（不备份、不恢复、不删除）"
  if [ -z "$(sql_rows "$DB_NAME" "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${TARGET_DB}';")" ]; then
    die "演练库不存在：${TARGET_DB}"
  fi
fi

# --- 3. 比对 -----------------------------------------------------------------
log "第 3 步：逐项比对源库与演练库……"

check_same() {
  local label="$1" tpl="$2" src dst
  # tpl 中的 __DB__ 占位符会被替换为当前被查询的库名，
  # 否则在演练库上执行时仍会读到源库的元数据，导致指纹校验恒等成立。
  if ! src="$(sql_scalar "$DB_NAME" "${tpl//__DB__/$DB_NAME}")" || [ -z "$src" ]; then
    warn "  ✗ ${label}：源库查询失败"
    FAILED=1
    return
  fi
  if ! dst="$(sql_scalar "$TARGET_DB" "${tpl//__DB__/$TARGET_DB}")" || [ -z "$dst" ]; then
    warn "  ✗ ${label}：演练库查询失败"
    FAILED=1
    return
  fi
  if [ "$src" = "$dst" ]; then
    log "  ✓ ${label}：${src}"
  else
    warn "  ✗ ${label}：源库=${src} 演练库=${dst}"
    FAILED=1
  fi
}

# 3.1 表数量
check_same "表数量" "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='__DB__';"

# 3.2 全部表逐表行数比对（不维护手工表名清单，新增表自动纳入）
SRC_TABLES="$(sql_rows "$DB_NAME" "SELECT table_name FROM information_schema.tables WHERE table_schema='${DB_NAME}' ORDER BY table_name;")"
[ -n "$SRC_TABLES" ] || { warn "无法读取源库表清单"; FAILED=1; }
TABLE_ROWS=0
for t in $SRC_TABLES; do
  src="$(sql_scalar "$DB_NAME" "SELECT COUNT(*) FROM \`${t}\`;")" || { FAILED=1; continue; }
  dst="$(sql_scalar "$TARGET_DB" "SELECT COUNT(*) FROM \`${t}\`;")" || { FAILED=1; continue; }
  if [ "$src" != "$dst" ]; then
    warn "  ✗ 表 ${t} 行数：源库=${src} 演练库=${dst}"
    FAILED=1
  else
    TABLE_ROWS=$((TABLE_ROWS + 1))
  fi
done
if [ "$FAILED" -eq 0 ]; then
  log "  ✓ 逐表行数：${TABLE_ROWS} 张表行数完全一致"
fi

# 3.3 列结构指纹（列名/类型/可空/默认值/键位/额外属性）
check_same "列结构指纹" \
  "SELECT MD5(GROUP_CONCAT(CONCAT_WS('#', TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, IFNULL(COLUMN_DEFAULT, '~'), COLUMN_KEY, EXTRA) ORDER BY TABLE_NAME, ORDINAL_POSITION)) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='__DB__';"

# 3.4 外键定义指纹
check_same "外键定义指纹" \
  "SELECT MD5(GROUP_CONCAT(CONCAT_WS('#', TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME) ORDER BY TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME)) FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA='__DB__' AND REFERENCED_TABLE_NAME IS NOT NULL;"

# 3.5 索引指纹
check_same "索引指纹" \
  "SELECT MD5(GROUP_CONCAT(CONCAT_WS('#', TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, NON_UNIQUE) ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX)) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='__DB__';"

# 3.6 迁移记录数与内容
check_same "迁移记录数" "SELECT COUNT(*) FROM migrations;"
check_same "迁移记录内容" \
  "SELECT MD5(GROUP_CONCAT(CONCAT_WS('#', name, timestamp) ORDER BY timestamp)) FROM migrations;"

# 3.7 默认字符集
SRC_CHARSET="$(sql_scalar "$DB_NAME" "SELECT DEFAULT_CHARACTER_SET_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${DB_NAME}';")"
DST_CHARSET="$(sql_scalar "$TARGET_DB" "SELECT DEFAULT_CHARACTER_SET_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${TARGET_DB}';")"
if [ -n "$SRC_CHARSET" ] && [ "$SRC_CHARSET" = "$DST_CHARSET" ]; then
  log "  ✓ 默认字符集：${SRC_CHARSET}"
else
  warn "  ✗ 默认字符集：源库=${SRC_CHARSET} 演练库=${DST_CHARSET}"
  FAILED=1
fi

# --- 4. 清理 -----------------------------------------------------------------
if [ "$KEEP" -eq 1 ] || [ "$COMPARE_ONLY" -eq 1 ]; then
  log "第 4 步：按要求保留演练库 ${TARGET_DB}"
  DRILL_CREATED=0
else
  log "第 4 步：删除演练库 ${TARGET_DB} ……"
  drop_drill_db
  DRILL_CREATED=0
  if [ -n "$(sql_rows "$DB_NAME" "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${TARGET_DB}';")" ]; then
    warn "  ✗ 演练库仍然存在，请手动清理：${TARGET_DB}"
    FAILED=1
  else
    log "  ✓ 演练库已清理"
  fi
fi

if [ "$FAILED" -ne 0 ]; then
  die "恢复演练失败：存在比对不一致项"
fi

log "=== 恢复演练通过 ✅（备份 ${BACKUP_DIR} → ${TARGET_DB} → 比对一致）==="
