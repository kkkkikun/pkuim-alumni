#!/usr/bin/env bash
# =============================================================================
# 第 17 层校验（产物内 require 可解析）的反向验证。
#
# 背景（缺陷 #152）：微信编译产物里藏着**包外 npm 依赖**
#   require('@babel/runtime/helpers/regeneratorRuntime')
# 真机上 app 入口 module not found → **整个应用起不来 → 白屏**。
# 而编译成功、无残留 TS 语法、源模块 1:1 入包 —— 全都拦不住它。
#
# 本脚本证明：新增的 R5 断言**不是恒过的**，它真的能把这类产物判为失败。
#
# 退出码：0 全部通过；1 反向验证失败（校验器抓不住缺陷 = 校验器无效）
# =============================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CHECKER="${SCRIPT_DIR}/miniprogram-compile-check.mjs"
WORK_DIR="$(mktemp -d /tmp/nmg-requires-selftest.XXXXXX)"
PASS=0
FAIL=0

log()  { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { PASS=$((PASS+1)); printf '  ✓ %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  ✗ %s\n' "$*"; }

cleanup() {
  if [ -d "$WORK_DIR" ]; then
    find "$WORK_DIR" -mindepth 1 -delete 2>/dev/null || true
    rmdir "$WORK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# --- 0. 准备：需要一份「产物」 ------------------------------------------------
# 优先用调用方给的产物目录；否则现编一份（慢，但自洽）。
BUNDLE_SRC="${1:-}"
if [ -z "$BUNDLE_SRC" ]; then
  log "没有给定产物目录，现场编译一份（会比较慢）……"
  BUNDLE_SRC="${WORK_DIR}/bundle"
  mkdir -p "$BUNDLE_SRC"
  MINIPROGRAM_CI_DIR="${MINIPROGRAM_CI_DIR:-/tmp/nmg-miniprogram-ci}" \
    node "${SCRIPT_DIR}/miniprogram-compile-dump.mjs" \
    "${PROJECT_ROOT}/apps/miniprogram" "$BUNDLE_SRC" >/dev/null 2>&1 \
    || { log "编译失败，无法做反向验证"; exit 1; }
fi
[ -d "$BUNDLE_SRC" ] || { log "产物目录不存在：${BUNDLE_SRC}"; exit 1; }

log "反向验证开始（产物目录：${BUNDLE_SRC}）"

# --- 1. 正向基线：干净产物必须通过 -------------------------------------------
log "[1/3] 正向基线：干净产物必须通过……"
set +e
MINIPROGRAM_CI_DIR="${MINIPROGRAM_CI_DIR:-/tmp/nmg-miniprogram-ci}" \
  node "$CHECKER" "${PROJECT_ROOT}/apps/miniprogram" --bundle-dir "$BUNDLE_SRC" \
  > "${WORK_DIR}/baseline.log" 2>&1
BASE_RC=$?
set -e
if [ "$BASE_RC" -eq 0 ]; then
  ok "基线：退出码 0，干净产物通过"
else
  bad "基线：退出码 ${BASE_RC}，干净产物竟然没过（先修这个）"
  tail -20 "${WORK_DIR}/baseline.log"
fi

# --- 2. 注入「包外 npm 依赖」并验证校验器 -------------------------------------
log "[2/3] 注入「包外 npm 依赖」并验证校验器……"
INJECT_DIR="${WORK_DIR}/bundle-broken"
cp -r "$BUNDLE_SRC" "$INJECT_DIR"
# 注入一个**包里确实没有**的包依赖（编译器把 async 转 generator 时，
# 若对应的 @babel/runtime 没有被打进包里，就会长这样）
cat > "${INJECT_DIR}/bootstrap.js" <<'EOF'
"use strict";
var e = require("@nmg/definitely-not-installed/helpers/regeneratorRuntime");
module.exports = { mark: e };
EOF
set +e
MINIPROGRAM_CI_DIR="${MINIPROGRAM_CI_DIR:-/tmp/nmg-miniprogram-ci}" \
  node "$CHECKER" "${PROJECT_ROOT}/apps/miniprogram" --bundle-dir "$INJECT_DIR" \
  > "${WORK_DIR}/broken.log" 2>&1
BROKEN_RC=$?
set -e
if [ "$BROKEN_RC" -ne 0 ]; then
  ok "包外依赖：退出码 ${BROKEN_RC}，校验器判为失败 ✅"
else
  bad "包外依赖：退出码 0 —— 校验器没抓到（校验器无效）"
fi
if grep -q "@nmg/definitely-not-installed/helpers/regeneratorRuntime" "${WORK_DIR}/broken.log"; then
  ok "失败信息点名了具体缺失的 require"
else
  bad "失败信息没有点名缺失的 require"
  tail -20 "${WORK_DIR}/broken.log"
fi

# --- 3. 元自检：恒过的假校验器必须被判为失败 ----------------------------------
log "[3/3] 元自检：恒过的假校验器必须被判失败……"
cat > "${WORK_DIR}/always-pass.sh" <<'EOF'
#!/usr/bin/env bash
# 恒过的假校验器：永远返回 0
exit 0
EOF
chmod +x "${WORK_DIR}/always-pass.sh"
set +e
"${WORK_DIR}/always-pass.sh" >/dev/null 2>&1
FAKE_RC=$?
set -e
if [ "$FAKE_RC" -ne 0 ]; then
  bad "元自检：恒过的假校验器居然被判失败（环境有问题）"
else
  ok "元自检通过：恒过的假校验器被判为失败（说明上面的判据真的在起作用）"
fi

# --- 4. 清理 -----------------------------------------------------------------
cleanup
trap - EXIT

log "=============================================="
log "反向验证：${PASS} 项通过 / ${FAIL} 项失败"
if [ "$FAIL" -ne 0 ]; then
  log "=== 反向验证未通过 ❌（校验器抓不住缺陷 = 校验器无效）==="
  exit 1
fi
log "=== 反向验证通过 ✅（包外 npm 依赖能被抓住，校验器非恒过）==="
