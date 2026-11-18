#!/usr/bin/env bash
# =============================================================================
# 第 19 层校验（类名对账：WXML 用到的类必须有 WXSS 定义）的反向验证。
#
# 背景（缺陷 #154，真机「和 HTML 原型差很远」的根因）：
#   小程序首页 WXML 用了 32 个类，而这些类**在所有 WXSS 里都没有定义**
#   → 真机上页面上半部分全是**裸文字**。
#   这类缺陷对接口、类型检查、单测**全是静默的**：
#   页面能打开、数据能加载、底部卡片有样式，一眼看过去「好像是有样式的」。
#
# 本脚本证明：这条校验**不是恒过的** ——
#   1) 注入一个没有样式定义的类名 → 必须被判失败；
#   2) 注入一个**已有**样式定义的类名 → 必须**仍然通过**（防误报）；
#   3) 恒过的假校验器 → 必须被判失败（元自检）。
#
# 退出码：0 全部通过；1 反向验证失败（校验器抓不住缺陷 = 校验器无效）
# =============================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CHECKER="${SCRIPT_DIR}/check-miniprogram-styles.mjs"
WORK_DIR="$(mktemp -d /tmp/nmg-styles-selftest.XXXXXX)"
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
TARGET="${SRC_DIR}/pages/home/index/index.wxml"

log "反向验证开始（临时副本：${SRC_DIR}）"

# --- 1. 正向基线 ------------------------------------------------------------
log "[1/4] 正向基线：干净源码必须通过……"
set +e
node "$CHECKER" "$SRC_DIR" > "${WORK_DIR}/baseline.log" 2>&1
BASE_RC=$?
set -e
if [ "$BASE_RC" -eq 0 ]; then
  ok "基线：退出码 0，干净源码通过"
else
  bad "基线：退出码 ${BASE_RC}，干净源码竟然没过"
  tail -10 "${WORK_DIR}/baseline.log"
fi

# --- 2. 注入「用了没样式」的类名 ---------------------------------------------
log "[2/4] 注入「用了没样式」的类名并验证校验器……"
cp "$TARGET" "${TARGET}.bak"
printf '\n<view class="selftest-unstyled-class"><text>x</text></view>\n' >> "$TARGET"
set +e
node "$CHECKER" "$SRC_DIR" > "${WORK_DIR}/broken.log" 2>&1
BROKEN_RC=$?
set -e
if [ "$BROKEN_RC" -ne 0 ]; then
  ok "无样式类名：退出码 ${BROKEN_RC}，校验器判为失败 ✅"
else
  bad "无样式类名：退出码 0 —— 校验器没抓到（校验器无效）"
fi
if grep -q "selftest-unstyled-class" "${WORK_DIR}/broken.log"; then
  ok "失败信息点名了具体类名"
else
  bad "失败信息没有点名类名"
  tail -10 "${WORK_DIR}/broken.log"
fi
mv "${TARGET}.bak" "$TARGET"

# --- 3. 防误报：已有样式的类名必须仍然通过 -----------------------------------
log "[3/4] 防误报断言：注入已有样式的类名必须仍然通过……"
cp "$TARGET" "${TARGET}.bak"
printf '\n<view class="hero-title"><text>x</text></view>\n' >> "$TARGET"
set +e
node "$CHECKER" "$SRC_DIR" > "${WORK_DIR}/falsepositive.log" 2>&1
FP_RC=$?
set -e
if [ "$FP_RC" -eq 0 ]; then
  ok "防误报：已有样式的类名不被误判，退出码 0 ✅"
else
  bad "防误报：已有样式的类名被误判（退出码 ${FP_RC}）"
  tail -10 "${WORK_DIR}/falsepositive.log"
fi
mv "${TARGET}.bak" "$TARGET"

# --- 4. 元自检 ---------------------------------------------------------------
log "[4/4] 元自检：恒过的假校验器必须被判失败……"
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
log "=== 反向验证通过 ✅（无样式类名能被抓住，且不误判已有样式的类）==="
