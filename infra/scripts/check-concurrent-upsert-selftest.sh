#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 「先查后插」并发撞唯一键校验器的反向验证（自测）
#
#   bash infra/scripts/check-concurrent-upsert-selftest.sh
#
# 目的：证明 `check-concurrent-upsert.mjs` **不是恒过**——
#       当「先查后插」没有唯一键兜底时，它必须**报出来**；
#       同时证明它**不吵**——「读 A 校验、往 B 插子行」这种安全形态不得误报。
#
# 为什么这个校验器值得单测：
#   缺陷 #137 就是这种形态 —— 「先查后插」在单线程下永远正确，
#   并发下才撞唯一键。单线程测试覆盖不到，用例再全也测不出来。
#   而且这类形态在代码里会**重复出现**（修一处还有下一处），
#   只能由工具兜住。
#
# 三段式：
#   [0/3] 正向基线：干净副本 → 退出码 0，且不得出现 CONCURRENT_UPSERT；
#   [1/3] 注入「先查后插且无兜底」→ 必须退出码非 0 且命中 CONCURRENT_UPSERT；
#   [2/3] 注入「读 A 插 B 的安全形态」→ 必须退出码 0（**防误报**）；
#   [3/3] 元自检 + 清理。
#
# 安全约束：只在临时目录里的副本上改动，真实工作副本永远只读；全程不碰数据库。
#
# 退出码：0 自测通过；1 自测失败（校验器恒过、报错不准，或误报）。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

SCRIPT_DIR="${PROJECT_ROOT}/infra/scripts"
CHECKER="${SCRIPT_DIR}/check-concurrent-upsert.mjs"
INJECTOR="${SCRIPT_DIR}/selftest-inject.mjs"
FAILED=0

require_cmd node
require_cmd rsync

TMP_ROOT="$(mktemp -d /tmp/nmg-cu-selftest-XXXXXX)"
cleanup() {
  [ -d "$TMP_ROOT" ] && find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

log "=== 并发撞唯一键校验器反向验证开始 ==="
log "临时副本根目录：${TMP_ROOT}"

make_copy() {
  local dest="$1"
  mkdir -p "$dest"
  rsync -a \
    --exclude 'node_modules/' --exclude '.git/' --exclude 'dist/' \
    --exclude 'coverage/' --exclude '.env*' --exclude '*.log' \
    --exclude 'tests/concurrency/results/' \
    "${PROJECT_ROOT}/" "${dest}/"
}

# --- 0. 正向基线 ----------------------------------------------------------
log "[0/3] 正向基线：干净副本上不得有「先查后插」缺口……"
BASE_COPY="${TMP_ROOT}/baseline"
make_copy "$BASE_COPY"
set +e
BASE_OUT="$(node "$CHECKER" --root "$BASE_COPY" 2>&1)"
BASE_RC=$?
set -e
if [ "$BASE_RC" -ne 0 ]; then
  warn "  ✗ 基线：退出码 ${BASE_RC}（干净副本竟然不通过）"
  printf '%s\n' "$BASE_OUT" | tail -12 | sed 's/^/      /'
  FAILED=1
elif printf '%s' "$BASE_OUT" | grep -q "CONCURRENT_UPSERT"; then
  warn "  ✗ 基线：干净副本竟报出了缺口 → 规则太吵（误报）"
  printf '%s\n' "$BASE_OUT" | tail -12 | sed 's/^/      /'
  FAILED=1
else
  log "  ✓ 基线：退出码 0，无「先查后插」缺口"
  printf '%s\n' "$BASE_OUT" | grep "并发撞唯一键" | head -2 | sed 's/^/      /'
fi

# --- 元自检：断言函数本身有效 ----------------------------------------------
log "  元自检：expect_failure 对「永远返回 0 的假校验器」必须判失败……"
FAKE_CHECKER="${TMP_ROOT}/fake-checker.mjs"
printf 'process.exit(0);\n' > "$FAKE_CHECKER"
META_OUT="$(
  set +e
  out="$(node "$FAKE_CHECKER" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "恒过"
  fi
)"
if printf '%s' "$META_OUT" | grep -q "恒过"; then
  log "  ✓ 元自检通过：恒过的校验器被正确判为失败"
else
  warn "  ✗ 元自检失败：断言函数对恒过的校验器没有反应（自测本身不可信）"
  FAILED=1
fi

run_case() {
  local case_name="$1" expected="$2" expect_rc="$3" case_copy
  case_copy="${TMP_ROOT}/case-${case_name}"
  make_copy "$case_copy"

  if ! node "$INJECTOR" "$case_name" "$case_copy" >/dev/null 2>&1; then
    warn "  ✗ ${case_name}：缺陷注入失败"
    node "$INJECTOR" "$case_name" "$case_copy" 2>&1 | sed 's/^/      /'
    FAILED=1
    find "$case_copy" -mindepth 1 -delete 2>/dev/null || true
    rmdir "$case_copy" 2>/dev/null || true
    return
  fi

  set +e
  out="$(node "$CHECKER" --root "$case_copy" 2>&1)"
  rc=$?
  set -e

  if [ "$expect_rc" = "nonzero" ] && [ "$rc" -eq 0 ]; then
    warn "  ✗ ${case_name}：退出码 0 —— 校验器恒过，不可信"
    FAILED=1
    return
  fi
  if [ "$expect_rc" = "zero" ] && [ "$rc" -ne 0 ]; then
    warn "  ✗ ${case_name}：退出码 ${rc} —— 校验器误报了（安全形态被判成缺口）"
    printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
    FAILED=1
    return
  fi
  if printf '%s' "$out" | grep -q "$expected"; then
    log "  ✓ ${case_name}：退出码 ${rc}，命中 ${expected}"
    printf '%s\n' "$out" | grep "$expected" | head -2 | sed 's/^/      /'
  else
    warn "  ✗ ${case_name}：输出未命中 ${expected}"
    printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
    FAILED=1
  fi
}

# --- 1. 注入缺陷并验证 ---------------------------------------------------
log "[1/3] 注入「先查后插且无唯一键兜底」并验证校验器……"
run_case "concurrent-upsert-unprotected" "CONCURRENT_UPSERT" nonzero

# --- 2. 防误报 -------------------------------------------------------------
log "[2/3] 注入「读 A 校验、往 B 插子行」的安全形态 —— 不得误报……"
run_case "concurrent-upsert-safe-cross-table" "并发撞唯一键对账通过" zero

# --- 3. 清理 ---------------------------------------------------------------
log "[3/3] 清理临时副本……"
find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
rmdir "$TMP_ROOT" 2>/dev/null || true

if [ "$FAILED" -ne 0 ]; then
  die "并发撞唯一键校验器反向验证失败 ❌"
fi

log "=== 反向验证通过 ✅（先查后插缺口能被抓出，且不误报）==="
log "并发撞唯一键校验器反向验证通过 ✅"
