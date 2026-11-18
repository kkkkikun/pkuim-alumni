#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 集成测试的**隔离性**自检：每个套件**单独跑**都必须绿。
#
# 背景（缺陷 #158）：
#   `resetDatabase()` 把 `admin_user_roles` 列为**保留表**（不清空），
#   而 `admin-test` 这个管理员账号被**十几个套件共用** ——
#   它的角色会**跨套件、跨运行累积**。
#   于是某个套件如果**没有显式授予自己需要的权限**，
#   它能不能拿到那个权限就取决于 **jest 的执行顺序**
#   （jest 按上一次运行的耗时缓存排序，容器一重建缓存就没了 → 顺序变）。
#
#   现场：上一轮整链 **295/295 全绿**，下一轮同一个用例就红了
#   （`http-status-semantics` 期望 200 实得 403 —— 少了 `alumni:manage`）。
#   也就是说：**回归链的绿不绿是随机的**，而且没有任何报错提示原因。
#
# 这一层为什么必要：
#   「整链绿」只能证明**某种执行顺序下**没问题；
#   「单独跑也绿」才能证明这个套件**不依赖别的套件的残留状态**。
#   后者才是可复现、可并行、可持续的前提。
#
# 退出码：0 全部套件单独跑都绿；1 有套件单独跑会红
# =============================================================================

set -Eeuo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

TEST_DB_NAME="${TEST_DB_NAME:-nmg_alumni_test}"
SPEC_DIR="${PROJECT_ROOT}/apps/api/test/integration"
SPEC_FILTER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --filter) SPEC_FILTER="${2:-}"; [ -n "$SPEC_FILTER" ] || die "--filter 需要一个值"; shift 2 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

require_cmd docker
require_file "$ENV_FILE"

MAIN_DB_NAME="$(env_get_or MYSQL_DATABASE nmg_alumni)"
if [ "$TEST_DB_NAME" = "$MAIN_DB_NAME" ]; then
  die "拒绝执行：测试库名必须与业务库不同（当前为 '${TEST_DB_NAME}'）"
fi

MYSQL_ROOT_PASSWORD="$(env_get_or MYSQL_ROOT_PASSWORD '')"
MYSQL_USER="$(env_get_or MYSQL_USER nmg)"
MYSQL_PASSWORD="$(env_get_or MYSQL_PASSWORD '')"

build_db_url() {
  python3 - "$1" "$MYSQL_USER" "$MYSQL_PASSWORD" <<'PY'
import sys, urllib.parse
db, user, pwd = sys.argv[1], sys.argv[2], sys.argv[3]
# 主机必须是容器网络里的 mysql，库名在路径上 —— 写反了会得到
# 「getaddrinfo EAI_AGAIN <库名>」（把库名当成了主机名）。
print(f"mysql://{urllib.parse.quote(user, safe='')}:{urllib.parse.quote(pwd, safe='')}@mysql:3306/{db}")
PY
}
TEST_DB_URL="$(build_db_url "$TEST_DB_NAME")"

log "集成测试隔离性自检（每个套件单独跑必须绿）"
log "测试库=${TEST_DB_NAME}  业务库(只读)=${MAIN_DB_NAME}"

# --- 0. 等待 api 容器就绪 ----------------------------------------------------
log "等待 api 容器就绪……"
for _ in $(seq 1 60); do
  STATUS="$(compose ps --format '{{.Status}}' api 2>/dev/null | tail -n 1)"
  case "$STATUS" in
    *healthy*) break ;;
    *unhealthy*|*Restarting*) die "api 容器异常：${STATUS}" ;;
  esac
  sleep 2
done

SPECS="$(ls "${SPEC_DIR}"/*.e2e-spec.ts 2>/dev/null | xargs -n1 basename 2>/dev/null || true)"
if [ -n "$SPEC_FILTER" ]; then
  SPECS="$(printf '%s\n' "$SPECS" | grep -- "$SPEC_FILTER" || true)"
fi
if [ -z "$SPECS" ]; then
  die "找不到集成测试套件：${SPEC_DIR}${SPEC_FILTER:+ (filter=${SPEC_FILTER})}"
fi

