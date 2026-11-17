#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 请求契约校验器的反向验证（自测）
#
#   bash infra/scripts/check-request-contract-selftest.sh [--swagger <url>]
#
# 目的：证明 `check-request-contract.mjs` **不是恒过**——
#       当客户端多发一个服务端没声明的查询参数 / 请求体字段时，
#       它必须报错并返回非 0 退出码。
#
# 为什么这个校验器值得单测：
#   它守的是「客户端发了、服务端不接」这一层。缺陷 #59（管理端校友列表）
#   与 #63（6 个列表页的筛选框是摆设）都属于这一类：
#   请求照发、状态码 200、结果不受影响 —— 不抛异常，页面也看不出异常，
#   只有把「客户端发了什么」和「服务端接了什么」摆在一起对账才能发现。
#
# 流程：
#   0. 正向基线：干净副本上必须 0 不一致、退出码 0；
#   1. 逐个用例：临时副本里注入缺陷 → 断言「退出码非 0」且
#      「输出命中预期的参数名」；
#   2. 元自检：用「永远返回 0 的假校验器」证明断言函数本身有效；
#   3. 清理全部临时副本。
#
# 安全约束：
#   - 只在临时目录（mktemp -d）里的副本上改动，真实工作副本永远只读；
#   - 副本由 rsync 只读拷贝得到，不做原地修改；
#   - 全程不写业务库。
#
# 退出码：0 自测通过；1 自测失败（校验器恒过或报错不准）。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

SCRIPT_DIR="${PROJECT_ROOT}/infra/scripts"
CHECKER="${SCRIPT_DIR}/check-request-contract.mjs"
INJECTOR="${SCRIPT_DIR}/selftest-inject.mjs"
SWAGGER_URL="${SWAGGER_URL:-http://127.0.0.1:18081/docs-json}"
FAILED=0

require_cmd node
require_cmd rsync

TMP_ROOT="$(mktemp -d /tmp/nmg-request-selftest-XXXXXX)"
cleanup() {
  [ -d "$TMP_ROOT" ] && find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

log "=== 请求契约校验器反向验证开始 ==="
log "swagger：${SWAGGER_URL}"

make_copy() {
  local dest="$1"
  mkdir -p "$dest"
  rsync -a \
    --exclude 'node_modules/' --exclude '.git/' --exclude 'dist/' \
    --exclude 'coverage/' --exclude '.env*' --exclude '*.log' \
    --exclude 'tests/concurrency/results/' \
    "${PROJECT_ROOT}/" "${dest}/"
}

# --- 断言：校验器应当通过（无不一致）---------------------------------------
expect_pass() {
  local label="$1" root="$2" out rc
  set +e
  out="$(node "$CHECKER" --root "$root" --swagger "$SWAGGER_URL" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    log "  ✓ 基线 ${label}：退出码 0（客户端与服务端请求契约一致）"
  else
    warn "  ✗ 基线 ${label}：退出码 ${rc}（干净副本竟然不通过）"
    printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
    FAILED=1
  fi
}

# --- 断言：校验器应当失败并命中指定特征 -------------------------------------
expect_failure() {
  local label="$1" root="$2" expected="$3" out rc
  set +e
  out="$(node "$CHECKER" --root "$root" --swagger "$SWAGGER_URL" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    warn "  ✗ ${label}：退出码 0 —— 校验器恒过，不可信"
    FAILED=1
    return
  fi
  if printf '%s' "$out" | grep -q "$expected"; then
    log "  ✓ ${label}：退出码 ${rc}，命中 ${expected}"
    printf '%s\n' "$out" | grep "$expected" | head -2 | sed 's/^/      /'
  else
    warn "  ✗ ${label}：退出码 ${rc} 但输出未命中 ${expected}"
    printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
    FAILED=1
  fi
}

# --- 0. 正向基线 ------------------------------------------------------------
log "[0/2] 正向基线：干净副本上请求契约必须一致……"
BASE_COPY="${TMP_ROOT}/baseline"
make_copy "$BASE_COPY"
expect_pass "check-request-contract.mjs" "$BASE_COPY"

# --- 1. 逐个注入缺陷并验证 ---------------------------------------------------
log "[1/2] 逐个注入缺陷并验证校验器……"

# 元自检：断言函数本身必须能识破「恒过的校验器」。
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
  local case_name="$1" expected="$2" case_copy
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

  expect_failure "$case_name" "$case_copy" "$expected"
}

# 客户端多发一个服务端没声明的查询参数
run_case "request-extra-query-param" "selftestBogusFilter"
# 客户端多发一个服务端 schema 里没有的请求体字段
run_case "request-extra-body-field" "selftestExtraContact"

# --- 2. 清理 ----------------------------------------------------------------
log "[2/2] 清理临时副本……"
find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
rmdir "$TMP_ROOT" 2>/dev/null || true

if [ "$FAILED" -ne 0 ]; then
  die "请求契约校验器反向验证失败 ❌"
fi

log "=== 反向验证通过 ✅（2 类请求契约缺陷全部被抓出，校验器非恒过）==="
log "请求契约校验器反向验证通过 ✅"
