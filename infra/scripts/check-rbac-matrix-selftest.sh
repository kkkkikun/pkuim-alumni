#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— RBAC 三方对账校验器的反向验证（自测）
#
#   bash infra/scripts/check-rbac-matrix-selftest.sh
#
# 目的：证明 `check-rbac-matrix.mjs` **不是恒过**——
#       当「前端硬编码的角色权限矩阵与种子数据不一致」时，
#       它必须报错并返回非 0。
#
# 为什么这个校验器值得单测：
#   它守的是「角色 × 权限矩阵」的多方一致性这一层：
#     契约 `AdminPermission` / `AdminRole` ⟷ 种子 `PERMISSION_FIXTURES` / `ROLE_FIXTURES`
#     ⟷ 前端硬编码矩阵 `ROLE_PERMISSIONS` ⟷ 服务端端点实际要求的权限点。
#   漂移的后果**完全静默**，不抛异常也不打日志：
#     - 服务端按 `role_permissions` 表放行、前端按代码显示 →
#       管理员在矩阵页看到的「谁能看什么」是错的，排查时根本无从下手；
#     - 更危险的是「没有任何角色被授予某个权限」→ 端点写着
#       `@RequirePermissions('x')`，但没有一个角色带 'x' →
#       该端点对**所有管理员**都不可达，功能等于不存在，且没有任何报错提示。
#   响应结构校验、请求契约对账、端点覆盖全都查不出这类问题
#   （它们看的是**结构与字段**，不是**角色与权限的对应关系**）。
#
# 一个用例覆盖一条判定路径：
#   rbac-matrix-drift → R3：角色 ↔ 权限矩阵（种子 ROLE_FIXTURES ≡ 前端 ROLE_PERMISSIONS）
#                        注入点：前端矩阵里 alumni_reviewer 少了 'alumni:manage'
#                        → 种子独有 alumni:manage、前端独有 无 → ROLE_MATRIX_DRIFT
#
# ⚠️ 第十七轮补了一条：规则 6（「每个管理端端点都必须有 `@RequirePermissions`」）
#   此前是一条**恒过**的判定，第十六轮修好了它，但**修好之后没人验过它** ——
#   摘掉一个管理端点的权限点，它必须被抓出来。
#
# 流程：
#   0. 正向基线：干净副本上必须 0 不一致、退出码 0；
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
CHECKER="${SCRIPT_DIR}/check-rbac-matrix.mjs"
INJECTOR="${SCRIPT_DIR}/selftest-inject.mjs"
FAILED=0

require_cmd node
require_cmd rsync

TMP_ROOT="$(mktemp -d /tmp/nmg-rbac-selftest-XXXXXX)"
cleanup() {
  [ -d "$TMP_ROOT" ] && find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

log "=== RBAC 三方对账校验器反向验证开始 ==="
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
    log "  ✓ 基线 ${label}：退出码 0（角色 × 权限矩阵三方一致）"
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
log "[0/2] 正向基线：干净副本上角色 × 权限矩阵必须三方一致……"
BASE_COPY="${TMP_ROOT}/baseline"
make_copy "$BASE_COPY"
expect_pass "check-rbac-matrix.mjs" "$BASE_COPY"

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

run_case "rbac-matrix-drift" "ROLE_MATRIX_DRIFT"

# --- 第十七轮：给第十六轮修掉的「规则 6 恒过」补上反向验证 ------------------
#
# ⚠️ **为什么必须补**：规则 6（「每个管理端端点都必须有 `@RequirePermissions`」）
#   此前是一条**恒过**的判定（路径缺前导斜杠 → 拼出来的路径永远不以 `/admin` 开头）。
#   第十六轮把它修好了，但**修好之后没人验过它** ——
#   「修好了」与「真的能抓住缺陷」是两件事。
#   这一条就是那道修复的**反向验证**：摘掉一个管理端点的权限点，
#   它必须被抓出来（退出码非 0 + 报出 `ADMIN_ENDPOINT_NO_PERMISSION`）。
run_case "rbac-matrix-admin-endpoint-no-permission" "ADMIN_ENDPOINT_NO_PERMISSION"

# --- 2. 清理 ---------------------------------------------------------------
log "[2/2] 清理临时副本……"
find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
rmdir "$TMP_ROOT" 2>/dev/null || true

if [ "$FAILED" -ne 0 ]; then
  die "RBAC 三方对账校验器反向验证失败 ❌"
fi

log "=== 反向验证通过 ✅（2 类缺陷被抓出：矩阵漂移 + 管理端端点缺权限点，校验器非恒过）=="
log "RBAC 三方对账校验器反向验证通过 ✅"
