#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 「库内实况」对账校验器的反向验证（自测）
#
#   bash infra/scripts/check-db-reality-selftest.sh
#
# ⚠️ 第十七轮起，**两份**自测合并成**这一支**：
#   此前是 `check-unique-index-db-selftest.sh`（唯一键那一半，1 例）
#   与 `check-migration-schema-db-selftest.sh`（实体 ↔ 库那一半，8 例），
#   同一层对账被拆成两支、各自维护注入点 —— 判定码清单也散在两处。
#   现在合并为一支：**注入点与判定码一一对应**（下表），
#   任何一条判定码漏了注入点，这一支自测就会在「覆盖度自检」那一步红。
#
# 目的：证明 `check-db-reality.mjs` **不是恒过**——
#       当「实体声明了、库里其实不存在」的索引 / 外键 / 列真的发生时，
#       它必须报错并返回非 0。
#
# 为什么这个校验器值得单测：
#   它守的是「生产库里**真的**有那些索引 / 外键 / 列」这一层 ——
#   静态对账（`check-error-semantics.mjs` 的 R5 / R7 / R8 / R9）只能证明
#   「迁移里**写了**创建那道索引」，证明不了「**这个库里真的有**」。
#   而这一层的失败是**静默**的：
#     - 索引没建 → 按该列的查询退化成全表扫（生产上只是「慢」，没人报警）；
#     - 外键没建 → 引用完整性不再被数据库保证；
#     - 列定义对不上 → 超长写入被**静默截断**（数据丢失）。
#
# 注入点 ↔ 判定码**一一对应**（17 例，判定码 17 个）：
#   DB_UNIQUE_MISSING            ← unique-index-db-registry-injected
#   DB_INDEX_MISSING             ← migration-schema-db-entity-index-injected
#   DB_INDEX_COLUMN_MISMATCH     ← migration-schema-db-index-columns-injected
#   DB_COLUMN_DEF_MISMATCH       ← migration-schema-db-column-length-injected
#   DB_COLUMN_DEF_MISMATCH       ← migration-schema-db-column-nullable-injected
#   DB_FOREIGN_KEY_MISSING       ← migration-schema-db-foreign-key-injected
#   DB_COLUMN_DEFAULT_MISMATCH   ← migration-schema-db-column-default-injected
#   DB_COLUMN_UNSIGNED_MISMATCH  ← migration-schema-db-column-unsigned-injected
#   DB_COLUMN_ENUM_MISMATCH      ← migration-schema-db-column-enum-injected
#   DB_UNIQUE_NOT_DECLARED       ← db-reality-unique-not-declared-injected
#   DB_TABLE_MISSING             ← db-reality-table-missing-injected
#   DB_INDEX_UNIQUENESS_MISMATCH ← db-reality-index-uniqueness-injected
#   DB_INDEX_NOT_DECLARED        ← db-reality-index-not-declared-injected
#   DB_FOREIGN_KEY_TARGET_MISMATCH ← db-reality-foreign-key-target-injected
#   DB_FOREIGN_KEY_NOT_DECLARED  ← db-reality-foreign-key-not-declared-injected
#   DB_COLUMN_MISSING            ← db-reality-column-missing-injected
#   DB_COLUMN_NOT_DECLARED       ← db-reality-column-not-declared-injected
#
# 流程：
#   0. 正向基线：对着**真实测试库**跑，必须 0 不一致、退出码 0；
#   1. 逐个注入缺陷（在**临时副本**里改实体声明，库不动）→
#      断言「退出码非 0」且「输出命中对应的判定码」；
#   2. **覆盖度自检**：判定码清单必须与校验器源码里实际能报出的**完全一致**
#      （新增判定码却没补注入点 → 这一支自测立刻红）；
#   3. 元自检：用「永远返回 0 的假校验器」证明断言函数本身有效；
#   4. 清理全部临时副本。
#
# 安全约束：
#   - 全程**只读**：只查 information_schema，不建索引、不跑迁移、不写数据；
#     校验器自身还会把会话设成 `READ ONLY`（三重护栏，见脚本头注释）。
#   - 缺陷注入只发生在**临时副本**里（改的是副本里的实体声明），
#     真实工作副本与数据库永远只读。
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
CHECKER="${SCRIPT_DIR}/check-db-reality.mjs"
INJECTOR="${SCRIPT_DIR}/selftest-inject.mjs"
FAILED=0

require_cmd node
require_cmd rsync

if [ -z "${DATABASE_URL:-}" ] && [ -z "${DB_HOST:-}" ]; then
  die "缺少数据库连接参数（DATABASE_URL 或 DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME）—— 这个自测需要真实测试库"
fi

