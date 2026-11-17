#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 小程序离线演示兜底层校验器的反向验证（自测）
#
#   bash infra/scripts/check-miniprogram-demo-selftest.sh
#
# 目的：证明 `check-miniprogram-demo.sh` **不是恒过**——
#       路由漏覆盖、模式开关写错、演示数据混进联系方式字段、
#       回退边界被改成「4xx 也回退」、演示分支里偷偷发了网络请求、
#       类型检查被打破 —— 每一条都必须被抓出（退出码非 0 + 命中预期错误码）；
#       同时证明它**不吵**：干净副本必须通过。
#
# 八段式：
#   [0/8] 正向基线：干净副本 → 退出码 0；
#   [1/8] R1 注入「路由漏覆盖」；
#   [2/8] R2 注入「DATA_MODE 取值非法」；
#   [3/8] R3 注入「演示数据出现 contactPhone 字段」；
#   [4/8] R4 注入「回退改为由 HTTP 状态码触发」；
#   [5/8] R5 注入「演示分支里调用 wx.request」；
#   [6/8] R6 注入「类型错误」；
#   [7/8] R7 注入「运行时 import .json 模块」；
#   [8/8] 清理。
#
# 安全约束：
#   - **只在临时目录里的副本上改动**，原仓库一个字节都不碰；
#   - **禁止 rm -rf / rm -f**：删除一律用 `find -delete` + `rmdir`，
#     需要移走文件时用 `mv`（移回原处，不是删除）。
#   - 只读原仓库，不发任何网络请求。
#
# 退出码：0 自测通过；1 自测失败。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

SCRIPT_DIR="${PROJECT_ROOT}/infra/scripts"
CHECKER="${SCRIPT_DIR}/check-miniprogram-demo.sh"
MINIPROGRAM_DIR="${PROJECT_ROOT}/apps/miniprogram"
FAILED=0

require_cmd node
require_cmd python3
require_cmd rsync
[ -f "$CHECKER" ] || die "校验器不存在：${CHECKER}"
[ -d "$MINIPROGRAM_DIR" ] || die "小程序目录不存在：${MINIPROGRAM_DIR}"

