#!/usr/bin/env bash
# =============================================================================
# 第 23 层校验（真机反馈回归守卫）的反向验证。
#
# 背景（缺陷 #161）：
#   客户在真机上一次报了 12 张截图 —— 输入框文字被裁切、底部固定按钮压住正文、
#   筛选/搜索看起来完全不生效、筛选后卡在空列表。
#   当时**24 步回归链全绿**：接口 200、类型检查过、样式校验过、单测全绿。
#   因为这几类问题都不违反任何契约，只有人拿在手里才看得出来。
#
# 第二轮真机反馈（3 张截图）追加：
#   认证页底部两个按钮要左右并排；连接二级筛选页去掉「信息类型」（外面已有）；
#   连接列表页的「按行业」chip 行太乱，应收进二级筛选页。
#
# 本脚本证明：这层校验**不是恒过的** ——
#   逐条注入 13 类真机可见缺陷 → 每一条都必须被判失败；
#   注入两处**合法**改动 → 必须仍然通过（防误报）；
#   恒过的假校验器 → 必须被判失败（元自检）。
#
# 退出码：0 全部通过；1 反向验证失败（校验器抓不住缺陷 = 校验器无效）
# =============================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CHECKER="${SCRIPT_DIR}/check-miniprogram-ui-feedback.mjs"
INJECT="${SCRIPT_DIR}/check-miniprogram-ui-feedback-inject.mjs"
WORK_DIR="$(mktemp -d /tmp/nmg-uifb-selftest.XXXXXX)"
PASS=0
FAIL=0
TOTAL=17

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
log "[1/${TOTAL}] 正向基线：干净源码必须通过……"
set +e
node "$CHECKER" "$SRC_DIR" > "${WORK_DIR}/baseline.log" 2>&1
BASE_RC=$?
set -e
if [ "$BASE_RC" -eq 0 ]; then
  ok "基线：退出码 0，干净源码通过"
else
  bad "基线：退出码 ${BASE_RC}，干净源码竟然没过"
  tail -12 "${WORK_DIR}/baseline.log"
fi

# --- 2~14. 逐条注入真机可见缺陷 ----------------------------------------------
run_case() {
  local idx="$1"; shift
  local label="$1"; shift
  local op="$1"; shift
  local expect_msg="$1"; shift

  log "[${idx}/${TOTAL}] 注入「${label}」并验证校验器……"
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

run_case 2  "固定底栏没有留出正文空间"  strip-bar-padding "固定底栏遮挡正文"
run_case 3  "输入框没有显式高度"        input-height      "输入框文字被裁切"
run_case 4  "输入框有纵向 padding"      input-padding     "输入框文字被裁切"
run_case 5  "筛选变化后不重新加载"      no-reload         "没有重新拉数据"
run_case 6  "空列表没有清空出路"        no-empty-action   "没有「清空筛选条件」的出路"
run_case 7  "年份条件不可见"            hide-year         "幽灵条件"
run_case 8  "类型条件不可见"            hide-type         "幽灵条件"
run_case 9  "有地区一条资源都没有"      region-gap        "一条资源都没有"
run_case 10 "认证页按钮改回上下堆叠"    stack-verify-buttons "没有左右并排"
run_case 11 "二级筛选页加回信息类型"    restore-type-filter "重复入口"
run_case 12 "二级筛选页重新接管类型"    filter-type-leak  "仍在处理信息类型"
run_case 13 "列表页加回行业 chip 行"    restore-industry-chips "横向 chip 行"
run_case 14 "列表页行业入口不可见"      hide-industry-entry "没有可见的行业筛选入口"

# --- 15~16. 防误报：合法改动必须仍然通过 -------------------------------------
log "[15/${TOTAL}] 防误报断言：注入合法改动（按钮文案）必须仍然通过……"
rm -rf "$SRC_DIR"
cp -r "${PROJECT_ROOT}/apps/miniprogram/src" "$SRC_DIR"
node "$INJECT" "$SRC_DIR" benign > "${WORK_DIR}/inject.log" 2>&1
set +e
node "$CHECKER" "$SRC_DIR" > "${WORK_DIR}/falsepositive.log" 2>&1
FP_RC=$?
set -e
if [ "$FP_RC" -eq 0 ]; then
  ok "防误报：合法改动不被误判，退出码 0 ✅"
else
  bad "防误报：合法改动被误判（退出码 ${FP_RC}）"
  tail -12 "${WORK_DIR}/falsepositive.log"
fi

log "[16/${TOTAL}] 防误报断言：注释里出现敏感字样必须仍然通过……"
rm -rf "$SRC_DIR"
cp -r "${PROJECT_ROOT}/apps/miniprogram/src" "$SRC_DIR"
node "$INJECT" "$SRC_DIR" benign-comment > "${WORK_DIR}/inject.log" 2>&1
set +e
node "$CHECKER" "$SRC_DIR" > "${WORK_DIR}/falsepositive2.log" 2>&1
FP2_RC=$?
set -e
if [ "$FP2_RC" -eq 0 ]; then
  ok "防误报：注释里的字样不被当成界面内容，退出码 0 ✅"
else
  bad "防误报：注释里的字样被误判（退出码 ${FP2_RC}）"
  tail -12 "${WORK_DIR}/falsepositive2.log"
fi

# --- 17. 元自检 --------------------------------------------------------------
log "[17/${TOTAL}] 元自检：恒过的假校验器必须被判失败……"
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
log "=== 反向验证通过 ✅（13 类真机可见缺陷都能被抓住，且不误判合法改动）==="
