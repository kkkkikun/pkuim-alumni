#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 小程序离线编译自检的反向验证（自测）
#
#   bash infra/scripts/check-miniprogram-compile-selftest.sh
#
# 目的：证明 `miniprogram-compile-check.mjs` **不是恒过**。
#
# 关键事实（实测得来，别想当然）：
#   微信的编译流水线是**只转译、不做类型检查**的。
#   - 注入**语法**错误 → 编译必须失败（所以编译自检有意义）；
#   - 注入**类型**错误 → 编译照样「成功」，只有 `tsc --noEmit` 会红。
#   （所以「编译成功」不能证明类型没问题，两道检查都得跑。）
#
# 三段式：
#   [0/3] 正向基线：干净工程 → 编译通过；
#   [1/3] 注入语法错误 → 编译必须失败（退出码非 0）；
#   [2/3] 注入类型错误 → 编译仍过、但 tsc 必须红（记录分工）；
#   [3/3] 清理。
#
# 安全约束：
#   - 只在临时副本上改动，原仓库一个字节都不碰；
#   - 禁止 rm -rf / rm -f：删除一律用 `find -delete` + `rmdir`；
#   - 只读原仓库，不发任何网络请求（离线编译走本地打桩）。
#
# 退出码：0 自测通过；1 自测失败。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

SCRIPT_DIR="${PROJECT_ROOT}/infra/scripts"
COMPILE_CHECK="${SCRIPT_DIR}/miniprogram-compile-check.mjs"
MINIPROGRAM_DIR="${PROJECT_ROOT}/apps/miniprogram"
FAILED=0

require_cmd node
require_cmd rsync
require_cmd python3
[ -f "$COMPILE_CHECK" ] || die "编译自检脚本不存在：${COMPILE_CHECK}"
[ -d "$MINIPROGRAM_DIR" ] || die "小程序目录不存在：${MINIPROGRAM_DIR}"

TMP_ROOT="$(mktemp -d /tmp/nmg-mp-compile-selftest-XXXXXX)"
cleanup() {
  find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

log "=== 小程序离线编译自检 · 反向验证开始 ==="
log "临时副本根目录：${TMP_ROOT}"

make_copy() {
  local dest="$1"
  # 保持仓库目录结构：apps/miniprogram/tsconfig.json 里 extends '../../tsconfig.base.json'
  # → 副本也必须把 tsconfig.base.json 放在 apps/ 的上一层，否则 tsc 会报 TS5083
  mkdir -p "${dest}/apps"
  rsync -a --exclude 'node_modules/' --exclude '.git/' "${MINIPROGRAM_DIR}/" "${dest}/apps/miniprogram/"
  cp -p "${PROJECT_ROOT}/tsconfig.base.json" "${dest}/tsconfig.base.json"
  if [ -d "${MINIPROGRAM_DIR}/node_modules" ]; then
    ln -s "${MINIPROGRAM_DIR}/node_modules" "${dest}/apps/miniprogram/node_modules"
  fi
}

# --- 0. 正向基线：干净工程必须编译通过 --------------------------------------
log "[0/3] 正向基线：干净工程必须编译通过……"
set +e
BASE_OUT="$(node "$COMPILE_CHECK" "$MINIPROGRAM_DIR" 2>&1)"
BASE_RC=$?
set -e
if [ "$BASE_RC" -ne 0 ]; then
  warn "  ✗ 基线：退出码 ${BASE_RC}（干净工程竟然编译不过）"
  printf '%s\n' "$BASE_OUT" | tail -20 | sed 's/^/      /'
  FAILED=1
else
  log "  ✓ 基线：退出码 0，干净工程离线编译通过"
  printf '%s\n' "$BASE_OUT" | grep -E "产物文件数|产物体积|耗时" | sed 's/^/      /'
fi

# --- 1. 注入语法错误 → 编译必须失败 ------------------------------------------
log "[1/3] 注入「语法错误」（编译必须失败）……"
R1_COPY="${TMP_ROOT}/case-syntax-error"
make_copy "$R1_COPY"
python3 - "${R1_COPY}/apps/miniprogram/src/config/index.ts" <<'PY'
import sys

path = sys.argv[1]
with open(path, 'a', encoding='utf-8') as f:
    f.write("\nthis is not valid javascript ===\n")
print('已注入语法错误')
PY

set +e
R1_OUT="$(node "$COMPILE_CHECK" "${R1_COPY}/apps/miniprogram" 2>&1)"
R1_RC=$?
set -e
if [ "$R1_RC" -eq 0 ]; then
  warn "  ✗ 注入语法错误后编译**仍然通过** → 编译自检是恒过的，不可信"
  FAILED=1
else
  log "  ✓ 注入语法错误后编译失败（退出码 ${R1_RC}）"
  printf '%s\n' "$R1_OUT" | grep -iE "error|fail" | head -3 | sed 's/^/      /'
fi

# --- 2. 注入类型错误 → 编译仍过，但 tsc 必须红（分工记录）-------------------
log "[2/3] 注入「类型错误」（编译仍过、tsc 必须红 —— 记录分工）……"
R2_COPY="${TMP_ROOT}/case-type-error"
make_copy "$R2_COPY"
python3 - "${R2_COPY}/apps/miniprogram/src/config/index.ts" <<'PY'
import sys

path = sys.argv[1]
with open(path, 'a', encoding='utf-8') as f:
    f.write("\nconst __ts_probe: number = 'not-a-number';\nexport { __ts_probe };\n")
print('已注入类型错误')
PY

set +e
R2_OUT="$(node "$COMPILE_CHECK" "${R2_COPY}/apps/miniprogram" 2>&1)"
R2_RC=$?
set -e
if [ "$R2_RC" -ne 0 ]; then
  warn "  ! 注意：注入类型错误后编译也失败了（与「只转译不检查」的预期不符），退出码 ${R2_RC}"
  printf '%s\n' "$R2_OUT" | tail -6 | sed 's/^/      /'
else
  log "  ✓ 注入类型错误后编译仍通过 → 证实编译器不做类型检查"
fi

TSC_BIN="${MINIPROGRAM_DIR}/node_modules/.bin/tsc"
if [ -x "$TSC_BIN" ]; then
  set +e
  (cd "${R2_COPY}/apps/miniprogram" && "$TSC_BIN" --noEmit -p tsconfig.json) >/tmp/nmg-mp-tsc.out 2>&1
  TSC_RC=$?
  set -e
  if [ "$TSC_RC" -ne 0 ]; then
    log "  ✓ tsc --noEmit 抓到了类型错误（退出码 ${TSC_RC}）→ 类型问题由 tsc 负责"
    head -3 /tmp/nmg-mp-tsc.out | sed 's/^/      /'
  else
    warn "  ✗ tsc 没抓到注入的类型错误 —— 类型检查这一环有问题"
    FAILED=1
  fi
else
  warn "  ! 跳过 tsc 用例：找不到 ${TSC_BIN}（依赖未安装）"
fi

# --- 3. 清理 -----------------------------------------------------------------
log "[3/3] 清理临时副本……"
find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
rmdir "$TMP_ROOT" 2>/dev/null || true

if [ "$FAILED" -ne 0 ]; then
  die "小程序离线编译自检的反向验证失败 ❌"
fi

log "=== 反向验证通过 ✅（编译自检会因语法错误变红；类型错误由 tsc 负责）==="
