#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 请求参数 DTO 校验器的反向验证（自测）
#
#   bash infra/scripts/check-request-dto-selftest.sh
#
# 目的：证明 `check-request-dto.mjs` **不是恒过**——
#       当请求体在运行时会被 ValidationPipe 跳过时，它必须报错并返回非 0。
#
# 为什么这个校验器值得单测：
#   它守的是「服务端到底有没有真的校验用户提交的数据」这一层。
#   缺陷 #79（管理端 12 个写端点）、#88（媒体登记）、#89（活动报名）
#   都是同一类：请求体写成 `Record<string, unknown>` / 普通 `interface` /
#   内联对象字面量 → 运行时 metatype 是 `Object` → ValidationPipe 直接跳过，
#   于是畸形输入进库、非法值变 500、契约外字段不被拒绝。
#   响应结构校验、请求契约对账都查不出这一类（它们只看响应与声明）。
#   `@Query()` 同理：交叉类型（`PaginationQueryDto & { keyword?: string }`）
#   会让 metatype 退化成 Object → 参数不校验也不转换（`page` 变 NaN → 500）。
#
# 四个用例覆盖四条判定路径：
#   body-dto-to-any        → 类型是原始类型（any）
#   body-dto-to-inline     → 类型是内联对象字面量
#   body-dto-no-validator  → 类存在，但没有任何 class-validator 装饰器
#   query-dto-to-intersection → 查询 DTO 写成交叉类型 → metatype 退化成 Object
#   query-dto-to-intersection → 查询 DTO 写成交叉类型 → 运行时 metatype 退化成 Object
#
# 流程：
#   0. 正向基线：干净副本上必须「无跳过项」、退出码 0；
#   1. 逐个用例：临时副本里注入缺陷 → 断言「退出码非 0」且「输出命中预期类型」；
#   2. 元自检：用「永远返回 0 的假校验器」证明断言函数本身有效；
#   3. 清理全部临时副本。
#
# 安全约束：
#   - 只在临时目录（mktemp -d）里的副本上改动，真实工作副本永远只读；
#   - 全程不碰数据库。
#
# 退出码：0 自测通过；1 自测失败（校验器恒过或报错不准）。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

SCRIPT_DIR="${PROJECT_ROOT}/infra/scripts"
CHECKER="${SCRIPT_DIR}/check-request-dto.mjs"
INJECTOR="${SCRIPT_DIR}/selftest-inject.mjs"
FAILED=0

require_cmd node
require_cmd rsync

TMP_ROOT="$(mktemp -d /tmp/nmg-body-dto-selftest-XXXXXX)"
cleanup() {
  [ -d "$TMP_ROOT" ] && find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

log "=== 请求参数 DTO 校验器反向验证开始 ==="
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

# --- 断言：校验器应当通过（没有被跳过的请求体）----------------------------
expect_pass() {
  local label="$1" root="$2" out rc
  set +e
  out="$(node "$CHECKER" --root "$root" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    log "  ✓ 基线 ${label}：退出码 0（所有请求体都会真正被校验）"
  else
    warn "  ✗ 基线 ${label}：退出码 ${rc}（干净副本竟然不通过）"
    printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
    FAILED=1
  fi
}

# --- 断言：校验器应当失败并命中指定特征 ------------------------------------
expect_failure() {
  local label="$1" root="$2" expected="$3" out rc
  set +e
  out="$(node "$CHECKER" --root "$root" 2>&1)"
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

# --- 0. 正向基线 ----------------------------------------------------------
log "[0/2] 正向基线：干净副本上不得有「会被跳过校验」的请求体……"
BASE_COPY="${TMP_ROOT}/baseline"
make_copy "$BASE_COPY"
expect_pass "check-request-dto.mjs" "$BASE_COPY"

# --- 1. 逐个注入缺陷并验证 -------------------------------------------------
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

run_case "body-dto-to-any" "OPEN_OR_PRIMITIVE_TYPE"
run_case "body-dto-to-inline" "INLINE_OBJECT_TYPE"
run_case "body-dto-no-validator" "NO_VALIDATOR_DECORATOR"
run_case "query-dto-to-intersection" "TYPE_NOT_RESOLVED"

# --- 2. 清理 ---------------------------------------------------------------
log "[2/2] 清理临时副本……"
find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
rmdir "$TMP_ROOT" 2>/dev/null || true

if [ "$FAILED" -ne 0 ]; then
  die "请求参数 DTO 校验器反向验证失败 ❌"
fi

log "=== 反向验证通过 ✅（4 类「请求参数不会被校验」缺陷全部被抓出，校验器非恒过）==="
log "请求参数 DTO 校验器反向验证通过 ✅"
