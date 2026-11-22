#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 「两层结论逐条对账」的反向验证（自测）
#
#   bash infra/scripts/check-layer-reconciliation-selftest.sh
#
# 目的：证明 `check-layer-conclusion-reconciliation.mjs` **不是恒过**——
#       当两层真的给出**互相矛盾**的结论（同一个对象，一个说「一致」、
#       一个说「不一致」）时，它必须报错并返回非 0。
#
# ⚠️ **为什么这个自测最要紧**：
#   对账脚本的输入是**两层的结论**，而当两层**都绿**的时候，
#   它们的结论集是空的 —— 一个只比对「差异集」的脚本在这种状态下
#   **必然恒过**（永远没有差异可比）。
#   所以本自测不只验「抓不抓得到矛盾」，还验两件更要紧的事：
#     ① **基线是真的在比**：它在**正常副本**上也要跑出**逐条对齐**的结论
#        （而不是「什么都没比就过了」）；
#     ② **口径漂移抓得住**：两层的判定口径一旦分叉（比的对象数不同），
#        它必须报出来 —— 那是「结论一致但其实没在同一个口径上比」的假绿。
#
# 注入点 ↔ 判定码**一一对应**（5 例 + 1 条反向用例）：
#   LAYER_VERDICT_CONFLICT     ← layer-reconciliation-migration-column-drifted
#   LAYER_DIMENSION_STATS_DRIFT ← layer-reconciliation-migration-column-removed
#   LAYER_SKIPPED_DIVERGENCE   ← layer-reconciliation-default-expression-skewed
#   LAYER_VERDICT_OMISSION     ← layer-reconciliation-registry-entry-removed
#   LAYER_ISSUE_CODE_UNMAPPED  ← layer-reconciliation-new-issue-code
#   （无分叉）                 ← layer-reconciliation-entity-default-drifted（反向用例）
#
# 流程：
#   0. 正向基线：正常副本上必须「逐条一致」、退出码 0；
#   1. 逐个注入缺陷 → 断言「退出码非 0」且「输出命中对应的判定码」；
#   2. 元自检：用「永远返回 0 的假校验器」证明断言函数本身有效；
#   3. 覆盖度自检：对账脚本的判定码清单必须与注入点一一对应。
#
# 前置条件：一个**已应用迁移**的测试库（连接参数走
#   DATABASE_URL 或 DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME）。
#
# 退出码：0 自测通过；1 自测失败（对账脚本恒过或报错不准）。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

SCRIPT_DIR="${PROJECT_ROOT}/infra/scripts"
CHECKER="${SCRIPT_DIR}/check-layer-conclusion-reconciliation.mjs"
INJECTOR="${SCRIPT_DIR}/selftest-inject.mjs"
FAILED=0

require_cmd node
require_cmd rsync

if [ -z "${DATABASE_URL:-}" ] && [ -z "${DB_HOST:-}" ]; then
  die "缺少数据库连接参数（DATABASE_URL 或 DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME）—— 这个自测需要真实测试库"
fi

TMP_ROOT="$(mktemp -d /tmp/nmg-layerrecon-selftest-XXXXXX)"
cleanup() {
  [ -d "$TMP_ROOT" ] && find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

log "=== 两层结论对账反向验证开始 ==="
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
  if [ "$rc" -ne 0 ]; then
    warn "  ✗ 基线 ${label}：退出码 ${rc}（干净副本竟然不通过）"
    printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
    FAILED=1
    return
  fi
  # ⚠️ **基线必须真的在比**，不能是「什么都没比就过了」——
  #    输出里必须出现「逐条一致」这句话，且**对象数大于 0**。
  if ! printf '%s' "$out" | grep -q "两层结论逐条一致"; then
    warn "  ✗ 基线 ${label}：退出码 0 但输出里没有「逐条一致」—— 对账脚本可能什么都没比就过了"
    printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
    FAILED=1
    return
  fi
  local compared
  compared="$(printf '%s' "$out" | grep -oE '[0-9]+ 个对象' | head -1 | grep -oE '[0-9]+' || true)"
  if [ -z "$compared" ] || [ "$compared" -eq 0 ]; then
    warn "  ✗ 基线 ${label}：比对的对象数为 ${compared:-0} —— 比对内容为空，等于没比"
    FAILED=1
    return
  fi
  log "  ✓ 基线 ${label}：退出码 0，逐条对齐了 ${compared} 个对象"
}

