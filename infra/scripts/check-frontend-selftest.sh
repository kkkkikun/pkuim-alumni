#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 前端 / 契约校验器的反向验证（自测）
#
#   bash infra/scripts/check-frontend-selftest.sh
#
# 目的：证明 check-miniprogram / check-admin-web / check-spec-coverage /
#       check-api-spec-doc / check-client-paths 这 5 个校验器
#       **不是恒过**——注入真实缺陷后必须报错并返回非 0 退出码。
#
# 流程：
#   0. 正向基线：在一份**干净副本**上跑全部校验器，必须全部退出码 0
#      （否则说明副本环境本身有问题，后续用例的结论不可信）；
#   1. 逐个用例：在**独立临时副本**里注入缺陷 → 跑对应校验器
#      → 断言「退出码非 0」且「输出命中预期错误码」；
#   2. 清理全部临时副本。
#
# 安全约束：
#   - 只在临时目录（mktemp -d）里的副本上改动，真实工作副本永远只读；
#   - 真实工作副本的内容以 rsync 只读拷贝的方式复制，不做任何原地修改。
#
# 退出码：0 自测通过；1 自测失败（某个校验器恒过或报错不准）。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

SWAGGER_URL="${SWAGGER_URL:-http://127.0.0.1:18081/docs-json}"
SCRIPT_DIR="${PROJECT_ROOT}/infra/scripts"
FAILED=0

require_cmd node
require_cmd rsync

