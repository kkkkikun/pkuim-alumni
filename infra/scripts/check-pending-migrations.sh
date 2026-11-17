#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 迁移一致性对账（第 14 层校验）
#
#   bash infra/scripts/check-pending-migrations.sh                 # 检查业务库
#   bash infra/scripts/check-pending-migrations.sh --db nmg_alumni_test
#   bash infra/scripts/check-pending-migrations.sh --static-only   # 只做静态核对（不连库）
#
# 目的：把「代码里的迁移」与「数据库里已应用的迁移」变成**可执行的对账**。
#
# 背景（缺陷 #142 / #143）：
#   1) **部署不跑迁移**（#142）：deploy 的流程是「同步 → 构建 → up -d → 健康检查」，
#      中间**没有迁移这一步**。于是代码改了表结构、库里却还是旧结构 →
#      运行时直接报错（例：#140 把 `idempotency_records.scope` 放宽到 VARCHAR(255)，
#      库里还是 64 → 长路径的幂等请求 `Data too long` → 500）。
#      这类漂移**不会**在本地或测试库暴露（测试库每次重建并跑迁移），
#      只会在业务库上炸 —— 所以必须有一层**对账**来兜住。
#   2) **迁移清单有两份**（#143）：`migrations/index.ts`（给应用）与
#      `data-source.ts` 里的数组（给 `migration:run` CLI）曾**各抄一份**，
#      手工维护的两份迟早不同步，而**真正去应用迁移的正是后者** ——
#      漏加一个，新增的迁移就**永远不会被应用**，且没有任何报错。
#      现已收敛为单一事实来源（`migrations/index.ts`），本脚本的 R1 就是防它回退。
#
# 三条规则：
#   R1 清单与文件一致（**失败**）：`migrations/` 目录里的每个迁移文件
#      都必须登记进 `migrations/index.ts` 的清单；清单里也不能有**不存在的**文件。
#      —— 防止「加了迁移文件却忘了登记」（CLI 用的就是这份清单）。
#   R2 业务库无未应用迁移（**失败**）：代码清单里的每个迁移都必须在
#      数据库的 `migrations` 表里有对应记录。
#      —— 防止「代码要的新结构还没上库」。
#   R3 库里有代码里没有的迁移（**提示**）：数据库里存在清单之外的迁移记录
#      （例如回滚过、或代码分支不一致）→ 只提示，不判失败。
#
# 安全约束：**只读** —— 本脚本只执行 SELECT，不写库、不跑迁移。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

DB_NAME=""
STATIC_ONLY=0
ROOT="${PROJECT_ROOT}"
while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB_NAME="${2:-}"; [ -n "$DB_NAME" ] || die "--db 需要一个值"; shift 2 ;;
    --static-only) STATIC_ONLY=1; shift ;;
    --root) ROOT="${2:-}"; [ -n "$ROOT" ] || die "--root 需要一个值"; shift 2 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done
if [ "$STATIC_ONLY" -eq 0 ]; then
  # 只有连库那一步才需要知道库名（静态核对不需要 .env.prod，
  # 这样本机也能跑 `--static-only`）
  [ -n "$DB_NAME" ] || DB_NAME="$(env_get_or MYSQL_DATABASE nmg_alumni)"
fi

MIGRATIONS_DIR="${ROOT}/apps/api/src/database/migrations"
MANIFEST="${MIGRATIONS_DIR}/index.ts"

require_cmd node
[ -d "$MIGRATIONS_DIR" ] || die "迁移目录不存在：${MIGRATIONS_DIR}"
[ -f "$MANIFEST" ] || die "迁移清单不存在：${MANIFEST}"

FAILED=0

# --- 取出「清单里登记的迁移类名」 -------------------------------------------
# 清单文件里每个迁移的**导入行**与**数组项**都以类名出现；
# 这里取数组项（`  Xxx1730000000000,` 形态）更贴近「真正会被执行的那些」。
mapfile -t MANIFEST_CLASSES < <(
  awk '/^export const migrations = \[/,/^\];/' "$MANIFEST" \
    | sed -n 's/^[[:space:]]*\([A-Za-z_][A-Za-z0-9_]*\),[[:space:]]*$/\1/p'
)

# --- 取出「目录里的迁移文件」 ------------------------------------------------
mapfile -t FILE_CLASSES < <(
  grep -ho 'export class [A-Za-z_][A-Za-z0-9_]* implements MigrationInterface' \
    "$MIGRATIONS_DIR"/*.ts \
    | sed 's/export class //; s/ implements MigrationInterface//' \
    | sort -u
)

log "=== 迁移一致性对账（${DB_NAME}）==="
log "清单登记 ${#MANIFEST_CLASSES[@]} 个迁移；目录里有 ${#FILE_CLASSES[@]} 个迁移文件"

# --- R1：清单 ↔ 文件 --------------------------------------------------------
for cls in "${FILE_CLASSES[@]}"; do
  if ! printf '%s\n' "${MANIFEST_CLASSES[@]}" | grep -qx "$cls"; then
    warn "  ✗ [PENDING_MIGRATION_UNREGISTERED] 迁移文件 ${cls} **没有登记进** migrations/index.ts"
    warn "      —— 真正执行迁移的 CLI 用的就是那份清单，漏登记 = 这条迁移**永远不会被应用**"
    FAILED=1
  fi
done
for cls in "${MANIFEST_CLASSES[@]}"; do
  if ! printf '%s\n' "${FILE_CLASSES[@]}" | grep -qx "$cls"; then
    warn "  ✗ [PENDING_MIGRATION_MISSING_FILE] 清单里的 ${cls} 在 migrations/ 目录里**找不到对应文件**"
    FAILED=1
  fi
done
if [ "$FAILED" -eq 0 ]; then
  log "  ✓ R1：清单与迁移文件一一对应"
fi

if [ "$STATIC_ONLY" -eq 1 ]; then
  [ "$FAILED" -eq 0 ] || die "迁移一致性对账失败（静态部分）"
  log "=== 迁移一致性对账通过（静态部分）✅"
  exit 0
fi

# --- R2 / R3：清单 ↔ 数据库 -------------------------------------------------
require_cmd docker
DB_APPLIED="$(compose exec -T mysql sh -c \
  'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -B "$1" -e "SELECT name FROM migrations"' \
  sh "$DB_NAME" 2>/dev/null | grep -v 'Using a password on the command line' || true)"
[ -n "$DB_APPLIED" ] || die "读取数据库 ${DB_NAME} 的 migrations 表失败（空结果）"

for cls in "${MANIFEST_CLASSES[@]}"; do
  if ! printf '%s\n' "$DB_APPLIED" | grep -qx "$cls"; then
    warn "  ✗ [PENDING_MIGRATION] 迁移 ${cls} **尚未应用到** ${DB_NAME}"
    warn "      —— 代码已经按新结构工作，库里还是旧结构 → 运行时才会报错"
    FAILED=1
  fi
done

for applied in $DB_APPLIED; do
  if ! printf '%s\n' "${MANIFEST_CLASSES[@]}" | grep -qx "$applied"; then
    warn "  [提示] 数据库里有清单之外的迁移记录：${applied}（代码分支不一致？回滚过？）"
  fi
done

if [ "$FAILED" -eq 0 ]; then
  log "  ✓ R2：数据库已应用全部 ${#MANIFEST_CLASSES[@]} 条迁移，无未应用迁移"
fi

if [ "$FAILED" -ne 0 ]; then
  die "迁移一致性对账失败：存在未登记或未应用的迁移"
fi

log "=== 迁移一致性对账通过 ✅"