expect_failure() {
  local label="$1" root="$2" expected="$3" out rc
  set +e
  out="$(node "$CHECKER" --root "$root" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    warn "  ✗ ${label}：退出码 0 —— 对账脚本恒过，不可信"
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
log "[0/3] 正向基线：两层结论必须逐条一致……"
BASE_COPY="${TMP_ROOT}/baseline"
make_copy "$BASE_COPY"
expect_pass "check-layer-conclusion-reconciliation.mjs" "$BASE_COPY"

# --- 1. 元自检 -------------------------------------------------------------
log "[1/3] 元自检：对「永远返回 0 的假校验器」必须判失败……"
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

# --- 2. 逐个注入缺陷并验证 -------------------------------------------------
log "[2/3] 逐个注入缺陷并验证对账脚本……"

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

# 迁移里那一列的长度被改掉 → 静态层说「不一致」，库内层说「一致」→ 矛盾
run_case "layer-reconciliation-migration-column-drifted" "LAYER_VERDICT_CONFLICT"
# 迁移里那一列整个被删掉 → 静态层判不了它的默认值，库内层判得了 → 口径漂移
run_case "layer-reconciliation-migration-column-removed" "LAYER_DIMENSION_STATS_DRIFT"
# 迁移里那一列的默认值改成表达式 → 静态层「判不了」，库内层「判了」→ 覆盖面分叉
run_case "layer-reconciliation-default-expression-skewed" "LAYER_SKIPPED_DIVERGENCE"
# 登记表里一道唯一键的条目被删 → 库内层压根不判它，静态层照判 → 互相遗漏
run_case "layer-reconciliation-registry-entry-removed" "LAYER_VERDICT_OMISSION"
# 新增一个**没归维度**的判定码 → 它的结论没人交叉验证 → 归属不完整
run_case "layer-reconciliation-new-issue-code" "LAYER_ISSUE_CODE_UNMAPPED"

# ⚠️ **反向用例**：实体里那一列的默认值被改掉 ——
#   两层**都**判了不一致、且说的是**同一件事** → 对账脚本**不该**报任何分叉。
#   这一条守的是「对账脚本不是『只要有一层说不一致就报』」——
#   否则上面两条用例报出来的「矛盾」就没有说服力了。
log "  反向用例：两层都判不一致（说的是同一件事）时，对账脚本必须放行……"
NEG_COPY="${TMP_ROOT}/case-negative"
make_copy "$NEG_COPY"
if node "$INJECTOR" "layer-reconciliation-entity-default-drifted" "$NEG_COPY" >/dev/null 2>&1; then
  set +e
  NEG_OUT="$(node "$CHECKER" --root "$NEG_COPY" 2>&1)"
  NEG_RC=$?
  set -e
  if [ "$NEG_RC" -eq 0 ]; then
    log "  ✓ 反向用例通过：两层结论一致（都判了同一处不一致），对账脚本未误报"
  else
    warn "  ✗ 反向用例失败：两层结论一致却被报了分叉（退出码 ${NEG_RC}）—— 对账脚本在误报"
    printf '%s\n' "$NEG_OUT" | tail -12 | sed 's/^/      /'
    FAILED=1
  fi
else
  warn "  ✗ 反向用例：缺陷注入失败"
  FAILED=1
fi

# --- 3. 覆盖度自检 ---------------------------------------------------------
log "[3/3] 覆盖度自检：判定码清单 ↔ 注入点必须一一对应……"
COVER_CODES="$(node --input-type=module - "$CHECKER" <<'NODE'
import fs from 'node:fs';
const src = fs.readFileSync(process.argv[2], 'utf8');
const codes = new Set();
// ⚠️ 先把**注释行**去掉 —— 注释里写的 `kind: 'X'` 是举例，
//    不是真的判定码（否则清单里会凭空多出一个「X」）。
const codeOnly = src
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');
const re = /kind:\s*'([A-Z_]+)'/g;
let m;
while ((m = re.exec(codeOnly)) !== null) codes.add(m[1]);
process.stdout.write([...codes].sort().join('\n'));
NODE
)"
COVER_COUNT="$(printf '%s\n' "$COVER_CODES" | grep -c . || true)"
log "  对账脚本可报出的判定码：${COVER_COUNT} 个"
MISSING_CODES=""
for code in $COVER_CODES; do
  if ! grep -q "\"${code}\"" "$0"; then
    MISSING_CODES="${MISSING_CODES} ${code}"
  fi
done
if [ -n "$MISSING_CODES" ]; then
  warn "  ✗ 以下判定码在本自测里**没有对应的注入点**：${MISSING_CODES}"
  warn "     —— 补一个注入点（注入点 ↔ 判定码一一对应），否则这条判定码的退化形态没人守"
  FAILED=1
else
  log "  ✓ 覆盖度自检通过：${COVER_COUNT} 个判定码全部有对应的注入点"
fi

# --- 4. 清理 ---------------------------------------------------------------
find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
rmdir "$TMP_ROOT" 2>/dev/null || true

if [ "$FAILED" -ne 0 ]; then
  die "两层结论对账反向验证失败 ❌"
fi

log "=== 反向验证通过 ✅（两层结论矛盾与口径漂移都被抓出，对账脚本非恒过）==="
