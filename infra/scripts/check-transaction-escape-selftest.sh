#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 事务逃逸校验器的反向验证（自测）
#
#   bash infra/scripts/check-transaction-escape-selftest.sh
#
# 目的：证明 `check-transaction-escape.mjs` **不是恒过**——
#       当「包了事务却用注入仓储写入（跳出事务）」或
#       「一个方法里有两次写却没有事务」时，它必须**报出来**。
#
# 为什么这个校验器值得单测：
#   它守的是「事务边界」这一层 —— 而事务边界**失效时不会抛异常**：
#     跳出事务的那次写**立刻提交**，事务随后回滚也回滚不掉它，
#     于是留下「一半提交、一半回滚」的半成品状态，
#     而且接口返回 200，一切看起来都很成功。
#   缺陷 #118（认证补交材料）与 #119（个人资料）修复前就是这个形态。
#
# 三段式：
#   [0/4] 正向基线：干净副本 → 退出码 0，且**不得**出现「多步写候选」提示
#         （只有已确认无害的豁免项会被打印）；
#   [1/4] 注入「事务逃逸」→ 必须退出码非 0 且命中 TRANSACTION_ESCAPE；
#   [2/4] 注入「多步写无事务」→ 必须命中 MULTI_STEP_WRITE_WITHOUT_TRANSACTION
#         （这是**提示级**规则，退出码仍为 0，所以断言的是「输出命中」）；
#   [3/5] 注入「跨方法的多步写」→ 必须命中 MULTI_STEP_WRITE_ACROSS_METHODS
#         （写分散在不同方法里，R2 看不见 —— 缺陷 #131 / #132 就是这个形态）；
#   [4/5] 注入「事务感知却绕过 manager 写入」→ 必须命中 TRANSACTION_AWARE_BYPASS；
#   [5/5] 元自检 + 清理。
#
# 安全约束：只在临时目录里的副本上改动，真实工作副本永远只读；全程不碰数据库。
#
# 退出码：0 自测通过；1 自测失败（校验器恒过或报错不准）。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

SCRIPT_DIR="${PROJECT_ROOT}/infra/scripts"
CHECKER="${SCRIPT_DIR}/check-transaction-escape.mjs"
INJECTOR="${SCRIPT_DIR}/selftest-inject.mjs"
FAILED=0

require_cmd node
require_cmd rsync

TMP_ROOT="$(mktemp -d /tmp/nmg-tx-selftest-XXXXXX)"
cleanup() {
  [ -d "$TMP_ROOT" ] && find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

log "=== 事务逃逸校验器反向验证开始 ==="
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
log "[0/5] 正向基线：干净副本上不得有事务逃逸，也不得有多步写候选提示……"
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
elif printf '%s' "$BASE_OUT" | grep -q "MULTI_STEP_WRITE_WITHOUT_TRANSACTION"; then
  warn "  ✗ 基线：干净副本竟报出了「多步写候选」→ 规则太吵（误报）"
  printf '%s\n' "$BASE_OUT" | tail -12 | sed 's/^/      /'
  FAILED=1
else
  log "  ✓ 基线：退出码 0，无事务逃逸、无多步写候选（仅有已确认的豁免项）"
  printf '%s\n' "$BASE_OUT" | grep "MULTI_STEP_EXEMPTION" | sed 's/^/      /'
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
  if printf '%s' "$out" | grep -q "$expected"; then
    log "  ✓ ${case_name}：退出码 ${rc}，命中 ${expected}"
    printf '%s\n' "$out" | grep "$expected" | head -2 | sed 's/^/      /'
  else
    warn "  ✗ ${case_name}：输出未命中 ${expected}"
    printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
    FAILED=1
  fi
}

# --- 1~2. 注入缺陷并验证 ---------------------------------------------------
log "[1/5] 注入「事务逃逸」并验证校验器……"
run_case "tx-escape-in-transaction" "TRANSACTION_ESCAPE" nonzero

log "[2/5] 注入「多步写无事务」并验证校验器（提示级，退出码仍为 0）……"
run_case "multi-step-no-transaction" "MULTI_STEP_WRITE_WITHOUT_TRANSACTION" zero

# --- 3. 清理 ---------------------------------------------------------------
log "[3/5] 注入「跨方法的多步写」并验证校验器（提示级，退出码仍为 0）……"
run_case "multi-step-across-methods" "MULTI_STEP_WRITE_ACROSS_METHODS" zero

log "[4/5] 注入「事务感知却绕过 manager 写入」并验证校验器（提示级，退出码仍为 0）……"
run_case "transaction-aware-bypass" "TRANSACTION_AWARE_BYPASS" zero

# --- 5. 清理 ---------------------------------------------------------------
log "[5/5] 清理临时副本……"
find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
rmdir "$TMP_ROOT" 2>/dev/null || true

if [ "$FAILED" -ne 0 ]; then
  die "事务逃逸校验器反向验证失败 ❌"
fi

log "=== 反向验证通过 ✅（事务逃逸 / 多步写候选 / 跨方法多步写 / 绕过 manager 四类缺陷都被抓出，校验器非恒过）==="
log "事务逃逸校验器反向验证通过 ✅"
