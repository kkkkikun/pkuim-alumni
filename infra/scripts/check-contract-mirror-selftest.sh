#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 契约镜像一致性校验器的反向验证（自测）
#
#   bash infra/scripts/check-contract-mirror-selftest.sh
#
# 目的：证明 `check-contract-mirror.mjs` **不是恒过**——
#       当「小程序本地类型副本与契约分叉」时，它必须报错并返回非 0。
#
# 为什么这个校验器值得单测：
#   它守的是「契约 → 小程序类型镜像」这条链路。
#   小程序无法在运行时引用工作区包 `@nmg/contracts`，
#   只能在 `apps/miniprogram/src/types/index.ts` 里**手工镜像**一份类型。
#   契约改了、小程序没改，两边就会**静默分叉**：
#     - 小程序的 TypeScript 依然编译通过（它用的是自己那份）；
#     - 运行期按着「以为存在」的字段取值，得到 undefined；
#     - 契约里的「唯一事实来源」在这条链路上被悄悄架空。
#   这类缺陷不抛异常、不打日志，契约路由对账、端点覆盖全都查不出来
#   （它们看的是**路径与端点**，不是**类型字段**）。
#
# 用例覆盖的判定路径：
#   mirror-type-drift → R1：同名 interface 的字段集合 / 可选性 / 类型必须一致
#                       （注入点：给小程序镜像里的 ArticleCategoryDto 加一个
#                         契约里没有的字段 selftestDriftedField → INTERFACE_DRIFT）
#
#   ⚠️ 作用域边界：「小程序绕过镜像表直接写字面量路径」（判定码 MIRROR_LITERAL_PATH）
#     **不由本校验器负责** —— 类型镜像校验器只比对类型字段，不看请求路径；
#     那个判定码由 `check-client-paths.mjs` 产出，
#     它的反向验证在 `infra/scripts/check-client-paths-selftest.sh`。
#
# 流程：
#   0. 正向基线：干净副本上必须 0 漂移、退出码 0；
#   1. 逐个用例：临时副本里注入缺陷 → 断言「退出码非 0」且「输出命中预期的判定码」；
#   2. 元自检：用「永远返回 0 的假校验器」证明断言函数本身有效；
#   3. 清理全部临时副本。
#
# 安全约束：只在临时目录里的副本上改动，真实工作副本永远只读；全程不碰数据库。
#
# 退出码：0 自测通过；1 自测失败（校验器恒过或报错不准）。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

SCRIPT_DIR="${PROJECT_ROOT}/infra/scripts"
CHECKER="${SCRIPT_DIR}/check-contract-mirror.mjs"
INJECTOR="${SCRIPT_DIR}/selftest-inject.mjs"
FAILED=0

require_cmd node
require_cmd rsync

TMP_ROOT="$(mktemp -d /tmp/nmg-mirror-selftest-XXXXXX)"
cleanup() {
  [ -d "$TMP_ROOT" ] && find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

log "=== 契约镜像一致性校验器反向验证开始 ==="
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

expect_pass() {
  local label="$1" root="$2" out rc
  set +e
  out="$(node "$CHECKER" --root "$root" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    log "  ✓ 基线 ${label}：退出码 0（契约与小程序类型镜像一致）"
  else
    warn "  ✗ 基线 ${label}：退出码 ${rc}（干净副本竟然不通过）"
    printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
    FAILED=1
  fi
}

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
log "[0/2] 正向基线：干净副本上契约与小程序类型镜像必须一致……"
BASE_COPY="${TMP_ROOT}/baseline"
make_copy "$BASE_COPY"
expect_pass "check-contract-mirror.mjs" "$BASE_COPY"

# --- 1. 逐个注入缺陷并验证 -------------------------------------------------
log "[1/2] 逐个注入缺陷并验证校验器……"

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

run_case "mirror-type-drift" "INTERFACE_DRIFT"

# --- 2. 清理 ---------------------------------------------------------------
log "[2/2] 清理临时副本……"
find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
rmdir "$TMP_ROOT" 2>/dev/null || true

if [ "$FAILED" -ne 0 ]; then
  die "契约镜像一致性校验器反向验证失败 ❌"
fi

log "=== 反向验证通过 ✅（1 类「类型镜像漂移」缺陷被抓出，校验器非恒过）==="
log "契约镜像一致性校验器反向验证通过 ✅"