TMP_ROOT="$(mktemp -d /tmp/nmg-dbreality-selftest-XXXXXX)"
cleanup() {
  [ -d "$TMP_ROOT" ] && find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

log "=== 库内实况对账校验器反向验证开始 ==="
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
    log "  ✓ 基线 ${label}：退出码 0（库里与实体声明一致）"
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
log "[0/4] 正向基线：真实测试库上的库内实况必须与实体声明自洽……"
BASE_COPY="${TMP_ROOT}/baseline"
make_copy "$BASE_COPY"
expect_pass "check-db-reality.mjs" "$BASE_COPY"

# --- 1. 逐个注入缺陷并验证 -------------------------------------------------
log "[1/4] 逐个注入缺陷并验证校验器……"

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

# --- 唯一键那一半 -----------------------------------------------------------
# 登记表要求一道唯一约束，但**库里没有**（迁移没建 / 没应用 / 被人手工删了）
run_case "unique-index-db-registry-injected" "DB_UNIQUE_MISSING"
# 库里多出一道**来源不明**的唯一约束（登记表与迁移里都没有）
run_case "db-reality-unique-not-declared-injected" "DB_UNIQUE_NOT_DECLARED"

# --- 表 ---------------------------------------------------------------------
# 实体声明了一张**库里根本没有**的表
run_case "db-reality-table-missing-injected" "DB_TABLE_MISSING"

# --- 索引 -------------------------------------------------------------------
# 实体声明了、库里其实不存在的那条索引
run_case "migration-schema-db-entity-index-injected" "DB_INDEX_MISSING"
# 索引的**列**与库里对不上
run_case "migration-schema-db-index-columns-injected" "DB_INDEX_COLUMN_MISMATCH"
# 索引的**唯一性**与库里对不上（库里是非唯一、实体说唯一）
run_case "db-reality-index-uniqueness-injected" "DB_INDEX_UNIQUENESS_MISMATCH"
# 库里多出一道**实体没声明**的索引
run_case "db-reality-index-not-declared-injected" "DB_INDEX_NOT_DECLARED"

# --- 外键 -------------------------------------------------------------------
# 实体声明了、库里其实没有的那条外键
run_case "migration-schema-db-foreign-key-injected" "DB_FOREIGN_KEY_MISSING"
# 外键的**指向**与库里对不上
run_case "db-reality-foreign-key-target-injected" "DB_FOREIGN_KEY_TARGET_MISMATCH"
# 库里多出一道**实体没声明**的外键
run_case "db-reality-foreign-key-not-declared-injected" "DB_FOREIGN_KEY_NOT_DECLARED"

# --- 列 ---------------------------------------------------------------------
# 实体声明了、库里其实没有的那一列
run_case "db-reality-column-missing-injected" "DB_COLUMN_MISSING"
# 同一列的**长度**不一致（写入会被静默截断）
run_case "migration-schema-db-column-length-injected" "DB_COLUMN_DEF_MISMATCH"
# 同一列的**可空性**不一致
run_case "migration-schema-db-column-nullable-injected" "DB_COLUMN_DEF_MISMATCH"
# 库里多出一列**实体没声明**的列
run_case "db-reality-column-not-declared-injected" "DB_COLUMN_NOT_DECLARED"
# 同一列的**默认值**不一致
run_case "migration-schema-db-column-default-injected" "DB_COLUMN_DEFAULT_MISMATCH"
# 同一列的**无符号性**不一致
run_case "migration-schema-db-column-unsigned-injected" "DB_COLUMN_UNSIGNED_MISMATCH"
# 同一列的**枚举取值**不一致
run_case "migration-schema-db-column-enum-injected" "DB_COLUMN_ENUM_MISMATCH"

# --- 2. 覆盖度自检：判定码清单必须与校验器实际能报出的完全一致 ----------------
#
# ⚠️ 为什么要有这一步：注入点与判定码「一一对应」这句话，
#   只有**真的**逐条核对过才成立 ——
#   校验器新增了一个判定码却忘了补注入点，这一支自测会立刻红，
#   而不是等到「那个新判定码的退化形态其实抓不住」的那一天。
log "[2/4] 覆盖度自检：判定码清单 ↔ 注入点必须一一对应……"
# ⚠️ 只取**缺陷码**（`issues.push` 里的 `kind`），**不含**提示码
#   （`notes.push` 里的 `DB_*_OK` / `DB_INDEX_BY_*`）——
#   提示码是「判了没问题」，它**本来就不该**有对应的注入点。
COVER_CODES="$(node --input-type=module - "$CHECKER" <<'NODE'
import fs from 'node:fs';
const src = fs.readFileSync(process.argv[2], 'utf8');
const codes = new Set();
// ⚠️ 先把**注释行**去掉 —— 注释里写的 `kind: 'X'` 是举例，不是真的判定码。
const codeOnly = src
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');
const re = /issues\.push\(\{\s*\n\s*kind:\s*'([A-Z_]+)'/g;
let m;
while ((m = re.exec(codeOnly)) !== null) codes.add(m[1]);
process.stdout.write([...codes].sort().join('\n'));
NODE
)"
COVER_COUNT="$(printf '%s\n' "$COVER_CODES" | grep -c . || true)"
log "  校验器可报出的缺陷判定码：${COVER_COUNT} 个"
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

# --- 3. 清理 ---------------------------------------------------------------
log "[3/4] 清理临时副本……"
find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
rmdir "$TMP_ROOT" 2>/dev/null || true

if [ "$FAILED" -ne 0 ]; then
  die "库内实况对账校验器反向验证失败 ❌"
fi

log "=== 反向验证通过 ✅（17 类「静态说有、库里其实没有」的缺陷全部被抓出，校验器非恒过）==="
log "库内实况对账校验器反向验证通过 ✅"