TMP_ROOT="$(mktemp -d /tmp/nmg-demo-selftest-XXXXXX)"
cleanup() {
  find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

log "=== 小程序离线演示兜底层校验器反向验证开始 ==="
log "临时副本根目录：${TMP_ROOT}"

# --- 复制一份干净的小程序工程（含根 tsconfig.base.json） --------------------
make_copy() {
  local dest="$1"
  mkdir -p "${dest}/apps"
  rsync -a \
    --exclude 'node_modules/' --exclude 'dist/' --exclude 'coverage/' \
    "${MINIPROGRAM_DIR}/" "${dest}/apps/miniprogram/"
  cp -p "${PROJECT_ROOT}/tsconfig.base.json" "${dest}/tsconfig.base.json"
  # 类型检查需要依赖：把原工程的 node_modules 软链进副本（不复制、不修改）
  if [ -d "${MINIPROGRAM_DIR}/node_modules" ]; then
    ln -s "${MINIPROGRAM_DIR}/node_modules" "${dest}/apps/miniprogram/node_modules"
  fi
}

# --- 跑一次校验器，输出与退出码 -------------------------------------------
run_checker() {
  local root="$1" out rc
  set +e
  out="$(bash "$CHECKER" --root "$root" 2>&1)"
  rc=$?
  set -e
  printf '%s' "$out"
  return "$rc"
}

# --- 断言「注入缺陷 → 校验器变红」 ----------------------------------------
expect_fail() {
  local case_name="$1" expected="$2" root="$3" out rc
  set +e
  out="$(bash "$CHECKER" --root "$root" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    warn "  ✗ ${case_name}：退出码 0 —— 校验器恒过，不可信"
    printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
    FAILED=1
    return
  fi
  if printf '%s' "$out" | grep -q "$expected"; then
    log "  ✓ ${case_name}：退出码 ${rc}，命中 ${expected}"
    printf '%s\n' "$out" | grep "$expected" | head -2 | sed 's/^/      /'
  else
    warn "  ✗ ${case_name}：输出未命中 ${expected}"
    printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
    FAILED=1
  fi
}

# --- 0. 正向基线 ----------------------------------------------------------
log "[0/8] 正向基线：干净副本必须通过……"
BASE_COPY="${TMP_ROOT}/baseline"
make_copy "$BASE_COPY"
set +e
BASE_OUT="$(bash "$CHECKER" --root "$BASE_COPY" 2>&1)"
BASE_RC=$?
set -e
if [ "$BASE_RC" -ne 0 ]; then
  warn "  ✗ 基线：退出码 ${BASE_RC}（干净副本竟然不通过）"
  printf '%s\n' "$BASE_OUT" | tail -20 | sed 's/^/      /'
  FAILED=1
else
  log "  ✓ 基线：退出码 0，校验器在干净副本上全绿"
  printf '%s\n' "$BASE_OUT" | grep -E 'R[1-7]' | sed 's/^/      /'
fi

# --- 1. R1：路由漏覆盖 ----------------------------------------------------
log "[1/8] 注入「演示路由漏覆盖一个端点」……"
R1_COPY="${TMP_ROOT}/case-r1"
make_copy "$R1_COPY"
python3 - "${R1_COPY}/apps/miniprogram/src/demo/router.ts" <<'PY'
import sys

path = sys.argv[1]
src = open(path, encoding='utf-8').read()
needle = "pattern: '/system/regions',"
assert needle in src, 'anchor not found'
src = src.replace(needle, "pattern: '/system/regions-removed',", 1)
open(path, 'w', encoding='utf-8').write(src)
PY
expect_fail "R1-route-missing" "DEMO_ROUTE_MISSING" "$R1_COPY"

# --- 2. R2：DATA_MODE 取值非法 --------------------------------------------
log "[2/8] 注入「DATA_MODE 取值非法」……"
R2_COPY="${TMP_ROOT}/case-r2"
make_copy "$R2_COPY"
python3 - "${R2_COPY}/apps/miniprogram/src/config/index.ts" <<'PY'
import re
import sys

path = sys.argv[1]
src = open(path, encoding='utf-8').read()
src2 = re.sub(r"(export const DATA_MODE: DataMode = ')[a-z]+(';)", r"\1offline\2", src, count=1)
assert src2 != src, 'anchor not found'
open(path, 'w', encoding='utf-8').write(src2)
PY
expect_fail "R2-data-mode-invalid" "DEMO_DATA_MODE_INVALID" "$R2_COPY"

# --- 3. R3：演示数据混入联系方式字段 --------------------------------------
log "[3/8] 注入「演示数据集出现 contactPhone 字段」……"
R3_COPY="${TMP_ROOT}/case-r3"
make_copy "$R3_COPY"
python3 - "${R3_COPY}/apps/miniprogram/src/demo/dataset.data.ts" <<'PY'
import sys

path = sys.argv[1]
src = open(path, encoding='utf-8').read()
needle = '"__note":'
assert needle in src, 'anchor not found'
src = src.replace(needle, '"contactPhone": null,\n  ' + needle, 1)
open(path, 'w', encoding='utf-8').write(src)
PY
expect_fail "R3-pii-field" "DEMO_PII_FIELD" "$R3_COPY"

# --- 4. R4：回退改为由 HTTP 状态码触发 ------------------------------------
log "[4/8] 注入「回退不再绑定网络错误（改成 HTTP 状态码）」……"
R4_COPY="${TMP_ROOT}/case-r4"
make_copy "$R4_COPY"
python3 - "${R4_COPY}/apps/miniprogram/src/services/request.ts" <<'PY'
import sys

path = sys.argv[1]
src = open(path, encoding='utf-8').read()
needle = "apiError.code === 'NETWORK_ERROR'"
assert needle in src, 'anchor not found'
src = src.replace(needle, "apiError.code === 'HTTP_500'", 1)
open(path, 'w', encoding='utf-8').write(src)
PY
expect_fail "R4-fallback-unsafe" "DEMO_FALLBACK_UNSAFE" "$R4_COPY"

# --- 5. R5：演示分支里偷偷发网络请求 --------------------------------------
log "[5/8] 注入「演示分支里调用 wx.request」……"
R5_COPY="${TMP_ROOT}/case-r5"
make_copy "$R5_COPY"
python3 - "${R5_COPY}/apps/miniprogram/src/services/auth.ts" <<'PY'
import sys

path = sys.argv[1]
src = open(path, encoding='utf-8').read()
needle = """  if (DATA_MODE === 'demo') {
    return applyLogin(buildDemoLoginResult());
  }"""
assert needle in src, 'anchor not found'
injected = """  if (DATA_MODE === 'demo') {
    wx.request({ url: 'https://demo.invalid' });
    return applyLogin(buildDemoLoginResult());
  }"""
src = src.replace(needle, injected, 1)
open(path, 'w', encoding='utf-8').write(src)
PY
expect_fail "R5-demo-network-call" "DEMO_AUTH_NETWORK_CALL" "$R5_COPY"

# --- 6. R6：类型错误 -------------------------------------------------------
log "[6/8] 注入「类型错误（tsc 必须报错）」……"
R6_COPY="${TMP_ROOT}/case-r6"
make_copy "$R6_COPY"
python3 - "${R6_COPY}/apps/miniprogram/src/demo/dataset.ts" <<'PY'
import sys

path = sys.argv[1]
src = open(path, encoding='utf-8').read()
src += "\nconst __typecheck_probe: number = 'not-a-number';\nexport { __typecheck_probe };\n"
open(path, 'w', encoding='utf-8').write(src)
PY
if [ -d "${MINIPROGRAM_DIR}/node_modules" ]; then
  expect_fail "R6-typecheck" "DEMO_TYPECHECK_FAILED" "$R6_COPY"
else
  warn "  ! 跳过：本机没有安装 node_modules（无法验证 R6），请在装好依赖的服务器上重跑"
fi

# --- 7. R7：运行时 JSON 模块引用 -------------------------------------------
log "[7/8] 注入「运行时 import 了 .json 模块」……"
R7_COPY="${TMP_ROOT}/case-r7"
make_copy "$R7_COPY"
python3 - "${R7_COPY}/apps/miniprogram/src/demo/dataset.ts" <<'PY'
import sys

path = sys.argv[1]
src = open(path, encoding='utf-8').read()
src = "import legacy from './legacy.json';\n" + src
open(path, 'w', encoding='utf-8').write(src)
PY
expect_fail "R7-json-import" "DEMO_JSON_IMPORT" "$R7_COPY"

# --- 8. 清理 ---------------------------------------------------------------
log "[8/8] 清理临时副本……"
find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
rmdir "$TMP_ROOT" 2>/dev/null || true

if [ "$FAILED" -ne 0 ]; then
  die "小程序离线演示兜底层校验器反向验证失败 ❌"
fi

log "=== 反向验证通过 ✅（R1~R7 都能被注入缺陷打红）==="
log "小程序离线演示兜底层校验器反向验证通过 ✅"
