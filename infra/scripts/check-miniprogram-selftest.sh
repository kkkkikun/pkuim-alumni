#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 小程序静态校验器的反向验证（自测）
#
#   bash infra/scripts/check-miniprogram-selftest.sh
#
# 目的：证明 `check-miniprogram.mjs` **不是恒过**——
#       当「页面没在 app.json 注册」「WXML 绑定了 TS 里不存在的方法」
#       或「usingComponents 指向不存在的组件」时，
#       它必须报错并返回非 0。
#
# 为什么这个校验器值得单测：
#   小程序尚未在微信开发者工具里跑起来（需要真实 AppID），
#   所以「编译通过」不等于「运行不报错」。而这一类缺陷恰恰**不报错**：
#     - 页面文件存在但没在 app.json 注册 → 导航过去白屏，没有任何提示；
#     - WXML 绑定了页面上不存在的方法 → 点击**没反应**，用户以为程序卡了；
#     - usingComponents 指向不存在的组件 → 组件渲染失败，整块区域空白。
#   TypeScript 编译期一个都查不出来（全都是运行期才暴露），
#   护栏本身恒过的话，小程序这层就完全没有防线。
#
# 三个用例覆盖三条判定路径：
#   mini-page-not-registered → R1：页面注册完整性
#                               （注入点：从 app.json 的 pages[] 里删掉一页，
#                                 该页面的 .wxml 还在 → 导航不到）
#   mini-handler-missing     → R2：WXML 的事件绑定必须在对应 .ts 里有同名方法
#                               （注入点：给页面 wxml 加一个 bindtap="__selftestMissingHandler__"）
#   mini-component-missing   → R3：usingComponents 指向的组件文件必须存在
#                               （注入点：页面 json 里加一个指向不存在路径的组件）
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
CHECKER="${SCRIPT_DIR}/check-miniprogram.mjs"
INJECTOR="${SCRIPT_DIR}/selftest-inject.mjs"
FAILED=0

require_cmd node
require_cmd rsync

TMP_ROOT="$(mktemp -d /tmp/nmg-mini-selftest-XXXXXX)"
cleanup() {
  [ -d "$TMP_ROOT" ] && find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

log "=== 小程序静态校验器反向验证开始 ==="
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
    log "  ✓ 基线 ${label}：退出码 0（页面 / 组件 / 服务层均自洽）"
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
log "[0/2] 正向基线：干净副本上小程序必须无静态一致性问题……"
BASE_COPY="${TMP_ROOT}/baseline"
make_copy "$BASE_COPY"
expect_pass "check-miniprogram.mjs" "$BASE_COPY"

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

run_case "mini-page-not-registered" "PAGE_NOT_REGISTERED"
run_case "mini-handler-missing" "HANDLER_MISSING"
run_case "mini-component-missing" "COMPONENT_MISSING"

# --- 2. 清理 ---------------------------------------------------------------
log "[2/2] 清理临时副本……"
find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
rmdir "$TMP_ROOT" 2>/dev/null || true

if [ "$FAILED" -ne 0 ]; then
  die "小程序静态校验器反向验证失败 ❌"
fi

log "=== 反向验证通过 ✅（3 类「小程序运行期缺陷」全部被抓出，校验器非恒过）==="
log "小程序静态校验器反向验证通过 ✅"
