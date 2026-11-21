#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 库内唯一键对账校验器的反向验证（自测）
#
#   bash infra/scripts/check-unique-index-db-selftest.sh
#
# 目的：证明 `check-unique-index-db.mjs` **不是恒过**——
#       当「登记表要求的唯一约束在库里其实不存在」时，它必须报错并返回非 0。
#
# 为什么这个校验器值得单测：
#   它守的是「生产库里**真的**有那道防线」这一层 ——
#   静态对账（`check-error-semantics.mjs` 的 R5）只能证明
#   「迁移里**写了**创建那道唯一索引」，证明不了「**这个库里真的有**」。
#   而这一层的失败是**静默**的：撞键不报错 → 数据库直接写出重复行。
#
# 流程：
#   0. 正向基线：对着**真实测试库**跑，必须 0 不一致、退出码 0；
#   1. 注入缺陷：往临时副本的登记表里塞一条**库里并不存在**的唯一键
#      （模拟「迁移没建 / 迁移没应用 / 索引被人手工删了」）
#      → 断言「退出码非 0」且「输出命中 DB_UNIQUE_MISSING」；
#   2. 元自检：用「永远返回 0 的假校验器」证明断言函数本身有效；
#   3. 清理全部临时副本。
#
# 安全约束：
#   - 全程**只读**：只查 information_schema，不建索引、不跑迁移、不写数据；
#   - 缺陷注入只发生在**临时副本**里，真实工作副本永远只读。
#
# 前置条件：一个**已应用迁移**的测试库（连接参数走
#   DATABASE_URL 或 DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME）。
#
# 退出码：0 自测通过；1 自测失败（校验器恒过或报错不准）。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

SCRIPT_DIR="${PROJECT_ROOT}/infra/scripts"
CHECKER="${SCRIPT_DIR}/check-unique-index-db.mjs"
INJECTOR="${SCRIPT_DIR}/selftest-inject.mjs"
FAILED=0

require_cmd node
require_cmd rsync

if [ -z "${DATABASE_URL:-}" ] && [ -z "${DB_HOST:-}" ]; then
  die "缺少数据库连接参数（DATABASE_URL 或 DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME）—— 这个自测需要真实测试库"
fi

TMP_ROOT="$(mktemp -d /tmp/nmg-uniqueindexdb-selftest-XXXXXX)"
cleanup() {
  [ -d "$TMP_ROOT" ] && find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

log "=== 库内唯一键对账校验器反向验证开始 ==="
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
    log "  ✓ 基线 ${label}：退出码 0（库里与登记表 / 迁移一致）"
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
log "[0/2] 正向基线：真实测试库上的唯一键必须自洽……"
BASE_COPY="${TMP_ROOT}/baseline"
make_copy "$BASE_COPY"
expect_pass "check-unique-index-db.mjs" "$BASE_COPY"

# --- 1. 注入缺陷并验证 -----------------------------------------------------
log "[1/2] 注入「库里其实没有那道唯一约束」的缺陷……"

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

CASE_COPY="${TMP_ROOT}/case-unique-index-db-missing"
make_copy "$CASE_COPY"
if ! node "$INJECTOR" "unique-index-db-registry-injected" "$CASE_COPY" >/dev/null 2>&1; then
  warn "  ✗ unique-index-db-registry-injected：缺陷注入失败"
  node "$INJECTOR" "unique-index-db-registry-injected" "$CASE_COPY" 2>&1 | sed 's/^/      /'
  FAILED=1
else
  expect_failure "unique-index-db-registry-injected" "$CASE_COPY" "DB_UNIQUE_MISSING"
fi

# --- 2. 清理 ---------------------------------------------------------------
log "[2/2] 清理临时副本……"
find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
rmdir "$TMP_ROOT" 2>/dev/null || true

if [ "$FAILED" -ne 0 ]; then
  die "库内唯一键对账校验器反向验证失败 ❌"
fi

log "=== 反向验证通过 ✅（「库里没有那道唯一约束」被抓住，校验器非恒过）==="
log "库内唯一键对账校验器反向验证通过 ✅"
