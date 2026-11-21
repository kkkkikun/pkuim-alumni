#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 管理后台静态校验器的反向验证（自测）
#
#   bash infra/scripts/check-admin-web-selftest.sh
#
# 目的：证明 `check-admin-web.mjs` **不是恒过**——
#       当「路由指向不存在的视图组件」或「路由声明了契约里没有的权限点」时，
#       它必须报错并返回非 0。
#
# 为什么这个校验器值得单测：
#   它守的是「管理后台运行期才暴露」的一类缺陷：
#     - 路由 `component: () => import('@/views/X.vue')` 指向的文件不存在 →
#       打开该页面直接白屏，TypeScript 编译期**查不出来**（动态 import 的路径
#       在类型里只是字符串）；
#     - 路由 `meta.requiredPermission` 写了一个契约里没有的权限点 →
#       权限守卫按契约判断，该页面**永远**被拦下，管理员点进去只会看到「无权限」，
#       而真正的原因是权限点名字拼错了。
#   这两类缺陷都不抛异常、不打后端日志，只能靠静态交叉校验兜住；
#   护栏本身恒过的话，管理后台的静态层就形同虚设。
#
# 两个用例覆盖两条判定路径：
#   admin-route-component-missing → R1：路由引用的组件文件必须存在
#                                   （注入点：把路由指向 @/views/__SelftestMissingView.vue）
#   admin-permission-not-contract → R3：路由声明的权限点必须在契约 AdminPermission 里
#                                   （注入点：把 requiredPermission 改成 '__selftest:permission'）
#
# 流程：
#   0. 正向基线：干净副本上必须 0 错误、退出码 0；
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
CHECKER="${SCRIPT_DIR}/check-admin-web.mjs"
INJECTOR="${SCRIPT_DIR}/selftest-inject.mjs"
FAILED=0

require_cmd node
require_cmd rsync

TMP_ROOT="$(mktemp -d /tmp/nmg-adminweb-selftest-XXXXXX)"
cleanup() {
  [ -d "$TMP_ROOT" ] && find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

log "=== 管理后台静态校验器反向验证开始 ==="
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
    log "  ✓ 基线 ${label}：退出码 0（路由 / 视图 / 权限点均自洽）"
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
log "[0/2] 正向基线：干净副本上管理后台必须无静态一致性问题……"
BASE_COPY="${TMP_ROOT}/baseline"
make_copy "$BASE_COPY"
expect_pass "check-admin-web.mjs" "$BASE_COPY"

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

run_case "admin-route-component-missing" "ROUTE_COMPONENT_MISSING"
run_case "admin-permission-not-contract" "PERMISSION_NOT_IN_CONTRACT"

# --- 2. 清理 ---------------------------------------------------------------
log "[2/2] 清理临时副本……"
find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
rmdir "$TMP_ROOT" 2>/dev/null || true

if [ "$FAILED" -ne 0 ]; then
  die "管理后台静态校验器反向验证失败 ❌"
fi

log "=== 反向验证通过 ✅（2 类「管理后台静态缺陷」全部被抓出，校验器非恒过）==="
log "管理后台静态校验器反向验证通过 ✅"
