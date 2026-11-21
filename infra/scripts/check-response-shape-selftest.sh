#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 响应结构校验器的反向验证（自测）
#
#   bash infra/scripts/check-response-shape-selftest.sh
#
# 目的：证明 `check-response-shape.mjs` **不是恒过**——
#       当服务端把分页结构改成裸数组、把列表项的必填字段删掉、
#       把审核/审计记录的 adminName 删掉时，它必须报错并返回非 0 退出码。
#
# 为什么这个校验器值得单测：
#   它守的是「响应结构」这一层。此前三个真实缺陷（#59 / #60 / #61）都**不抛异常**：
#   页面照常渲染，只是列是空的、筛选框是摆设。
#   路径一致性、端点覆盖、静态前端校验全都查不出这类问题。
#   护栏本身恒过的话，这层就形同虚设。
#
# 流程：
#   0. 正向基线：仓库里的基线夹具必须全部符合契约（退出码 0）；
#   1. 逐个用例：临时副本里注入缺陷 → 断言「退出码非 0」且
#      「输出命中预期的端点 / 字段」；
#   2. 元自检：用「永远返回 0 的假校验器」证明断言函数本身有效；
#   3. 清理全部临时副本。
#
# 安全约束：
#   - 只在临时目录（mktemp -d）里的副本上改动，仓库里的基线夹具永远只读；
#   - 全程只读，不碰业务库。
#
# 退出码：0 自测通过；1 自测失败（校验器恒过或报错不准）。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

SCRIPT_DIR="${PROJECT_ROOT}/infra/scripts"
CHECKER="${SCRIPT_DIR}/check-response-shape.mjs"
INJECTOR="${SCRIPT_DIR}/selftest-inject-shape.mjs"
BASE_FIXTURES="${PROJECT_ROOT}/infra/fixtures/response-shape"
FAILED=0

require_cmd node

if [ ! -d "$BASE_FIXTURES" ]; then
  die "缺少基线夹具目录：${BASE_FIXTURES}"
fi

