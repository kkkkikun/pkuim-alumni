#!/usr/bin/env bash
# =============================================================================
# 第 22 层校验（演示内容卫生）的反向验证。
#
# 背景（缺陷 #159）：
#   演示版小程序包是发给客户看的，但导出数据集里混着内部调试残留
#   （「调试校友沙龙」「FK修复验证活动」、正文写着「仅用于联调与自动化测试」），
#   事件类型混着英文枚举（客户端图标匹配不上，4 条活动退化成同一张日历图标），
#   通讯录昵称是「校友 A」这类占位代号，列表内容单薄且标题高度重复。
#
#   这类缺陷是**完全静默**的：接口 200、类型检查过、样式校验过、
#   单元测试全绿、回归链 24 步全绿 —— 因为它们不违反任何契约，
#   **只违反「给客户看」这件事本身**。所以必须有一层专门盯这个的校验。
#
# 本脚本证明：这层校验**不是恒过的** ——
#   逐条注入 8 类客户可见缺陷 → 每一条都必须被判失败；
#   注入一条**合法**内容 → 必须仍然通过（防误报）；
#   恒过的假校验器 → 必须被判失败（元自检）。
#
# 退出码：0 全部通过；1 反向验证失败（校验器抓不住缺陷 = 校验器无效）
# =============================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CHECKER="${SCRIPT_DIR}/check-miniprogram-demo-content.mjs"
INJECT="${SCRIPT_DIR}/check-miniprogram-demo-content-inject.mjs"
WORK_DIR="$(mktemp -d /tmp/nmg-demo-selftest.XXXXXX)"
PASS=0
FAIL=0

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()  { PASS=$((PASS+1)); printf '  \xe2\x9c\x93 %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf '  \xe2\x9c\x97 %s\n' "$*"; }

cleanup() {
  if [ -d "$WORK_DIR" ]; then
    find "$WORK_DIR" -mindepth 1 -delete 2>/dev/null || true
    rmdir "$WORK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

SRC_DIR="${WORK_DIR}/src"
cp -r "${PROJECT_ROOT}/apps/miniprogram/src" "$SRC_DIR"

log "反向验证开始（临时副本：${SRC_DIR}）"

# --- 1. 正向基线 ------------------------------------------------------------
log "[1/11] 正向基线：干净数据必须通过……"
set +e
node "$CHECKER" "$SRC_DIR" > "${WORK_DIR}/baseline.log" 2>&1
BASE_RC=$?
set -e
if [ "$BASE_RC" -eq 0 ]; then
  ok "基线：退出码 0，干净数据通过"
else
  bad "基线：退出码 ${BASE_RC}，干净数据竟然没过"
  tail -10 "${WORK_DIR}/baseline.log"
fi

# --- 2~9. 逐条注入客户可见缺陷 ----------------------------------------------
run_case() {
  local idx="$1"; shift
  local label="$1"; shift
  local op="$1"; shift
  local expect_msg="$1"; shift

  log "[${idx}/11] 注入「${label}」并验证校验器……"
  rm -rf "$SRC_DIR"
  cp -r "${PROJECT_ROOT}/apps/miniprogram/src" "$SRC_DIR"
  if ! node "$INJECT" "$SRC_DIR" "$op" > "${WORK_DIR}/inject.log" 2>&1; then
    bad "${label}：注入脚本执行失败，测试本身有问题"
    tail -5 "${WORK_DIR}/inject.log"
    return
  fi
  set +e
  node "$CHECKER" "$SRC_DIR" > "${WORK_DIR}/broken.log" 2>&1
  BROKEN_RC=$?
  set -e
  if [ "$BROKEN_RC" -ne 0 ]; then
    ok "${label}：退出码 ${BROKEN_RC}，校验器判为失败 ✅"
  else
    bad "${label}：退出码 0 —— 校验器没抓到（校验器无效）"
  fi
  if grep -q "$expect_msg" "${WORK_DIR}/broken.log"; then
    ok "${label}：失败信息点名了「${expect_msg}」"
  else
    bad "${label}：失败信息没有点名「${expect_msg}」"
    tail -12 "${WORK_DIR}/broken.log"
  fi
}

run_case 2  "标题含内部痕迹词"      title-word      "痕迹"
run_case 3  "正文含内部痕迹词"      body-word      "痕迹"
run_case 4  "标题缺虚构标记"        strip-prefix   "虚构"
run_case 5  "条目数不足"            drop-items     "低于下限"
run_case 6  "标题重复"              dup-title      "重复"
run_case 7  "事件类型是英文枚举"    eng-kind       "英文枚举"
run_case 8  "分类计数不符"          count-mismatch "不一致"
run_case 9  "通讯录占位式昵称"      placeholder-name "占位式代号"

# --- 10. 防误报：合法内容必须仍然通过 ---------------------------------------
log "[10/11] 防误报断言：注入合法内容必须仍然通过……"
rm -rf "$SRC_DIR"
cp -r "${PROJECT_ROOT}/apps/miniprogram/src" "$SRC_DIR"
node "$INJECT" "$SRC_DIR" benign > "${WORK_DIR}/inject.log" 2>&1
set +e
node "$CHECKER" "$SRC_DIR" > "${WORK_DIR}/falsepositive.log" 2>&1
FP_RC=$?
set -e
if [ "$FP_RC" -eq 0 ]; then
  ok "防误报：合法内容不被误判，退出码 0 ✅"
else
  bad "防误报：合法内容被误判（退出码 ${FP_RC}）"
  tail -12 "${WORK_DIR}/falsepositive.log"
fi

# --- 11. 元自检 --------------------------------------------------------------
log "[11/11] 元自检：恒过的假校验器必须被判失败……"
cat > "${WORK_DIR}/always-pass.sh" <<'EOF'
#!/usr/bin/env bash
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
  ok "元自检通过：恒过的假校验器被判为失败（说明判据真的在起作用）"
fi

cleanup
trap - EXIT

log "=============================================="
log "反向验证：${PASS} 项通过 / ${FAIL} 项失败"
if [ "$FAIL" -ne 0 ]; then
  log "=== 反向验证未通过 ❌（校验器抓不住缺陷 = 校验器无效）==="
  exit 1
fi
log "=== 反向验证通过 ✅（8 类客户可见缺陷都能被抓住，且不误判合法内容）==="
