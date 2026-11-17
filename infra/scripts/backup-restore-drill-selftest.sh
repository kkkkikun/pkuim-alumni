#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 恢复演练校验器的反向验证（自测）
#
#   bash infra/scripts/backup-restore-drill-selftest.sh
#
# 目的：证明 backup-restore-drill.sh 的比对逻辑**不是恒过**——
#       演练库一旦出现真实差异，校验器必须报错并返回非 0 退出码。
#
# 流程：
#   1. 正常演练并保留演练库（期望退出码 0）；
#   2. 在完好的演练库上跑 --compare-only（期望退出码 0，作为正向基线）；
#   3. 向演练库注入真实缺陷：
#        - 数据行数差异：删除一条 event_registrations
#        - 结构差异：修改 users.nickname 列类型
#   4. 再跑 --compare-only（期望退出码 1，且输出中出现 ✗）；
#   5. 清理演练库，线上库全程只读。
#
# 退出码：0 自测通过（校验器确实能抓出缺陷）；1 自测失败。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

DRILL_DB="nmg_restore_drill_selftest"
DRILL_SCRIPT="${PROJECT_ROOT}/infra/scripts/backup-restore-drill.sh"
FAILED=0

require_cmd docker
DB_NAME="$(env_get_or MYSQL_DATABASE nmg_alumni)"

drop_db() {
  compose exec -T mysql sh -c \
    "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -e 'DROP DATABASE IF EXISTS ${DRILL_DB};'" \
    >/dev/null 2>&1 || warn "清理演练库失败：${DRILL_DB}"
}

on_exit() { drop_db; }
trap on_exit EXIT

# 期望校验器在缺陷库上失败：退出码非 0，且输出命中关键词
expect_mismatch() {
  local label="$1" keyword="$2" out rc
  set +e
  out="$(bash "$DRILL_SCRIPT" --target-db "$DRILL_DB" --compare-only 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    log "  ✓ ${label}：校验器返回非 0 退出码（${rc}）"
  else
    warn "  ✗ ${label}：校验器对缺陷库返回了 0——比对逻辑恒过，不可信"
    FAILED=1
  fi
  if printf '%s' "$out" | grep -q "$keyword"; then
    log "  ✓ ${label}：输出命中「${keyword}」"
    printf '%s\n' "$out" | grep "$keyword" | sed 's/^/      /'
  else
    warn "  ✗ ${label}：输出中未命中「${keyword}」，差异未被正确定位"
    FAILED=1
  fi
}

log "=== 恢复演练校验器反向验证开始 ==="

# --- 1. 正常演练（保留演练库）-----------------------------------------------
log "[1/5] 正常演练（保留演练库 ${DRILL_DB}）……"
if bash "$DRILL_SCRIPT" --target-db "$DRILL_DB" --keep >/dev/null 2>&1; then
  log "  ✓ 正常演练退出码 0"
else
  warn "  ✗ 正常演练退出码非 0（演练本身有问题）"
  FAILED=1
fi

# --- 2. 正向基线：完好的演练库应当比对通过 ---------------------------------
log "[2/5] 正向基线：完好演练库跑 --compare-only（期望退出码 0）……"
if bash "$DRILL_SCRIPT" --target-db "$DRILL_DB" --compare-only >/dev/null 2>&1; then
  log "  ✓ 完好演练库比对通过（退出码 0）"
else
  warn "  ✗ 完好演练库竟然比对失败——比对逻辑有问题"
  FAILED=1
fi

# --- 3. 注入真实缺陷 A：数据行数差异 ----------------------------------------
log "[3/6] 注入缺陷 A：删除一条 event_registrations（期望比对报「行数」不一致）……"
compose exec -T mysql sh -c \
  "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -e 'DELETE FROM ${DRILL_DB}.event_registrations LIMIT 1;'" \
  >/dev/null 2>&1 || { warn "  ✗ 缺陷 A 注入失败"; FAILED=1; }

expect_mismatch "缺陷 A" "行数"

# --- 4. 回到完好状态，为第二轮注入做准备 -----------------------------------
log "[4/6] 重新演练以回到完好状态（期望退出码 0）……"
drop_db
if bash "$DRILL_SCRIPT" --target-db "$DRILL_DB" --keep >/dev/null 2>&1; then
  log "  ✓ 重新演练退出码 0"
else
  warn "  ✗ 重新演练退出码非 0"
  FAILED=1
fi

# --- 5. 注入真实缺陷 B：结构差异 --------------------------------------------
log "[5/6] 注入缺陷 B：修改 users.nickname 列类型（期望比对报「列结构指纹」不一致）……"
compose exec -T mysql sh -c \
  "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -e 'ALTER TABLE ${DRILL_DB}.users MODIFY COLUMN nickname VARCHAR(255);'" \
  >/dev/null 2>&1 || { warn "  ✗ 缺陷 B 注入失败"; FAILED=1; }

expect_mismatch "缺陷 B" "列结构指纹"

# --- 6. 清理 -----------------------------------------------------------------
log "[6/6] 清理演练库 ${DRILL_DB} ……"
drop_db
trap - EXIT

if [ "$FAILED" -ne 0 ]; then
  die "反向验证失败：校验器未能可靠抓出差异"
fi

log "=== 反向验证通过 ✅（注入的行数/结构缺陷均被抓出，退出码非 0）==="
