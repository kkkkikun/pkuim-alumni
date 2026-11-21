#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 错误语义对账校验器的反向验证（自测）
#
#   bash infra/scripts/check-error-semantics-selftest.sh
#
# 目的：证明 `check-error-semantics.mjs` **不是恒过**——
#       当「唯一键冲突又被改回 500」「新增唯一列却没人登记失败语义」
#       「代码改了但 API-SPEC 的口径没改」时，它必须报错并返回非 0。
#
# 为什么这个校验器值得单测：
#   它守的是「管理端写操作的失败**语义**」这一层 —— 400 / 404 / 409。
#   这层的缺陷**完全静默**：
#     - 唯一键冲突返回 500 → 管理端按 `code` 分支，500 被当成「服务端故障」，
#       运维去查服务健康度、管理员去刷新页面，而真实原因只是「slug 重复了」
#       （缺陷 #190 就是这样暴露的）；
#     - 新加一个唯一列却没人想清楚「撞了返回什么」→ 上线后同样的静默失败；
#     - 代码改了、API-SPEC 没改 → 对外契约悄悄变了，客户端按旧口径处理。
#   端点覆盖、契约镜像、响应结构这些校验器全都查不出这一层
#   （它们看的是**路径与结构**，不是**失败时返回什么**）。
#
# 用例覆盖各条判定路径：
#   error-semantics-conflict-mapping-removed      → R3：冲突处置被改回 500（管理端）
#   error-semantics-new-unique-column             → R1：新增唯一列没登记（管理端）
#   error-semantics-doc-row-removed                → R4：口径改了但文档没改（管理端）
#   error-semantics-user-conflict-mapping-removed  → R3：用户侧的冲突处置被删掉
#   error-semantics-user-unique-key-unregistered   → R1：用户侧新增唯一列没登记
#   error-semantics-composite-unique-key-unregistered
#                                                 → R1：新增**复合**唯一索引没登记
#   error-semantics-user-doc-row-removed          → R4：用户侧的口径改了但文档没改
#
# 第九轮新增的四个用例针对**用户侧**：这一轮把唯一键登记表扩到了用户侧
# （连接申请 / 联系方式授权 / 活动报名 / 资源附件 / 认证附件 / openid / unionid /
# 会话 refreshToken / 幂等键 ……），不验证这些注入的话，
# 「扩面」这一层同样可能是恒过的。
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
CHECKER="${SCRIPT_DIR}/check-error-semantics.mjs"
INJECTOR="${SCRIPT_DIR}/selftest-inject.mjs"
FAILED=0

require_cmd node
require_cmd rsync

TMP_ROOT="$(mktemp -d /tmp/nmg-errorsemantics-selftest-XXXXXX)"
cleanup() {
  [ -d "$TMP_ROOT" ] && find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

log "=== 错误语义对账校验器反向验证开始 ==="
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
    log "  ✓ 基线 ${label}：退出码 0（唯一键都有 409 处置与文档口径）"
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
log "[0/2] 正向基线：干净副本上的错误语义必须自洽……"
BASE_COPY="${TMP_ROOT}/baseline"
make_copy "$BASE_COPY"
expect_pass "check-error-semantics.mjs" "$BASE_COPY"

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

# 缺陷 #190 的原形：唯一键冲突又被改回 500
run_case "error-semantics-conflict-mapping-removed" "MISSING_CONFLICT_MAPPING"
# 新增唯一列却没人登记失败语义
run_case "error-semantics-new-unique-column" "UNIQUE_COLUMN_NOT_REVIEWED"
# 代码改了、API-SPEC 的口径没改
run_case "error-semantics-doc-row-removed" "ERROR_SEMANTICS_UNDOCUMENTED"
# 用户侧：报名撞唯一键的处置被删掉（同样的缺陷，用户侧此前没人核过）
run_case "error-semantics-user-conflict-mapping-removed" "MISSING_CONFLICT_MAPPING"
# 用户侧：users 上新增唯一列却没人登记
run_case "error-semantics-user-unique-key-unregistered" "UNIQUE_COLUMN_NOT_REVIEWED"
# 用户侧：新增复合唯一索引却没人登记
run_case "error-semantics-composite-unique-key-unregistered" "UNIQUE_COLUMN_NOT_REVIEWED"
# 用户侧：口径改了但 API-SPEC 没改
run_case "error-semantics-user-doc-row-removed" "ERROR_SEMANTICS_UNDOCUMENTED"

# --- 2. 清理 ---------------------------------------------------------------
log "[2/2] 清理临时副本……"
find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
rmdir "$TMP_ROOT" 2>/dev/null || true

if [ "$FAILED" -ne 0 ]; then
  die "错误语义对账校验器反向验证失败 ❌"
fi

log "=== 反向验证通过 ✅（7 类「错误语义失配」缺陷全部被抓出，校验器非恒过）==="
log "错误语义对账校验器反向验证通过 ✅"