# --- 0.5 前置检查：包根目录不得有测试文件残留 --------------------------------
# ⚠️ 现场（缺陷 #158 的姊妹问题）：
#   `apps/api/` 根目录下残留着两份 Nov 16 调试时 cp 出来的副本
#   （`event-capacity-accounting.e2e-spec.ts` / `events.service.ts`）——
#   它们**不在 git 里**，但服务器的工作副本里有，
#   于是被 **Docker 构建上下文**（= 服务器工作副本）一起烘进了镜像。
#
#   后果：jest 的 `testRegex` 匹配**整棵目录树**，
#   于是那份残留副本**和正式套件同时被匹配**，
#   而它引用的 `../helpers` 在那个位置不存在 →
#   整条链报「Test suite failed to run」，与真实用例无关。
#
#   所以这里先扫一遍：包根目录（src/ 与 test/ 之外）不允许出现测试文件。
STRAY="$(find "${PROJECT_ROOT}/apps" "${PROJECT_ROOT}/packages" -maxdepth 2 -type f \
  \( -name '*.spec.ts' -o -name '*.e2e-spec.ts' -o -name '*.test.ts' \) \
  -not -path '*/src/*' -not -path '*/test/*' -not -path '*/node_modules/*' 2>/dev/null | sed "s|^${PROJECT_ROOT}/||" || true)"
if [ -n "$STRAY" ]; then
  die "包根目录有测试文件残留（会被 jest 同时匹配 → 整链报 'Test suite failed to run'）：
$(printf '%s\n' "$STRAY" | sed 's/^/  · /')

处置：这些是调试残留（通常来自 cp 出来的副本）。
删掉后**必须重建镜像** —— 镜像是从服务器工作副本构建的，
工作副本干净了但旧镜像里那份还在。
另外：rsync 不会删除服务器上的多余文件，这类残留只能手工清理。"
fi
TOTAL="$(printf '%s\n' "$SPECS" | wc -l | tr -d ' ')"
log "共 ${TOTAL} 个套件，逐个单独跑……"

PASS=0
FAIL=0
FAILED_LIST=""
LOG_DIR="$(mktemp -d /tmp/nmg-isolation.XXXXXX)"
cleanup() {
  if [ -d "$LOG_DIR" ]; then
    find "$LOG_DIR" -mindepth 1 -delete 2>/dev/null || true
    rmdir "$LOG_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

for spec in $SPECS; do
  set +e
  compose exec -T \
    -e DATABASE_URL="$TEST_DB_URL" \
    -e DB_NAME="$TEST_DB_NAME" \
    -e DB_HOST=mysql \
    -e DB_PORT=3306 \
    -e DB_USER="$MYSQL_USER" \
    -e DB_PASSWORD="$MYSQL_PASSWORD" \
    -e REDIS_DB=1 \
    -e NODE_ENV=test \
    -e RATE_LIMIT_ENABLED=false \
    api sh -lc "cd /app/apps/api && ./node_modules/.bin/jest --config jest.config.js --runInBand --testPathPattern='${spec}' --forceExit" \
    > "${LOG_DIR}/${spec}.log" 2>&1
  RC=$?
  set -e
  if [ "$RC" -eq 0 ]; then
    PASS=$((PASS+1))
    printf '  ✓ %s\n' "$spec"
  else
    FAIL=$((FAIL+1))
    FAILED_LIST="${FAILED_LIST} ${spec}"
    printf '  ✗ %s （退出码 %s）\n' "$spec" "$RC"
    grep -E '●' "${LOG_DIR}/${spec}.log" | head -3 | sed 's/^/      /' || true
  fi
done

log "------------------------------------------------------------"
log "单独跑：${PASS} 绿 / ${FAIL} 红（共 ${TOTAL}）"
if [ "$FAIL" -ne 0 ]; then
  log "以下套件**单独跑会红** → 它们依赖了别的套件的残留状态："
  for s in $FAILED_LIST; do log "  · $s"; done
  log ""
  log "修法（参考 admin-account-management.e2e-spec.ts 的写法）："
  log "  用**唯一账号 + 唯一角色**显式授予本套件需要的权限，"
  log "  不要共用 admin-test，更不要指望别的套件留下的授权。"
  exit 1
fi
log "=== 隔离性自检通过 ✅（每个套件都能独立跑，不依赖执行顺序）==="
