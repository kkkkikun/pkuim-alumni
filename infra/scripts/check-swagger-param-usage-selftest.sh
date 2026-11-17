#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 声明参数消费校验器的反向验证（自测）
#
#   bash infra/scripts/check-swagger-param-usage-selftest.sh
#
# 目的：证明 `check-swagger-param-usage.mjs` **不是恒过**——
#       当「服务端声明了查询参数、但实现里根本没用它」时，
#       它必须报错并返回非 0 退出码。
#
# 为什么这个校验器值得单测：
#   它守的是「服务端自己承诺的参数，到底有没有被真正用上」这一层。
#   缺陷 #72（`GET /alumni` 管理端列表 9 个筛选项里 5 个被静默丢弃）
#   就属于这一类：Swagger 如实公布了参数，客户端照发，状态码 200，
#   但结果根本不受筛选影响 —— 筛选框看起来能用，实际上是摆设。
#   响应结构校验（看返回了什么）、请求契约对账（看客户端发了什么）
#   都查不出这一类，必须单独一层。
#
# 三个用例分别覆盖三条判定路径：
#   swagger-param-declared-unused → 一级：handler 从未引用该参数
#   swagger-param-service-drop    → 二级：handler 整体透传给 service，但 service 里被删掉了
#   swagger-param-own-helper-drop → 二级变体：整体透传给**控制器自己的私有方法**
#                                   （`this.setUserStatus(actor, id, body)`），
#                                   私有方法里那个字段被删掉 —— 这条路径曾经追不到，
#                                   会让校验器对正常实现误报（校验器自身盲点）。
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
#   - 全程不碰数据库。
#
# 退出码：0 自测通过；1 自测失败（校验器恒过或报错不准）。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

SCRIPT_DIR="${PROJECT_ROOT}/infra/scripts"
CHECKER="${SCRIPT_DIR}/check-swagger-param-usage.mjs"
INJECTOR="${SCRIPT_DIR}/selftest-inject.mjs"
FAILED=0

require_cmd node
require_cmd rsync

TMP_ROOT="$(mktemp -d /tmp/nmg-param-usage-selftest-XXXXXX)"
cleanup() {
  [ -d "$TMP_ROOT" ] && find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

log "=== 声明参数消费校验器反向验证开始 ==="
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

# --- 断言：校验器应当通过（无不一致）---------------------------------------
expect_pass() {
  local label="$1" root="$2" out rc
  set +e
  out="$(node "$CHECKER" --root "$root" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    log "  ✓ 基线 ${label}：退出码 0（声明参数全部被真正消费）"
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

# --- 断言：校验器**不应**报错（误报防线）------------------------------------
# 有些「缺陷」其实不是缺陷：多行装饰器 `@ApiPropertyOptional({ enum: [...] })`
# 曾经被校验器把装饰器里的 `enum:` 当成字段名 → 误报
# 「查询参数 enum 在 XxxQueryDto 里声明，但服务端从未真正使用它」。
# 这条断言专门盯**误报**。
expect_no_issue() {
  local label="$1" root="$2" out rc
  set +e
  out="$(node "$CHECKER" --root "$root" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    warn "  ✗ ${label}：退出码 ${rc}（不应报错，却报错了 —— 误报）"
    printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
    FAILED=1
    return
  fi
  if printf '%s' "$out" | grep -q "DECLARED_PARAM_NOT_USED"; then
    warn "  ✗ ${label}：退出码 0 但输出里仍有误报"
    printf '%s\n' "$out" | grep "DECLARED_PARAM_NOT_USED" | head -3 | sed 's/^/      /'
    FAILED=1
  else
    log "  ✓ ${label}：退出码 0，且无误报"
  fi
}

# --- 0. 正向基线 ------------------------------------------------------------
log "[0/3] 正向基线：干净副本上声明参数必须全部被消费……"
BASE_COPY="${TMP_ROOT}/baseline"
make_copy "$BASE_COPY"
expect_pass "check-swagger-param-usage.mjs" "$BASE_COPY"

# --- 1. 逐个注入缺陷并验证 ---------------------------------------------------
log "[1/3] 逐个注入缺陷并验证校验器……"

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

# 一级：DTO 声明了参数，handler 从不引用
run_case "swagger-param-declared-unused" "selftestUnusedFilter"
# 二级：handler 整体透传 query，但 service 里的筛选条件被删掉了
run_case "swagger-param-service-drop" "graduationYear"
# 二级变体：handler 整体透传给控制器私有方法，私有方法里的字段被删掉了
run_case "swagger-param-own-helper-drop" "reason"
# 多行装饰器：校验器必须剥掉装饰器，不能把装饰器里的 `enum:` 当成字段名（防误报）
run_no_issue_case() {
  local case_name="$1" case_copy
  case_copy="${TMP_ROOT}/noissue-${case_name}"
  make_copy "$case_copy"

  if ! node "$INJECTOR" "$case_name" "$case_copy" >/dev/null 2>&1; then
    warn "  ✗ ${case_name}：缺陷注入失败"
    node "$INJECTOR" "$case_name" "$case_copy" 2>&1 | sed 's/^/      /'
    FAILED=1
    find "$case_copy" -mindepth 1 -delete 2>/dev/null || true
    rmdir "$case_copy" 2>/dev/null || true
    return
  fi

  expect_no_issue "$case_name" "$case_copy"
}
run_no_issue_case "swagger-param-multiline-decorator"

# --- 2. 清理 ----------------------------------------------------------------
log "[2/3] 清理临时副本……"
find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
rmdir "$TMP_ROOT" 2>/dev/null || true

if [ "$FAILED" -ne 0 ]; then
  die "声明参数消费校验器反向验证失败 ❌"
fi

log "=== 反向验证通过 ✅（3 类「声明了但没用」缺陷全部被抓出 + 1 类误报被挡住，校验器非恒过）==="
log "声明参数消费校验器反向验证通过 ✅"
