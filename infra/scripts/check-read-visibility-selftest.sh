#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 公开读端点可见性对账校验器的反向验证（自测）
#
#   bash infra/scripts/check-read-visibility-selftest.sh
#
# 目的：证明 `check-read-visibility.mjs` **不是恒过**——
#       当「某个公开读端点的可见性过滤被删掉」「不可见被改成 403」
#       「新增公开读端点却没人登记口径」「文档里的口径被删掉」
#       「待拍板的条目被从 KNOWN-ISSUES 里抹掉」时，它必须报错并返回非 0。
#
# 为什么这个校验器值得单测：
#   它守的是「公开读端点的可见性口径」这一层 ——
#   `docs/DATABASE-DESIGN.md`「未审核内容公开」与
#   `docs/KNOWN-ISSUES.md`「已知设计取舍」第 2 条定的口径是
#   「不可见 → 404（不用 403，避免泄露存在性）」。
#   这层的缺陷**完全静默**：
#     - 过滤被删掉 → 未发布 / 未审核的内容**凭 id 就能公开读到**
#       （第十轮就抽查出 `GET /events/:id` 漏了过滤，记为 #197）；
#     - 404 被改成 403 → 状态码本身泄露「这个对象存在」；
#     - 新增公开读端点没登记 → 「不可见返回什么」没人想过。
#   而端点覆盖、契约镜像、响应结构这些校验器全都查不出这一层
#   （它们看的是**路径与结构**，不是**看得见 / 看不见**）。
#
# 用例覆盖各条判定路径：
#   read-visibility-filter-removed      → R2：可见性过滤被删掉
#   read-visibility-status-changed      → R3：不可见被改成 403（状态码用错）
#   read-visibility-endpoint-unregistered → R1：新增公开读端点没登记口径
#   read-visibility-doc-row-removed     → R4：API-SPEC 里的可见性口径被删掉
#   read-visibility-known-issue-removed → R5：待拍板条目被从 KNOWN-ISSUES 抹掉
#   read-visibility-pending-resolved    → R5：待拍板端点的行为被改掉（登记表过期）
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
CHECKER="${SCRIPT_DIR}/check-read-visibility.mjs"
INJECTOR="${SCRIPT_DIR}/selftest-inject.mjs"
FAILED=0

require_cmd node
require_cmd rsync

TMP_ROOT="$(mktemp -d /tmp/nmg-readvisibility-selftest-XXXXXX)"
cleanup() {
  [ -d "$TMP_ROOT" ] && find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

log "=== 公开读端点可见性对账校验器反向验证开始 ==="
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
    log "  ✓ 基线 ${label}：退出码 0（公开读端点的可见性口径自洽）"
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
log "[0/2] 正向基线：干净副本上的公开读端点可见性口径必须自洽……"
BASE_COPY="${TMP_ROOT}/baseline"
make_copy "$BASE_COPY"
expect_pass "check-read-visibility.mjs" "$BASE_COPY"

# --- 1. 注入缺陷并验证 -----------------------------------------------------
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

# 可见性过滤被删掉 → 未发布的内容凭 id 就能公开读到
run_case "read-visibility-filter-removed" "READ_VISIBILITY_FILTER_MISSING"
# 不可见被改成 403 → 状态码泄露存在性
run_case "read-visibility-status-changed" "READ_VISIBILITY_STATUS_MISMATCH"
# 新增公开读端点却没登记口径
run_case "read-visibility-endpoint-unregistered" "READ_VISIBILITY_NOT_REGISTERED"
# 文档里的可见性口径被删掉
run_case "read-visibility-doc-row-removed" "READ_VISIBILITY_UNDOCUMENTED"
# 待拍板条目被从 KNOWN-ISSUES 抹掉
run_case "read-visibility-known-issue-removed" "READ_VISIBILITY_KNOWN_ISSUE_MISSING"
# 待拍板端点的行为被改掉（登记表与文档过期）
run_case "read-visibility-pending-resolved" "READ_VISIBILITY_REGISTRY_STALE"

# --- 2. 清理 ---------------------------------------------------------------
log "[2/2] 清理临时副本……"
find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
rmdir "$TMP_ROOT" 2>/dev/null || true

if [ "$FAILED" -ne 0 ]; then
  die "公开读端点可见性对账校验器反向验证失败 ❌"
fi

log "=== 反向验证通过 ✅（6 类「可见性口径失配」缺陷全部被抓出，校验器非恒过）==="
log "公开读端点可见性对账校验器反向验证通过 ✅"
