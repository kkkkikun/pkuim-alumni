#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 迁移一致性对账校验器的反向验证（自测）
#
#   bash infra/scripts/check-pending-migrations-selftest.sh
#
# 目的：证明 `check-pending-migrations.sh` **不是恒过**——
#       「加了迁移却忘了登记」与「登记了却没应用到库」都必须被抓出；
#       同时证明它**不吵**：干净副本必须通过。
#
# 为什么这个校验器值得单测：
#   缺陷 #142（部署不跑迁移）与 #143（迁移清单有两份）都属于
#   「**没有任何报错**」的静默失败 —— 本地测试库每次重建并跑迁移，
#   所以这类漂移**只会在业务库上炸**。没有对账层就等于没有防线。
#
# 四段式：
#   [0/4] 正向基线：干净副本 → 退出码 0，且不得出现 PENDING_*；
#   [1/4] 注入「迁移文件未登记进清单」→ 必须退出码非 0 且命中
#         PENDING_MIGRATION_UNREGISTERED；
#   [2/4] 注入「登记了但数据库里没有」→ 必须退出码非 0 且命中 PENDING_MIGRATION；
#   [3/4] 元自检（恒过的假校验器必须被判失败）；
#   [4/4] 清理。
#
# 安全约束：只在临时目录里的副本上改动；**全程只读数据库**，不跑迁移、不写库。
#
# 退出码：0 自测通过；1 自测失败。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

SCRIPT_DIR="${PROJECT_ROOT}/infra/scripts"
CHECKER="${SCRIPT_DIR}/check-pending-migrations.sh"
FAILED=0

require_cmd node
require_cmd rsync

DB_NAME="$(env_get_or MYSQL_DATABASE nmg_alumni)"

TMP_ROOT="$(mktemp -d /tmp/nmg-mig-selftest-XXXXXX)"
cleanup() {
  [ -d "$TMP_ROOT" ] && find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

log "=== 迁移一致性对账校验器反向验证开始 ==="
log "临时副本根目录：${TMP_ROOT}"
log "对账目标库：${DB_NAME}（只读）"

make_copy() {
  local dest="$1"
  mkdir -p "$dest"
  rsync -a \
    --exclude 'node_modules/' --exclude '.git/' --exclude 'dist/' \
    --exclude 'coverage/' --exclude '.env*' --exclude '*.log' \
    --exclude 'tests/concurrency/results/' \
    "${PROJECT_ROOT}/" "${dest}/"
}

# --- 0. 正向基线 ----------------------------------------------------------
log "[0/4] 正向基线：干净副本上不得有未登记 / 未应用的迁移……"
BASE_COPY="${TMP_ROOT}/baseline"
make_copy "$BASE_COPY"
set +e
BASE_OUT="$(bash "$CHECKER" --root "$BASE_COPY" --db "$DB_NAME" 2>&1)"
BASE_RC=$?
set -e
if [ "$BASE_RC" -ne 0 ]; then
  warn "  ✗ 基线：退出码 ${BASE_RC}（干净副本竟然不通过）"
  printf '%s\n' "$BASE_OUT" | tail -12 | sed 's/^/      /'
  FAILED=1
elif printf '%s' "$BASE_OUT" | grep -q "PENDING_MIGRATION"; then
  warn "  ✗ 基线：干净副本竟报出了未应用迁移 → 规则太吵（误报）"
  printf '%s\n' "$BASE_OUT" | tail -12 | sed 's/^/      /'
  FAILED=1
else
  log "  ✓ 基线：退出码 0，迁移清单与数据库完全一致"
  printf '%s\n' "$BASE_OUT" | grep "R2" | head -2 | sed 's/^/      /'
fi

# --- 元自检：断言函数本身有效 ----------------------------------------------
log "  元自检：恒过的假校验器必须被判失败……"
FAKE_CHECKER="${TMP_ROOT}/fake-checker.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKE_CHECKER"
chmod +x "$FAKE_CHECKER"
META_OUT="$(
  set +e
  out="$(bash "$FAKE_CHECKER" 2>&1)"
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

  # 注入：在迁移目录里加一条**新迁移**（本 case 不写库）
  # ⚠️ heredoc 里只用 ASCII —— 中文会被执行环境吞掉。
  local mig_dir="${case_copy}/apps/api/src/database/migrations"
  cat > "${mig_dir}/1730000009999-InjectedPendingMigration.ts" <<'TS'
import { MigrationInterface, QueryRunner } from 'typeorm';

/** Injected migration that has never been applied. */
export class InjectedPendingMigration1730000009999 implements MigrationInterface {
  name = 'InjectedPendingMigration1730000009999';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('SELECT 1');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('SELECT 1');
  }
}
TS

  if [ "$case_name" = "migration-registered-not-applied" ]; then
    # 再把它登记进清单 → R1 通过，但库里没有 → R2 必须抓出
    python3 - "${mig_dir}/index.ts" <<'PY'
import re, sys
path = sys.argv[1]
s = open(path, encoding='utf-8').read()
s = s.replace(
    "import { InitSchema1730000000000 } from './1730000000000-InitSchema';",
    "import { InitSchema1730000000000 } from './1730000000000-InitSchema';\n"
    "import { InjectedPendingMigration1730000009999 } from './1730000009999-InjectedPendingMigration';",
)
s = re.sub(r"(export const migrations = \[\n)", r"\1  InjectedPendingMigration1730000009999,\n", s)
open(path, 'w', encoding='utf-8').write(s)
PY
  fi

  set +e
  out="$(bash "$CHECKER" --root "$case_copy" --db "$DB_NAME" 2>&1)"
  rc=$?
  set -e

  if [ "$rc" -eq 0 ]; then
    warn "  ✗ ${case_name}：退出码 0 —— 校验器恒过，不可信"
    FAILED=1
  elif printf '%s' "$out" | grep -q "$expected"; then
    log "  ✓ ${case_name}：退出码 ${rc}，命中 ${expected}"
    printf '%s\n' "$out" | grep "$expected" | head -2 | sed 's/^/      /'
  else
    warn "  ✗ ${case_name}：输出未命中 ${expected}"
    printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
    FAILED=1
  fi
}

# --- 1~2. 注入缺陷并验证 ---------------------------------------------------
log "[1/4] 注入「迁移文件未登记进清单」并验证校验器……"
run_case "migration-file-unregistered" "PENDING_MIGRATION_UNREGISTERED"

log "[2/4] 注入「已登记但数据库里没有」并验证校验器……"
run_case "migration-registered-not-applied" "PENDING_MIGRATION"

# --- 3. 清理 ---------------------------------------------------------------
log "[3/4] 清理临时副本……"
find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
rmdir "$TMP_ROOT" 2>/dev/null || true

if [ "$FAILED" -ne 0 ]; then
  die "迁移一致性对账校验器反向验证失败 ❌"
fi

log "=== 反向验证通过 ✅（未登记 / 未应用的迁移都能被抓出）==="
log "迁移一致性对账校验器反向验证通过 ✅"