TMP_ROOT="$(mktemp -d /tmp/nmg-frontend-selftest-XXXXXX)"
cleanup() {
  [ -d "$TMP_ROOT" ] && find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

log "=== 前端 / 契约校验器反向验证开始 ==="
log "临时副本根目录：${TMP_ROOT}"

# --- 复制一份干净副本 -------------------------------------------------------
make_copy() {
  local dest="$1"
  mkdir -p "$dest"
  rsync -a \
    --exclude 'node_modules/' --exclude '.git/' --exclude 'dist/' \
    --exclude 'coverage/' --exclude '.env*' --exclude '*.log' \
    "${PROJECT_ROOT}/" "${dest}/"
}

# --- 断言：校验器应当通过（退出码 0）-----------------------------------------
expect_pass() {
  local label="$1" checker="$2" root="$3" needs_swagger="$4" out rc checker_path
  checker_path="${checker}"
  case "$checker_path" in /*) : ;; *) checker_path="${SCRIPT_DIR}/${checker_path}" ;; esac
  set +e
  if [ "$needs_swagger" = "yes" ]; then
    out="$(node "$checker_path" --root "$root" --swagger "$SWAGGER_URL" 2>&1)"
  else
    out="$(node "$checker_path" --root "$root" 2>&1)"
  fi
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    log "  ✓ 基线 ${label}：退出码 0"
  else
    warn "  ✗ 基线 ${label}：退出码 ${rc}（干净副本竟然不通过）"
    printf '%s\n' "$out" | tail -8 | sed 's/^/      /'
    FAILED=1
  fi
}

# --- 断言：校验器应当失败并命中指定错误码 -----------------------------------
# expect_failure：needs_swagger=yes 时传 --swagger（URL）
# expect_failure_with_swagger：swagger_arg 可以是 URL，也可以是本地 Swagger 文件路径
expect_failure_with_swagger() {
  local label="$1" checker="$2" expected_code="$3" root="$4" swagger_arg="$5" out rc checker_path
  checker_path="${checker}"
  case "$checker_path" in /*) : ;; *) checker_path="${SCRIPT_DIR}/${checker_path}" ;; esac
  set +e
  if [ -n "$swagger_arg" ]; then
    out="$(node "$checker_path" --root "$root" --swagger "$swagger_arg" 2>&1)"
  else
    out="$(node "$checker_path" --root "$root" 2>&1)"
  fi
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    warn "  ✗ ${label}：退出码 0 —— 校验器恒过，不可信"
    FAILED=1
    return
  fi
  if printf '%s' "$out" | grep -q "$expected_code"; then
    log "  ✓ ${label}：退出码 ${rc}，命中 ${expected_code}"
    printf '%s\n' "$out" | grep "$expected_code" | head -2 | sed 's/^/      /'
  else
    warn "  ✗ ${label}：退出码 ${rc} 但输出未命中 ${expected_code}"
    printf '%s\n' "$out" | tail -8 | sed 's/^/      /'
    FAILED=1
  fi
}

expect_failure() {
  local label="$1" checker="$2" expected_code="$3" root="$4" needs_swagger="$5"
  if [ "$needs_swagger" = "yes" ]; then
    expect_failure_with_swagger "$label" "$checker" "$expected_code" "$root" "$SWAGGER_URL"
    return
  fi
  expect_failure_with_swagger "$label" "$checker" "$expected_code" "$root" ""
}

# --- 0. 正向基线 ------------------------------------------------------------
if ! curl -sS --max-time 8 -o /dev/null "$SWAGGER_URL"; then
  die "Swagger 不可达（${SWAGGER_URL}），无法完成反向验证"
fi

log "[0/2] 正向基线：干净副本上跑全部校验器（期望全部退出码 0）……"
BASE_COPY="${TMP_ROOT}/baseline"
make_copy "$BASE_COPY"
expect_pass "check-miniprogram.mjs"   "check-miniprogram.mjs"   "$BASE_COPY" "no"
expect_pass "check-admin-web.mjs"    "check-admin-web.mjs"    "$BASE_COPY" "no"
expect_pass "check-spec-coverage.mjs" "check-spec-coverage.mjs" "$BASE_COPY" "yes"
expect_pass "check-api-spec-doc.mjs"  "check-api-spec-doc.mjs"  "$BASE_COPY" "yes"
expect_pass "check-client-paths.mjs"  "check-client-paths.mjs"  "$BASE_COPY" "yes"
expect_pass "check-contract-routes.mjs" "check-contract-routes.mjs" "$BASE_COPY" "yes"
expect_pass "check-contract-mirror.mjs" "check-contract-mirror.mjs" "$BASE_COPY" "no"
expect_pass "check-rbac-matrix.mjs" "check-rbac-matrix.mjs" "$BASE_COPY" "no"

# --- 1. 逐个注入缺陷并验证 ---------------------------------------------------
# 用例格式：注入 case|校验器|期望错误码|swagger 来源|期望错误码2
# swagger 来源：url = 运行中的 API；file = 用例目录下的 swagger.json 副本
CASES=(
  "mini-page-not-registered|check-miniprogram.mjs|PAGE_NOT_REGISTERED|no|url"
  "mini-handler-missing|check-miniprogram.mjs|HANDLER_MISSING|no|url"
  "mini-component-missing|check-miniprogram.mjs|COMPONENT_MISSING|no|url"
  "admin-route-component-missing|check-admin-web.mjs|ROUTE_COMPONENT_MISSING|no|url"
  "admin-permission-not-contract|check-admin-web.mjs|PERMISSION_NOT_IN_CONTRACT|no|url"
  "spec-page-not-in-matrix|check-spec-coverage.mjs|PAGE_NOT_IN_MATRIX|yes|url"
  "spec-api-group-missing|check-spec-coverage.mjs|API_GROUP_NOT_IMPLEMENTED|yes|url"
  "doc-endpoint-missing|check-api-spec-doc.mjs|DOC_ENDPOINT_MISSING|yes|url"
  "paths-route-not-found|check-client-paths.mjs|ROUTE_NOT_FOUND|yes|url"
  "mirror-literal-path|check-client-paths.mjs|MIRROR_LITERAL_PATH|yes|url"
  "contract-route-missing|check-contract-routes.mjs|CONTRACT_ROUTE_MISSING|yes|url"
  "swagger-extra-route|check-contract-routes.mjs|SERVER_ROUTE_NOT_IN_CONTRACT|no|file"
  "mirror-type-drift|check-contract-mirror.mjs|INTERFACE_DRIFT|no|url"
  "rbac-matrix-drift|check-rbac-matrix.mjs|ROLE_MATRIX_DRIFT|no|url"
)

log "[1/2] 逐个注入缺陷并验证校验器（${#CASES[@]} 个用例）……"

# 元自检：断言函数本身必须能识破「恒过的校验器」。
# 若 expect_failure 写坏了（哪怕校验器永远返回 0 也算通过），本自测就失去意义。
log "  元自检：expect_failure 对「永远返回 0 的假校验器」必须判失败……"
FAKE_CHECKER="${TMP_ROOT}/fake-checker.mjs"
printf 'process.exit(0);\n' > "$FAKE_CHECKER"
META_OUT="$(
  set +e
  expect_failure "元自检" "$FAKE_CHECKER" "ANY_CODE" "$BASE_COPY" "no" 2>&1
)"
if printf '%s' "$META_OUT" | grep -q "恒过"; then
  log "  ✓ 元自检通过：恒过的校验器被正确判为失败"
else
  warn "  ✗ 元自检失败：断言函数对恒过的校验器没有反应（自测本身不可信）"
  FAILED=1
fi

i=0
for entry in "${CASES[@]}"; do
  i=$((i + 1))
  IFS='|' read -r case_name checker expected_code needs_swagger swagger_source <<<"$entry"
  case_copy="${TMP_ROOT}/case-${i}-${case_name}"
  make_copy "$case_copy"

  # 需要「服务端多一条路由」用例时，先把当前 Swagger 落到用例目录再注入
  swagger_arg="$SWAGGER_URL"
  if [ "$swagger_source" = "file" ]; then
    if ! curl -sS --max-time 15 -o "$case_copy/swagger.json" "$SWAGGER_URL"; then
      warn "  ✗ ${case_name}：拉取 Swagger 失败"
      FAILED=1
      continue
    fi
    swagger_arg="$case_copy/swagger.json"
  fi

  if ! node "${SCRIPT_DIR}/selftest-inject.mjs" "$case_name" "$case_copy" >/dev/null 2>&1; then
    warn "  ✗ ${case_name}：缺陷注入失败"
    node "${SCRIPT_DIR}/selftest-inject.mjs" "$case_name" "$case_copy" 2>&1 | sed 's/^/      /'
    FAILED=1
    continue
  fi

  expect_failure_with_swagger "${case_name}" "$checker" "$expected_code" "$case_copy" "$swagger_arg"

  # 用例副本用完即删，避免堆积
  find "$case_copy" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$case_copy" 2>/dev/null || true
done

# --- 2. 收尾 -----------------------------------------------------------------
log "[2/2] 清理临时副本……"
cleanup
trap - EXIT

if [ "$FAILED" -ne 0 ]; then
  die "反向验证失败：存在恒过或报错不准的校验器"
fi

log "=== 反向验证通过 ✅（${#CASES[@]} 类缺陷全部被抓出，6 个校验器均非恒过）==="