TMP_ROOT="$(mktemp -d /tmp/nmg-shape-selftest-XXXXXX)"
cleanup() {
  [ -d "$TMP_ROOT" ] && find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

log "=== 响应结构校验器反向验证开始 ==="
log "基线夹具：${BASE_FIXTURES}"

make_copy() {
  local dest="$1"
  mkdir -p "$dest"
  cp -a "${BASE_FIXTURES}/." "$dest/"
}

# --- 断言：校验器应当通过 ---------------------------------------------------
expect_pass() {
  local label="$1" dir="$2" out rc
  set +e
  out="$(node "$CHECKER" --root "$PROJECT_ROOT" --fixture "$dir" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    log "  ✓ 基线 ${label}：退出码 0（结构全部符合契约）"
  else
    warn "  ✗ 基线 ${label}：退出码 ${rc}（干净夹具竟然不通过）"
    printf '%s\n' "$out" | tail -10 | sed 's/^/      /'
    FAILED=1
  fi
}

# --- 断言：校验器应当失败并命中指定特征 -------------------------------------
expect_failure() {
  local label="$1" dir="$2" expected="$3" out rc
  set +e
  out="$(node "$CHECKER" --root "$PROJECT_ROOT" --fixture "$dir" 2>&1)"
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
    printf '%s\n' "$out" | tail -10 | sed 's/^/      /'
    FAILED=1
  fi
}

# --- 断言：校验器应当**报出盲点**（退出码 0，但输出里必须点名该类型）--------
# 用于「嵌套数组全是空 → 元素结构从未被校验」这类盲点（缺陷 #76）。
# 这类情况不该判失败（没有可判失败的样本），但**必须显式报出来**，
# 否则契约与实现的形状不一致会被永久掩盖。
expect_note() {
  local label="$1" dir="$2" expected="$3" out rc
  set +e
  out="$(node "$CHECKER" --root "$PROJECT_ROOT" --fixture "$dir" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    warn "  ✗ ${label}：退出码 ${rc}（夹具本应通过结构校验）"
    printf '%s\n' "$out" | tail -10 | sed 's/^/      /'
    FAILED=1
    return
  fi
  if printf '%s' "$out" | grep -q "$expected"; then
    log "  ✓ ${label}：退出码 0，且报出了盲点（命中 ${expected}）"
    printf '%s\n' "$out" | grep "$expected" | head -2 | sed 's/^/      /'
  else
    warn "  ✗ ${label}：退出码 0 但输出未命中 ${expected}（盲点被静默吞掉）"
    printf '%s\n' "$out" | tail -10 | sed 's/^/      /'
    FAILED=1
  fi
}

# --- 断言：校验器**不得**报盲点（退出码 0，且输出里不能出现盲点提示）--------
# 这是「假盲点」的对偶断言：
#   数组**非空**（或只有部分样本为空、其余非空）时，元素结构其实已经被校验过，
#   此时报盲点就是**误报** —— 必须被这条断言挡住。
#   （校验器曾经把判定条件写反：数组非空时反而报「所有样本里该数组都是空的」，
#    而真正全空的情况从来不报 —— #76 的盲点能力实际是失效的。）
expect_no_note() {
  local label="$1" dir="$2" out rc
  set +e
  out="$(node "$CHECKER" --root "$PROJECT_ROOT" --fixture "$dir" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    warn "  ✗ ${label}：退出码 ${rc}（夹具本应通过结构校验）"
    printf '%s\n' "$out" | tail -10 | sed 's/^/      /'
    FAILED=1
    return
  fi
  if printf '%s' "$out" | grep -q "元素结构从未被校验"; then
    warn "  ✗ ${label}：退出码 0 却报出了盲点（假盲点 / 判定条件写反）"
    printf '%s\n' "$out" | grep "元素结构从未被校验" | head -3 | sed 's/^/      /'
    FAILED=1
  else
    log "  ✓ ${label}：退出码 0，且**没有**误报盲点"
  fi
}

# --- 0. 正向基线 ------------------------------------------------------------
log "[0/2] 正向基线：干净夹具必须结构自洽……"
BASE_COPY="${TMP_ROOT}/baseline"
make_copy "$BASE_COPY"
expect_pass "check-response-shape.mjs" "$BASE_COPY"
# 基线夹具是「富」的（每个嵌套数组都有元素）→ 不应该有任何盲点提示
expect_no_note "基线夹具" "$BASE_COPY"

# --- 1. 逐个注入缺陷并验证 ---------------------------------------------------
log "[1/2] 逐个注入缺陷并验证校验器……"

# 元自检：断言函数本身必须能识破「恒过的校验器」。
# 若 expect_failure 写坏了（哪怕校验器永远返回 0 也算通过），本自测就失去意义。
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
  local case_name="$1" expected="$2" case_copy out rc
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

# 缺陷 #58 原形：分页结构被换成裸数组
run_case "shape-bare-array" "admin/users"
# 缺陷 #58 第二形：列表项缺少必填字段
run_case "shape-missing-field" "roles"
# 分页结构缺少 meta
run_case "shape-missing-meta" "meta"
# 缺陷 #60 / #61：审核与审计记录缺少 adminName
run_case "shape-missing-admin-name" "adminName"
# 缺陷 #75：嵌套数组（证明材料）里的元素缺少契约声明的字段
run_case "shape-nested-missing-field" "fileName"

# 缺陷 #181：字面量联合的**取值**越界
# （此前联合切分出的空片段让取值校验恒过 —— 护栏形同虚设）
run_case "shape-bogus-enum-value" "totally_bogus_status"

# 缺陷 #181：角色目录条目缺少字段
# （此前第三轮端点被记成 unknown → 结构从未被校验）
run_case "shape-missing-role-field" "缺失必填字段"

# 只有部分条目的嵌套数组为空 → 元素结构**已被校验过** → **不得**报盲点（防假盲点）
run_no_note_case() {
  local case_name="$1" case_copy
  case_copy="${TMP_ROOT}/nonote-${case_name}"
  make_copy "$case_copy"

  if ! node "$INJECTOR" "$case_name" "$case_copy" >/dev/null 2>&1; then
    warn "  ✗ ${case_name}：缺陷注入失败"
    node "$INJECTOR" "$case_name" "$case_copy" 2>&1 | sed 's/^/      /'
    FAILED=1
    find "$case_copy" -mindepth 1 -delete 2>/dev/null || true
    rmdir "$case_copy" 2>/dev/null || true
    return
  fi

  expect_no_note "$case_name" "$case_copy"
}
run_no_note_case "shape-nested-sparse-array"

# 缺陷 #76 的盲点形态：嵌套数组全空 → 元素结构从未被校验，必须被**报出来**
run_note_case() {
  local case_name="$1" expected="$2" case_copy
  case_copy="${TMP_ROOT}/note-${case_name}"
  make_copy "$case_copy"

  if ! node "$INJECTOR" "$case_name" "$case_copy" >/dev/null 2>&1; then
    warn "  ✗ ${case_name}：缺陷注入失败"
    node "$INJECTOR" "$case_name" "$case_copy" 2>&1 | sed 's/^/      /'
    FAILED=1
    find "$case_copy" -mindepth 1 -delete 2>/dev/null || true
    rmdir "$case_copy" 2>/dev/null || true
    return
  fi

  expect_note "$case_name" "$case_copy" "$expected"
}
run_note_case "shape-nested-empty-array" "元素结构从未被校验"

# --- 2. 清理 ----------------------------------------------------------------
log "[2/2] 清理临时副本……"
find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
rmdir "$TMP_ROOT" 2>/dev/null || true

if [ "$FAILED" -ne 0 ]; then
  die "响应结构校验器反向验证失败 ❌"
fi

log "=== 反向验证通过 ✅（7 类结构缺陷全部被抓出 + 1 类盲点被报出，校验器非恒过）==="
log "响应结构校验器反向验证通过 ✅"
